// The runtime half of Canopy's repair agents. `vibeRepair.ts` owns what a
// troubleshooter is — the problem envelope, the authority contract, the
// prompt, the verdict. This module owns running one: reserving the task,
// launching the agent with write-and-shell authority scoped to the broken
// component, narrating what it is doing in plain language, and returning its
// verdict to whoever reported the problem.
//
// Why this exists: Build's promise is that nobody technical is in the seat.
// Until now a server that crashed three times produced a recorded log tail and
// the sentence "The app server keeps stopping" — the evidence was captured and
// nothing ever read it. A repair task is the thing that reads it.
import { CANOPY_MCP_ALLOWANCE } from "./agentTools";
import { launchEnvSync } from "./profiles";
import { getSettings } from "./settings";
import * as ipc from "./ipc";
import type { ProjectRunnerTransport } from "./projectRunner";
import { streamsStructured, type StructuredRunnerLaunch } from "./structuredRunners";
import { rankRoutes, resolveRoute, type RouteVersions } from "./vibeFailover";
import {
  parseRepairVerdict,
  plainRepairActivity,
  repairPrompt,
  type RepairProblem,
  type RepairVerdict,
} from "./vibeRepair";
import type { VibeProjectSetupTaskDeps } from "./vibeProjectSetup";

/** Repair reserves, launches and settles through the same surface as project
 *  setup — one dependency shape means one fake in tests and no second wiring
 *  path to drift. */
export type VibeRepairTaskDeps = VibeProjectSetupTaskDeps;

/** Repair is diagnosis with authority to act, which the routing table classes
 *  as a fix, not a survey. */
const REPAIR_TASK_CLASS = "fix" as const;

const REPAIR_ROUTE_VERSIONS: RouteVersions = {
  harnessVersion: "vibe-repair-1",
  promptVersion: "vibe-repair-1",
  toolPolicyVersion: "component-write-shell-confirm-destructive-1",
};

/** Same ceiling as setup and for the same reason: an install can legitimately
 *  take minutes, and a repair cut off mid-`npm install` leaves the checkout
 *  worse than it found it. */
const REPAIR_TIMEOUT_MS = 900_000;

export interface VibeRepairTaskInput {
  problem: RepairProblem;
  timeoutMs?: number;
  /** Already in the person's language — plainRepairActivity has run. A raw
   *  command line must never reach a Build pane. */
  onActivity?: (doing: string) => void;
  signal?: AbortSignal;
}

export type VibeRepairTaskResult =
  | { ok: true; verdict: RepairVerdict; runId: string }
  | {
      ok: false;
      reason: "no-agent" | "timeout" | "agent-failed" | "invalid-output";
      message: string;
      runId: string | null;
    };

type RepairAttempt =
  | { kind: "complete"; text: string }
  | { kind: "failed"; text: string; timedOut: boolean };

/** Reserve and run one repair attempt. One attempt on purpose: this agent
 *  acts on the machine, and automatically replaying a half-applied fix on a
 *  different model is not a retry, it is a second incident. If repair fails,
 *  the failure — with what was tried — goes back to the person. */
export async function runVibeRepairTask(
  input: VibeRepairTaskInput,
  deps: VibeRepairTaskDeps,
): Promise<VibeRepairTaskResult> {
  const { problem } = input;
  const timeoutMs = Math.max(1_000, Math.min(1_200_000, input.timeoutMs ?? REPAIR_TIMEOUT_MS));
  const candidates = (await deps.listRoutes().catch(() => [])).filter(
    (candidate) => streamsStructured(candidate.cli),
  );
  const eligible = rankRoutes(
    candidates,
    REPAIR_TASK_CLASS,
    getSettings().defaultAgent,
  );
  const chosen = eligible[0];
  if (!chosen) {
    return {
      ok: false, reason: "no-agent", runId: null,
      message: "I couldn't look into the problem because no repair agent is available right now.",
    };
  }
  const bin = deps.binFor(chosen.cli);
  if (!bin) {
    return {
      ok: false, reason: "no-agent", runId: null,
      message: "I couldn't look into the problem because the repair agent is unavailable.",
    };
  }
  const reservation = await deps.reserve({
    kind: "vibe-repair",
    projectId: problem.projectId,
    componentId: problem.component.id,
    worktreePath: problem.component.path,
    goal: `Diagnose and fix: ${problem.statement}`,
    acceptance: [
      "Say what was wrong in plain language.",
      "Fix it and verify the fix took, or name the one thing still in the way.",
      "Ask the person before any destructive or invasive action.",
    ],
    contextSummary: `Repair for ${problem.projectName}: ${problem.code}`,
    riskClass: "workspace-write",
    authorityPolicy: {
      writes: "component",
      shell: "allowed",
      confirmDestructive: true,
      verification: { required: [] },
    },
    failoverPolicy: { automatic: false },
    attemptCap: 1,
    deadlineAt: Date.now() + timeoutMs,
    title: "Figuring out what went wrong",
    metadata: { history: true, taskId: "vibe-repair", label: "Repair" },
    route: resolveRoute(
      chosen,
      eligible,
      REPAIR_ROUTE_VERSIONS,
      await deps.cliVersion(chosen.cli).catch(() => null),
    ),
  });
  const runId = reservation.envelope.runId;
  const attempt = reservation.attempt;
  await deps.startAttempt(attempt.attemptId);

  const prompt = repairPrompt(problem);
  const launch: StructuredRunnerLaunch = {
    bin,
    policy: {
      systemPromptAppend: prompt.system,
      // The fix is real work: edits apply without a prompt, and Bash is in
      // allowedTools because nobody is in this session to approve it call by
      // call. What holds the line on destructive actions is the contract in
      // the prompt — REPAIR_CONFIRM_FIRST routes them through canopy_ask_user,
      // which blocks until the person answers — plus the authority recorded
      // on the envelope, which is what verification audits against.
      permissionMode: "acceptEdits",
      allowedTools: [CANOPY_MCP_ALLOWANCE, "Bash"],
      disallowedTools: ["KillShell", "NotebookEdit"],
      model: chosen.requestedModel ?? "",
      sessionId: deps.sessionId(),
      cwd: problem.component.path,
      authority: "workspace-write",
    },
    env: [
      ...launchEnvSync(chosen.cli),
      ["CANOPY_VIBE_REPAIR", "1"],
      ["CANOPY_RUN_ID", runId],
      ["CANOPY_ATTEMPT_ID", attempt.attemptId],
    ],
  };
  void ipc.jsLog(
    "error",
    `vibe-repair: launching ${chosen.cli} bin=${bin} model=${chosen.requestedModel ?? "(none)"} ` +
      `cwd=${problem.component.path} problem=${problem.code} ` +
      `promptChars=${prompt.system.length}+${prompt.user.length} ` +
      `env=${JSON.stringify(launchEnvSync(chosen.cli).map(([name]) => name))}`,
  );

  let output = "";
  let error = "";
  let finishEvent: ((result: RepairAttempt) => void) | null = null;
  let live: ProjectRunnerTransport | null = null;
  let transport: ProjectRunnerTransport;
  try {
    transport = await deps.runner.start(attempt.attemptId, chosen.cli, launch, {
      emit(event) {
        if (event.kind === "tool") {
          const doing = plainRepairActivity(event.name);
          if (doing) input.onActivity?.(doing);
        }
        if (event.kind === "delta" || event.kind === "reply") output += event.text;
        else if (event.kind === "error") error = event.message;
        else if (event.kind === "blocked") {
          error =
            `Canopy requested permissions to use ${event.tool} in a session it started itself, ` +
            "and the request had nobody to answer it.";
          void live?.stop().catch(() => {});
          finishEvent?.({ kind: "failed", text: error, timedOut: false });
        }
        // `turn.failed` emits `error` then `turnEnd`; the error only wins an
        // empty turn. Same rule as setup, for the same hour it cost there.
        else if (event.kind === "turnEnd") {
          finishEvent?.(output || !error
            ? { kind: "complete", text: output }
            : { kind: "failed", text: error, timedOut: false });
        }
        else if (event.kind === "exit") {
          finishEvent?.({ kind: "failed", text: error || output || "repair agent exited", timedOut: false });
        }
      },
    }, { resume: false });
    live = transport;
  } catch (spawnError) {
    transport = { send: async () => {}, stop: async () => {} };
    error = String(spawnError);
  }

  const result: RepairAttempt = error
    ? { kind: "failed", text: error, timedOut: false }
    : await new Promise<RepairAttempt>((resolve) => {
        let finished = false;
        let timer: number | undefined;
        const finish = (outcome: RepairAttempt) => {
          if (finished) return;
          finished = true;
          if (timer !== undefined) window.clearTimeout(timer);
          input.signal?.removeEventListener("abort", abort);
          resolve(outcome);
        };
        const abort = () => {
          void transport.stop().catch(() => {});
          finish({ kind: "failed", text: "repair was cancelled", timedOut: false });
        };
        finishEvent = finish;
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted) {
          abort();
          return;
        }
        timer = window.setTimeout(() => {
          void transport.stop().catch(() => {});
          finish({ kind: "failed", text: "repair agent timed out", timedOut: true });
        }, timeoutMs);
        void transport.send(prompt.user).catch((sendError) =>
          finish({ kind: "failed", text: String(sendError), timedOut: false }),
        );
      });

  if (result.kind === "complete") {
    const verdict = parseRepairVerdict(result.text);
    if (!verdict) {
      void ipc.jsLog(
        "error",
        `vibe-repair: ${chosen.cli} returned no parseable verdict; it said: ${result.text.slice(0, 500) || "(nothing)"}`,
      );
      await deps.settleAttempt({
        attemptId: attempt.attemptId, state: "blocked",
        failureClass: "task", failureCode: "invalid-structured-output",
      });
      return {
        ok: false, reason: "invalid-output", runId,
        message: "I looked into the problem but couldn't put together a clear answer.",
      };
    }
    await deps.settleAttempt({
      attemptId: attempt.attemptId,
      state: verdict.fixed ? "completed" : "blocked",
      ...(verdict.fixed ? {} : { failureClass: "task", failureCode: "repair-blocked" }),
    });
    return { ok: true, verdict, runId };
  }

  if (input.signal?.aborted) {
    await deps.settleAttempt({
      attemptId: attempt.attemptId, state: "interrupted",
      failureClass: "lifecycle", failureCode: "project-closed",
    });
    return { ok: false, reason: "agent-failed", runId, message: "Repair stopped when the project closed." };
  }
  void ipc.jsLog(
    "error",
    `vibe-repair: attempt on ${chosen.cli} failed (timedOut=${result.timedOut}): ${result.text.slice(0, 600)}`,
  );
  await deps.settleAttempt({
    attemptId: attempt.attemptId, state: "failed",
    failureClass: result.timedOut ? "timeout" : "runner",
    failureCode: result.timedOut ? "repair-timeout" : "repair-agent-failed",
  });
  return {
    ok: false,
    reason: result.timedOut ? "timeout" : "agent-failed",
    runId,
    message: result.timedOut
      ? "I ran out of time trying to fix it."
      : "I tried to fix it and couldn't finish.",
  };
}

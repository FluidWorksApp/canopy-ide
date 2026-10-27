// Context controls for an agent session: "Compact now", and "Summarize from
// here" / "Summarize up to here" on a turn of its timeline.
//
// All three are the harness's own compaction (harness.ts `compaction`,
// HARNESS_COMPACT_COMMAND) with instructions. Claude Code's /compact always
// condenses the whole conversation; the instructions tell it what to keep in
// detail and what to boil down, which is as close as a CLI-driven control can
// get to choosing a range. The UI says so.
//
// Driven two ways, never by guessing:
//   - a session live in a terminal gets the command typed at its prompt — and
//     only when the agent is idle. Mid-turn the request waits for the turn to
//     end; a session waiting on a question or a permission is left alone.
//   - a session with no live terminal is resumed headlessly by the CLI's
//     verified runner (structuredRunners.ts compactArgs), which compacts and
//     exits — on this computer, or in a cloud workspace inside the workspace
//     itself, where the session lives (the host's session_compact,
//     packages/remote-host/session-compact.mjs). That run is not a Canopy
//     agent: no hooks, no turn snapshot.

import * as ipc from "./ipc";
import { agentCliFor, structuredRunnerFor } from "./projects";
import { HARNESS_COMPACT_COMMAND, harnessSupport } from "./harness";
import { StructuredRunCollector } from "./structuredEvents";
import { BRAIN_DISALLOWED_TOOLS } from "./structuredRunners";
import { noteContextWindows } from "./contextWindow";
import { activeWorkspace } from "./remoteExecution/workspace";

export type CompactScope =
  | { kind: "all"; note?: string }
  | { kind: "from" | "upto"; turn: { n: number; prompt?: string | null }; note?: string };

const excerpt = (s: string | null | undefined) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
};

/** The instructions that go after the compaction command. */
export function compactInstructions(scope: CompactScope): string {
  const note = scope.note?.trim();
  if (scope.kind === "all") return note ?? "";
  const which = `turn ${scope.turn.n}${scope.turn.prompt ? ` ("${excerpt(scope.turn.prompt)}")` : ""}`;
  const base =
    scope.kind === "from"
      ? `Keep everything before ${which} as close to verbatim as you can. Condense ${which} and everything after it into a short summary of what was done, decided and left open.`
      : `Condense everything up to and including ${which} into a short summary of what was done, decided and left open. Keep everything after it in full detail.`;
  return note ? `${base} Also: ${note}` : base;
}

/** The full text to send, or null when this CLI has no compaction. */
export function compactCommand(agent: string, scope: CompactScope): string | null {
  const cmd = HARNESS_COMPACT_COMMAND[agent];
  if (!cmd || harnessSupport(agent, "compaction") === "unknown") return null;
  const text = compactInstructions(scope).replace(/[\r\n]+/g, " ").trim();
  return text ? `${cmd} ${text}` : cmd;
}

export type CompactPlan =
  | { route: "terminal" }
  /** Live and mid-turn (or starting): send when the turn ends. */
  | { route: "wait"; why: string }
  | { route: "runner" }
  | { route: "unavailable"; why: string };

/** How a compaction of this session can be driven right now. */
export function compactPlan(o: {
  agent: string;
  /** A terminal here is running the session. */
  live: boolean;
  lifeState?: string;
  /** In a cloud workspace (the CLI and its sessions are on the host; the
   *  headless run happens there). */
  remote?: boolean;
}): CompactPlan {
  if (!HARNESS_COMPACT_COMMAND[o.agent] || harnessSupport(o.agent, "compaction") === "unknown") {
    return { route: "unavailable", why: "This agent's CLI has no compaction Canopy can drive." };
  }
  if (o.live) {
    if (o.lifeState === "idle") return { route: "terminal" };
    if (o.lifeState === "waiting") {
      return { route: "unavailable", why: "The agent is waiting for your answer — answer it first." };
    }
    if (o.lifeState === "ended") return runnerOr();
    return { route: "wait", why: "Sends when the agent finishes this turn — never mid-turn." };
  }
  return runnerOr();

  function runnerOr(): CompactPlan {
    return structuredRunnerFor(o.agent)?.compactArgs
      ? { route: "runner" }
      : { route: "unavailable", why: "Open the session in a terminal to compact it." };
  }
}

export interface CompactResult {
  ok: boolean;
  preTokens?: number | null;
  postTokens?: number | null;
  message?: string;
}

const COMPACT_TIMEOUT_MS = 5 * 60 * 1000;

/** Resume `sessionId` headlessly and compact it. Never throws. */
export async function compactHeadless(
  o: {
    agent: string;
    sessionId: string;
    cwd: string;
    /** The full text: the compaction command and its instructions. */
    command: string;
    /** Just the instructions — what a cloud workspace's host is sent. */
    instructions?: string;
    profile?: string | null;
  },
  deps: {
    spawn: typeof ipc.brainCallSpawn;
    kill: typeof ipc.brainKill;
    remote?: typeof ipc.sessionCompact;
  } = {
    spawn: ipc.brainCallSpawn,
    kill: ipc.brainKill,
  },
): Promise<CompactResult> {
  const runner = structuredRunnerFor(o.agent);
  const bin = agentCliFor(o.agent)?.bin;
  if (!runner?.compactArgs || !bin) return { ok: false, message: "This agent's CLI cannot compact a session headlessly." };
  if (deps.remote || activeWorkspace()) {
    // The session lives in the workspace: compact it there.
    try {
      const r = await (deps.remote ?? ipc.sessionCompact)({
        agent: o.agent,
        sessionId: o.sessionId,
        cwd: o.cwd,
        instructions: o.instructions ?? "",
        profile: o.profile ?? null,
      });
      noteContextWindows(r.contextWindows);
      return r.ok
        ? { ok: true, preTokens: r.preTokens ?? null, postTokens: r.postTokens ?? null }
        : { ok: false, message: r.message ?? "The compaction failed." };
    } catch (e) {
      return { ok: false, message: String(e instanceof Error ? e.message : e) };
    }
  }
  const args = runner.compactArgs(
    {
      bin,
      policy: {
        systemPromptAppend: "",
        permissionMode: "plan",
        disallowedTools: BRAIN_DISALLOWED_TOOLS,
        model: "",
        sessionId: o.sessionId,
        authority: "read-only",
      },
    },
    o.command,
  );
  const collector = new StructuredRunCollector(runner.dialect);
  const callId = `compact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise<CompactResult>((resolve) => {
    let done = false;
    const finish = (r: CompactResult) => {
      if (done) return;
      done = true;
      noteContextWindows(collector.summary.contextWindows);
      resolve(r);
    };
    const settle = () => {
      const s = collector.summary;
      if (s.isError) return finish({ ok: false, message: s.errorMessage ?? "The compaction failed." });
      if (!s.compacted) return finish({ ok: false, message: "The CLI finished without compacting." });
      finish({ ok: true, preTokens: s.compacted.preTokens, postTokens: s.compacted.postTokens });
    };
    deps
      .spawn(
        callId,
        { command: bin, args, cwd: o.cwd, env: [...(runner.sessionEnv ?? [])].map(([k, v]) => [k, v] as [string, string]), timeoutMs: COMPACT_TIMEOUT_MS },
        (out) => {
          if (out.kind === "line") {
            collector.handleLine(out.text);
            if (collector.summary.done) settle();
          } else if (out.kind === "exit") {
            if (collector.summary.done) settle();
            else finish({ ok: false, message: `The CLI exited (${out.code ?? "killed"}) before compacting.` });
          }
        },
      )
      .catch((e: unknown) => finish({ ok: false, message: String(e instanceof Error ? e.message : e) }));
  }).finally(() => void deps.kill(callId).catch(() => {}));
}

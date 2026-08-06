import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import type { ProjectRunnerController } from "./projectRunner";
import type { StructuredRunnerHost } from "./structuredEvents";
import type { TaskReservation } from "./taskEnvelope";
import {
  createVibeBuilderSession,
  DEFAULT_VIBE_BUILDER_DEPS,
  scopedGitEntries,
  type CheckpointReview,
  type VibeBuilderSessionDeps,
  type VibeBuilderSessionOptions,
} from "./vibeBuilderSession";
import type { VerificationObservation } from "./vibeVerification";

const route = {
  cli: "claude",
  profileId: "default",
  harnessVersion: "1",
  promptVersion: "1",
  toolPolicyVersion: "1",
  executionMode: "structured" as const,
};

function reservation(): TaskReservation {
  return {
    envelope: {
      runId: "run-1",
      projectId: "project-1",
      componentId: "app",
      kind: "vibe-turn",
      title: "Make the button blue",
      status: "running",
      attemptCount: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    attempt: {
      attemptId: "attempt-1",
      runId: "run-1",
      ordinal: 1,
      state: "reserved",
      route,
    },
  };
}

const observation = (
  kind: VerificationObservation["kind"],
  verdict: VerificationObservation["verdict"] = "pass",
): VerificationObservation => ({ kind, verdict, note: `${kind} ${verdict}`, at: 10 });

const safeReview = (verification: CheckpointReview["context"]["verification"]): CheckpointReview => ({
  context: {
    isolatedOrGreenfield: true,
    cleanAtTurnStart: true,
    lineageUnchanged: true,
    pathsExclusive: true,
    secretScanClean: true,
    noOpenIncident: true,
    verification,
  },
  repoRoot: "/repo",
  paths: ["src/App.tsx"],
  diff: "diff --git a/src/App.tsx b/src/App.tsx",
});

function harness(
  over: Partial<VibeBuilderSessionDeps> = {},
  options: Partial<VibeBuilderSessionOptions> = {},
) {
  const order: string[] = [];
  let host: StructuredRunnerHost | null = null;
  const transport = {
    send: vi.fn(async () => void order.push("send")),
    stop: vi.fn(async () => {}),
  };
  const runner: ProjectRunnerController = {
    start: vi.fn(async (_attemptId, _cliId, _launch, nextHost) => {
      order.push("spawn");
      host = nextHost;
      return transport;
    }),
  };
  const transcripts: { kind: string; body: string }[] = [];
  const events: { kind: string; code?: string | null; metadata?: unknown }[] = [];
  const abstractionRuns: { argv: string[]; cwd: string }[] = [];
  const deps: VibeBuilderSessionDeps = {
    abstractionContext: vi.fn(async (cwd: string) => ({
      cwd,
      entries: ["package.json", "package-lock.json"],
      packageManagerField: null,
      dependencies: {},
      devDependencies: {},
      link: {
        cliInstalled: true,
        authenticated: true,
        presentSecrets: [],
        envFileTracked: false,
      },
      // No `verification` here on purpose — it is the session's observation,
      // not the project's, and the type no longer allows it to be smuggled in.
      deploy: { dirty: false, cliInstalled: true },
    })),
    runAbstraction: vi.fn(async (argv: string[], cwd: string) => {
      abstractionRuns.push({ argv, cwd });
      return { ok: true, exitCode: 0, output: "added 1 package", timedOut: false };
    }),
    runner,
    reserve: vi.fn(async () => {
      order.push("reserve");
      return reservation();
    }),
    startAttempt: vi.fn(async () => {
      order.push("start-attempt");
      return reservation().attempt;
    }),
    settleAttempt: vi.fn(async () => reservation().attempt),
    appendTranscript: vi.fn(async (entry) => {
      order.push(`transcript:${entry.kind}`);
      transcripts.push(entry);
      return {} as never;
    }),
    appendEvent: vi.fn(async (event) => {
      events.push(event);
      return {} as never;
    }),
    writeArtifact: vi.fn(async ({ kind }) => ({
      id: `artifact-${kind}`,
      runId: "run-1",
      attemptId: "attempt-1",
      kind,
      bytes: 10,
      createdAt: 1,
    })),
    captureBaseline: vi.fn(async () => ({
      cleanAtStart: true,
      head: "abc",
      isolated: true,
      repoRoot: "/repo",
    })),
    runCheck: vi.fn(async () => ({
      observation: observation("check"),
      output: "checks passed",
    })),
    beginBrowserTurn: vi.fn(async () => true),
    inspectBrowser: vi.fn(async () => ({
      observations: [
        observation("server"),
        observation("console"),
        observation("network"),
        observation("screenshot"),
      ],
      screenshot: "jpeg",
    })),
    reviewCheckpoint: vi.fn(async ({ verification }) => safeReview(verification)),
    commit: vi.fn(async () => "commit-1"),
    // Unarmed by default, which is what a real machine looks like the first
    // time this code ever runs. A harness that armed it would hide the gate
    // from every test that does not mention it — and the gate exists precisely
    // because a green suite is not evidence that `git commit` works here.
    autoCheckpointObserved: vi.fn(() => false),
    recordAutoCheckpointObserved: vi.fn(),
    updateMetadata: vi.fn(async () => ({})),
    reserveAttempt: vi.fn(async () => ({
      ...reservation().attempt,
      attemptId: "attempt-2",
      ordinal: 2,
    })),
    listRoutes: vi.fn(async () => [
      {
        cli: "claude",
        profileId: "default",
        family: "anthropic" as const,
        state: {
          agent: "claude",
          profile: "default",
          kind: "ready" as const,
          reasons: [],
        },
        choices: [{ id: "claude-fable-5", label: "Fable 5", hint: "" }],
      },
    ]),
    cliVersion: vi.fn(async () => "1.2.3"),
    now: () => 10,
    sessionId: () => "session-1",
    sleep: vi.fn(async () => {}),
    ...over,
  };
  const session = createVibeBuilderSession(
    {
      projectId: "project-1",
      projectName: "Shop",
      componentId: "app",
      componentPath: "/repo",
      cliId: "claude",
    cliBin: "claude",
      checkCommand: "npm test",
      previewTabId: () => "preview-1",
      ...options,
    },
    deps,
  );
  const replies: string[] = [];
  session.events$.subscribe((event) => {
    if (event.kind === "reply") replies.push(event.text);
  });
  return {
    replies,
    session,
    deps,
    order,
    transcripts,
    events,
    transport,
    abstractionRuns,
    emit: (event: Parameters<StructuredRunnerHost["emit"]>[0]) => host?.emit(event),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("VibeBuilderSession", () => {
  it("collects turn-scoped network evidence through the production dependency", async () => {
    vi.spyOn(ipc, "browserHere").mockResolvedValue({
      url: "http://localhost:5173/",
      title: "App",
    });
    vi.spyOn(ipc, "browserNavigate").mockResolvedValue();
    vi.spyOn(ipc, "browserPainted").mockResolvedValue(true);
    let evalCalls = 0;
    const op = vi.spyOn(ipc, "browserRunOp").mockImplementation(async (_tab, request) => {
      if (request.op === "console")
        return { done: true, ok: true, data: { messages: [] } };
      if (request.op === "network")
        return {
          done: true,
          ok: true,
          data: {
            requests: [{ url: "/api/orders", status: 200, ms: 12, bytes: 800 }],
            total: 1,
            pending: 0,
            lastActivityAt: 0,
          },
        };
      if (request.op === "eval")
        return {
          done: true,
          ok: true,
          data: {
            result:
              evalCalls++ === 0
                ? 100
                : { ready: "complete", origin: 200 },
          },
        };
      return null;
    });

    await DEFAULT_VIBE_BUILDER_DEPS.beginBrowserTurn("preview-1");
    const inspection = await DEFAULT_VIBE_BUILDER_DEPS.inspectBrowser(
      "preview-1",
      false,
      10,
      true,
    );

    expect(op).toHaveBeenCalledWith(
      "preview-1",
      expect.objectContaining({ op: "network", clear: true }),
    );
    expect(inspection.observations).toContainEqual(
      expect.objectContaining({ kind: "network", verdict: "pass" }),
    );
  });

  // The scan itself is unit-tested next door; what this covers is the wiring
  // that made it dead code — `secretScanClean` was a hardcoded `false`, so no
  // turn could ever save itself however clean the diff, and no test noticed
  // because every checkpoint test injects the flag through a stub.
  it("derives the secret verdict from the diff the production review builds", async () => {
    const files = {
      clean: "-  const a = 1;\n+  const a = 2;",
      // Assembled at runtime: a literal AWS key in this file is what a secret
      // scanner in CI is for, and it would flag its own test fixture.
      leaky: `+  const key = "${"AKIA"}${"J".repeat(16)}";`,
    };
    for (const [name, body] of Object.entries(files)) {
      vi.spyOn(ipc, "gitStatus").mockResolvedValue({
        is_repo: true,
        entries: [{ status: " M", path: "src/App.tsx" }],
      } as Awaited<ReturnType<typeof ipc.gitStatus>>);
      vi.spyOn(ipc, "gitWorktrees").mockResolvedValue([
        { path: "/repo", head: "abc", is_main: false } as Awaited<
          ReturnType<typeof ipc.gitWorktrees>
        >[number],
      ]);
      vi.spyOn(ipc, "contextClaims").mockResolvedValue([]);
      vi.spyOn(ipc, "gitDiff").mockImplementation(async (_root, _path, staged) =>
        staged ? "" : `+++ b/src/App.tsx\n@@ -1,1 +1,1 @@\n${body}`,
      );

      const review = await DEFAULT_VIBE_BUILDER_DEPS.reviewCheckpoint({
        cwd: "/repo",
        baseline: {
          cleanAtStart: true,
          head: "abc",
          isolated: true,
          repoRoot: "/repo",
        },
        verification: "verified",
        noOpenIncident: true,
      });
      expect(review.context.secretScanClean).toBe(name === "clean");
      expect(review.secrets?.clean).toBe(name === "clean");
      if (name === "leaky") {
        expect(review.secrets?.findings[0].rule).toBe("aws-access-key");
        // A finding names the rule and the place; repeating the value here
        // would leak it into the record the scan exists to keep clean.
        expect(JSON.stringify(review.secrets)).not.toContain("AKIA");
      }
    }
  });

  it("reserves a Build turn the task panels can actually list", async () => {
    const h = harness();
    await h.session.send("Make the button blue");
    expect(h.deps.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        // Both panels gate on this: `json_extract(metadata_json,'$.history')=1`
        // in tasks.rs and `if (!metadata?.history) return null` in
        // taskHistory.ts. Reserving without it filed a complete evidence ledger
        // somewhere no surface would ever look.
        metadata: expect.objectContaining({
          history: true,
          taskId: "vibe-turn",
          agent: "claude",
          cwd: "/repo",
          projectId: "project-1",
          brief: "Make the button blue",
        }),
      }),
    );
  });

  it("puts the verification summary on the run's history row", async () => {
    const h = harness();
    await h.session.send("Make the button blue");
    h.emit({ kind: "turnEnd" });
    await vi.waitFor(() => expect(h.deps.updateMetadata).toHaveBeenCalled());
    expect(h.deps.updateMetadata).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        history: true,
        summary: expect.stringContaining("all required evidence passed"),
      }),
    );
  });

  it("says why a project with no check script stays unverified", async () => {
    const caveat =
      "app has no check, typecheck, test or build script, so there's no check I can run — turns here stay unverified until you add one.";
    const h = harness(
      {
        runCheck: vi.fn(async () => ({
          observation: observation("check", "unknown"),
          output: "",
        })),
      },
      { checkCommand: null, checkCaveat: caveat },
    );
    await h.session.send("Make the button blue");
    h.emit({ kind: "turnEnd" });

    await vi.waitFor(() =>
      expect(h.transcripts).toContainEqual(
        expect.objectContaining({ kind: "system", body: expect.stringContaining(caveat) }),
      ),
    );
    // And in the durable ledger, not only in a message that scrolls away.
    expect(h.events).toContainEqual(
      expect.objectContaining({
        kind: "verification.observation",
        code: "check",
        metadata: expect.objectContaining({ note: caveat }),
      }),
    );
  });

  it("scopes absolute git-status paths for root and nested components", () => {
    const entries = [
      { status: "!!", path: "/repo/node_modules/" },
      { status: " M", path: "/repo/packages/web/src/App.tsx" },
      { status: " M", path: "/repo/packages/api/src/index.ts" },
    ];
    expect(scopedGitEntries(entries, "/repo", "/repo")).toEqual(entries.slice(1));
    expect(scopedGitEntries(entries, "/repo", "/repo/packages/web")).toEqual([
      { status: " M", path: "/repo/packages/web/src/App.tsx" },
    ]);
  });

  it("records the route it actually chose, not a literal", async () => {
    const h = harness();
    await h.session.send("Make the button blue");
    expect(h.deps.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({
          cli: "claude",
          profileId: "default",
          cliVersion: "1.2.3",
          requestedModel: "claude-fable-5",
          // No CLI reports the model it really used, so claiming one would
          // turn a request into a false observation.
          observedModel: null,
          selection: expect.objectContaining({
            policy: "vibe-fleet-ranked-1",
            eligible: ["claude:default"],
          }),
        }),
      }),
    );
  });

  it("refuses to launch, and reserves nothing, when the fleet has no usable route", async () => {
    const h = harness({
      listRoutes: vi.fn(async () => [
        {
          cli: "claude",
          profileId: "default",
          family: "anthropic" as const,
          state: {
            agent: "claude",
            profile: "default",
            kind: "unusable" as const,
            reasons: ["signed-out" as const],
          },
          choices: [{ id: "claude-fable-5", label: "Fable 5", hint: "" }],
        },
      ]),
    });
    await expect(h.session.send("Make the button blue")).rejects.toThrow(
      /No agent is ready to build/i,
    );
    expect(h.deps.reserve).not.toHaveBeenCalled();
    expect(h.deps.runner.start).not.toHaveBeenCalled();
  });

  it("launches on the model the route asked for", async () => {
    const h = harness();
    await h.session.send("Make the button blue");
    expect(h.deps.runner.start).toHaveBeenCalledWith(
      expect.anything(),
      "claude",
      expect.objectContaining({
        policy: expect.objectContaining({ model: "claude-fable-5" }),
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("moves to another model when the route runs out of quota, and says so", async () => {
    const h = harness({
      listRoutes: vi.fn(async () => [
        {
          cli: "claude",
          profileId: "default",
          family: "anthropic" as const,
          state: { agent: "claude", profile: "default", kind: "ready" as const, reasons: [] },
          choices: [{ id: "claude-fable-5", label: "Fable 5", hint: "" }],
        },
        {
          cli: "codex",
          profileId: "default",
          family: "openai" as const,
          state: { agent: "codex", profile: "default", kind: "ready" as const, reasons: [] },
          choices: [{ id: "gpt-5.6-sol", label: "GPT-5.6", hint: "" }],
        },
      ]),
    });
    await h.session.send("Make the button blue");
    h.emit({ kind: "error", message: "usage limit reached for your plan" });
    h.emit({ kind: "exit" });

    await vi.waitFor(() => expect(h.deps.reserveAttempt).toHaveBeenCalled());
    // The new attempt is linked to the one that failed, and to nothing else.
    expect(h.deps.reserveAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveryFromAttemptId: "attempt-1",
        route: expect.objectContaining({ cli: "codex" }),
      }),
    );
    expect(h.deps.settleAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ state: "failed", failureClass: "route" }),
    );
    expect(h.replies.join(" ")).toMatch(/Claude .*quota.*switched to Codex/i);
  });

  it("does not switch when the failure is about the task", async () => {
    const h = harness();
    await h.session.send("Make the button blue");
    h.emit({ kind: "error", message: "prompt is too long: context window exceeded" });
    h.emit({ kind: "exit" });

    await vi.waitFor(() =>
      expect(h.deps.settleAttempt).toHaveBeenCalledWith(
        expect.objectContaining({ state: "failed", failureClass: "task" }),
      ),
    );
    expect(h.deps.reserveAttempt).not.toHaveBeenCalled();
    expect(h.replies.join(" ")).toMatch(/not the model/i);
  });

  it("reserves and starts the durable attempt before spawning", async () => {
    const h = harness();
    await h.session.send("Make the button blue");

    expect(h.order).toEqual([
      "reserve",
      "start-attempt",
      "spawn",
      "transcript:user",
      "send",
    ]);
    expect(h.deps.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        componentId: "app",
        goal: "Make the button blue",
      }),
    );
    expect(h.transcripts).toContainEqual(
      expect.objectContaining({ kind: "user", body: "Make the button blue" }),
    );
  });

  it("records a crash loop on the active attempt with a capped log artifact", async () => {
    const h = harness();
    await h.session.send("Make the button blue");

    await expect(
      h.session.reportServerIncident({
        key: "server-1",
        componentId: "app",
        runCommandId: "dev",
        exitCode: 1,
        crashTimes: [1, 2, 3],
        automaticRestarts: 2,
        ports: [5173],
        outputBytes: 9000,
        totalCpu: 12,
        totalMemBytes: 1024,
        logTail: "server exploded",
      }),
    ).resolves.toBe("recorded");

    expect(h.deps.reserve).toHaveBeenCalledTimes(2);
    expect(h.deps.writeArtifact).toHaveBeenCalledWith({
      runId: "run-1",
      attemptId: "attempt-1",
      kind: "vibe-server-log-tail",
      content: "server exploded",
    });
    expect(h.events).toContainEqual(
      expect.objectContaining({
        kind: "watchdog-incident",
        code: "vibe-server-crash-loop",
        metadata: expect.objectContaining({
          logArtifactId: "artifact-vibe-server-log-tail",
          lastObservedPorts: [5173],
          activeRunId: "run-1",
          activeAttemptId: "attempt-1",
        }),
      }),
    );
    expect(h.session.state.question?.prompt).toBe(
      "The app server keeps stopping.",
    );
  });

  it("correlates a retried incident to the attempt that was live when it crashed", async () => {
    // The crash is observed during one turn but only persists during a later
    // one. What the bundle has to say is which attempt was running when the
    // server died, so the correlation is captured once and carried through the
    // retry rather than re-read from whatever attempt is current by then.
    let turns = 0;
    const reserve = vi.fn(
      async (request: Parameters<VibeBuilderSessionDeps["reserve"]>[0]) => {
        const base = reservation();
        if (request.kind === "vibe-server-health") {
          return {
            envelope: { ...base.envelope, runId: "server-run" },
            attempt: {
              ...base.attempt,
              runId: "server-run",
              attemptId: "server-attempt",
            },
          };
        }
        turns += 1;
        return {
          envelope: { ...base.envelope, runId: `run-${turns}` },
          attempt: {
            ...base.attempt,
            runId: `run-${turns}`,
            attemptId: `attempt-${turns}`,
          },
        };
      },
    );
    let writable = false;
    const h = harness({
      reserve,
      writeArtifact: vi.fn(async ({ kind }) => {
        if (!writable) throw new Error("disk busy");
        return {
          id: `artifact-${kind}`,
          runId: "server-run",
          attemptId: "server-attempt",
          kind,
          bytes: 10,
          createdAt: 1,
        };
      }),
    });
    await h.session.send("Make the button blue");
    const incident = {
      key: "server-drift",
      componentId: "app",
      runCommandId: "dev",
      exitCode: 1,
      crashTimes: [1, 2, 3],
      automaticRestarts: 2,
      ports: [] as number[],
      outputBytes: null,
      totalCpu: null,
      totalMemBytes: null,
      logTail: "server exploded",
    };
    await expect(h.session.reportServerIncident(incident)).resolves.toBe(
      "failed",
    );
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ kind: "watchdog-incident" }),
    );

    // A fresh attempt takes over before the retry lands. An unexplained exit
    // now reseeds the turn rather than ending it, so the later attempt becomes
    // current on its own — which is exactly the drift this test guards against.
    h.emit({ kind: "exit" });
    await vi.waitFor(() =>
      expect(h.deps.startAttempt).toHaveBeenCalledWith("attempt-2"),
    );

    writable = true;
    await expect(h.session.reportServerIncident(incident)).resolves.toBe(
      "recorded",
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        kind: "watchdog-incident",
        metadata: expect.objectContaining({
          activeRunId: "run-1",
          activeAttemptId: "attempt-1",
        }),
      }),
    );
  });

  it("creates a dedicated durable incident attempt before the first Build turn", async () => {
    const h = harness();
    const result = await h.session.reportServerIncident({
      key: "server-early",
      componentId: "app",
      runCommandId: "dev",
      exitCode: 1,
      crashTimes: [1, 2, 3],
      automaticRestarts: 2,
      ports: [],
      outputBytes: null,
      totalCpu: null,
      totalMemBytes: null,
      logTail: "early failure",
    });

    expect(result).toBe("recorded");
    expect(h.deps.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "vibe-server-health" }),
    );
    expect(h.deps.startAttempt).toHaveBeenCalledWith("attempt-1");
    expect(h.deps.settleAttempt).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      state: "blocked",
      failureClass: "watchdog",
      failureCode: "vibe-server-crash-loop",
    });
    expect(
      vi.mocked(h.deps.writeArtifact).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(h.deps.appendEvent).mock.invocationCallOrder[0]);
  });

  it("retries the required log artifact before recording the incident", async () => {
    const writeArtifact = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk busy"))
      .mockResolvedValue({
        id: "artifact-retry",
        runId: "run-1",
        attemptId: "attempt-1",
        kind: "vibe-server-log-tail",
        bytes: 10,
        createdAt: 1,
      });
    const h = harness({
      writeArtifact,
    });
    await expect(h.session.reportServerIncident({
      key: "server-no-artifact",
      componentId: "app",
      runCommandId: "dev",
      exitCode: 1,
      crashTimes: [1, 2, 3],
      automaticRestarts: 2,
      ports: [],
      outputBytes: null,
      totalCpu: null,
      totalMemBytes: null,
      logTail: "failure",
    })).resolves.toBe("recorded");
    expect(writeArtifact).toHaveBeenCalledTimes(2);
    expect(h.events[0]).toMatchObject({
      kind: "watchdog-incident",
      metadata: { logArtifactId: "artifact-retry" },
    });
  });

  it("reports when the durable incident exists but its dedicated attempt did not settle", async () => {
    let canSettle = false;
    const h = harness({
      settleAttempt: vi.fn(async () => {
        if (!canSettle) throw new Error("store busy");
        return reservation().attempt;
      }),
    });
    await expect(
      h.session.reportServerIncident({
        key: "server-unsettled",
        componentId: "app",
        runCommandId: "dev",
        exitCode: 1,
        crashTimes: [1, 2, 3],
        automaticRestarts: 2,
        ports: [],
        outputBytes: null,
        totalCpu: null,
        totalMemBytes: null,
        logTail: "failure",
      }),
    ).resolves.toBe("recorded-unsettled");
    expect(h.events).toContainEqual(
      expect.objectContaining({ kind: "watchdog-incident" }),
    );
    expect(h.deps.settleAttempt).toHaveBeenCalledTimes(3);
    canSettle = true;
    await expect(h.session.repairServerIncidentSettlements()).resolves.toBe(true);
    expect(h.deps.settleAttempt).toHaveBeenCalledTimes(4);
  });

  it("keeps checkpoint safety blocked until server recovery", async () => {
    const h = harness();
    await h.session.send("Make the button blue");
    await h.session.reportServerIncident({
      key: "server-blocks-checkpoint",
      componentId: "app",
      runCommandId: "dev",
      exitCode: 1,
      crashTimes: [1, 2, 3],
      automaticRestarts: 2,
      ports: [],
      outputBytes: null,
      totalCpu: null,
      totalMemBytes: null,
      logTail: "failure",
    });
    h.emit({ kind: "turnEnd" });

    await vi.waitFor(() => {
      expect(h.deps.reviewCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ noOpenIncident: false }),
      );
    });
    h.session.resolveServerIncident("server-blocks-checkpoint");
    expect(h.session.state.persona.kind).toBe("incident-recovered");
  });

  it("rechecks incidents after an awaited checkpoint review before committing", async () => {
    let finishReview!: (review: CheckpointReview) => void;
    const review = new Promise<CheckpointReview>((resolve) => {
      finishReview = resolve;
    });
    const h = harness({ reviewCheckpoint: vi.fn(() => review) });
    await h.session.send("Make the button blue");
    h.emit({ kind: "turnEnd" });
    await vi.waitFor(() => expect(h.deps.reviewCheckpoint).toHaveBeenCalled());

    await h.session.reportServerIncident({
      key: "server-during-review",
      componentId: "app",
      runCommandId: "dev",
      exitCode: 1,
      crashTimes: [1, 2, 3],
      automaticRestarts: 2,
      ports: [],
      outputBytes: null,
      totalCpu: null,
      totalMemBytes: null,
      logTail: "failure",
    });
    finishReview(safeReview("verified"));
    await vi.waitFor(() => {
      expect(h.session.state.question?.prompt).toBe("This turn was not auto-saved.");
    });
    expect(h.deps.commit).not.toHaveBeenCalled();
  });

  it("does not re-dedupe an incident that recovered while persistence was in flight", async () => {
    let finishArtifact!: (artifact: Awaited<ReturnType<VibeBuilderSessionDeps["writeArtifact"]>>) => void;
    const artifact = new Promise<
      Awaited<ReturnType<VibeBuilderSessionDeps["writeArtifact"]>>
    >((resolve) => {
      finishArtifact = resolve;
    });
    const h = harness({ writeArtifact: vi.fn(() => artifact) });
    const input = {
      key: "server-recovery-race",
      componentId: "app",
      runCommandId: "dev",
      exitCode: 1,
      crashTimes: [1, 2, 3],
      automaticRestarts: 2,
      ports: [] as number[],
      outputBytes: null,
      totalCpu: null,
      totalMemBytes: null,
      logTail: "failure",
    };
    const first = h.session.reportServerIncident(input);
    await vi.waitFor(() => expect(h.deps.writeArtifact).toHaveBeenCalled());
    h.session.resolveServerIncident(input.key);
    finishArtifact({
      id: "artifact-race",
      runId: "run-1",
      attemptId: "attempt-1",
      kind: "vibe-server-log-tail",
      bytes: 10,
      createdAt: 1,
    });
    await first;
    await h.session.reportServerIncident(input);
    expect(h.deps.reserve).toHaveBeenCalledTimes(2);
  });

  it("persists activity and the completed assistant turn", async () => {
    const h = harness();
    await h.session.send("Make the button blue");
    h.emit({ kind: "delta", text: "Done " });
    h.emit({ kind: "tool", name: "Edit", detail: "src/App.tsx" });
    h.emit({ kind: "delta", text: "carefully." });
    h.emit({ kind: "turnEnd" });

    await vi.waitFor(() => {
      expect(h.transcripts).toContainEqual(
        expect.objectContaining({ kind: "assistant", body: "Done carefully." }),
      );
    });
    expect(h.transcripts).toContainEqual(
      expect.objectContaining({ kind: "activity", body: "Edit: src/App.tsx" }),
    );
    expect(h.events.filter((event) => event.kind === "verification.observation"))
      .toHaveLength(5);
  });

  it("records unknown evidence and offers the diff instead of inventing a pass", async () => {
    const unknown = (kind: VerificationObservation["kind"]) =>
      observation(kind, "unknown");
    const review = safeReview("incomplete");
    review.context.secretScanClean = false;
    const h = harness({
      runCheck: vi.fn(async () => ({ observation: unknown("check"), output: "" })),
      inspectBrowser: vi.fn(async () => ({
        observations: [
          unknown("server"),
          unknown("console"),
          unknown("network"),
          unknown("screenshot"),
        ],
      })),
      reviewCheckpoint: vi.fn(async () => review),
    });
    await h.session.send("Make the button blue");
    h.emit({ kind: "turnEnd" });

    await vi.waitFor(() => {
      expect(h.session.state.question?.prompt).toBe("This turn was not auto-saved.");
    });
    expect(h.session.state.question?.diff).toContain("diff --git");
    expect(h.session.state.question?.actions?.[0]?.response).toBe("Save this version");
    expect(h.events).toContainEqual(
      expect.objectContaining({ kind: "verification.verdict", code: "incomplete" }),
    );
    expect(h.deps.commit).not.toHaveBeenCalled();
  });

  it("auto-commits only when independent verification and checkpoint policy pass", async () => {
    // Armed explicitly: on a machine that has never made a checkpoint the
    // policy passing is not enough, which the test below is about.
    const h = harness({ autoCheckpointObserved: () => true });
    await h.session.send("Make the button blue");
    h.emit({ kind: "turnEnd" });

    await vi.waitFor(() => expect(h.deps.commit).toHaveBeenCalled());
    expect(h.session.state.persona.kind).toBe("checkpoint-saved");
    expect(h.events).toContainEqual(
      expect.objectContaining({ kind: "checkpoint.saved", code: "automatic" }),
    );
    expect(h.deps.settleAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ state: "completed" }),
    );
  });

  it("holds the first automatic checkpoint on a machine that has never made one", async () => {
    const h = harness();
    await h.session.send("Make the button blue");
    h.emit({ kind: "turnEnd" });

    await vi.waitFor(() => expect(h.session.state.question).not.toBeNull());
    // No unattended git write along a path that has never executed here.
    expect(h.deps.commit).not.toHaveBeenCalled();
    expect(h.session.state.question?.prompt).toBe(
      "This is the first version I'd save here.",
    );
    expect(h.session.state.question?.diff).toContain("diff --git");
    // The evidence trail is intact: the decision, the paths, the baseline and
    // an empty reason list, because the policy did not refuse anything.
    const held = h.events.find((event) => event.kind === "checkpoint.held");
    expect(held).toBeDefined();
    expect(held?.code).toBe("auto-checkpoint-never-observed");
    expect(held?.metadata).toMatchObject({
      reasons: [],
      paths: ["src/App.tsx"],
      repoRoot: "/repo",
      baselineHead: "abc",
      secretScan: "unknown",
      context: expect.objectContaining({ verification: "verified" }),
    });
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ kind: "checkpoint.refused" }),
    );
  });

  it("arms automatic checkpointing only once a save has actually committed", async () => {
    const h = harness();
    await h.session.send("Make the button blue");
    h.emit({ kind: "turnEnd" });
    await vi.waitFor(() => expect(h.session.state.question).not.toBeNull());
    expect(h.deps.recordAutoCheckpointObserved).not.toHaveBeenCalled();

    await h.session.send("Save this version");
    expect(h.deps.commit).toHaveBeenCalledTimes(1);
    expect(h.deps.recordAutoCheckpointObserved).toHaveBeenCalledTimes(1);
  });

  it("does not arm the gate when the checkpoint commit fails", async () => {
    const h = harness({
      commit: vi.fn(async () => {
        throw new Error("index.lock exists");
      }),
    });
    await h.session.send("Make the button blue");
    h.emit({ kind: "turnEnd" });
    await vi.waitFor(() => expect(h.session.state.question).not.toBeNull());

    await h.session.send("Save this version");
    expect(h.deps.commit).toHaveBeenCalledTimes(1);
    expect(h.deps.recordAutoCheckpointObserved).not.toHaveBeenCalled();
  });

  it("commits a refused checkpoint only after the explicit save response", async () => {
    const review = safeReview("verified");
    review.context.isolatedOrGreenfield = false;
    const h = harness({ reviewCheckpoint: vi.fn(async () => review) });
    await h.session.send("Make the button blue");
    h.emit({ kind: "turnEnd" });
    await vi.waitFor(() => expect(h.session.state.question).not.toBeNull());
    expect(h.deps.commit).not.toHaveBeenCalled();

    await h.session.send("Save this version");
    expect(h.deps.commit).toHaveBeenCalledTimes(1);
    expect(h.session.state.question).toBeNull();
    expect(h.events).toContainEqual(
      expect.objectContaining({ kind: "checkpoint.saved", code: "explicit" }),
    );
  });

  it("requires a second confirmation when the reviewed diff changes", async () => {
    const first = safeReview("verified");
    first.context.isolatedOrGreenfield = false;
    const changed = { ...first, diff: `${first.diff}\n+ changed later` };
    const review = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(changed)
      .mockResolvedValue(changed);
    const h = harness({ reviewCheckpoint: review });
    await h.session.send("Make the button blue");
    h.emit({ kind: "turnEnd" });
    await vi.waitFor(() => expect(h.session.state.question).not.toBeNull());

    await h.session.send("Save this version");
    expect(h.deps.commit).not.toHaveBeenCalled();
    expect(h.session.state.question?.prompt).toContain("diff changed");
    await h.session.send("Save this version");
    expect(h.deps.commit).toHaveBeenCalledTimes(1);
  });

  it("serializes a second turn behind the first turn's verification", async () => {
    const h = harness();
    await h.session.send("First change");
    const second = h.session.send("Second change");
    await Promise.resolve();
    expect(h.transport.send).toHaveBeenCalledTimes(1);

    h.emit({ kind: "turnEnd" });
    await second;
    expect(h.transport.send).toHaveBeenCalledTimes(2);
    h.emit({ kind: "turnEnd" });
  });

  it("kills a process that finishes spawning after the session was stopped", async () => {
    let release!: () => void;
    const transport = { send: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const start = vi.fn(
      () => new Promise<typeof transport>((resolve) => {
        release = () => resolve(transport);
      }),
    );
    const h = harness({ runner: { start } });
    const sending = h.session.send("Start slowly");
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    const stopping = h.session.stop();
    release();
    await stopping;
    await expect(sending).rejects.toThrow("closed during launch");
    expect(transport.stop).toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("settles a reservation when startAttempt fails", async () => {
    const h = harness({
      startAttempt: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
    });
    await expect(h.session.send("Start")).rejects.toThrow("store unavailable");
    expect(h.deps.settleAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ state: "failed", failureCode: "spawn-failed" }),
    );
  });

  it("kills and settles the running attempt when user transcript persistence fails", async () => {
    const h = harness({
      appendTranscript: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    await expect(h.session.send("Start")).rejects.toThrow("disk full");
    expect(h.transport.stop).toHaveBeenCalled();
    expect(h.deps.settleAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "failed",
        failureClass: "persistence",
        failureCode: "transcript-write-failed",
      }),
    );
  });

  it("flushes partial assistant prose when the process exits", async () => {
    const h = harness();
    await h.session.send("Start");
    h.emit({ kind: "delta", text: "Partly done" });
    h.emit({ kind: "exit" });
    await vi.waitFor(() => {
      expect(h.transcripts).toContainEqual(
        expect.objectContaining({ kind: "assistant", body: "Partly done" }),
      );
    });
  });
});

describe("finding the env file in a monorepo", () => {
  // The component's own .env.local is committed, so git says nothing about it.
  // The repo root's is gitignored, so git reports it as `!!`. Matching by
  // basename finds the root one, reads "ignored, therefore safe", and never
  // reaches the absence rule that would have refused — telling the user their
  // keys stay out of git while writing them into a file git carries.
  const monorepo = (h: ReturnType<typeof harness>) => {
    vi.spyOn(ipc, "gitWorktrees").mockResolvedValue([
      { path: "/repo", head: "abc", is_main: true, branch: "main" },
    ] as never);
    vi.spyOn(ipc, "gitStatus").mockResolvedValue({
      is_repo: true,
      branch: "main",
      entries: [{ status: "!!", path: ".env.local" }],
    } as never);
    vi.spyOn(ipc, "fsReadDir").mockResolvedValue([
      { name: "package.json", path: "/repo/apps/web/package.json", is_dir: false },
      { name: ".env.local", path: "/repo/apps/web/.env.local", is_dir: false },
    ] as never);
    vi.spyOn(ipc, "fsReadFile").mockRejectedValue(new Error("no package.json"));
    return h;
  };

  it("does not let the repo root's ignored file vouch for the component's tracked one", async () => {
    const h = monorepo(
      harness({ abstractionContext: DEFAULT_VIBE_BUILDER_DEPS.abstractionContext }, {
        componentPath: "/repo/apps/web",
      }),
    );
    await h.session.send("connect supabase");
    const q = h.session.state.question;
    const said = `${q?.prompt ?? ""} ${q?.detail ?? ""}`;
    // It must refuse, and it must not claim the file is safely out of git.
    expect(said).not.toMatch(/untracked|stay out of git|out of git/i);
    expect(said).toMatch(/can't link|tracked/i);
  });
});

describe("managed abstractions", () => {
  it("proposes an install instead of running it, and never sends it to the agent", async () => {
    const h = harness();
    await h.session.send("install stripe");
    // The agent must not see this. Its tool policy has no shell, so a forwarded
    // install is a request it cannot carry out — and Canopy would be asking an
    // agent to do the one job it kept for itself.
    expect(h.order).not.toContain("spawn");
    expect(h.abstractionRuns).toHaveLength(0);
    expect(h.session.state.question?.kind).toBe("confirm");
    expect(h.session.state.question?.diff).toContain("stripe");
  });

  it("runs only after the user confirms", async () => {
    const h = harness();
    await h.session.send("install stripe");
    const confirm = h.session.state.question?.actions?.[0];
    expect(confirm).toBeTruthy();
    await h.session.send(confirm!.response);
    expect(h.abstractionRuns).toHaveLength(1);
    expect(h.abstractionRuns[0].argv[0]).toBe("npm");
    // Argv, never one string — the property this whole path exists to keep.
    expect(h.abstractionRuns[0].argv).toContain("stripe");
  });

  it("runs nothing when the user declines", async () => {
    const h = harness();
    await h.session.send("install stripe");
    const decline = h.session.state.question!.actions!.at(-1)!;
    await h.session.send(decline.response);
    expect(h.abstractionRuns).toHaveLength(0);
  });

  /** A project with somewhere to deploy to. Without a provider marker every
   *  deploy request is refused for having nowhere to go, and a test written
   *  against that would pass without reaching the gate it claims to check. */
  const deployable = async (h: ReturnType<typeof harness>) => {
    const base = await h.deps.abstractionContext("/w/app", {
      kind: "deploy",
      target: "preview",
    });
    h.deps.abstractionContext = async (cwd: string) => ({
      ...base,
      cwd,
      entries: [...base.entries, "vercel.json"],
    });
  };

  /** Drive a real turn to a real verdict. Production deploys are gated on what
   *  the session actually observed, so a test that wants that gate open has to
   *  earn it the way the product does rather than set a flag. */
  const verified = async (h: ReturnType<typeof harness>) => {
    await h.session.send("make the button blue");
    h.emit({ kind: "turnEnd" });
    await vi.waitFor(() =>
      expect(h.events).toContainEqual(
        expect.objectContaining({ kind: "verification.verdict", code: "verified" }),
      ),
    );
  };

  it("refuses to publish work this session never verified", async () => {
    const h = harness();
    await deployable(h);
    // Nothing has been verified in this session, so `lastVerification` is
    // "incomplete" — and production must not go out on an unproven build, no
    // matter what the project on disk claims.
    await h.session.send("deploy to production");
    expect(h.session.state.question?.kind).toBe("question");
    expect(h.abstractionRuns).toHaveLength(0);
  });

  it("requires the exact phrase once production is otherwise allowed", async () => {
    const h = harness();
    await deployable(h);
    await verified(h);

    await h.session.send("deploy to production");
    const q = h.session.state.question;
    expect(q?.kind).toBe("confirm");
    // No button carries the confirm sentinel: the phrase must be typed, so a
    // click on a card the user has scrolled past cannot publish anything.
    expect(q?.actions?.some((a) => a.response === "vibe:abstraction:confirm")).toBe(false);

    // A near miss is a miss. This must not run, and it must not run for the
    // reason under test rather than because the proposal was already gone.
    await h.session.send("publish to production");
    expect(h.abstractionRuns).toHaveLength(0);
  });

  it("publishes on the exact phrase", async () => {
    const h = harness();
    await deployable(h);
    await verified(h);
    await h.session.send("deploy to production");
    await h.session.send("Publish to production");
    expect(h.abstractionRuns).toHaveLength(1);
    expect(h.abstractionRuns[0].argv[0]).toBe("vercel");
  });

  it("carries on with a build request typed instead of an answer", async () => {
    const h = harness();
    await h.session.send("install stripe");
    expect(h.session.state.question?.kind).toBe("confirm");
    // Changing your mind mid-question is normal. The install must not run, and
    // the thing actually asked for must not be swallowed by the card.
    await h.session.send("add a login button");
    expect(h.abstractionRuns).toHaveLength(0);
    expect(h.order).toContain("spawn");
  });

  it("offers a preview without a typed phrase, and runs it on confirm", async () => {
    const h = harness();
    await deployable(h);
    await h.session.send("deploy this");
    const q = h.session.state.question;
    expect(q?.kind).toBe("confirm");
    const confirm = q!.actions![0];
    await h.session.send(confirm.response);
    expect(h.abstractionRuns).toHaveLength(1);
    expect(h.abstractionRuns[0].argv[0]).toBe("vercel");
  });

  it("leaves an ordinary build request alone", async () => {
    const h = harness();
    await h.session.send("add a login button");
    expect(h.order).toContain("spawn");
    expect(h.abstractionRuns).toHaveLength(0);
  });
});

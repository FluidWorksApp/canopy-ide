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

function harness(over: Partial<VibeBuilderSessionDeps> = {}) {
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
  const deps: VibeBuilderSessionDeps = {
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
    },
    deps,
  );
  return {
    session,
    deps,
    order,
    transcripts,
    events,
    transport,
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

    // A fresh attempt takes over before the retry lands.
    h.emit({ kind: "exit" });
    await h.session.send("Try again");
    expect(h.deps.startAttempt).toHaveBeenCalledWith("attempt-2");

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
    const h = harness();
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

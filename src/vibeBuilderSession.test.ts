import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRunnerController } from "./projectRunner";
import type { StructuredRunnerHost } from "./structuredEvents";
import type { TaskReservation } from "./taskEnvelope";
import {
  createVibeBuilderSession,
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
    beginBrowserTurn: vi.fn(async () => {}),
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
    now: () => 10,
    sessionId: () => "session-1",
    ...over,
  };
  const session = createVibeBuilderSession(
    {
      projectId: "project-1",
      projectName: "Shop",
      componentId: "app",
      componentPath: "/repo",
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
  it("filters ignored and sibling-package changes out of the component checkpoint", () => {
    expect(
      scopedGitEntries(
        [
          { status: "!!", path: "node_modules/" },
          { status: " M", path: "packages/web/src/App.tsx" },
          { status: " M", path: "packages/api/src/index.ts" },
        ],
        "/repo",
        "/repo/packages/web",
      ),
    ).toEqual([{ status: " M", path: "packages/web/src/App.tsx" }]);
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

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ledger", async () => (await import("./test/fakeLedger")).fakeLedger);
vi.mock("./ipc", () => ({}));

import { fakeLedger } from "./test/fakeLedger";
import type { AgentTurnEnd } from "./agentTurns";
import {
  lensSteps,
  lensStepsVersion,
  matchStepSummary,
  parseStepKey,
  recordStep,
  resetLensStepsForTests,
  rootFor,
  stepSummariesFor,
  subscribeLensSteps,
  type LensStepsDeps,
} from "./lensSteps";
import { resetLensCheckpointsForTests } from "./lensCheckpoints";
import { turnSnapshotRange } from "./turnSnapshots";

const turn = (over: Partial<AgentTurnEnd> = {}): AgentTurnEnd => ({
  turnId: "s1:1000",
  ptyId: 4,
  sessionId: "s1",
  cli: "claude",
  cwd: "/proj/web",
  root: "/proj",
  prompt: "Add a sign-up page",
  startedAt: 1000,
  endedAt: 5000,
  filesTouched: ["src/signup.tsx"],
  ...over,
});

const SUMMARY = { title: "Added sign-up", whatChanged: "There is a sign-up page.", layer: "view" as const, risk: "low" as const };

function deps(over: Partial<LensStepsDeps> = {}): LensStepsDeps {
  return {
    summarize: vi.fn(async () => SUMMARY),
    range: vi.fn(async () => ({ from: "aaa", to: "bbb", shared: false })),
    files: vi.fn(async () => ["scripts/gen.sh", "src/signup.tsx"]),
    autoSummaries: () => true,
    ...over,
  };
}

beforeEach(() => {
  fakeLedger.reset();
  resetLensStepsForTests();
  resetLensCheckpointsForTests();
});

describe("steps collected app-wide", () => {
  it("files a turn under its project, with Bash-made files from the snapshots, and summarises it", async () => {
    const d = deps();
    let heard = 0;
    subscribeLensSteps(() => heard++);
    const step = await recordStep(turn(), [{ root: "/proj", builder: true }], d);
    expect(step?.files).toEqual(["src/signup.tsx", "scripts/gen.sh"]);
    expect(step?.range).toEqual({ from: "aaa", to: "bbb", shared: false });
    expect(lensSteps("/proj")).toHaveLength(1);
    await vi.waitFor(() => expect(d.summarize).toHaveBeenCalledWith("/proj", expect.objectContaining({ key: "turn:s1:1000" })));
    await vi.waitFor(() => expect(heard).toBe(2));
    expect(lensStepsVersion()).toBe(2);
  });

  it("doesn't summarise outside the builder lens or with summaries off", async () => {
    const d = deps();
    await recordStep(turn(), [{ root: "/proj", builder: false }], d);
    await recordStep(turn({ turnId: "s1:2000" }), [{ root: "/proj", builder: true }], deps({ autoSummaries: () => false, summarize: d.summarize }));
    expect(d.summarize).not.toHaveBeenCalled();
    expect(lensSteps("/proj")).toHaveLength(2);
  });

  it("in a shared checkout keeps to the journal's files", async () => {
    const d = deps({ range: vi.fn(async () => ({ from: "a", to: "b", shared: true })) });
    const step = await recordStep(turn(), [{ root: "/proj", builder: true }], d);
    expect(d.files).not.toHaveBeenCalled();
    expect(step?.files).toEqual(["src/signup.tsx"]);
  });

  it("ignores turns outside every project, and picks the deepest project", async () => {
    expect(await recordStep(turn({ cwd: "/elsewhere" }), [{ root: "/proj", builder: true }], deps())).toBeNull();
    expect(rootFor("/proj/web/src", [{ root: "/proj", builder: false }, { root: "/proj/web", builder: true }])?.root).toBe("/proj/web");
    expect(rootFor("/project", [{ root: "/proj", builder: false }])).toBeNull();
  });
});

describe("summaries for the engineer lens's turn list", () => {
  it("reads them back from the ledger by session and matches a turn by its start", async () => {
    await fakeLedger.appendLedger("/proj", { kind: "memory", ref: { kind: "lens-checkpoint", id: "turn:s1:1000" }, data: SUMMARY });
    await fakeLedger.appendLedger("/proj", { kind: "memory", ref: { kind: "lens-checkpoint", id: "turn:s2:1000" }, data: { ...SUMMARY, title: "Other" } });
    const got = await stepSummariesFor("/proj", "s1");
    expect(got).toEqual([{ startedAt: 1000, summary: SUMMARY }]);
    // The snapshot's stamp sits a little before the observed start.
    expect(matchStepSummary(got, 1000 - 4000)?.title).toBe("Added sign-up");
    expect(matchStepSummary(got, 1000 + 60_000)).toBeNull();
    expect(matchStepSummary(got, null)).toBeNull();
  });

  it("parses step keys", () => {
    expect(parseStepKey("turn:abc-1:1700000000000")).toEqual({ sessionId: "abc-1", startedAt: 1700000000000 });
    expect(parseStepKey("commit:abc")).toBeNull();
  });
});

describe("turn snapshots", () => {
  const list = (end: boolean) => ({
    git: true,
    root: "/proj",
    shared: false,
    peers: [],
    restores: [],
    turns: [
      { n: 1, start: { ref: "r1", commit: "c-start-old", tree: "t", ts_ms: 100 }, end: null, prompt: null, late: false, native_uuid: null },
      { n: 2, start: { ref: "r2", commit: "c-start", tree: "t", ts_ms: 990 }, end: end ? { ref: "r3", commit: "c-end", tree: "t", ts_ms: 5000 } : null, prompt: null, late: false, native_uuid: null },
    ],
  });

  it("finds the pair closest to the turn's start", async () => {
    const r = await turnSnapshotRange("/proj", "s1", 1000, 5000, { turnList: async () => list(true) as never });
    expect(r).toEqual({ from: "c-start", to: "c-end", shared: false });
  });

  it("waits once for a late end snapshot", async () => {
    let calls = 0;
    const r = await turnSnapshotRange("/proj", "s1", 1000, 5000, {
      turnList: async () => list(++calls > 1) as never,
      sleep: async () => {},
    });
    expect(r).toEqual({ from: "c-start", to: "c-end", shared: false });
    expect(calls).toBe(2);
  });

  it("is null without git", async () => {
    expect(await turnSnapshotRange("/proj", "s1", 1, 2, { turnList: async () => ({ ...list(true), git: false }) as never })).toBeNull();
  });
});

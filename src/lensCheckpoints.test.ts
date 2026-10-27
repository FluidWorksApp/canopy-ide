import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ledger", async () => (await import("./test/fakeLedger")).fakeLedger);
vi.mock("./ipc", () => ({
  gitCommitPatch: vi.fn(async () => ({ patch: "diff --git a/src/App.tsx b/src/App.tsx\n+<button>Buy</button>" })),
  gitDiff: vi.fn(async () => ""),
}));

import {
  checkpointSummaryPrompt,
  checkpointTitle,
  checkpointsFromLog,
  filesInPatch,
  peekCheckpointSummary,
  resetLensCheckpointsForTests,
  summarizeCheckpoint,
  validateCheckpointSummary,
  type LensCheckpoint,
} from "./lensCheckpoints";
import type { askBrain } from "./brainCall";
import { fakeLedger as fake } from "./test/fakeLedger";

const GOOD = { title: "Added a Buy button", whatChanged: "The shop page now has a `Buy` button.", layer: "view", risk: "low" };

const okAnswer = (value: unknown) => ({
  ok: true as const, text: JSON.stringify(value), value, costUsd: 0.001,
  inputTokens: 1, outputTokens: 1, durationMs: 5, model: null,
});

function brainReturning(value: unknown) {
  return vi.fn(async (req: { validate?: (v: unknown) => unknown }) => {
    const validated = req.validate ? req.validate(value) : value;
    return validated == null
      ? { ok: false as const, reason: "invalid-output" as const, message: "bad" }
      : okAnswer(validated);
  }) as unknown as typeof askBrain & ReturnType<typeof vi.fn>;
}

const cp: LensCheckpoint = { key: "commit:abc", kind: "checkpoint", sha: "abc", goal: "add a buy button", at: 1, files: [] };

beforeEach(() => {
  fake.reset();
  resetLensCheckpointsForTests();
  vi.clearAllMocks();
});

describe("checkpoint summary prompt", () => {
  it("asks for plain language, one layer and risk, and carries the goal and change", () => {
    const prompt = checkpointSummaryPrompt({ goal: "add a buy button", files: ["src/App.tsx"] }, "+<button>");
    expect(prompt).toContain("not an engineer");
    expect(prompt).toContain("no jargon");
    expect(prompt).toContain("add a buy button");
    expect(prompt).toContain("+<button>");
    expect(prompt).toMatch(/data\|logic\|view\|auth\|deploy\|integration/);
    expect(prompt).toMatch(/low\|medium\|high/);
  });

  it("shortens a huge change instead of sending it whole", () => {
    const prompt = checkpointSummaryPrompt({ goal: "x", files: [] }, "y".repeat(50_000));
    expect(prompt.length).toBeLessThan(14_000);
    expect(prompt).toContain("diff shortened");
  });
});

describe("checkpoint summary validation", () => {
  it("accepts a complete answer and strips code formatting", () => {
    expect(validateCheckpointSummary(GOOD)).toEqual({
      title: "Added a Buy button",
      whatChanged: "The shop page now has a Buy button.",
      layer: "view",
      risk: "low",
    });
  });

  it.each([
    [{ ...GOOD, layer: "frontend" }],
    [{ ...GOOD, risk: "critical" }],
    [{ ...GOOD, title: "" }],
    [{ ...GOOD, whatChanged: 3 }],
    [null],
    ["text"],
  ])("rejects %j", (v) => {
    expect(validateCheckpointSummary(v)).toBeNull();
  });

  it("normalises case and caps length", () => {
    const v = validateCheckpointSummary({ ...GOOD, layer: "DATA", risk: "High", title: "t".repeat(200) });
    expect(v?.layer).toBe("data");
    expect(v?.risk).toBe("high");
    expect(v?.title.length).toBe(80);
  });
});

describe("summarizeCheckpoint", () => {
  it("asks the brain on the background tier with the lens tag, then caches in memory and the ledger", async () => {
    const ask = brainReturning(GOOD);
    const s = await summarizeCheckpoint("/repo", cp, { ask });
    expect(s?.title).toBe("Added a Buy button");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatchObject({ feature: "lens", tier: "background", json: true, cwd: "/repo" });
    expect(ask.mock.calls[0][0].prompt).toContain("<button>Buy</button>");
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]).toMatchObject({ kind: "memory", ref: { kind: "lens-checkpoint", id: "commit:abc" } });

    // Second time: memory, no brain.
    await summarizeCheckpoint("/repo", cp, { ask });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(peekCheckpointSummary("/repo", "commit:abc")?.title).toBe("Added a Buy button");
  });

  it("reads a summary saved in an earlier run from the ledger instead of paying again", async () => {
    await fake.appendLedger("/repo", { kind: "memory", ref: { kind: "lens-checkpoint", id: "commit:abc" }, data: GOOD });
    const ask = brainReturning(GOOD);
    const s = await summarizeCheckpoint("/repo", cp, { ask });
    expect(s?.whatChanged).toContain("Buy button");
    expect(ask).not.toHaveBeenCalled();
  });

  it("shares one brain call between concurrent requests", async () => {
    const ask = brainReturning(GOOD);
    await Promise.all([summarizeCheckpoint("/repo", cp, { ask }), summarizeCheckpoint("/repo", cp, { ask })]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("returns null quietly when the brain is unavailable or answers junk, and caches nothing", async () => {
    const none = vi.fn(async () => ({ ok: false, reason: "no-brain", message: "no brain" })) as never;
    expect(await summarizeCheckpoint("/repo", cp, { ask: none })).toBeNull();
    expect(await summarizeCheckpoint("/repo", cp, { ask: brainReturning({ title: "x" }) })).toBeNull();
    expect(fake.rows).toHaveLength(0);
    expect(peekCheckpointSummary("/repo", cp.key)).toBeNull();
  });

  it("titles fall back to the request when there is no summary", () => {
    expect(checkpointTitle(cp, null)).toBe("add a buy button");
    expect(checkpointTitle({ ...cp, goal: "" }, null)).toBe("Saved version");
    expect(checkpointTitle(cp, validateCheckpointSummary(GOOD))).toBe("Added a Buy button");
  });
});

describe("saved versions from git", () => {
  it("lists only Build's checkpoint commits, newest first as git gives them", () => {
    const log = [
      { hash: "h3", short: "h3", author: "a", date: "2026-10-27T10:00:00Z", subject: "vibe: make the header blue", refs: "" },
      { hash: "h2", short: "h2", author: "a", date: "2026-10-27T09:00:00Z", subject: "fix typo", refs: "" },
      { hash: "h1", short: "h1", author: "a", date: "2026-10-27T08:00:00Z", subject: "vibe: add login", refs: "" },
    ];
    const cps = checkpointsFromLog(log);
    expect(cps.map((c) => c.sha)).toEqual(["h3", "h1"]);
    expect(cps[0]).toMatchObject({ key: "commit:h3", kind: "checkpoint", goal: "make the header blue" });
  });

  it("reads touched files from a patch", () => {
    expect(filesInPatch("diff --git a/x.ts b/x.ts\n+1\ndiff --git a/auth/login.ts b/auth/login.ts\n")).toEqual(["x.ts", "auth/login.ts"]);
  });
});

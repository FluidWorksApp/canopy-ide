import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildInsightPrompt,
  insightFacts,
  loadInsight,
  readCachedInsight,
  validateInsight,
  INSIGHT_MAX_AGE_MS,
  type InsightInput,
} from "./insight";
import type { MetricRow } from "./metrics";

const row = (key: string, over: Partial<MetricRow> = {}): MetricRow => ({
  key,
  sessions: 14,
  costUsd: 7,
  merged: 14,
  costPerMerged: 0.5,
  receipts: { proven: 14, partial: 0, unproven: 0, contradicted: 0, total: 14 },
  passRate: 1,
  reverted: 0,
  reworked: 0,
  revertRate: 0,
  reworkRate: 0,
  medianReviewHours: 3,
  ...over,
});

const input = (over: Partial<InsightInput> = {}): InsightInput => ({
  days: 30,
  total: row("all"),
  byClass: [row("deps"), row("ui", { reworked: 4, reworkRate: 0.4 })],
  byCli: [row("cli-a")],
  byWeek: [row("2026-10-19")],
  brainByFeature: { review: { calls: 3, failures: 0, costUsd: 0.3, inputTokens: 0, outputTokens: 0 } },
  ...over,
});

const good = {
  headline: "Dependency bumps are reliable; UI work is often redone",
  wins: ["Dependency bumps: 14 proven, 0 reverted — consider auto-merge"],
  concerns: ["UI features: 40% reworked within a week"],
  suggestions: ["Require plans for UI features"],
};

const ok = (value: unknown) =>
  ({ ok: true, text: JSON.stringify(value), value, costUsd: 0.01, inputTokens: 1, outputTokens: 1, durationMs: 1, model: null }) as const;

beforeEach(() => localStorage.clear());

describe("insight prompt", () => {
  it("carries the aggregated numbers and asks for the JSON shape", () => {
    const facts = insightFacts(input());
    expect(facts).toContain("deps: 14 sessions");
    expect(facts).toContain("4 reworked within a week (40%)");
    expect(facts).toContain("review: 3 calls, $0.30");
    const prompt = buildInsightPrompt(facts);
    expect(prompt).toContain('"headline"');
    expect(prompt).toContain("auto-merge");
    expect(prompt).toContain("require plans");
  });

  it("is deterministic, so it can key the cache", () => {
    expect(insightFacts(input())).toBe(insightFacts(input()));
  });
});

describe("validateInsight", () => {
  it("accepts the panel's shape and trims", () => {
    expect(validateInsight({ ...good, wins: ["  a  ", 3, ""] })).toEqual({ ...good, wins: ["a"] });
    expect(validateInsight({ headline: "h" })).toEqual({ headline: "h", wins: [], concerns: [], suggestions: [] });
  });

  it("rejects anything else", () => {
    expect(validateInsight(null)).toBeNull();
    expect(validateInsight({ wins: [] })).toBeNull();
    expect(validateInsight({ headline: "h", wins: "x" })).toBeNull();
    expect(validateInsight([good])).toBeNull();
  });

  it("caps list length", () => {
    const v = validateInsight({ headline: "h", wins: ["1", "2", "3", "4", "5", "6"] });
    expect(v?.wins).toHaveLength(4);
  });
});

describe("loadInsight", () => {
  it("asks the brain on the background tier with the outcomes feature, then caches", async () => {
    const ask = vi.fn(async () => ok(good));
    const first = await loadInsight("/repo", input(), { ask: ask as never, now: 1000 });
    expect(first).toMatchObject({ state: "fresh", insight: good });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "outcomes", tier: "background", json: true, cwd: "/repo" }),
    );
    const req = (ask.mock.calls[0] as unknown[])[0] as { prompt: string; validate: (v: unknown) => unknown };
    expect(req.validate(good)).toEqual(good);
    expect(req.validate({})).toBeNull();
    expect(readCachedInsight("/repo")?.insight).toEqual(good);

    // Within a day: cached, no call.
    const again = await loadInsight("/repo", input({ days: 7 }), { ask: ask as never, now: 2000 });
    expect(again.state).toBe("cached");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("re-asks after a day when the numbers moved, or on demand", async () => {
    const ask = vi.fn(async () => ok(good));
    await loadInsight("/repo", input(), { ask: ask as never, now: 0 });
    // A day later, same numbers: still cached.
    await loadInsight("/repo", input(), { ask: ask as never, now: INSIGHT_MAX_AGE_MS + 1 });
    expect(ask).toHaveBeenCalledTimes(1);
    await loadInsight("/repo", input({ days: 7 }), { ask: ask as never, now: INSIGHT_MAX_AGE_MS + 1 });
    expect(ask).toHaveBeenCalledTimes(2);
    await loadInsight("/repo", input({ days: 7 }), { ask: ask as never, now: INSIGHT_MAX_AGE_MS + 2, force: true });
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("skips with no data and reports failures with the last good answer", async () => {
    const ask = vi.fn();
    const empty = row("all", { sessions: 0, receipts: { proven: 0, partial: 0, unproven: 0, contradicted: 0, total: 0 } });
    const skipped = await loadInsight("/repo", input({ total: empty }), { ask: ask as never });
    expect(skipped.state).toBe("skipped");
    expect(ask).not.toHaveBeenCalled();

    await loadInsight("/repo", input(), { ask: (async () => ok(good)) as never, now: 0 });
    const failed = await loadInsight("/repo", input(), {
      ask: (async () => ({ ok: false, reason: "no-brain", message: "none" })) as never,
      force: true,
    });
    expect(failed).toMatchObject({ state: "failed", reason: "no-brain" });
    if (failed.state === "failed") expect(failed.cached?.insight).toEqual(good);
  });
});

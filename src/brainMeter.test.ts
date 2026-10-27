import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRAIN_METER_EVENT,
  brainSpend,
  brainSpendByFeature,
  overBudget,
  recordBrainCall,
  resetBrainMeterForTests,
  startOfToday,
  subscribeBrainMeter,
} from "./brainMeter";
import { getSettings, updateSettings } from "./settings";

const call = (feature: string, ts: number, costUsd: number | null, ok = true) => ({
  feature,
  ts,
  costUsd,
  inputTokens: 10,
  outputTokens: 2,
  ok,
  ...(ok ? {} : { reason: "failed" }),
});

beforeEach(() => {
  localStorage.clear();
  resetBrainMeterForTests();
});

describe("brain meter", () => {
  it("totals spend per feature and window", () => {
    const now = Date.now();
    recordBrainCall(call("receipt", now - 1000, 0.5), now);
    recordBrainCall(call("receipt", now - 500, null, false), now);
    recordBrainCall(call("review", now - 100, 0.25), now);
    expect(brainSpend()).toEqual({ calls: 3, failures: 1, costUsd: 0.75, inputTokens: 30, outputTokens: 6 });
    expect(brainSpend({ feature: "receipt" })).toMatchObject({ calls: 2, costUsd: 0.5 });
    expect(brainSpend({ sinceMs: now - 600 })).toMatchObject({ calls: 2 });
    expect(Object.keys(brainSpendByFeature()).sort()).toEqual(["receipt", "review"]);
    expect(brainSpendByFeature(now - 200)).toEqual({
      review: { calls: 1, failures: 0, costUsd: 0.25, inputTokens: 10, outputTokens: 2 },
    });
  });

  it("persists to storage and drops records past 30 days", () => {
    const now = Date.now();
    recordBrainCall(call("memory", now - 31 * 24 * 3600 * 1000, 9), now - 31 * 24 * 3600 * 1000);
    recordBrainCall(call("memory", now, 1), now);
    expect(JSON.parse(localStorage.getItem("canopy.brainMeter")!)).toHaveLength(1);
    expect(brainSpend({ feature: "memory" }).costUsd).toBe(1);
  });

  it("caps the record count", () => {
    const now = Date.now();
    const many = Array.from({ length: 5000 }, (_, i) => call("lens", now - i, 0));
    localStorage.setItem("canopy.brainMeter", JSON.stringify(many));
    recordBrainCall(call("lens", now, 0), now);
    expect(JSON.parse(localStorage.getItem("canopy.brainMeter")!)).toHaveLength(5000);
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("canopy.brainMeter", "{nope");
    expect(brainSpend().calls).toBe(0);
    localStorage.setItem("canopy.brainMeter", JSON.stringify([{ bogus: 1 }, call("x", 1, 1)]));
    expect(brainSpend().calls).toBe(1);
  });

  it("gates on the daily total and per-feature caps, counting only today", () => {
    const now = new Date(2026, 9, 27, 15).getTime();
    const yesterday = startOfToday(now) - 1000;
    updateSettings({ brainDailyBudgetUsd: 1, brainFeatureBudgetsUsd: { review: 0.3 } });
    recordBrainCall(call("receipt", yesterday, 5), now);
    expect(overBudget("receipt", now)).toBe(false);
    recordBrainCall(call("review", now - 10, 0.3), now);
    expect(overBudget("review", now)).toBe(true);
    expect(overBudget("receipt", now)).toBe(false);
    recordBrainCall(call("receipt", now - 5, 0.7), now);
    expect(overBudget("receipt", now)).toBe(true);
    // The connection probe is never gated.
    expect(overBudget("connect-probe", now)).toBe(false);
  });

  it("normalizes budget settings so bad values mean no cap", () => {
    localStorage.setItem(
      "canopy.settings",
      JSON.stringify({ brainDailyBudgetUsd: -1, brainFeatureBudgetsUsd: { a: 1, b: "x", c: -2 } }),
    );
    expect(getSettings().brainDailyBudgetUsd).toBeNull();
    expect(getSettings().brainFeatureBudgetsUsd).toEqual({ a: 1 });
    expect(getSettings().brainModel).toBe("");
  });

  it("notifies subscribers on every record", () => {
    const cb = vi.fn();
    const off = subscribeBrainMeter(cb);
    recordBrainCall(call("plan", Date.now(), 0));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    window.dispatchEvent(new Event(BRAIN_METER_EVENT));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("brain spend per project", () => {
  it("records the call's directory and project, and totals by both", async () => {
    const m = await import("./brainMeter");
    m.resetBrainMeterForTests();
    m.setBrainProjectResolver((cwd) => (cwd.startsWith("/shop") ? { id: "p1", name: "Shop" } : null));
    m.recordBrainCall({ feature: "receipts", ts: 10, costUsd: 0.2, inputTokens: 1, outputTokens: 1, ok: true, cwd: "/shop/web" }, 10);
    m.recordBrainCall({ feature: "lens", ts: 11, costUsd: 0.1, inputTokens: 1, outputTokens: 1, ok: true, cwd: "/shop-wt-fix" }, 11);
    m.recordBrainCall({ feature: "lens", ts: 12, costUsd: 0.05, inputTokens: 1, outputTokens: 1, ok: true, cwd: "/blog" }, 12);
    m.recordBrainCall({ feature: "commit-message", ts: 13, costUsd: 0.01, inputTokens: 1, outputTokens: 1, ok: true }, 13);
    m.setBrainProjectResolver(null);
    const by = m.brainSpendByProject(0);
    expect(by.map((r) => [r.name, r.calls])).toEqual([
      ["Shop", 2],
      ["blog", 1],
      ["Not about a project", 1],
    ]);
    expect(by[0].costUsd).toBeCloseTo(0.3);
    // The Outcomes panel's view: calls made in this repository (and its Canopy worktrees).
    const here = m.brainSpendByFeatureUnder("/shop", 0);
    expect(Object.keys(here).sort()).toEqual(["lens", "receipts"]);
    expect(m.callUnder("/shopping", "/shop")).toBe(false);
  });
});

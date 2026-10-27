import { beforeEach, describe, expect, it, vi } from "vitest";

const askBrain = vi.fn();
vi.mock("../brainCall", () => ({ askBrain: (...a: unknown[]) => askBrain(...a) }));

import {
  FILE_PATCH_MAX,
  TOTAL_PATCH_MAX,
  buildReviewPrompt,
  cachedReview,
  contentHash,
  reviewCacheKey,
  riskOrder,
  sliceStatus,
  splitDiff,
  splitRequest,
  summarizeChange,
  validateReview,
} from "./intentReview";
import type { PlanData } from "../plans/plan";

const filePatch = (path: string, adds: number, dels = 0) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    ...Array.from({ length: dels }, (_, i) => `-old ${i}`),
    ...Array.from({ length: adds }, (_, i) => `+new ${i}`),
  ].join("\n");

const plan: PlanData = {
  planId: "pl-r-1",
  goal: "Paginate orders",
  decisions: [{ question: "Pages or scroll?", options: ["Pages", "Scroll"], recommended: "Pages", why: "", answer: "Scroll" }],
  touches: ["src/orders.ts"],
  acceptance: ["npm test passes"],
  wontDo: ["Change the API"],
  risk: "medium",
  size: "small",
  taskClass: "feature",
  request: "r",
  dir: "/repo",
  source: "task",
  gate: "approval",
  gateWhy: [],
};

const good = {
  summary: "Adds infinite scroll to the orders list, as planned.",
  deviations: [{ what: "Also renamed a helper", where: "src/util.ts", severity: "low" }],
  unplanned: ["src/util.ts"],
  missing: [],
  risk: [
    { file: "src/orders.ts", level: "medium", why: "behaviour change" },
    { file: "src/util.ts", level: "low", why: "rename" },
  ],
};

beforeEach(() => {
  askBrain.mockReset();
  localStorage.clear();
});

describe("review prompt", () => {
  it("states the plan, the receipt and every changed file", () => {
    const files = splitDiff([filePatch("src/orders.ts", 3, 1), filePatch("src/util.ts", 1)].join("\n"));
    expect(files.map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ["src/orders.ts", 3, 1],
      ["src/util.ts", 1, 0],
    ]);
    const p = buildReviewPrompt(plan, files, "verdict proven");
    expect(p).toContain("Goal: Paginate orders");
    expect(p).toContain("Pages or scroll? → Scroll");
    expect(p).toContain("- npm test passes");
    expect(p).toContain("PROOF RECEIPT: verdict proven");
    expect(p).toContain("- src/orders.ts (+3 -1)");
    expect(p).toContain('"deviations"');
    expect(p).toContain('"sliceSuggestion"');
  });

  it("says when there is no plan", () => {
    expect(buildReviewPrompt(null, [])).toMatch(/PLAN: none was recorded/);
  });

  it("caps each file and the total, naming what it left out", () => {
    const big = Array.from({ length: 30 }, (_, i) => filePatch(`src/f${i}.ts`, 400)).join("\n");
    const p = buildReviewPrompt(plan, splitDiff(big));
    expect(p).toContain("more characters of this file not shown");
    expect(p).toContain("Patches not shown (over the size cap");
    expect(p.length).toBeLessThan(TOTAL_PATCH_MAX + 30 * 200 + 5000);
    expect(FILE_PATCH_MAX).toBeLessThan(TOTAL_PATCH_MAX);
  });
});

describe("validateReview", () => {
  it("accepts a good reply and normalises levels", () => {
    const v = validateReview({ ...good, risk: [{ file: "a", level: "critical", why: "" }] })!;
    expect(v.summary).toMatch(/infinite scroll/);
    expect(v.deviations[0].severity).toBe("low");
    expect(v.risk[0].level).toBe("medium");
    expect(v.sliceSuggestion).toBeUndefined();
  });
  it("rejects replies with no summary", () => {
    expect(validateReview({ deviations: [] })).toBeNull();
    expect(validateReview("text")).toBeNull();
  });
});

describe("summarizeChange", () => {
  it("asks the main-tier review brain once per plan + diff and caches the answer", async () => {
    askBrain.mockResolvedValue({ ok: true, text: "", value: validateReview(good), costUsd: 0.01, inputTokens: 1, outputTokens: 1 });
    const patch = filePatch("src/orders.ts", 2);
    const first = await summarizeChange({ cwd: "/repo", plan, patch });
    expect(first.ok && first.value?.summary).toMatch(/as planned/);
    expect(askBrain).toHaveBeenCalledTimes(1);
    expect(askBrain.mock.calls[0][0]).toMatchObject({ feature: "review", tier: "main", json: true, cwd: "/repo" });
    const second = await summarizeChange({ cwd: "/repo", plan, patch });
    expect(askBrain).toHaveBeenCalledTimes(1);
    expect(second.ok && second.cached).toBe(true);
    expect(cachedReview(reviewCacheKey(plan, patch))?.summary).toMatch(/as planned/);
    // A different diff is a different question.
    await summarizeChange({ cwd: "/repo", plan, patch: `${patch}\n+more` });
    expect(askBrain).toHaveBeenCalledTimes(2);
  });

  it("shares one call between two surfaces asking at once, and caches nothing on failure", async () => {
    let release!: (v: unknown) => void;
    askBrain.mockReturnValue(new Promise((r) => (release = r)));
    const patch = filePatch("x.ts", 1);
    const a = summarizeChange({ cwd: "/repo", plan: null, patch });
    const b = summarizeChange({ cwd: "/repo", plan: null, patch });
    release({ ok: false, reason: "no-brain", message: "" });
    expect((await a).ok).toBe(false);
    expect((await b).ok).toBe(false);
    expect(askBrain).toHaveBeenCalledTimes(1);
    expect(cachedReview(reviewCacheKey(null, patch))).toBeNull();
  });

  it("hashes content stably", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });
});

describe("risk order", () => {
  it("puts auth/data/migrations/money first as forced high, then the brain's ranking, then unrated", () => {
    const files = splitDiff(
      [
        filePatch("src/util.ts", 1),
        filePatch("README.md", 50),
        filePatch("src/orders.ts", 5),
        filePatch("db/migrations/0004_orders.sql", 2),
        filePatch("src/auth/session.ts", 1),
      ].join("\n"),
    );
    const brain = [
      { file: "src/orders.ts", level: "medium" as const, why: "behaviour" },
      { file: "src/util.ts", level: "low" as const, why: "rename" },
      // The brain calls the migration low; the path floor wins.
      { file: "db/migrations/0004_orders.sql", level: "low" as const, why: "adds a column" },
    ];
    const rows = riskOrder(files, brain);
    expect(rows.map((r) => r.path)).toEqual([
      "db/migrations/0004_orders.sql",
      "src/auth/session.ts",
      "src/orders.ts",
      "src/util.ts",
      "README.md",
    ]);
    expect(rows[0]).toMatchObject({ level: "high", forced: true });
    expect(rows[0].why).toMatch(/migration — always read every line\. adds a column/);
    expect(rows[1].why).toMatch(/^auth/);
    expect(rows[4]).toMatchObject({ forced: false, why: "" });
  });

  it("still ranks forced-high files with no brain at all", () => {
    const rows = riskOrder(splitDiff([filePatch("a.ts", 9), filePatch("src/billing/charge.ts", 1)].join("\n")));
    expect(rows[0]).toMatchObject({ path: "src/billing/charge.ts", forced: true });
  });
});

describe("slice budget", () => {
  it("flags a change over budget and words the split request", () => {
    const files = splitDiff(filePatch("a.ts", 300, 200));
    const s = sliceStatus(files, 400);
    expect(s).toEqual({ lines: 500, budget: 400, over: true });
    expect(sliceStatus(files, 600).over).toBe(false);
    const text = splitRequest(s, "First the refactor, then the UI.");
    expect(text).toContain("500 changed lines");
    expect(text).toContain("under 400 lines");
    expect(text).toContain("Suggested split: First the refactor, then the UI.");
    expect(text).not.toContain("\n");
    expect(splitRequest(s, undefined)).toMatch(/Split it by concern/);
  });
});

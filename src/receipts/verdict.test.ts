import { describe, expect, it } from "vitest";
import { DIFF_SUMMARY_MAX, brainNote, buildVerdictPrompt, readAcceptance, validateVerdict, validateVerdictFor } from "./verdict";
import type { CheckResult } from "./types";

const failing: CheckResult = {
  id: "npm:test",
  label: "Tests",
  kind: "test",
  command: "npm run test",
  exitCode: 1,
  outcome: "failed",
  counts: { passed: 11, failed: 1, skipped: 0, total: 12, unit: "tests" },
  durationMs: 4200,
  outputTail: "x".repeat(5000) + "\nTests  1 failed | 11 passed (12)",
  failures: ["sums > adds"],
};

describe("buildVerdictPrompt", () => {
  const prompt = buildVerdictPrompt({
    asked: "Fix the sum bug",
    claim: "Fixed it, all tests pass.",
    diffSummary: "d".repeat(DIFF_SUMMARY_MAX + 500),
    filesTouched: ["src/sum.ts"],
    checks: [failing],
    tamper: [{ path: "src/sum.test.ts", severity: "review", reason: "assertions-changed", detail: "1 assertion was removed.", lines: ["- expect(1).toBe(1)"] }],
    packages: [{ ecosystem: "npm", name: "left-padz", status: "unknown", manifest: "package.json" }],
  });

  it("carries the request, the claim as a claim, and the raw evidence", () => {
    expect(prompt).toContain("Fix the sum bug");
    expect(prompt).toContain("a claim, not evidence");
    expect(prompt).toContain("Fixed it, all tests pass.");
    expect(prompt).toContain("outcome: failed; exit code: 1; 11 passed, 1 failed");
    expect(prompt).toContain("failing: sums > adds");
    expect(prompt).toContain("Tests  1 failed | 11 passed (12)");
    expect(prompt).toContain("src/sum.test.ts: 1 assertion was removed.");
    expect(prompt).toContain("left-padz (npm): unknown");
  });

  it("caps the diff and each output tail", () => {
    expect(prompt).toContain("(diff truncated)");
    expect(prompt).not.toContain("d".repeat(DIFF_SUMMARY_MAX + 1));
    expect(prompt).not.toContain("x".repeat(3000));
  });

  it("asks for the verdict JSON shape", () => {
    expect(prompt).toMatch(/"verdict":"proven"\|"partial"\|"unproven"\|"contradicted"/);
  });
});

describe("validateVerdict", () => {
  it("accepts a well-formed verdict and clips it", () => {
    const v = validateVerdict({ verdict: "Partial", asked: "a", did: "d", evidence: ["e", 3, ""], gaps: Array(20).fill("g") });
    expect(v).toEqual({ verdict: "partial", asked: "a", did: "d", evidence: ["e"], gaps: Array(8).fill("g") });
  });
  it("rejects unknown verdicts, a missing 'did' and non-objects", () => {
    expect(validateVerdict({ verdict: "done", did: "x" })).toBeNull();
    expect(validateVerdict({ verdict: "proven" })).toBeNull();
    expect(validateVerdict("proven")).toBeNull();
    expect(validateVerdict(null)).toBeNull();
  });
});

describe("brainNote", () => {
  it("explains a missing verdict in plain words", () => {
    expect(brainNote("no-brain")).toMatch(/No brain connected/);
    expect(brainNote("over-budget")).toMatch(/budget/);
    expect(brainNote("weird")).toMatch(/could not be asked/);
  });
});

describe("acceptance checks", () => {
  const items = ["npm test passes", "The page shows the total"];
  it("matches answers by number or wording, in the plan's order, and fills the gaps", () => {
    expect(
      readAcceptance(
        [
          { item: "The page shows the total", met: true, evidence: "seen in the preview" },
          { item: 9, met: true, evidence: "stray" },
        ],
        items,
      ),
    ).toEqual([
      { item: "npm test passes", met: null, evidence: "The brain did not report on this check." },
      { item: "The page shows the total", met: true, evidence: "seen in the preview" },
    ]);
  });
  it("reads proven with an unshown check as partial; without a plan, validates as before", () => {
    const raw = { verdict: "proven", asked: "a", did: "d", evidence: [], gaps: [], acceptance: [{ item: 1, met: true, evidence: "4 passed" }] };
    expect(validateVerdictFor(items)(raw)).toMatchObject({ verdict: "partial", acceptance: [{ met: true }, { met: null }] });
    expect(validateVerdictFor(undefined)(raw)).not.toHaveProperty("acceptance");
    const all = { ...raw, acceptance: [{ item: 1, met: true, evidence: "x" }, { item: 2, met: true, evidence: "y" }] };
    expect(validateVerdictFor(items)(all)).toMatchObject({ verdict: "proven" });
  });
  it("puts the numbered checks in the prompt and asks for one answer each", () => {
    const p = buildVerdictPrompt({ asked: "x", diffSummary: "", filesTouched: [], checks: [], tamper: [], packages: [], acceptance: items });
    expect(p).toContain("1. npm test passes");
    expect(p).toContain("proven requires every acceptance check met");
  });
});

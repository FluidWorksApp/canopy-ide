import { beforeEach, describe, expect, it, vi } from "vitest";

const receiptRunCheck = vi.fn();
const ghPrBody = vi.fn();
vi.mock("../ipc", () => ({
  receiptRunCheck: (...a: unknown[]) => receiptRunCheck(...a),
  ghPrBody: (...a: unknown[]) => ghPrBody(...a),
}));
vi.mock("../ledger", () => ({ queryLedger: vi.fn(async () => []) }));

import {
  patchSignature,
  planReverted,
  readReceipt,
  receiptLine,
  receiptMatches,
  resetEvidenceForTests,
  revertIndex,
  revertedPlans,
  scoreTrackRecord,
} from "./evidence";
import type { LedgerEntry } from "../ledger";
import type { PlanData } from "../plans/plan";

const receipt = (data: unknown, ref = { kind: "session", id: "s1" }): LedgerEntry => ({
  id: "r",
  kind: "receipt",
  ts: 5,
  root: "/repo",
  author: { kind: "brain", name: "receipt" },
  scope: "project",
  ref,
  data,
});

const planEntry = (sessionId: string, taskClass: PlanData["taskClass"], commits?: PlanData["commits"]): LedgerEntry<PlanData> => ({
  id: sessionId,
  kind: "plan",
  ts: 1,
  root: "/repo",
  author: { kind: "brain", name: "plan" },
  scope: "project",
  status: "done",
  data: {
    planId: `pl-${sessionId}-1`,
    goal: "g",
    decisions: [],
    touches: [],
    acceptance: [],
    wontDo: [],
    risk: "low",
    size: "tiny",
    taskClass,
    request: "r",
    dir: "/repo",
    source: "task",
    gate: "inline",
    gateWhy: [],
    sessionId,
    commits,
  },
});

beforeEach(() => {
  resetEvidenceForTests();
  receiptRunCheck.mockReset();
  ghPrBody.mockReset();
});

describe("reading receipts defensively", () => {
  it("reads the receipts feature's shape", () => {
    const r = readReceipt(
      receipt({
        verdict: "partial",
        asked: "Paginate",
        did: "Added pages",
        evidence: ["tests ran", { text: "screenshot shows pager" }],
        gaps: ["No test for page 2"],
        checks: [{ name: "npm test", exit: 0, passed: 41, failed: 0 }, { command: "tsc", exitCode: 2 }],
        tamper: [],
      }),
    );
    expect(r.verdict).toBe("partial");
    expect(r.evidence).toEqual(["tests ran", "screenshot shows pager"]);
    expect(r.checks[0]).toMatchObject({ name: "npm test", ok: true });
    expect(r.checks[0].detail).toContain("exit 0");
    expect(r.checks[0].detail).toContain("41 passed");
    expect(r.checks[1]).toMatchObject({ name: "tsc", ok: false });
    expect(r.tampered).toBe(false);
    expect(receiptLine(r)).toContain("verdict partial");
  });

  it("reads a stored receipt's nested verdict, final status, checks and acceptance", () => {
    const r = readReceipt(
      receipt({
        status: "partial",
        verdict: {
          verdict: "proven",
          asked: "Paginate",
          did: "Added pages",
          evidence: ["4 passed"],
          gaps: [],
          acceptance: [
            { item: "npm test passes", met: true, evidence: "4 passed" },
            { item: "Page 2 loads", met: null, evidence: "" },
          ],
        },
        checks: [
          { id: "t", label: "Tests", kind: "test", command: "npm test", exitCode: 0, outcome: "passed", counts: { passed: 4, failed: 0, skipped: 0, total: 4, unit: "tests" } },
          { id: "l", label: "Lint", kind: "lint", command: "npm run lint", exitCode: null, outcome: "timed-out", counts: null },
        ],
        tamper: [],
      }),
    );
    expect(r.verdict).toBe("partial");
    expect(r.did).toBe("Added pages");
    expect(r.checks[0]).toMatchObject({ name: "Tests", ok: true });
    expect(r.checks[0].detail).toContain("4 passed");
    expect(r.checks[1]).toMatchObject({ name: "Lint", ok: null });
    expect(r.checks[1].detail).toContain("timed out");
    expect(r.acceptance).toEqual([
      { item: "npm test passes", met: true, evidence: "4 passed" },
      { item: "Page 2 loads", met: null, evidence: "" },
    ]);
    expect(receiptLine(r)).toContain("(2) Page 2 loads — not shown");
  });

  it("survives junk", () => {
    const r = readReceipt(receipt("not an object"));
    expect(r).toMatchObject({ verdict: null, evidence: [], gaps: [], checks: [], tampered: false });
    expect(readReceipt(receipt({ verdict: "maybe", tamper: { editedTests: true } })).tampered).toBe(true);
  });

  it("matches a receipt to a session by session or turn ref", () => {
    expect(receiptMatches(receipt({}), "s1")).toBe(true);
    expect(receiptMatches(receipt({}, { kind: "turn", id: "s1:123" }), "s1")).toBe(true);
    expect(receiptMatches(receipt({}, { kind: "turn", id: "s10:1" }), "s1")).toBe(false);
  });
});

const run = (stdout: string, code = 0) => ({ code, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false, timedOut: false, durationMs: 1, spawnError: null });
const RS = "\x1e";
const US = "\x1f";
const logOf = (rows: { sha: string; parents?: string; subject: string; body?: string; files?: string[] }[]) => ({
  log: rows.map((r) => `${RS}${r.sha}${US}${r.parents ?? "p0"}${US}${r.subject}${US}${r.body ?? ""}`).join("\n"),
  names: rows.map((r) => `${RS}${r.sha}\n\n${(r.files ?? []).join("\n")}`).join("\n"),
});
/** A git that answers the two log reads, `show` and `diff` from tables. */
function fakeGit(rows: Parameters<typeof logOf>[0], patches: Record<string, string> = {}, extra: Record<string, string> = {}) {
  const { log, names } = logOf(rows);
  receiptRunCheck.mockImplementation(async (_dir: string, argv: string[]) => {
    const cmd = argv.slice(1).join(" ");
    if (cmd.includes("--name-only")) return run(names);
    if (argv[1] === "log") return run(log);
    if (argv[1] === "show") return patches[argv[argv.length - 1]] != null ? run(patches[argv[argv.length - 1]]) : run("", 128);
    if (extra[cmd] != null) return run(extra[cmd]);
    return run("", 128);
  });
}

const PATCH_A = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n context\n";
const REVERT_A = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-const a = 2;\n+const  a = 1;\n context\n";

describe("autonomy ledger", () => {
  it("counts verdicts and reverts per task class and never graduates a class with a revert", () => {
    const plans = Array.from({ length: 12 }, (_, i) => planEntry(`s${i}`, "test-addition", [{ sha: `abc${i}def`, subject: `Add test ${i}` }]));
    plans.push(planEntry("other", "feature"));
    const receipts = plans.map((p) => receipt({ verdict: "proven" }, { kind: "session", id: p.data.sessionId as string }));
    const clean = scoreTrackRecord("test-addition", plans, receipts, new Set());
    expect(clean).toMatchObject({ runs: 12, proven: 12, reverted: 0, eligible: true });
    const reverted = scoreTrackRecord("test-addition", plans, receipts, new Set([plans[3].data.planId, plans[5].data.planId]));
    expect(reverted).toMatchObject({ proven: 12, reverted: 2, eligible: false });
    expect(scoreTrackRecord("feature", plans, receipts, new Set())).toMatchObject({ runs: 1, proven: 1, eligible: false });
  });
});

describe("revert detection", () => {
  it("reads revert trailers from any commit, GitHub revert links, and asks gh about a squashed revert PR", async () => {
    fakeGit([
      { sha: "aaaa1111", subject: "Back out the cache", body: "This reverts commit 0123456789abcdef." },
      { sha: "bbbb2222", parents: "p1 p2", subject: "Merge pull request #34 from acme/revert-33-cache" },
      { sha: "cccc3333", subject: 'Revert "Add cache" (#56)' },
      { sha: "dddd4444", subject: 'Revert "Speed up"', body: "Reverts acme/app#12" },
    ]);
    ghPrBody.mockResolvedValue("Reverts acme/app#55\n\nBroke prod.");
    const idx = await revertIndex("/repo");
    expect(idx.shas).toEqual(["0123456789abcdef"]);
    expect([...idx.subjects].sort()).toEqual(["Add cache", "Speed up"]);
    expect([...idx.prs].sort((a, b) => a - b)).toEqual([12, 33, 55]);
    expect(ghPrBody).toHaveBeenCalledTimes(1);
    expect(ghPrBody).toHaveBeenCalledWith("/repo", 56);
  });

  it("an inverse patch is a revert, whitespace and line order aside", () => {
    expect(patchSignature(REVERT_A)).toBe(patchSignature(PATCH_A, true));
    expect(patchSignature(PATCH_A)).not.toBe(patchSignature(PATCH_A, true));
  });

  it("finds a run reverted by trailer, by inverse patch, or through a reverted GitHub PR", async () => {
    const plan = (commits: { sha: string; subject: string }[]) => ({ ...planEntry("s1", "bugfix", commits).data, baseHead: "base0000" });
    // Trailer naming the run's commit, with a subject that says nothing.
    fakeGit([{ sha: "ffff0000", subject: "Undo", body: "This reverts commit abcdef12." }]);
    expect(await planReverted("/repo", plan([{ sha: "abcdef1234", subject: "Fix a" }]), await revertIndex("/repo"))).toBe(true);

    // A hand-made revert: no trailer, no "Revert" subject, inverse patch.
    resetEvidenceForTests();
    fakeGit(
      [
        { sha: "eeee0000", subject: "Put a back", files: ["src/a.ts"] },
        { sha: "abcdef1234", subject: "Fix a", files: ["src/a.ts"] },
      ],
      { eeee0000: REVERT_A, abcdef1234: PATCH_A },
      { "diff --no-color --no-ext-diff base0000 abcdef1234": PATCH_A },
    );
    expect(await planReverted("/repo", plan([{ sha: "abcdef1234", subject: "Fix a" }]), await revertIndex("/repo"))).toBe(true);

    // Squash-merged as #70, then reverted with GitHub's button (#71).
    resetEvidenceForTests();
    fakeGit(
      [
        { sha: "9999aaaa", subject: 'Revert "Fix a" (#71)', files: ["src/b.ts"] },
        { sha: "8888bbbb", subject: "Fix a (#70)", files: ["src/a.ts"] },
      ],
      { "8888bbbb": PATCH_A, "9999aaaa": "" },
      { "diff --no-color --no-ext-diff base0000 1234abcd": PATCH_A },
    );
    ghPrBody.mockResolvedValue("Reverts acme/app#70");
    expect(await planReverted("/repo", plan([{ sha: "1234abcd", subject: "Fix the thing" }]), await revertIndex("/repo"))).toBe(true);

    // Nothing undone.
    resetEvidenceForTests();
    fakeGit([{ sha: "7777cccc", subject: "Unrelated", files: ["README.md"] }], { "7777cccc": "diff --git a/README.md b/README.md\n+hi\n" });
    expect(await revertedPlans("/repo", [planEntry("s2", "bugfix", [{ sha: "abcdef1234", subject: "Fix a" }])])).toEqual(new Set());
  });
});

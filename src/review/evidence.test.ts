import { beforeEach, describe, expect, it, vi } from "vitest";

const gitLog = vi.fn();
const gitCommitDetail = vi.fn();
vi.mock("../ipc", () => ({
  gitLog: (...a: unknown[]) => gitLog(...a),
  gitCommitDetail: (...a: unknown[]) => gitCommitDetail(...a),
}));
vi.mock("../ledger", () => ({ queryLedger: vi.fn(async () => []) }));

import { readReceipt, receiptLine, receiptMatches, resetEvidenceForTests, revertedCommits, scoreTrackRecord } from "./evidence";
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
  gitLog.mockReset();
  gitCommitDetail.mockReset();
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

describe("autonomy ledger", () => {
  it("counts verdicts and reverts per task class and never graduates a class with a revert", () => {
    const plans = Array.from({ length: 12 }, (_, i) => planEntry(`s${i}`, "test-addition", [{ sha: `abc${i}def`, subject: `Add test ${i}` }]));
    plans.push(planEntry("other", "feature"));
    const receipts = plans.map((p) => receipt({ verdict: "proven" }, { kind: "session", id: p.data.sessionId as string }));
    const none = { shas: [], subjects: new Set<string>() };
    const clean = scoreTrackRecord("test-addition", plans, receipts, none);
    expect(clean).toMatchObject({ runs: 12, proven: 12, reverted: 0, eligible: true });
    const reverted = scoreTrackRecord("test-addition", plans, receipts, { shas: ["abc3"], subjects: new Set(["Add test 5"]) });
    expect(reverted).toMatchObject({ proven: 12, reverted: 2, eligible: false });
    expect(scoreTrackRecord("feature", plans, receipts, none)).toMatchObject({ runs: 1, proven: 1, eligible: false });
  });

  it("finds reverted commits from git history", async () => {
    gitLog.mockResolvedValue([
      { hash: "r1", subject: 'Revert "Add test 5"' },
      { hash: "c1", subject: "Add test 5" },
    ]);
    gitCommitDetail.mockResolvedValue({ body: "This reverts commit 0123456789abcdef." });
    const r = await revertedCommits("/repo");
    expect(r.shas).toEqual(["0123456789abcdef"]);
    expect([...r.subjects]).toEqual(["Add test 5"]);
    expect(gitCommitDetail).toHaveBeenCalledTimes(1);
  });
});

// Shared receipt fixtures for tests.
import type { ReceiptRecord } from "./types";

export function sampleReceipt(over: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    v: 1,
    id: "r1",
    ts: Date.UTC(2026, 9, 27, 12, 0),
    root: "/repo",
    trigger: "turn-end",
    sessionId: "s1",
    ptyId: 7,
    cli: "agent-x",
    cwd: "/repo",
    branch: "feat/sum",
    asked: "Fix the sum bug",
    claim: "Fixed it — all tests pass.",
    filesTouched: ["src/sum.ts", "src/sum.test.ts"],
    base: "HEAD",
    checks: [
      {
        id: "npm:test",
        label: "Tests",
        kind: "test",
        command: "npm run test",
        exitCode: 1,
        outcome: "failed",
        counts: { passed: 11, failed: 1, skipped: 0, total: 12, unit: "tests" },
        durationMs: 4200,
        outputTail: "FAIL src/sum.test.ts > adds\n      Tests  1 failed | 11 passed (12)",
        failures: ["src/sum.test.ts > adds"],
      },
    ],
    tamper: [
      {
        path: "src/sum.test.ts",
        severity: "review",
        reason: "assertions-changed",
        detail: "1 assertion was removed or rewritten.",
        lines: ["- expect(sum(1, 2)).toBe(3);"],
      },
    ],
    packages: [{ ecosystem: "npm", name: "left-padz", status: "unknown", manifest: "package.json" }],
    verdict: {
      verdict: "contradicted",
      asked: "Make sum add its two numbers.",
      did: "Changed subtraction to addition, but one test still fails.",
      evidence: ["Tests: 1 failed, 11 passed"],
      gaps: ["The failing test was the one the agent edited."],
    },
    ceiling: "unproven",
    reasons: ["1 check failed: Tests."],
    status: "contradicted",
    costUsd: 0.0042,
    startedAt: 1,
    endedAt: 2,
    ...over,
  };
}

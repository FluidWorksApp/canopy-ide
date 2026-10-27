import { describe, expect, it } from "vitest";
import {
  aggregate,
  detectReverted,
  detectReworked,
  filesFromPatch,
  isRevertSubject,
  mergedPrOf,
  parseMergedPrs,
  sessionOutcomes,
  weekKey,
  REWORK_WINDOW_MS,
} from "./metrics";
import type { SpendData } from "./types";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-05T12:00:00Z");

const spend = (sessionId: string, files: [string, number][], over: Partial<SpendData> = {}): SpendData => ({
  type: "session",
  sessionId,
  cli: "cli-a",
  profile: "default",
  person: "You",
  cwd: "/repo",
  costUsd: 1,
  costReported: true,
  inputTokens: 0,
  outputTokens: 0,
  turns: 1,
  model: null,
  files: files.map(([path, ts]) => ({ path, ts })),
  firstTs: Math.min(T0, ...files.map((f) => f[1])),
  lastTs: Math.max(T0, ...files.map((f) => f[1])),
  ...over,
});

describe("git parsing", () => {
  it("reads PR numbers from merge and squash subjects", () => {
    expect(mergedPrOf("Merge pull request #642 from org/docs")).toBe(642);
    expect(mergedPrOf("Fix the header (#12)")).toBe(12);
    expect(mergedPrOf("Fix #12 in the header")).toBeNull();
    const m = parseMergedPrs([
      { subject: "Merge pull request #1 from a/b", date: "2026-10-01" },
      { subject: "Tidy (#2)", date: "2026-10-02T10:00:00+00:00" },
      { subject: "plain commit", date: "2026-10-03" },
    ]);
    expect([...m.keys()].sort()).toEqual([1, 2]);
    expect(m.get(2)).toBe(Date.parse("2026-10-02T10:00:00+00:00"));
  });

  it("recognises revert commits and patch paths", () => {
    expect(isRevertSubject('Revert "Add the thing"')).toBe(true);
    expect(isRevertSubject("Reverted styles")).toBe(false);
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "diff --git a/old.ts b/new.ts",
    ].join("\n");
    expect(filesFromPatch(patch)).toEqual(["src/a.ts", "new.ts"]);
  });
});

describe("revert and rework detection", () => {
  it("flags a session whose file a later revert changed", () => {
    const spends = [spend("s1", [["src/a.ts", T0]]), spend("s2", [["src/b.ts", T0]])];
    const hit = detectReverted(spends, [{ hash: "r", ts: T0 + DAY, files: ["src/a.ts"] }]);
    expect([...hit]).toEqual(["s1"]);
    // A revert from before the session edited the file is not about it.
    expect(detectReverted(spends, [{ hash: "r", ts: T0 - DAY, files: ["src/a.ts"] }]).size).toBe(0);
  });

  it("flags a session another session re-edited within a week", () => {
    const spends = [
      spend("s1", [["src/a.ts", T0]]),
      spend("s2", [["src/a.ts", T0 + 2 * DAY]]),
      spend("s3", [["src/c.ts", T0]]),
      spend("s4", [["src/c.ts", T0 + REWORK_WINDOW_MS + DAY]]),
    ];
    expect([...detectReworked(spends)]).toEqual(["s1"]);
  });

  it("does not count a session re-editing its own files", () => {
    expect(detectReworked([spend("s1", [["a", T0], ["b", T0 + 1]])]).size).toBe(0);
  });
});

describe("session outcomes and aggregation", () => {
  const spends = [
    spend("deps1", [["package.json", T0]], { taskClass: "deps", costUsd: 0.5 }),
    spend("deps2", [["lock.json", T0]], { taskClass: "deps", costUsd: 0.7 }),
    spend("ui1", [["src/ui.tsx", T0]], { taskClass: "ui", costUsd: 4, cli: "cli-b" }),
    spend("ui2", [["src/ui.tsx", T0 + DAY]], { taskClass: "ui", costUsd: 3, cli: "cli-b" }),
  ];
  const outcomes = sessionOutcomes({
    spends,
    reverts: [],
    merged: new Map([
      [10, T0 + 5 * 3_600_000],
      [11, T0 + DAY],
    ]),
    edges: new Map([
      ["deps1", [{ prNumber: 10, openedAt: T0 }]],
      ["deps2", [{ prNumber: 11, openedAt: T0 }]],
      ["ui1", [{ prNumber: 99, openedAt: T0 }]],
    ]),
  });

  it("joins provenance, merges and review time per session", () => {
    const d1 = outcomes.find((o) => o.sessionId === "deps1")!;
    expect(d1).toMatchObject({ merged: true, mergedPrs: [10], reviewHours: 5, taskClass: "deps" });
    const u1 = outcomes.find((o) => o.sessionId === "ui1")!;
    expect(u1).toMatchObject({ merged: false, reworked: true });
  });

  it("aggregates by class with cost per merged change, pass rate and rates", () => {
    const { rows, total } = aggregate(
      outcomes,
      [
        { sessionId: "deps1", verdict: "proven", ts: T0 },
        { sessionId: "deps2", verdict: "proven", ts: T0 },
        { sessionId: "ui1", verdict: "partial", ts: T0 },
        { sessionId: null, verdict: "contradicted", ts: T0 },
      ],
      "class",
    );
    const deps = rows.find((r) => r.key === "deps")!;
    expect(deps.merged).toBe(2);
    expect(deps.costPerMerged).toBeCloseTo(0.6);
    expect(deps.passRate).toBe(1);
    expect(deps.medianReviewHours).toBe(14.5);
    const ui = rows.find((r) => r.key === "ui")!;
    expect(ui.reworkRate).toBe(0.5);
    expect(ui.costPerMerged).toBeNull();
    expect(rows.find((r) => r.key === "unplanned")?.receipts.contradicted).toBe(1);
    expect(total.sessions).toBe(4);
    expect(total.receipts.total).toBe(4);
    expect(total.passRate).toBe(0.5);
  });

  it("groups by CLI and by week", () => {
    expect(aggregate(outcomes, [], "cli").rows.map((r) => r.key)).toEqual(["cli-b", "cli-a"]);
    expect(aggregate(outcomes, [], "week").rows.map((r) => r.key)).toEqual([weekKey(T0), weekKey(T0 + DAY)].filter((v, i, a) => a.indexOf(v) === i));
  });

  it("week keys start on Monday", () => {
    const k = weekKey(Date.parse("2026-10-08T12:00:00")); // a Thursday
    expect(new Date(`${k}T00:00:00`).getDay()).toBe(1);
  });
});

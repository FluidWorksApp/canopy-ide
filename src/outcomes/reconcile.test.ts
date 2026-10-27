import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LedgerDraft, LedgerEntry } from "../ledger";
import { gatherOutcomes, writeOutcomes, type ReconcileDeps } from "./reconcile";
import { outcomesFor } from "./index";
import type { OutcomeData, SpendData } from "./types";

const DAY = 86_400_000;

function entry<D>(kind: LedgerEntry["kind"], data: D, over: Partial<LedgerEntry<D>> = {}): LedgerEntry<D> {
  return {
    id: `${kind}-${Math.random().toString(36).slice(2)}`,
    kind,
    ts: Date.now(),
    root: "/repo",
    author: { kind: "workspace", name: "test" },
    scope: "personal",
    data,
    ...over,
  };
}

const spend = (sessionId: string, files: [string, number][], over: Partial<SpendData> = {}): SpendData => ({
  type: "session",
  sessionId,
  cli: "cli-a",
  profile: "default",
  person: "You",
  cwd: "/repo",
  costUsd: 2,
  costReported: true,
  inputTokens: 0,
  outputTokens: 0,
  turns: 1,
  model: null,
  files: files.map(([path, ts]) => ({ path, ts })),
  firstTs: files[0]?.[1] ?? Date.now(),
  lastTs: Math.max(...files.map((f) => f[1])),
  ...over,
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

/** Deps that read a real git repository with the same commands the app runs. */
function gitDeps(dir: string, ledger: LedgerEntry[], edges: Record<string, { pr_number: number; at: number }[]>): ReconcileDeps {
  return {
    query: vi.fn(async (_root: string, q: { kinds?: string[] }) =>
      ledger.filter((e) => !q.kinds || q.kinds.includes(e.kind)),
    ) as ReconcileDeps["query"],
    append: vi.fn(async (_root: string, d: LedgerDraft<unknown>) => ({ ...d, id: "new", ts: Date.now(), root: "/repo" })) as ReconcileDeps["append"],
    gitLog: async (_repo, limit) =>
      git(dir, "log", `-${limit}`, "--format=%H%x1f%aI%x1f%s")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [hash, date, subject] = l.split("\x1f");
          return { hash, date, subject };
        }),
    commitDate: async (_repo, hash) => git(dir, "show", "-s", "--format=%aI", hash).trim(),
    commitPatch: async (_repo, hash) => git(dir, "show", "--format=", hash),
    provenance: async (sid) => edges[sid] ?? [],
  };
}

describe("reconcile on a real git repository", () => {
  it("detects reverts, merges, rework and review time from history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canopy-outcomes-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, "a.ts"), "one\n");
      writeFileSync(join(dir, "b.ts"), "one\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "init");
      writeFileSync(join(dir, "a.ts"), "two\n");
      git(dir, "commit", "-qam", "Change a (#7)");
      git(dir, "revert", "--no-edit", "HEAD");
      writeFileSync(join(dir, "b.ts"), "two\n");
      git(dir, "commit", "-qam", "Change b (#8)");

      const now = Date.now();
      const edited = now - 3 * DAY;
      const ledger: LedgerEntry[] = [
        entry("spend", spend("sA", [["a.ts", edited]], { taskClass: "ui" }), { ref: { kind: "session", id: "sA" } }),
        entry("spend", spend("sB", [["b.ts", edited]], { taskClass: "deps", costUsd: 1 }), { ref: { kind: "session", id: "sB" } }),
        entry("spend", spend("sC", [["b.ts", edited + DAY]], { taskClass: "deps", costUsd: 1 }), { ref: { kind: "session", id: "sC" } }),
        entry("receipt", { verdict: "proven" }, { ref: { kind: "turn", id: "sB:123" } }),
        entry("plan", { title: "Bump deps" }, { id: "p2", supersedes: "p1" }),
      ];
      const openedSec = Math.floor((now - 10 * 3_600_000) / 1000);
      const deps = gitDeps(dir, ledger, { sB: [{ pr_number: 8, at: openedSec }] });

      const report = await gatherOutcomes(deps, dir, now - 30 * DAY);
      const by = new Map(report.outcomes.map((o) => [o.sessionId, o]));
      expect(by.get("sA")).toMatchObject({ reverted: true, merged: false });
      expect(by.get("sB")).toMatchObject({ reverted: false, merged: true, mergedPrs: [8], reworked: true });
      expect(by.get("sB")!.reviewHours).toBeGreaterThan(9);
      expect(by.get("sB")!.reviewHours).toBeLessThan(11);
      expect(by.get("sC")).toMatchObject({ reworked: false });
      expect(report.receipts).toEqual([expect.objectContaining({ sessionId: "sB", verdict: "proven" })]);
      expect(report.mergedInWindow).toBe(2);
      expect(report.gitUnavailable).toBe(false);
      expect(report.planTitles.get("p1")).toBe("Bump deps");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sees rebase and squash merges by content, and GitHub's word when content can't tell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canopy-outcomes-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, "a.ts"), "one\n");
      writeFileSync(join(dir, "b.ts"), "one\n");
      writeFileSync(join(dir, "c.ts"), "one\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "init");
      const base = git(dir, "rev-parse", "HEAD").trim();
      // PR 7: two commits, rebase-merged (replayed onto main, no "#7").
      git(dir, "checkout", "-qb", "feat-7");
      writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
      git(dir, "commit", "-qam", "Add two");
      writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n");
      git(dir, "commit", "-qam", "Add three");
      const pr7 = git(dir, "diff", `${base}...feat-7`);
      // PR 8: squash-merged under a subject that doesn't name it.
      git(dir, "checkout", "-q", "main");
      git(dir, "checkout", "-qb", "feat-8");
      writeFileSync(join(dir, "b.ts"), "one\nb1\n");
      git(dir, "commit", "-qam", "b1");
      writeFileSync(join(dir, "b.ts"), "one\nb2\n");
      git(dir, "commit", "-qam", "b2");
      const pr8 = git(dir, "diff", `${base}...feat-8`);
      git(dir, "checkout", "-q", "main");
      writeFileSync(join(dir, "c.ts"), "one\nunrelated\n");
      git(dir, "commit", "-qam", "Unrelated work");
      git(dir, "cherry-pick", "feat-7~1", "feat-7");
      git(dir, "merge", "--squash", "-q", "feat-8");
      git(dir, "commit", "-qm", "Tidy b");

      const now = Date.now();
      const ledger: LedgerEntry[] = ["s7", "s8", "s9", "s10"].map((sid) =>
        entry("spend", spend(sid, [["x.ts", now - DAY]]), { ref: { kind: "session", id: sid } }),
      );
      const openedSec = Math.floor((now - 2 * 3_600_000) / 1000);
      const deps = gitDeps(dir, ledger, {
        s7: [{ pr_number: 7, at: openedSec }],
        s8: [{ pr_number: 8, at: openedSec }],
        s9: [{ pr_number: 9, at: openedSec }],
        s10: [{ pr_number: 10, at: openedSec }],
      });
      const { fingerprint } = await import("./patchId");
      deps.prFingerprint = async (_r, n) => (n === 7 ? fingerprint(pr7) : n === 8 ? fingerprint(pr8) : null);
      deps.prState = async (_r, n) => (n === 9 ? "MERGED" : n === 10 ? "OPEN" : null);

      const report = await gatherOutcomes(deps, dir, now - 30 * DAY);
      const by = new Map(report.outcomes.map((o) => [o.sessionId, o]));
      expect(by.get("s7")).toMatchObject({ merged: true, mergedPrs: [7] });
      expect(by.get("s7")!.reviewHours).toBeGreaterThan(1);
      expect(by.get("s8")).toMatchObject({ merged: true, mergedPrs: [8] });
      // GitHub says merged but no content matched: merged, review time unknown.
      expect(by.get("s9")).toMatchObject({ merged: true, mergedPrs: [9] });
      expect(by.get("s9")!.reviewHours).toBeUndefined();
      expect(by.get("s10")).toMatchObject({ merged: false });
      expect(report.mergedInWindow).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says git is unavailable rather than reporting zero", async () => {
    const deps = gitDeps("/nonexistent", [], {});
    deps.gitLog = async () => {
      throw new Error("not a repo");
    };
    const report = await gatherOutcomes(deps, "/repo", 0);
    expect(report.gitUnavailable).toBe(true);
  });
});

describe("writeOutcomes", () => {
  const outcome = (over: Partial<OutcomeData> = {}): OutcomeData => ({
    type: "session",
    sessionId: "s1",
    cli: "cli-a",
    person: "You",
    taskClass: "deps",
    costUsd: 1,
    mergedPrs: [],
    merged: false,
    reverted: false,
    reworked: false,
    lastTs: 1,
    ...over,
  });

  it("writes only changed outcomes, superseding the last one", async () => {
    const prev = entry("outcome", outcome(), { id: "o1" });
    const append = vi.fn(async (_r: string, d: LedgerDraft<unknown>) => ({ ...d, id: "o2", ts: 1, root: "/repo" }));
    const deps = {
      query: vi.fn(async () => [prev]) as unknown as ReconcileDeps["query"],
      append: append as unknown as ReconcileDeps["append"],
    };
    expect(await writeOutcomes(deps, "/repo", [outcome()], 0)).toBe(0);
    expect(await writeOutcomes(deps, "/repo", [outcome({ merged: true, mergedPrs: [3] })], 0)).toBe(1);
    expect(append.mock.calls[0][1]).toMatchObject({ kind: "outcome", supersedes: "o1", ref: { kind: "session", id: "s1" } });
  });
});

describe("outcomesFor (autonomy input)", () => {
  it("returns per-class counts from the ledger alone", async () => {
    const rows: LedgerEntry[] = [
      entry("spend", spend("d1", [["x", 1]], { taskClass: "deps", costUsd: 0.5 })),
      entry("spend", spend("d2", [["y", 1]], { taskClass: "deps", costUsd: 0.25 })),
      entry("spend", spend("u1", [["z", 1]], { taskClass: "ui", costUsd: 3 })),
      entry("outcome", { type: "session", sessionId: "d1", cli: "c", person: "You", taskClass: "deps", costUsd: 0.5, mergedPrs: [1], merged: true, reverted: false, reworked: false, lastTs: 1 }),
      entry("outcome", { type: "session", sessionId: "u1", cli: "c", person: "You", taskClass: "ui", costUsd: 3, mergedPrs: [], merged: false, reverted: true, reworked: true, lastTs: 1 }),
      entry("receipt", { verdict: "proven" }, { ref: { kind: "session", id: "d1" } }),
      entry("receipt", { verdict: "proven" }, { ref: { kind: "turn", id: "d2:5" } }),
      entry("receipt", { verdict: "contradicted" }, { ref: { kind: "turn", id: "u1:5" } }),
      entry("receipt", { verdict: "unproven" }),
    ];
    const query = vi.fn(async (_root: string, q: { kinds?: string[] }) =>
      rows.filter((e) => !q.kinds || q.kinds.includes(e.kind)),
    );
    const all = await outcomesFor("/repo", { sinceMs: 0 }, query as never);
    expect(all.byClass.deps).toMatchObject({ proven: 2, merged: 1, reverted: 0, sessions: 2, costUsd: 0.75 });
    expect(all.byClass.ui).toMatchObject({ contradicted: 1, reverted: 1, reworked: 1, costUsd: 3 });
    expect(all.byClass.unplanned).toMatchObject({ unproven: 1 });
    expect(all.total.sessions).toBe(3);

    const deps = await outcomesFor("/repo", { sinceMs: 0, taskClass: "deps" }, query as never);
    expect(Object.keys(deps.byClass)).toEqual(["deps"]);
    expect(deps.total.proven).toBe(2);
    expect(query).toHaveBeenCalledWith("/repo", expect.objectContaining({ sinceTs: 0 }));
  });
});

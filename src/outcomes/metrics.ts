// Outcome metrics, as pure functions over what the reconciler gathered: spend
// records, receipts, revert commits, merged PRs and which session raised
// which PR. Nothing here touches IPC, so every number the panel shows can be
// tested from fixtures.
//
// Definitions (plain-language versions are in the panel's tooltips):
//   merged     — the session raised a PR (provenance) that is in the
//                checkout's history, by GitHub's merge-commit subject
//                ("Merge pull request #12") or squash subject ("… (#12)").
//   reverted   — a later `Revert "…"` commit changed a file the session edited.
//   reworked   — a different session edited one of the session's files within
//                7 days after it did.
//   pass rate  — receipts with verdict "proven" over all receipts.
//   time in review — PR opened (first seen by Canopy) to its merge commit.

import { UNPLANNED, type OutcomeData, type ReceiptLike, type SpendData } from "./types";

export const REWORK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface RevertCommit {
  hash: string;
  ts: number;
  files: string[];
}

export interface PrEdge {
  prNumber: number;
  /** Ms; when Canopy first knew the PR existed. */
  openedAt: number | null;
}

export interface ReceiptFact {
  sessionId: string | null;
  verdict: string;
  ts: number;
}

export type GroupBy = "class" | "cli" | "person" | "week";

export interface VerdictCounts {
  proven: number;
  partial: number;
  unproven: number;
  contradicted: number;
  total: number;
}

export interface MetricRow {
  key: string;
  sessions: number;
  costUsd: number;
  merged: number;
  /** Cost of the sessions that produced merged changes, per merged PR. */
  costPerMerged: number | null;
  receipts: VerdictCounts;
  passRate: number | null;
  reverted: number;
  reworked: number;
  revertRate: number | null;
  reworkRate: number | null;
  medianReviewHours: number | null;
}

// ------------------------------------------------------------ git parsing

const MERGE_RE = /^Merge pull request #(\d+)\b/;
const SQUASH_RE = /\(#(\d+)\)\s*$/;

/** PR number a commit subject says it merged, if any. */
export function mergedPrOf(subject: string): number | null {
  const m = MERGE_RE.exec(subject) ?? SQUASH_RE.exec(subject);
  return m ? Number(m[1]) : null;
}

/** PR number → merge time (ms), from commit subjects and dates. The newest
 *  wins when a subject repeats (a re-merge after a revert). */
export function parseMergedPrs(commits: { subject: string; date: string }[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const c of commits) {
    const n = mergedPrOf(c.subject);
    if (n == null) continue;
    const ts = Date.parse(c.date);
    if (!Number.isFinite(ts)) continue;
    out.set(n, Math.max(out.get(n) ?? 0, ts));
  }
  return out;
}

export const isRevertSubject = (subject: string) => /^Revert\s+"/.test(subject);

/** Paths a unified patch changed (the post-image side, so a rename counts
 *  under its new name; deletions under the old one). */
export function filesFromPatch(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) out.add(m[2]);
  }
  return [...out];
}

// ------------------------------------------------------------ detection

/** Sessions whose edited files a later revert changed. */
export function detectReverted(spends: SpendData[], reverts: RevertCommit[]): Set<string> {
  const hit = new Set<string>();
  for (const r of reverts) {
    const files = new Set(r.files);
    for (const s of spends) {
      if (hit.has(s.sessionId)) continue;
      if (s.files.some((f) => files.has(f.path) && r.ts >= f.ts)) hit.add(s.sessionId);
    }
  }
  return hit;
}

/** Sessions with a file another session edited within `windowMs` after them.
 *  A session's file ts is its *last* edit, so "the other session's last edit
 *  is after mine" proves it edited the file after me. */
export function detectReworked(spends: SpendData[], windowMs = REWORK_WINDOW_MS): Set<string> {
  const byPath = new Map<string, { sessionId: string; ts: number }[]>();
  for (const s of spends) {
    for (const f of s.files) {
      const list = byPath.get(f.path) ?? [];
      list.push({ sessionId: s.sessionId, ts: f.ts });
      byPath.set(f.path, list);
    }
  }
  const hit = new Set<string>();
  for (const list of byPath.values()) {
    if (list.length < 2) continue;
    for (const a of list) {
      if (hit.has(a.sessionId)) continue;
      if (list.some((b) => b.sessionId !== a.sessionId && b.ts > a.ts && b.ts - a.ts <= windowMs)) {
        hit.add(a.sessionId);
      }
    }
  }
  return hit;
}

/** Newest spend record per session (a reader may see several heads if two
 *  windows wrote at once). */
export function latestSpends(spends: SpendData[]): SpendData[] {
  const by = new Map<string, SpendData>();
  for (const s of spends) {
    const prev = by.get(s.sessionId);
    if (!prev || s.lastTs > prev.lastTs || (s.lastTs === prev.lastTs && s.costUsd > prev.costUsd)) {
      by.set(s.sessionId, s);
    }
  }
  return [...by.values()];
}

/** What became of each session's work. */
export function sessionOutcomes(input: {
  spends: SpendData[];
  reverts: RevertCommit[];
  merged: Map<number, number>;
  edges: Map<string, PrEdge[]>;
}): OutcomeData[] {
  const spends = latestSpends(input.spends);
  const reverted = detectReverted(spends, input.reverts);
  const reworked = detectReworked(spends);
  return spends.map((s) => {
    const prs = input.edges.get(s.sessionId) ?? [];
    const mergedEdges = prs.filter((e) => input.merged.has(e.prNumber));
    const first = mergedEdges
      .map((e) => ({ e, at: input.merged.get(e.prNumber)! }))
      .sort((a, b) => a.at - b.at)[0];
    const reviewHours =
      first && first.e.openedAt != null && first.at >= first.e.openedAt
        ? (first.at - first.e.openedAt) / 3_600_000
        : undefined;
    return {
      type: "session",
      sessionId: s.sessionId,
      cli: s.cli,
      person: s.person,
      taskClass: s.taskClass ?? UNPLANNED,
      costUsd: s.costUsd,
      mergedPrs: [...new Set(mergedEdges.map((e) => e.prNumber))].sort((a, b) => a - b),
      merged: mergedEdges.length > 0,
      reverted: reverted.has(s.sessionId),
      reworked: reworked.has(s.sessionId),
      ...(reviewHours != null ? { reviewHours } : {}),
      lastTs: s.lastTs,
    };
  });
}

// ------------------------------------------------------------ aggregation

/** Monday of the week `ts` falls in, local time, as YYYY-MM-DD. */
export function weekKey(ts: number): string {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function keyOf(o: Pick<OutcomeData, "taskClass" | "cli" | "person" | "lastTs">, by: GroupBy): string {
  switch (by) {
    case "class":
      return o.taskClass;
    case "cli":
      return o.cli;
    case "person":
      return o.person;
    case "week":
      return weekKey(o.lastTs);
  }
}

const emptyVerdicts = (): VerdictCounts => ({
  proven: 0,
  partial: 0,
  unproven: 0,
  contradicted: 0,
  total: 0,
});

export function countVerdict(v: VerdictCounts, verdict: string): void {
  v.total += 1;
  if (verdict === "proven" || verdict === "partial" || verdict === "unproven" || verdict === "contradicted") {
    v[verdict] += 1;
  }
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** One row per group, plus the total as `key: "all"`. Receipts group by the
 *  session they are about; a receipt whose session has no spend record lands
 *  under "unplanned" / "unknown". */
export function aggregate(
  outcomes: OutcomeData[],
  receipts: ReceiptFact[],
  by: GroupBy,
): { rows: MetricRow[]; total: MetricRow } {
  const bySession = new Map(outcomes.map((o) => [o.sessionId, o]));
  type Acc = { outcomes: OutcomeData[]; receipts: VerdictCounts };
  const groups = new Map<string, Acc>();
  const total: Acc = { outcomes: [], receipts: emptyVerdicts() };
  const acc = (key: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { outcomes: [], receipts: emptyVerdicts() };
      groups.set(key, g);
    }
    return g;
  };
  for (const o of outcomes) {
    acc(keyOf(o, by)).outcomes.push(o);
    total.outcomes.push(o);
  }
  for (const r of receipts) {
    const o = r.sessionId ? bySession.get(r.sessionId) : undefined;
    const key = o
      ? keyOf(o, by)
      : keyOf({ taskClass: UNPLANNED, cli: "unknown", person: "You", lastTs: r.ts }, by);
    countVerdict(acc(key).receipts, r.verdict);
    countVerdict(total.receipts, r.verdict);
  }
  const row = (key: string, g: Acc): MetricRow => {
    const sessions = g.outcomes.length;
    const mergedSessions = g.outcomes.filter((o) => o.merged);
    const mergedPrs = mergedSessions.reduce((n, o) => n + Math.max(1, o.mergedPrs.length), 0);
    const mergedCost = mergedSessions.reduce((n, o) => n + o.costUsd, 0);
    const reverted = g.outcomes.filter((o) => o.reverted).length;
    const reworked = g.outcomes.filter((o) => o.reworked).length;
    return {
      key,
      sessions,
      costUsd: g.outcomes.reduce((n, o) => n + o.costUsd, 0),
      merged: mergedPrs,
      costPerMerged: mergedPrs > 0 ? mergedCost / mergedPrs : null,
      receipts: g.receipts,
      passRate: g.receipts.total > 0 ? g.receipts.proven / g.receipts.total : null,
      reverted,
      reworked,
      revertRate: sessions > 0 ? reverted / sessions : null,
      reworkRate: sessions > 0 ? reworked / sessions : null,
      medianReviewHours: median(
        g.outcomes.map((o) => o.reviewHours).filter((h): h is number => h != null),
      ),
    };
  };
  const rows = [...groups.entries()].map(([k, g]) => row(k, g));
  rows.sort((a, b) => (by === "week" ? a.key.localeCompare(b.key) : b.costUsd - a.costUsd));
  return { rows, total: row("all", total) };
}

/** Receipts as facts the aggregator understands. */
export function receiptFacts(
  entries: { ts: number; data: ReceiptLike; ref?: { kind: string; id: string } }[],
  sessionOf: (ref?: { kind: string; id: string }) => string | null,
): ReceiptFact[] {
  return entries
    .filter((e) => typeof e.data?.verdict === "string")
    .map((e) => ({ sessionId: sessionOf(e.ref), verdict: e.data.verdict as string, ts: e.ts }));
}

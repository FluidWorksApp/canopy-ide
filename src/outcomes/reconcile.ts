// Gather what happened to each session's work and file it as `outcome`
// ledger entries.
//
// Everything here is local: the ledger (spend, receipts, plans), the
// checkout's own git history (reverts, merge commits) and the provenance
// store (which session raised which PR). No GitHub round trip and nothing
// leaves the machine — "local-first, no telemetry" is the point of the panel.
// The price is that a PR merged on GitHub counts once the checkout has fetched
// it, and a rebase-merge (no "#12" in any subject) is not seen as merged.
//
// Writing outcomes back to the ledger is what lets `outcomesFor` (the
// autonomy view's input) answer from the ledger alone, cheaply and without
// git.

import type { LedgerDraft, LedgerEntry, LedgerQuery } from "../ledger";
import {
  aggregate,
  filesFromPatch,
  isRevertSubject,
  latestSpends,
  mergedPrOf,
  parseMergedPrs,
  receiptFacts,
  sessionOutcomes,
  type GroupBy,
  type MetricRow,
  type PrEdge,
  type ReceiptFact,
  type RevertCommit,
} from "./metrics";
import {
  isOutcome,
  isSpend,
  sessionOfRef,
  type OutcomeData,
  type PlanLike,
  type ReceiptLike,
  type SpendData,
} from "./types";

/** Commits of history scanned for reverts and merges. */
export const LOG_DEPTH = 600;
/** Revert commits whose patches are read per run — each is one git call. */
const MAX_REVERTS = 40;

export interface ReconcileDeps {
  query<D>(root: string, q: LedgerQuery): Promise<LedgerEntry<D>[]>;
  append<D>(root: string, draft: LedgerDraft<D>): Promise<LedgerEntry<D>>;
  gitLog(repo: string, limit: number): Promise<{ hash: string; subject: string; date: string }[]>;
  /** Full-precision commit date (ISO); the log only has the day. */
  commitDate(repo: string, hash: string): Promise<string | null>;
  commitPatch(repo: string, hash: string): Promise<string>;
  provenance(sessionId: string): Promise<{ pr_number: number; at: number }[]>;
  /** When a PR the watcher still holds was opened (ms), if it holds it. */
  prOpened?(repo: string, number: number): number | null;
}

export interface OutcomesReport {
  root: string;
  sinceMs: number;
  generatedAt: number;
  spends: SpendData[];
  outcomes: OutcomeData[];
  receipts: ReceiptFact[];
  /** Merge commits in history over the window (not only agent-made). */
  mergedInWindow: number;
  /** git could not be read — merges and reverts are unknown, not zero. */
  gitUnavailable: boolean;
  /** Plan id → its title, so spend by plan reads as words. */
  planTitles: Map<string, string>;
}

/** Read everything and compute; writes nothing. */
export async function gatherOutcomes(
  deps: ReconcileDeps,
  root: string,
  sinceMs: number,
): Promise<OutcomesReport> {
  // A session edited before the window can still be reworked inside it, so
  // spend is read a rework window further back than what is reported.
  const lookback = sinceMs - 7 * 24 * 60 * 60 * 1000;
  const [spendRows, receiptRows, planRows] = await Promise.all([
    deps.query<SpendData>(root, { kinds: ["spend"], sinceTs: lookback, limit: 5000 }).catch(() => []),
    deps.query<ReceiptLike>(root, { kinds: ["receipt"], sinceTs: sinceMs, limit: 5000 }).catch(() => []),
    deps.query<PlanLike>(root, { kinds: ["plan"], sinceTs: lookback, limit: 1000 }).catch(() => []),
  ]);
  // A spend record keeps the plan id it first saw; a status change gives the
  // plan a new head id, so file the title under every id in the chain.
  const planTitles = new Map<string, string>();
  for (const p of planRows) {
    const title = (typeof p.data?.title === "string" && p.data.title.trim()) || p.subject;
    if (!title) continue;
    planTitles.set(p.id, title);
    if (p.supersedes) planTitles.set(p.supersedes, title);
  }
  const allSpends = latestSpends(spendRows.filter(isSpend).map((e) => e.data));

  let gitUnavailable = false;
  let log: { hash: string; subject: string; date: string }[] = [];
  try {
    log = await deps.gitLog(root, LOG_DEPTH);
  } catch {
    gitUnavailable = true;
  }

  const reverts: RevertCommit[] = [];
  for (const c of log.filter((c) => isRevertSubject(c.subject)).slice(0, MAX_REVERTS)) {
    try {
      const [patch, date] = await Promise.all([
        deps.commitPatch(root, c.hash),
        deps.commitDate(root, c.hash).catch(() => null),
      ]);
      const ts = Date.parse(date ?? c.date);
      if (Number.isFinite(ts)) reverts.push({ hash: c.hash, ts, files: filesFromPatch(patch) });
    } catch {
      // One unreadable commit costs one revert, not the panel.
    }
  }

  const merged = parseMergedPrs(log);
  const hashOf = new Map<number, string>();
  for (const c of log) {
    const n = mergedPrOf(c.subject);
    if (n != null && !hashOf.has(n)) hashOf.set(n, c.hash);
  }

  const edges = new Map<string, PrEdge[]>();
  await Promise.all(
    allSpends.map(async (s) => {
      const rows = await deps.provenance(s.sessionId).catch(() => []);
      if (rows.length === 0) return;
      edges.set(
        s.sessionId,
        rows.map((r) => ({
          prNumber: r.pr_number,
          openedAt: deps.prOpened?.(root, r.pr_number) ?? (r.at > 0 ? r.at * 1000 : null),
        })),
      );
    }),
  );

  // The log has day-resolution dates; time-in-review in hours needs the real
  // merge time, so read it for the PRs a session is linked to.
  const linked = new Set([...edges.values()].flat().map((e) => e.prNumber));
  await Promise.all(
    [...linked]
      .filter((n) => merged.has(n) && hashOf.has(n))
      .slice(0, 50)
      .map(async (n) => {
        const iso = await deps.commitDate(root, hashOf.get(n)!).catch(() => null);
        const ts = iso ? Date.parse(iso) : NaN;
        if (Number.isFinite(ts)) merged.set(n, ts);
      }),
  );

  const outcomes = sessionOutcomes({ spends: allSpends, reverts, merged, edges }).filter(
    (o) => o.lastTs >= sinceMs,
  );
  const inWindow = new Set(outcomes.map((o) => o.sessionId));
  return {
    root,
    sinceMs,
    generatedAt: Date.now(),
    spends: allSpends.filter((s) => inWindow.has(s.sessionId)),
    outcomes,
    receipts: receiptFacts(receiptRows, sessionOfRef),
    mergedInWindow: [...merged.values()].filter((t) => t >= sinceMs).length,
    gitUnavailable,
    planTitles,
  };
}

const sameOutcome = (a: OutcomeData, b: OutcomeData) =>
  a.merged === b.merged &&
  a.reverted === b.reverted &&
  a.reworked === b.reworked &&
  a.taskClass === b.taskClass &&
  Math.abs(a.costUsd - b.costUsd) < 0.005 &&
  a.mergedPrs.join(",") === b.mergedPrs.join(",") &&
  (a.reviewHours ?? -1) === (b.reviewHours ?? -1);

/** File each changed outcome as a ledger entry superseding the last one for
 *  its session. Resolves with how many were written. */
export async function writeOutcomes(
  deps: Pick<ReconcileDeps, "query" | "append">,
  root: string,
  outcomes: OutcomeData[],
  sinceMs: number,
): Promise<number> {
  const existing = await deps
    .query<OutcomeData>(root, { kinds: ["outcome"], sinceTs: sinceMs - 30 * 86_400_000, limit: 5000 })
    .catch(() => []);
  const heads = new Map<string, LedgerEntry<OutcomeData>>();
  for (const e of existing) if (isOutcome(e) && !heads.has(e.data.sessionId)) heads.set(e.data.sessionId, e);
  let written = 0;
  for (const o of outcomes) {
    const prev = heads.get(o.sessionId);
    if (prev && sameOutcome(prev.data, o)) continue;
    try {
      await deps.append<OutcomeData>(root, {
        kind: "outcome",
        author: { kind: "workspace", name: "outcomes", sessionId: o.sessionId, cli: o.cli },
        scope: "personal",
        subject: [o.merged ? "merged" : "not merged", o.reverted && "reverted", o.reworked && "reworked"]
          .filter(Boolean)
          .join(", "),
        ref: { kind: "session", id: o.sessionId },
        data: o,
        ...(prev ? { supersedes: prev.id } : {}),
      });
      written += 1;
    } catch {
      // The next run tries again.
    }
  }
  return written;
}

/** Gather, file what changed, and summarise for the panel. */
export async function reconcileOutcomes(
  deps: ReconcileDeps,
  root: string,
  sinceMs: number,
): Promise<OutcomesReport> {
  const report = await gatherOutcomes(deps, root, sinceMs);
  await writeOutcomes(deps, root, report.outcomes, sinceMs);
  return report;
}

export function groupReport(report: OutcomesReport, by: GroupBy): { rows: MetricRow[]; total: MetricRow } {
  return aggregate(report.outcomes, report.receipts, by);
}

// Spend and outcomes: the front door.
//
//  * `installOutcomes` (App.tsx, once) — records per-session spend at every
//    agent turn end, runs session budgets (warn at 80%, pause at 100%), and
//    keeps each repository's `outcome` ledger entries current in the
//    background.
//  * `outcomesFor` — per-task-class counts from the ledger alone, for the
//    autonomy view ("has this class of work earned more autonomy?").
//  * `realReconcileDeps` — the IPC the Outcomes panel and the background
//    reconciler gather with.

import * as ipc from "../ipc";
import { appendLedger, queryLedger } from "../ledger";
import { onAgentSessionEnd, onAgentTurnEnd, onAgentTurnStart, watchAgentSessionExits } from "../agentTurns";
import { teamIdentity } from "../teamIdentity";
import { cachedReconcileDeps } from "./cache";
import { fingerprint } from "./patchId";
import { postAttention, resolveAttentionByKey } from "../attention";
import { rowFor } from "../prWatchStore";
import { isWorkspaceHost } from "../host";
import { createSpendRecorder, planForSession } from "./spend";
import { ACTIVE_POLL_MS, createBudgetMonitor } from "./budgets";
import { reconcileOutcomes, type ReconcileDeps } from "./reconcile";
import {
  UNPLANNED,
  isOutcome,
  isSpend,
  sessionOfRef,
  type OutcomeData,
  type ReceiptLike,
  type SpendData,
} from "./types";

export * from "./types";

// ------------------------------------------------------------ outcomesFor

export interface OutcomeCounts {
  proven: number;
  partial: number;
  unproven: number;
  contradicted: number;
  reverted: number;
  reworked: number;
  merged: number;
  sessions: number;
  costUsd: number;
}

export interface OutcomesFor {
  /** Keyed by task class (the plan's class; "unplanned" without one). */
  byClass: Record<string, OutcomeCounts>;
  total: OutcomeCounts;
}

const zero = (): OutcomeCounts => ({
  proven: 0,
  partial: 0,
  unproven: 0,
  contradicted: 0,
  reverted: 0,
  reworked: 0,
  merged: 0,
  sessions: 0,
  costUsd: 0,
});

type Query = typeof queryLedger;

/** Per-class outcome counts since `sinceMs`, from the ledger only (no git, no
 *  network): receipts' verdicts, the reconciler's merged/reverted/reworked
 *  flags, and spend. A session with spend but no outcome entry yet counts its
 *  cost and nothing else. Pass `taskClass` to get only that class. */
export async function outcomesFor(
  root: string,
  opts: { taskClass?: string; sinceMs: number },
  query: Query = queryLedger,
): Promise<OutcomesFor> {
  const q = (kinds: ("spend" | "outcome" | "receipt")[]) =>
    query(root, { kinds, sinceTs: opts.sinceMs, limit: 5000 }).catch(() => []);
  const [spends, outcomes, receipts] = await Promise.all([q(["spend"]), q(["outcome"]), q(["receipt"])]);

  const sessionClass = new Map<string, string>();
  const outcomeBy = new Map<string, OutcomeData>();
  for (const e of outcomes) {
    if (isOutcome(e) && !outcomeBy.has(e.data.sessionId)) outcomeBy.set(e.data.sessionId, e.data);
  }
  const spendBy = new Map<string, SpendData>();
  for (const e of spends) {
    if (!isSpend(e)) continue;
    const prev = spendBy.get(e.data.sessionId);
    if (!prev || e.data.lastTs > prev.lastTs) spendBy.set(e.data.sessionId, e.data);
  }
  for (const [id, s] of spendBy) sessionClass.set(id, s.taskClass ?? UNPLANNED);
  for (const [id, o] of outcomeBy) sessionClass.set(id, o.taskClass);

  const byClass: Record<string, OutcomeCounts> = {};
  const total = zero();
  const bucket = (cls: string) => (byClass[cls] ??= zero());
  const add = (cls: string, f: (c: OutcomeCounts) => void) => {
    if (opts.taskClass && cls !== opts.taskClass) return;
    f(bucket(cls));
    f(total);
  };

  for (const id of new Set([...spendBy.keys(), ...outcomeBy.keys()])) {
    const o = outcomeBy.get(id);
    const s = spendBy.get(id);
    add(sessionClass.get(id) ?? UNPLANNED, (c) => {
      c.sessions += 1;
      c.costUsd += Math.max(o?.costUsd ?? 0, s?.costUsd ?? 0);
      if (o?.merged) c.merged += Math.max(1, o.mergedPrs.length);
      if (o?.reverted) c.reverted += 1;
      if (o?.reworked) c.reworked += 1;
    });
  }
  for (const e of receipts) {
    const data = e.data as ReceiptLike | null;
    if (typeof data?.verdict !== "string") continue;
    const sid = sessionOfRef(e.ref);
    const cls = (sid && sessionClass.get(sid)) || UNPLANNED;
    const v = data.verdict;
    if (v === "proven" || v === "partial" || v === "unproven" || v === "contradicted") {
      add(cls, (c) => (c[v] += 1));
    }
  }
  return { byClass, total };
}

// ------------------------------------------------------------ wiring

export const realReconcileDeps: ReconcileDeps = {
  query: queryLedger,
  append: appendLedger,
  gitLog: (repo, limit) => ipc.gitLog(repo, limit),
  commitDate: async (repo, hash) => (await ipc.gitCommitDetail(repo, hash)).date || null,
  commitPatch: async (repo, hash) => (await ipc.gitCommitPatch(repo, hash)).patch,
  provenance: (sessionId) => ipc.provenanceForSession(sessionId),
  prOpened: (repo, number) => {
    const row = rowFor(repo, number);
    const ts = row ? Date.parse(row.created) : NaN;
    return Number.isFinite(ts) ? ts : null;
  },
  // A cloud workspace's host watches PRs for provenance and knows when each
  // opened and merged; the desktop's watcher rows don't cover its checkouts.
  prHistory: async (repo) => (isWorkspaceHost() ? (await ipc.provenanceObserve(repo)).prs : []),
  // GitHub, when its CLI is here: a PR's state, and its diff to recognise a
  // rebase or squash merge by content.
  prState: async (repo, number) => ((await ghReady()) ? (await ipc.ghPrState(repo, number)) || null : null),
  prFingerprint: async (repo, number) => ((await ghReady()) ? fingerprint(await ipc.ghPrDiff(repo, number)) : null),
};

let gh: { at: number; ok: Promise<boolean> } | null = null;
/** Whether gh is usable, asked at most every ten minutes. */
function ghReady(): Promise<boolean> {
  if (!gh || Date.now() - gh.at > 10 * 60_000) gh = { at: Date.now(), ok: ipc.ghAvailable().catch(() => false) };
  return gh.ok;
}

/** What the panel and the background reconcile read through: the same IPC,
 *  with git reads cached and incremental (cache.ts). */
export const outcomesReconcileDeps: ReconcileDeps = cachedReconcileDeps(realReconcileDeps);

/** Background reconcile per repository at most this often. */
const RECONCILE_EVERY_MS = 6 * 60 * 60 * 1000;
const RECONCILE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
/** The CLI's usage store is written as the turn ends; give it a moment. */
const USAGE_SETTLE_MS = 1500;

export interface InstallDeps {
  isPrototype(cwd: string): boolean;
  projectFor?(cwd: string): { id: string; name: string } | null;
}

export function installOutcomes(deps: InstallDeps): () => void {
  const spend = createSpendRecorder({
    usage: ipc.agentUsage,
    append: appendLedger,
    query: queryLedger,
    identity: teamIdentity,
  });
  const budgets = createBudgetMonitor({
    usage: ipc.agentUsage,
    ptyWrite: (id, data) => ipc.ptyWrite(id, data),
    notify: (input) => void postAttention(input),
    resolveNotice: (key) => resolveAttentionByKey(key, "answered"),
    isPrototype: deps.isPrototype,
    projectFor: deps.projectFor,
    planBudget: async (root, sessionId) => {
      const plan = await planForSession({ query: queryLedger }, root, sessionId);
      const usd = plan?.data.budgetUsd;
      return typeof usd === "number" && usd > 0 ? usd : null;
    },
  });
  const lastReconcile = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const offStart = onAgentTurnStart((t) => void budgets.onTurnStart(t));
  const offEnd = onAgentTurnEnd((t) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      void (async () => {
        const rec = await spend.record(t);
        await budgets.onTurnEnd(t, rec?.costUsd ?? null);
        const last = lastReconcile.get(t.root) ?? 0;
        if (Date.now() - last > RECONCILE_EVERY_MS) {
          lastReconcile.set(t.root, Date.now());
          await reconcileOutcomes(outcomesReconcileDeps, t.root, Date.now() - RECONCILE_WINDOW_MS).catch(() => {});
        }
      })();
    }, USAGE_SETTLE_MS);
    timers.add(timer);
  });
  // The session is over (SessionEnd, or its terminal exited): the final
  // spend write, after the usage store has settled.
  const offSessionEnd = onAgentSessionEnd((end) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      void spend.finish(end);
    }, USAGE_SETTLE_MS);
    timers.add(timer);
  });
  const stopExits = watchAgentSessionExits();
  const poll = setInterval(() => void budgets.tick(), ACTIVE_POLL_MS);

  return () => {
    offStart();
    offEnd();
    offSessionEnd();
    stopExits();
    clearInterval(poll);
    for (const t of timers) clearTimeout(t);
  };
}

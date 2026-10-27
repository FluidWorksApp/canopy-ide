// The shapes the outcomes feature reads and writes in the ledger.
//
// `spend` and `outcome` are ours. `plan` and `receipt` belong to sibling
// features; we read only the few fields we need and type them as optional so a
// plan or receipt written by an older or newer build never breaks the join.

import type { LedgerEntry } from "../ledger";

/** One file an agent session edited, with when it last did. Kept on the spend
 *  record because turn events are ephemeral: revert and rework detection run
 *  days later and need to know which files a session owned. */
export interface TouchedFile {
  path: string;
  ts: number;
}

/** `spend` ledger entry data: one agent session's running cost. Rewritten (as
 *  a successor that `supersedes` the last one) at each turn end where the
 *  numbers moved, so a query sees one head per session. `ref` is
 *  `{kind:"session", id: sessionId}`. */
export interface SpendData {
  /** Discriminates from other writers of the `spend` kind. */
  type: "session";
  sessionId: string;
  /** Agent registry id. */
  cli: string;
  /** Which account ran it ("default" for the main login). */
  profile: string;
  /** Who to attribute it to: the signed-in Canopy team member when there is
   *  one, else the CLI account label, else "You". */
  person: string;
  /** The team member's account id, when signed in — what groups one person's
   *  sessions across computers. */
  personId?: string;
  /** When the session ended (its CLI's SessionEnd, or its terminal exiting):
   *  this record is final. */
  endedAt?: number;
  cwd: string;
  costUsd: number;
  /** True when the CLI reported its own price; false = estimated from tokens. */
  costReported: boolean;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  model: string | null;
  /** The plan (ledger id when first seen) this session works under, if any. */
  planId?: string;
  /** The plan's task class, copied so outcomes group without a second join. */
  taskClass?: string;
  files: TouchedFile[];
  firstTs: number;
  lastTs: number;
}

/** `outcome` ledger entry data: what became of one session's work, written by
 *  the reconciler (outcomes/reconcile.ts). `ref` is the session. */
export interface OutcomeData {
  type: "session";
  sessionId: string;
  cli: string;
  person: string;
  personId?: string;
  taskClass: string;
  costUsd: number;
  /** PR numbers this session raised (provenance) that have merged. */
  mergedPrs: number[];
  merged: boolean;
  /** A later `git revert` touched files this session edited. */
  reverted: boolean;
  /** Another session re-edited this session's files within a week. */
  reworked: boolean;
  /** Hours from PR opened to merged, for the session's first merged PR. */
  reviewHours?: number;
  lastTs: number;
}

/** What we read off a plan entry. */
export interface PlanLike {
  class?: string;
  taskClass?: string;
  budgetUsd?: number;
  title?: string;
}

/** What we read off a receipt entry. */
export interface ReceiptLike {
  verdict?: "proven" | "partial" | "unproven" | "contradicted" | string;
  costUsd?: number;
}

export type SpendEntry = LedgerEntry<SpendData>;
export type OutcomeEntry = LedgerEntry<OutcomeData>;

/** Plans with no class, and sessions with no plan, group here. */
export const UNPLANNED = "unplanned";

/** A plan's task class, whichever field its writer used. */
export function planClass(plan: PlanLike | undefined | null): string | undefined {
  const c = plan?.class ?? plan?.taskClass;
  return typeof c === "string" && c.trim() ? c.trim() : undefined;
}

/** The session a ledger `ref` points at. A turn ref is `<sessionId>:<startedAt>`
 *  (agentTurns.ts), so the session is everything before the last colon. */
export function sessionOfRef(ref: { kind: string; id: string } | undefined): string | null {
  if (!ref) return null;
  if (ref.kind === "session") return ref.id;
  if (ref.kind === "turn") {
    const i = ref.id.lastIndexOf(":");
    return i > 0 ? ref.id.slice(0, i) : ref.id;
  }
  return null;
}

export const isSpend = (e: LedgerEntry): e is SpendEntry => {
  const d = e.data as Partial<SpendData> | null;
  return e.kind === "spend" && !!d && d.type === "session" && typeof d.sessionId === "string";
};

export const isOutcome = (e: LedgerEntry): e is OutcomeEntry => {
  const d = e.data as Partial<OutcomeData> | null;
  return e.kind === "outcome" && !!d && d.type === "session" && typeof d.sessionId === "string";
};

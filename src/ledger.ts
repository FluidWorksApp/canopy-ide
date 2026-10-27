// The ledger: one durable, append-only store for what the brain and the agents
// produce — plans, proof receipts, memories, awareness notes, handoffs, review
// verdicts, rules, outcomes, spend.
//
// The store is Rust (src-tauri/src/ledger.rs): one JSONL file per repository,
// keyed by the repo's main checkout so every worktree of it shares one ledger.
// This is the typed front door. Features own their `kind`'s `data` shape and
// should export a type for it; the ledger owns id, time, attribution, scope
// and supersession.
//
// Status changes never rewrite an entry. `setLedgerStatus` appends a successor
// that `supersedes` it, and `queryLedger` returns only chain heads — so the id
// a caller holds may be superseded; the returned entry carries the new one,
// and any id in a chain still reaches its head.

import * as ipc from "./ipc";

export type LedgerKind =
  | "plan"
  | "receipt"
  | "memory"
  | "awareness"
  | "handoff"
  | "rule"
  | "spend"
  | "review"
  | "outcome";

export interface LedgerEntry<D = unknown> {
  id: string;
  kind: LedgerKind;
  ts: number;
  root: string;
  author: {
    kind: "agent" | "human" | "brain" | "workspace";
    name: string;
    sessionId?: string;
    cli?: string;
    ptyId?: number;
  };
  scope: "personal" | "project" | "team";
  subject?: string;
  /** session/turn/PR/plan id this is about */
  ref?: { kind: string; id: string };
  data: D;
  expiresAt?: number;
  supersedes?: string;
  status?: string;
}

/** What a caller supplies: id, ts and root are assigned by the store (an
 *  explicit id/ts is kept — useful for idempotent imports). */
export type LedgerDraft<D = unknown> = Omit<LedgerEntry<D>, "id" | "ts" | "root"> & {
  id?: string;
  ts?: number;
};

export interface LedgerQuery {
  kinds?: LedgerKind[];
  refKind?: string;
  refId?: string;
  sinceTs?: number;
  /** Default 200, max 5000. */
  limit?: number;
}

/** Append one entry under the repository containing `root` (any directory of
 *  it). Resolves with the stored entry, including its canonical `root`. */
export async function appendLedger<D>(root: string, entry: LedgerDraft<D>): Promise<LedgerEntry<D>> {
  return (await ipc.ledgerAppend(root, entry)) as LedgerEntry<D>;
}

/** Newest first, chain heads only, expired entries dropped. */
export async function queryLedger<D = unknown>(
  root: string,
  query: LedgerQuery = {},
): Promise<LedgerEntry<D>[]> {
  return (await ipc.ledgerQuery(root, query)) as LedgerEntry<D>[];
}

/** Append a successor with `status`; resolves with the new head. */
export async function setLedgerStatus<D = unknown>(
  root: string,
  id: string,
  status: string,
): Promise<LedgerEntry<D>> {
  return (await ipc.ledgerUpdateStatus(root, id, status)) as LedgerEntry<D>;
}

/** The canonical root `path` files under — what entries' `root` will say. */
export const ledgerRoot = (path: string): Promise<string> => ipc.ledgerRoot(path);

// ------------------------------------------------------------ subscription

type Listener = { root: string; cb: (entry: LedgerEntry) => void };
const listeners = new Set<Listener>();
let armed: Promise<void> | null = null;

/** The root an entry is filed under is canonical (the main checkout); a
 *  subscriber may have passed any directory of the repo. Match when either
 *  contains the other, which covers the main checkout and its subfolders.
 *  Linked worktrees live outside the main checkout's directory on some
 *  setups: subscribe with the canonical `root` from any stored entry (or an
 *  append result) to be exact. */
function sameRepo(subscribed: string, filed: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  const a = norm(subscribed);
  const b = norm(filed);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) || subscribed === "*";
}

function arm(): void {
  if (armed) return;
  armed = ipc
    .onLedgerAppended((wire) => {
      const entry = wire as LedgerEntry;
      for (const l of listeners) {
        if (sameRepo(l.root, entry.root)) {
          try {
            l.cb(entry);
          } catch {
            // One subscriber's bug must not starve the others.
          }
        }
      }
    })
    .then(() => {})
    .catch(() => {
      // Retry on the next subscribe rather than never hearing again.
      armed = null;
    });
}

/** Hear every entry appended under `root` (any window, any writer, status
 *  changes included). Pass "*" for every repository. Returns an unsubscribe. */
export function subscribeLedger(root: string, cb: (entry: LedgerEntry) => void): () => void {
  const l: Listener = { root, cb };
  listeners.add(l);
  arm();
  return () => {
    listeners.delete(l);
  };
}

/** Tests only. */
export function resetLedgerForTests(): void {
  listeners.clear();
  armed = null;
}

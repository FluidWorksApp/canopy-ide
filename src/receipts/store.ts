// What every surface reads: the latest receipt state per agent session.
//
// The ledger is the durable record; this is the live view over it — a
// session's receipt is "verifying" while the engine runs, then the stored
// record. Surfaces key by session id (micro-task runs are sessions too, so
// they get the same badge) and fall back to the terminal id where that is all
// they have. A surface mounting for a session this window never verified
// hydrates once from the ledger.
//
// No React or IPC at module top level beyond the ledger import: microTasks.ts
// reads `latestReceiptFor` synchronously while building a Raise PR brief.

import { useSyncExternalStore } from "react";
import { queryLedger, subscribeLedger, type LedgerEntry } from "../ledger";
import type { ReceiptData, ReceiptRecord } from "./types";

export type ReceiptState =
  | { state: "verifying"; since: number }
  | { state: "done"; record: ReceiptRecord }
  | { state: "error"; message: string; record?: ReceiptRecord };

const bySession = new Map<string, ReceiptState>();
const byPty = new Map<number, string>();
/** Newest last; bounded — the PR lookup only ever wants a recent one. */
const recent: ReceiptRecord[] = [];
const listeners = new Set<() => void>();
const hydrated = new Set<string>();
let version = 0;

function changed(): void {
  version++;
  for (const l of listeners) {
    try {
      l();
    } catch {
      // A surface's bug must not stop the others hearing.
    }
  }
}

export function subscribeReceipts(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function receiptVersion(): number {
  return version;
}

export function receiptFor(sessionId?: string | null, ptyId?: number | null): ReceiptState | null {
  const id = sessionId || (ptyId != null ? byPty.get(ptyId) : undefined);
  return id ? (bySession.get(id) ?? null) : null;
}

export function setVerifying(sessionId: string, ptyId: number | null): void {
  if (ptyId != null) byPty.set(ptyId, sessionId);
  const prev = bySession.get(sessionId);
  // Keep the last record reachable while re-verifying: the panel shows it
  // greyed rather than going blank.
  bySession.set(sessionId, { state: "verifying", since: Date.now() });
  if (prev?.state === "done") lastDone.set(sessionId, prev.record);
  changed();
}

const lastDone = new Map<string, ReceiptRecord>();

/** The previous finished record while a re-verify runs. */
export function previousReceipt(sessionId: string): ReceiptRecord | undefined {
  const cur = bySession.get(sessionId);
  if (cur?.state === "done") return cur.record;
  return lastDone.get(sessionId);
}

export function setReceiptError(sessionId: string, message: string): void {
  bySession.set(sessionId, { state: "error", message, record: lastDone.get(sessionId) });
  changed();
}

export function recordFromEntry(entry: LedgerEntry<ReceiptData>): ReceiptRecord {
  return { ...entry.data, id: entry.id, ts: entry.ts, root: entry.root };
}

export function setReceipt(record: ReceiptRecord): void {
  const cur = bySession.get(record.sessionId);
  // An older record (hydration racing a fresh run) never replaces a newer one.
  if (cur?.state === "done" && cur.record.ts > record.ts) return;
  bySession.set(record.sessionId, { state: "done", record });
  if (record.ptyId != null) byPty.set(record.ptyId, record.sessionId);
  lastDone.set(record.sessionId, record);
  const at = recent.findIndex((r) => r.id === record.id);
  if (at >= 0) recent.splice(at, 1);
  recent.push(record);
  recent.sort((a, b) => a.ts - b.ts);
  if (recent.length > 100) recent.splice(0, recent.length - 100);
  hydrated.add(record.sessionId);
  changed();
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** The newest receipt for a branch (preferred) or a checkout path — what a
 *  Raise PR brief attaches. Synchronous on purpose. */
export function latestReceiptFor(q: { branch?: string | null; path?: string | null }): ReceiptRecord | null {
  const path = q.path ? norm(q.path) : null;
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    if (q.branch && r.branch === q.branch) return r;
  }
  if (!path) return null;
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    const cwd = norm(r.cwd);
    if (cwd === path || cwd.startsWith(`${path}/`) || norm(r.root) === path) return r;
  }
  return null;
}

/** Load the latest stored receipt for a session once (a surface mounted for
 *  a session this window did not verify — e.g. after a restart). */
export async function hydrateReceipt(cwd: string, sessionId: string): Promise<void> {
  if (!cwd || !sessionId || hydrated.has(sessionId)) return;
  hydrated.add(sessionId);
  try {
    const [entry] = await queryLedger<ReceiptData>(cwd, {
      kinds: ["receipt"],
      refKind: "session",
      refId: sessionId,
      limit: 1,
    });
    if (entry && !bySession.has(sessionId)) setReceipt(recordFromEntry(entry));
  } catch {
    // No ledger (remote without a desktop, an old build): stay unverified.
  }
}

/** Receipts appended by another window of the app reach this one too. */
export function followLedger(): () => void {
  return subscribeLedger("*", (entry) => {
    if (entry.kind !== "receipt") return;
    const data = entry.data as ReceiptData;
    if (!data || typeof data.sessionId !== "string") return;
    setReceipt(recordFromEntry(entry as LedgerEntry<ReceiptData>));
  });
}

export function useReceipt(sessionId?: string | null, ptyId?: number | null): ReceiptState | null {
  useSyncExternalStore(subscribeReceipts, receiptVersion, receiptVersion);
  return receiptFor(sessionId, ptyId);
}

/** Tests only. */
export function resetReceiptsForTests(): void {
  bySession.clear();
  byPty.clear();
  recent.length = 0;
  hydrated.clear();
  lastDone.clear();
  listeners.clear();
  version = 0;
}

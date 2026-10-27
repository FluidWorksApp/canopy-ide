// An in-memory ledger for tests of the plan and review features: same fold
// (chain heads only, newest first) and the same subscription, no IPC.
import type { LedgerDraft, LedgerEntry, LedgerQuery } from "../ledger";

export function memoryLedger() {
  const rows: LedgerEntry[] = [];
  const subs = new Set<(e: LedgerEntry) => void>();
  let n = 0;
  const heads = () => {
    const gone = new Set(rows.map((r) => r.supersedes).filter(Boolean));
    return rows.filter((r) => !gone.has(r.id));
  };
  return {
    rows,
    appendLedger: async <D,>(root: string, draft: LedgerDraft<D>): Promise<LedgerEntry<D>> => {
      n++;
      const entry = { ...draft, id: draft.id ?? `e${n}`, ts: draft.ts ?? 1000 + n, root } as LedgerEntry<D>;
      rows.push(entry as LedgerEntry);
      for (const s of subs) s(entry as LedgerEntry);
      return entry;
    },
    queryLedger: async <D,>(_root: string, q: LedgerQuery = {}): Promise<LedgerEntry<D>[]> =>
      heads()
        .filter((r) => !q.kinds?.length || q.kinds.includes(r.kind))
        .filter((r) => !q.refKind || r.ref?.kind === q.refKind)
        .filter((r) => !q.refId || r.ref?.id === q.refId)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, q.limit ?? 200) as LedgerEntry<D>[],
    subscribeLedger: (_root: string, cb: (e: LedgerEntry) => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    heads,
  };
}

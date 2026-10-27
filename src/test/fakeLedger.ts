// An in-memory stand-in for the Rust ledger (src-tauri/src/ledger.rs) with
// the same visible rules: append-only, newest-first queries by kind and ref,
// status updates that append a superseding copy so only chain heads return.
// Use as `vi.mock("./ledger", async () => (await import("./test/fakeLedger")).fakeLedger)`.
import { vi } from "vitest";

type Row = {
  id: string;
  ts: number;
  kind: string;
  ref?: { kind: string; id: string };
  data: unknown;
  status?: string;
  supersedes?: string;
  [k: string]: unknown;
};

const rows: Row[] = [];
let n = 0;
const heads = () => {
  const superseded = new Set(rows.map((r) => r.supersedes).filter(Boolean));
  return rows.filter((r) => !superseded.has(r.id));
};

export const fakeLedger = {
  rows,
  reset() {
    rows.length = 0;
    n = 0;
  },
  appendLedger: vi.fn(async (_root: string, d: Record<string, unknown>) => {
    const row = { ...d, id: `e${++n}`, ts: n } as Row;
    rows.push(row);
    return row;
  }),
  queryLedger: vi.fn(
    async (_root: string, q: { kinds?: string[]; refKind?: string; refId?: string; limit?: number }) =>
      heads()
        .filter((r) => !q.kinds || q.kinds.includes(r.kind))
        .filter((r) => !q.refKind || r.ref?.kind === q.refKind)
        .filter((r) => !q.refId || r.ref?.id === q.refId)
        .reverse()
        .slice(0, q.limit ?? 200),
  ),
  setLedgerStatus: vi.fn(async (_root: string, id: string, status: string) => {
    const old = rows.find((r) => r.id === id);
    if (!old) throw new Error(`no ledger entry ${id}`);
    const row = { ...old, id: `e${++n}`, ts: n, status, supersedes: id };
    rows.push(row);
    return row;
  }),
  subscribeLedger: vi.fn(() => () => {}),
  ledgerRoot: vi.fn(async (p: string) => p),
};

// One Canopy instance extracts a session's memory, never two.
//
// Every running Canopy on the machine sees the same hook events, so without
// this two open windows (or a desktop and a cloud workspace window) would
// each ask the brain about the same turns and each propose the same entries.
// The lease lives in the ledger, which every instance already shares: an
// instance appends a claim for a key (a session, a proposal) and holds it
// while its earliest live claim is the earliest live claim of anyone's.
// Ledger ids sort by time, so two instances racing for a free lease both
// read the same order and agree on one winner, with no lock file.

import { appendLedger, queryLedger, type LedgerEntry } from "./ledger";

export interface LeaseData {
  type: "lease";
  key: string;
  owner: string;
}

/** This app window's identity for the length of its life. */
export const LEASE_OWNER = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const LEASE_REF = "memory-lease";

export interface LeaseDeps {
  query: (root: string, key: string) => Promise<LedgerEntry<LeaseData>[]>;
  append: (root: string, key: string, owner: string, until: number) => Promise<unknown>;
  now: () => number;
  owner: string;
}

const realDeps: LeaseDeps = {
  query: (root, key) => queryLedger<LeaseData>(root, { kinds: ["memory"], refKind: LEASE_REF, refId: key, limit: 50 }),
  append: (root, key, owner, until) =>
    appendLedger<LeaseData>(root, {
      kind: "memory",
      author: { kind: "workspace", name: "memory" },
      scope: "personal",
      subject: "Memory extraction lease",
      ref: { kind: LEASE_REF, id: key },
      data: { type: "lease", key, owner },
      // The ledger drops it when the term ends; a crashed holder frees it.
      expiresAt: until,
    }),
  now: () => Date.now(),
  owner: LEASE_OWNER,
};

function live(rows: LedgerEntry<LeaseData>[], key: string, now: number): LedgerEntry<LeaseData>[] {
  return rows
    .filter((e) => e.data?.type === "lease" && e.data.key === key && (e.expiresAt ?? 0) > now)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Hold (or take) the lease on `key` for `ttlMs`. True when this instance is
 *  the holder and may do the work; false when another instance holds it. A
 *  ledger that cannot be read or written answers true: a lost lease costs a
 *  duplicate proposal, a stuck one would cost memory altogether. */
export async function claimLease(
  root: string,
  key: string,
  ttlMs: number,
  deps: LeaseDeps = realDeps,
): Promise<boolean> {
  try {
    const now = deps.now();
    const rows = live(await deps.query(root, key), key, now);
    const holder = rows[0];
    if (holder && holder.data.owner !== deps.owner) return false;
    if (holder) {
      // Renew before the term runs out so a long session keeps one holder.
      const latest = Math.max(...rows.filter((r) => r.data.owner === deps.owner).map((r) => r.expiresAt ?? 0));
      if (latest - now < ttlMs / 2) await deps.append(root, key, deps.owner, now + ttlMs);
      return true;
    }
    await deps.append(root, key, deps.owner, now + ttlMs);
    const after = live(await deps.query(root, key), key, deps.now());
    return !after.length || after[0].data.owner === deps.owner;
  } catch {
    return true;
  }
}

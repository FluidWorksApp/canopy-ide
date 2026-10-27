import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "./ledger";
import { claimLease, type LeaseData, type LeaseDeps } from "./memoryLease";

/** A shared in-memory ledger two "instances" append to, with ids that sort by
 *  time like the real one's. */
function sharedLedger() {
  const rows: LedgerEntry<LeaseData>[] = [];
  let clock = 1_000;
  let seq = 0;
  const deps = (owner: string): LeaseDeps => ({
    owner,
    now: () => clock,
    query: async () => [...rows].reverse(),
    append: async (root, key, who, until) => {
      seq += 1;
      rows.push({
        id: `${String(clock).padStart(13, "0")}-${String(seq).padStart(4, "0")}`,
        kind: "memory",
        ts: clock,
        root,
        author: { kind: "workspace", name: "memory" },
        scope: "personal",
        ref: { kind: "memory-lease", id: key },
        data: { type: "lease", key, owner: who },
        expiresAt: until,
      } as LedgerEntry<LeaseData>);
    },
  });
  return { deps, rows, tick: (ms: number) => (clock += ms) };
}

describe("memory extraction lease", () => {
  it("lets exactly one instance extract a session", async () => {
    const l = sharedLedger();
    const [a, b] = await Promise.all([
      claimLease("/r", "s1", 60_000, l.deps("A")),
      claimLease("/r", "s1", 60_000, l.deps("B")),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    // The holder keeps it on the next turn; the other still stands aside.
    const holder = a ? "A" : "B";
    const other = a ? "B" : "A";
    l.tick(10_000);
    expect(await claimLease("/r", "s1", 60_000, l.deps(holder))).toBe(true);
    expect(await claimLease("/r", "s1", 60_000, l.deps(other))).toBe(false);
  });

  it("renews before the term ends and frees a lease whose holder went away", async () => {
    const l = sharedLedger();
    expect(await claimLease("/r", "s1", 60_000, l.deps("A"))).toBe(true);
    l.tick(40_000);
    expect(await claimLease("/r", "s1", 60_000, l.deps("A"))).toBe(true);
    expect(l.rows).toHaveLength(2);
    l.tick(30_000);
    expect(await claimLease("/r", "s1", 60_000, l.deps("B"))).toBe(false);
    l.tick(200_000);
    expect(await claimLease("/r", "s1", 60_000, l.deps("B"))).toBe(true);
  });

  it("keeps separate keys separate, and fails open when the ledger fails", async () => {
    const l = sharedLedger();
    expect(await claimLease("/r", "s1", 60_000, l.deps("A"))).toBe(true);
    expect(await claimLease("/r", "s2", 60_000, l.deps("B"))).toBe(true);
    const broken: LeaseDeps = { ...l.deps("C"), query: async () => { throw new Error("no ledger"); } };
    expect(await claimLease("/r", "s1", 60_000, broken)).toBe(true);
  });
});

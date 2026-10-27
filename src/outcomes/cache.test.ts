import { describe, expect, it, vi } from "vitest";
import { cachedReconcileDeps, INCREMENTAL_READ, keepReport, lastReport, type CacheStore } from "./cache";
import type { OutcomesReport, ReconcileDeps } from "./reconcile";

const row = (i: number) => ({ hash: `h${i}`, subject: `c${i}`, date: "2026-01-01" });
const history = (n: number) => Array.from({ length: n }, (_, i) => row(n - i)); // newest first

function store(): CacheStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

function base(log: { current: ReturnType<typeof history> }): ReconcileDeps & { gitLog: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn(),
    append: vi.fn(),
    gitLog: vi.fn(async (_r: string, limit: number) => log.current.slice(0, limit)),
    commitDate: vi.fn(async (_r: string, h: string) => `date-${h}`),
    commitPatch: vi.fn(async () => "diff --git a/a b/a\n+x"),
    provenance: vi.fn(async () => []),
    prState: vi.fn(async (_r: string, n: number) => (n === 1 ? "MERGED" : "OPEN")),
    prFingerprint: vi.fn(async () => new Map([["a\u0000x", 1]])),
  } as never;
}

describe("the Outcomes git cache", () => {
  it("reads the log incrementally from the last commit it saw", async () => {
    const log = { current: history(300) };
    const b = base(log);
    const s = store();
    const deps = cachedReconcileDeps(b, s);
    expect(await deps.gitLog("/r", 600)).toHaveLength(300);
    expect(b.gitLog).toHaveBeenLastCalledWith("/r", 600);
    log.current = [row(302), row(301), ...log.current];
    const again = await cachedReconcileDeps(b, s).gitLog("/r", 600);
    expect(again.slice(0, 3).map((c) => c.hash)).toEqual(["h302", "h301", "h300"]);
    expect(again).toHaveLength(302);
    // Only the short read: the cached history joined it.
    expect(b.gitLog).toHaveBeenLastCalledWith("/r", INCREMENTAL_READ);
  });

  it("reads everything again when history was rewritten", async () => {
    const log = { current: history(100) };
    const b = base(log);
    const s = store();
    await cachedReconcileDeps(b, s).gitLog("/r", 600);
    log.current = history(100).map((c) => ({ ...c, hash: `new-${c.hash}` }));
    const out = await cachedReconcileDeps(b, s).gitLog("/r", 600);
    expect(out[0].hash).toBe("new-h100");
    expect(b.gitLog).toHaveBeenLastCalledWith("/r", 600);
  });

  it("keeps commit dates, settled PR states and open PRs' content", async () => {
    const b = base({ current: [] });
    const s = store();
    const deps = cachedReconcileDeps(b, s);
    await deps.commitDate("/r", "h1");
    await cachedReconcileDeps(b, s).commitDate("/r", "h1");
    expect(b.commitDate).toHaveBeenCalledTimes(1);
    await deps.prState!("/r", 1);
    await deps.prState!("/r", 1);
    expect(b.prState).toHaveBeenCalledTimes(1);
    await deps.prState!("/r", 2);
    await deps.prState!("/r", 2);
    expect(b.prState).toHaveBeenCalledTimes(3);
    await deps.prFingerprint!("/r", 2);
    // gh gone later: the fingerprint seen while it was open still answers.
    (b.prFingerprint as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const later = await cachedReconcileDeps(b, s).prFingerprint!("/r", 2);
    expect(later?.get("a\u0000x")).toBe(1);
  });

  it("remembers the last report so reopening shows it at once", () => {
    const report = { root: "/r", sinceMs: 1 } as OutcomesReport;
    expect(lastReport("/r", 30)).toBeNull();
    keepReport("/r", 30, report);
    expect(lastReport("/r", 30)).toBe(report);
    expect(lastReport("/r", 7)).toBeNull();
  });
});

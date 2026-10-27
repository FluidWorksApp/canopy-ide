// Live team memory for a project: every memory chain head across its
// repositories, refreshed as the ledger changes. Shared by the Memory panel
// and the rail's review badge.
import { useCallback, useEffect, useRef, useState } from "react";
import { ledgerRoot, subscribeLedger } from "./ledger";
import { listMemories, needsReview, type MemoryEntry } from "./memoryLedger";

export interface MemoryRow {
  /** The canonical ledger root the entry is filed under. */
  root: string;
  entry: MemoryEntry;
}

/** Every memory across the project's repositories, live. A project's
 *  components can be separate repos, each with its own ledger; components
 *  in one repo fold to one canonical root and are read once. */
export function useMemories(roots: readonly string[], load = listMemories) {
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canon, setCanon] = useState<string[]>([]);
  const key = roots.join("\n");

  useEffect(() => {
    let cancelled = false;
    void Promise.all(roots.map((r) => ledgerRoot(r).catch(() => r))).then((list) => {
      if (!cancelled) setCanon([...new Set(list)]);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const lists = await Promise.all(
        canon.map(async (root) => (await load(root)).map((entry) => ({ root, entry }))),
      );
      if (mine !== seq.current) return;
      setRows(lists.flat().sort((a, b) => b.entry.data.createdAt - a.entry.data.createdAt));
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(String(e));
    } finally {
      if (mine === seq.current) setLoaded(true);
    }
  }, [canon, load]);

  useEffect(() => {
    if (!canon.length) return;
    void reload();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const offs = canon.map((root) =>
      subscribeLedger(root, (e) => {
        if (e.kind !== "memory") return;
        // A status change is several appends in a row; one reload covers them.
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void reload(), 150);
      }),
    );
    return () => {
      if (timer) clearTimeout(timer);
      offs.forEach((off) => off());
    };
  }, [canon, reload]);

  return { rows, loaded, error, reload };
}

/** Entries waiting on a person — the rail's badge. */
export function useMemoryReviewCount(roots: readonly string[]): number {
  const { rows } = useMemories(roots);
  return rows.filter((r) => needsReview(r.entry)).length;
}

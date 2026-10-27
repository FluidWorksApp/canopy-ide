// The undo-turn timeline's honesty about what it can't undo: a turn in which
// an agent ran an approved irreversible action (canopy-hook recorded it as
// `allowed-once` with an irreversible finding) is marked "can't be undone",
// next to the generic note that file snapshots can't reach the outside world.

import { queryLedger } from "../ledger";
import type { BlockData } from "./rules";

export interface TurnWindow {
  n: number;
  startedMs: number | null;
  endedMs: number | null;
}

/** Turn number → what ran in it that can't be undone (labels). */
export async function irreversibleByTurn(
  cwd: string,
  sessionId: string,
  turns: readonly TurnWindow[],
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!sessionId || turns.length === 0) return out;
  const entries = await queryLedger<Partial<BlockData>>(cwd, { kinds: ["rule"], limit: 1000 });
  for (const e of entries) {
    const d = e.data;
    if (d?.type !== "block" || d.status !== "allowed-once" || d.findingKind !== "irreversible") continue;
    if (d.sessionId !== sessionId) continue;
    const turn = turns.find(
      (t) => t.startedMs != null && e.ts >= t.startedMs && (t.endedMs == null || e.ts <= t.endedMs),
    );
    if (!turn) continue;
    const label = d.label ? `${d.label}: ${d.action ?? ""}` : (d.action ?? "");
    out.set(turn.n, [...(out.get(turn.n) ?? []), label]);
  }
  return out;
}

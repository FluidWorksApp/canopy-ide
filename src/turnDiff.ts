// What a turn changed on disk, from the turn-rollback snapshots
// (src-tauri/src/turn_rollback.rs): whole-tree commits taken when the turn
// started and ended, tracked and untracked files alike. Diffing the pair is
// exactly what the turn did — Bash edits, generated files and deletions
// included — where the edit journal only sees the agent's edit tools.
//
// Shared by proof receipts (src/receipts/engine.ts) and team memory
// (src/memoryExtract.ts).

import * as ipc from "./ipc";

/** The snapshot pair closest to a turn's start. The snapshot is stamped when
 *  canopy-hook ran; the turn event is observed up to a batch later, so the
 *  closest start inside the turn wins. */
export function pickTurnSnapshots(
  list: ipc.TurnList,
  startedAt: number,
  endedAt: number,
): { start: string; end: string | null } | null {
  if (!list.git) return null;
  const hit = [...list.turns]
    .filter((p) => p.start && p.start.ts_ms >= startedAt - 15_000 && p.start.ts_ms <= endedAt + 2_000)
    .sort((a, b) => Math.abs(a.start!.ts_ms - startedAt) - Math.abs(b.start!.ts_ms - startedAt))[0];
  return hit?.start ? { start: hit.start.commit, end: hit.end?.commit ?? null } : null;
}

export interface TurnFileChange {
  path: string;
  status: "add" | "modify" | "delete";
}

export interface TurnDiffDeps {
  turnList: typeof ipc.turnList;
  run: typeof ipc.receiptRunCheck;
}

const realDeps: TurnDiffDeps = {
  turnList: (cwd, sessionId) => ipc.turnList(cwd, sessionId),
  run: (cwd, argv, opts) => ipc.receiptRunCheck(cwd, argv, opts),
};

/** Every file the turn changed between its start and end snapshots, by
 *  status. Null when there is no snapshot pair (no git, a hookless session,
 *  rollback off): the caller falls back to the edit journal. */
export async function turnFileChanges(
  t: { cwd: string; sessionId: string; startedAt: number; endedAt: number },
  deps: TurnDiffDeps = realDeps,
): Promise<TurnFileChange[] | null> {
  try {
    const pair = pickTurnSnapshots(await deps.turnList(t.cwd, t.sessionId), t.startedAt, t.endedAt);
    if (!pair?.end) return null;
    const r = await deps.run(t.cwd, ["git", "diff", "--name-status", "--no-renames", pair.start, pair.end], {
      timeoutMs: 20_000,
      head: true,
      keepBytes: 64 * 1024,
    });
    if (r.code !== 0) return null;
    return r.stdout
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((cols) => cols.length >= 2 && cols[1].trim())
      .map(([code, path]) => ({
        path: path.trim(),
        status: code.startsWith("A") ? "add" : code.startsWith("D") ? "delete" : "modify",
      }));
  } catch {
    return null;
  }
}

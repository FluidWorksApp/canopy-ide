// What a turn changed on disk, from the turn-rollback snapshots
// (src-tauri/src/turn_rollback.rs): whole-tree commits taken when the turn
// started and ended, tracked and untracked files alike. Diffing the pair is
// exactly what the turn did — Bash edits, generated files and deletions
// included — where the edit journal only sees the agent's edit tools.
//
// Shared by proof receipts (src/receipts/engine.ts), team memory
// (src/memoryExtract.ts), awareness (src/awareness/engine.ts) and the
// builder lens's step summaries (src/lensSteps.ts, lensCheckpoints.ts).

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

// ------------------------------------------------- ranges and patches
// The pair itself, the files between it and the patch, for features that
// read the change rather than list it (awareness, step summaries).

export interface SnapshotRange {
  /** The tree as the turn started. */
  from: string;
  /** The tree as it ended; null when the end snapshot hasn't landed. */
  to: string | null;
  /** Another agent works in the same checkout, so the range can hold its
   *  changes too. */
  shared: boolean;
}

export interface SnapshotDeps {
  turnList(cwd: string, sessionId: string): Promise<ipc.TurnList>;
  run(cwd: string, argv: string[], opts: { timeoutMs?: number; keepBytes?: number; head?: boolean }): Promise<ipc.ReceiptCheckRun>;
  sleep(ms: number): Promise<void>;
}

const defaultDeps: SnapshotDeps = {
  turnList: (cwd, sessionId) => ipc.turnList(cwd, sessionId),
  run: (cwd, argv, opts) => ipc.receiptRunCheck(cwd, argv, opts),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const END_RETRY_MS = 2000;

/** The snapshot pair for the turn that started at `startedAt` (closest start
 *  inside the turn wins). Null when there is no git, no snapshot, or any error. */
export async function turnSnapshotRange(
  cwd: string,
  sessionId: string,
  startedAt: number,
  endedAt: number,
  deps: Partial<SnapshotDeps> = {},
): Promise<SnapshotRange | null> {
  const d = { ...defaultDeps, ...deps };
  try {
    let list = await d.turnList(cwd, sessionId);
    const pair = pickTurnSnapshots(list, startedAt, endedAt);
    if (!pair) return null;
    if (!pair.end) {
      // The end snapshot is taken from the same hook batch that announced the
      // turn's end, so it can land a moment after us. Ask once more.
      await d.sleep(END_RETRY_MS);
      list = await d.turnList(cwd, sessionId);
      const again = list.turns.find((p) => p.start?.commit === pair.start);
      return { from: pair.start, to: again?.end?.commit ?? null, shared: list.shared };
    }
    return { from: pair.start, to: pair.end, shared: list.shared };
  } catch {
    return null;
  }
}

async function git(d: SnapshotDeps, cwd: string, args: string[], keepBytes = 64 * 1024): Promise<string | null> {
  try {
    const r = await d.run(cwd, ["git", ...args], { timeoutMs: 20_000, head: true, keepBytes });
    return r.code === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

/** Repo-relative files that differ between the snapshots (or, with no end
 *  snapshot, between the start and the working tree). */
export async function filesInRange(cwd: string, range: SnapshotRange, deps: Partial<SnapshotDeps> = {}): Promise<string[]> {
  const d = { ...defaultDeps, ...deps };
  const out = await git(d, cwd, ["diff", "--name-only", "--no-renames", range.from, ...(range.to ? [range.to] : [])]);
  return [...new Set((out ?? "").split("\n").map((l) => l.trim()).filter(Boolean))];
}

/** The patch between the snapshots, limited to `files` when given. */
export async function patchInRange(
  cwd: string,
  range: SnapshotRange,
  files: readonly string[] = [],
  keepBytes = 64 * 1024,
  deps: Partial<SnapshotDeps> = {},
): Promise<string> {
  const d = { ...defaultDeps, ...deps };
  const args = ["diff", "--no-color", "--no-ext-diff", range.from, ...(range.to ? [range.to] : [])];
  return (await git(d, cwd, files.length ? [...args, "--", ...files] : args, keepBytes)) ?? "";
}

// What one agent turn changed on disk, from turn rollback's snapshots.
//
// Turn rollback (src-tauri/src/turn_rollback.rs) commits the whole working
// tree — tracked and untracked — under a hidden ref as each turn starts and
// ends. Diffing the two is exactly what the turn changed, including what it
// did through Bash (`sed -i`, a codegen script, `git mv`), which the per-agent
// edit journal never sees. Proof receipts read the same pair; awareness and
// the step summaries read it through here.

import * as ipc from "./ipc";

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

/** How far a snapshot's stamp may sit from the observed turn start: the hook
 *  stamps it, the app sees the event up to a batch later. */
const START_SLACK_MS = 15_000;
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
    if (!list.git) return null;
    const hit = [...list.turns]
      .filter((p) => p.start && p.start.ts_ms >= startedAt - START_SLACK_MS && p.start.ts_ms <= endedAt + 2000)
      .sort((a, b) => Math.abs(a.start!.ts_ms - startedAt) - Math.abs(b.start!.ts_ms - startedAt))[0];
    if (!hit?.start) return null;
    if (!hit.end) {
      // The end snapshot is taken from the same hook batch that announced the
      // turn's end, so it can land a moment after us. Ask once more.
      await d.sleep(END_RETRY_MS);
      list = await d.turnList(cwd, sessionId);
      const again = list.turns.find((p) => p.start?.commit === hit.start!.commit);
      return { from: hit.start.commit, to: again?.end?.commit ?? null, shared: list.shared };
    }
    return { from: hit.start.commit, to: hit.end.commit, shared: list.shared };
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

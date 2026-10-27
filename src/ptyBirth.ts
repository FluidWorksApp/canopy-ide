// When each terminal was first seen running — the closest thing to a start
// time the frontend has for a PTY (the stats carry none). Used to tell a
// session that began in a terminal from the older sessions of the same CLI in
// the same folder (sessionDoc/resolveSession.ts).
//
// A terminal that already existed when watching began (a restored tab, a
// window reload) is "seen" at that moment, which is later than it really
// started: such a birth is marked imprecise, and callers treat it as a hint
// rather than a bound.

import * as ipc from "./ipc";

export interface PtyBirth {
  /** Unix milliseconds. */
  at: number;
  /** The terminal appeared while we were watching, so `at` is its start to
   *  within one stats tick. */
  precise: boolean;
}

const births = new Map<number, PtyBirth>();
let firstBatchSeen = false;
let watching: Promise<unknown> | null = null;

/** Record one stats batch. Exported for tests; `watchPtyBirths` feeds it. */
export function notePtyStats(stats: Pick<ipc.SessionStats, "id">[], now = Date.now()): void {
  const live = new Set<number>();
  for (const s of stats) {
    live.add(s.id);
    if (!births.has(s.id)) births.set(s.id, { at: now, precise: firstBatchSeen });
  }
  // A PTY id can be reused after its terminal closes; forget the dead ones.
  for (const id of births.keys()) if (!live.has(id)) births.delete(id);
  firstBatchSeen = true;
}

export const ptyBirth = (id: number | null | undefined): PtyBirth | null =>
  id == null ? null : (births.get(id) ?? null);

/** Start watching (idempotent). */
export function watchPtyBirths(): void {
  if (watching) return;
  // Never throws: without terminal stats there are just no birth times.
  watching = Promise.resolve()
    .then(() => ipc.onPtyStats((stats) => notePtyStats(stats)))
    .catch(() => {
      watching = null;
    });
}

/** Tests only. */
export function resetPtyBirthsForTests(): void {
  births.clear();
  firstBatchSeen = false;
  watching = null;
}

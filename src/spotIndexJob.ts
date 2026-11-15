// Index maintenance, running the whole time the app is open.
//
// The index used to be brought up to date in exactly one place: the moment the
// ⌘K palette opened. That is fine for a machine whose transcripts fit in a
// couple of passes and wrong for every other one — a cold index reads at most
// INGEST_BUDGET per call, so 1.7GB of history needs dozens of palette opens
// before search can answer for all of it, and the only visible symptom is a
// message count that climbs every time you look at it.
//
// Ingest is also the only thing that prunes. Deleted transcripts, an agent
// switched off in Settings, documents past the retention window and rows left
// by an older build all go at the top of a pass, so "nobody opened the palette
// today" also means "the index still claims conversations that no longer
// exist". Maintenance that only happens when someone searches is maintenance
// that is missing precisely when the index is stale.
//
// So: a pass a minute after launch, every 15 s while a backlog shrinks, then a
// half-hour heartbeat (opening the palette updates the index itself).
// Every pass is incremental and budgeted by the backend,
// and the pacing below is the only decision this file makes.
import { runIngest } from "./spotIndex";

export interface JobPace {
  /** Between passes while transcript is still unread. Short, because the
   *  backlog shrinks one budget per pass. Used only while it shrinks. */
  catchUpMs: number;
  /** Between passes once everything on disk has been read. This is the pruning
   *  heartbeat as much as the reading one. */
  idleMs: number;
  /** After a failed pass, doubling per consecutive failure up to `maxBackoffMs`
   *  — a locked or unwritable database should not be retried at catch-up
   *  speed for as long as the app is open. */
  backoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_PACE: JobPace = {
  catchUpMs: 15_000,
  idleMs: 30 * 60_000,
  backoffMs: 60_000,
  maxBackoffMs: 10 * 60_000,
};

/** Passes per tick. Two budgets (8MB) of reading, then back to sleep: the tick
 *  competes with the user's own work for disk and CPU, and the backlog is
 *  measured in minutes of background time, not in how fast one tick can go. */
export const PASSES_PER_TICK = 2;

/** Long enough after launch that the first pass is not competing with opening
 *  the workspace, restoring tabs and spawning shells. */
export const FIRST_PASS_MS = 60_000;

export interface PassOutcome {
  /** The pass completed — it may still have read nothing. */
  ok: boolean;
  /** Transcript bytes left unread after it. */
  pending: number;
}

/** When the next pass should run. Pure, so the pacing is a thing that can be
 *  tested. Catch-up pace only while the backlog is smaller than `previousPending`;
 *  a stuck backlog gets the heartbeat. With no previous pass, assume shrinking. */
export function nextDelay(
  outcome: PassOutcome,
  failures: number,
  pace: JobPace = DEFAULT_PACE,
  previousPending?: number,
): number {
  if (!outcome.ok) {
    const doubled = pace.backoffMs * 2 ** Math.max(0, failures - 1);
    return Math.min(doubled, pace.maxBackoffMs);
  }
  if (outcome.pending <= 0) return pace.idleMs;
  const shrinking = previousPending === undefined || outcome.pending < previousPending;
  return shrinking ? pace.catchUpMs : pace.idleMs;
}

/** Start the job. Returns the stop function, so it mounts as
 *  `useEffect(() => startSpotIndexJob(getRoots), [])`.
 *
 *  `getRoots` is read at each tick rather than captured: the open projects
 *  change while the app runs, and they are what makes the per-project stores
 *  (gemini's hashed buckets, aider's in-repo history) findable at all. */
export function startSpotIndexJob(
  getRoots: () => string[],
  pace: JobPace = DEFAULT_PACE,
  firstPassMs: number = FIRST_PASS_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let failures = 0;
  let lastPending: number | undefined;

  const tick = async () => {
    if (stopped) return;
    let outcome: PassOutcome = { ok: false, pending: 0 };
    try {
      const report = await runIngest(getRoots(), PASSES_PER_TICK);
      if (report) outcome = { ok: true, pending: report.pending };
    } catch {
      // An unreachable or locked index is not worth a notice: SpotSearch's
      // live sources answer without it, and the next pass may well work.
    }
    failures = outcome.ok ? 0 : failures + 1;
    const delay = nextDelay(outcome, failures, pace, lastPending);
    if (outcome.ok) lastPending = outcome.pending;
    if (stopped) return;
    timer = setTimeout(() => void tick(), delay);
  };

  timer = setTimeout(() => void tick(), firstPassMs);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

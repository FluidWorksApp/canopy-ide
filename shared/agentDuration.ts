// How long an agent has actually been working, as opposed to how long it has
// existed. Pure TypeScript, no imports: shared verbatim by the desktop shell
// (src/) and the mobile portal (portal/) so the two can never disagree about
// what a session's clock reads.
//
// The clock is kept by canopy_hook.rs, which is the only writer of a session
// digest and the only thing that sees every lifecycle transition. It credits
// the gap between two hook events to `active_secs` when the state across that
// gap was `working`, and to nothing at all when it was `idle` (the agent
// finished and is waiting for you to type) or `waiting` (it is blocked on a
// question or a permission prompt). That is the difference the user cares
// about: wall-clock says a session has been open since Tuesday, this says it
// did forty minutes of work.
//
// Two numbers come out of it:
//
//   run   — the current uninterrupted stretch. Resets every time the agent
//           re-enters `working` from anything else, so it answers "how long
//           has it been going *this* time" for the session you are watching.
//   total — every stretch this session has ever run, summed. The session's
//           actual working time.
//
// Both are credited only as far as the last hook event, because that is the
// last moment anything was known. A live row extrapolates past it (see
// `workingTime`); a row we have lost track of does not.

/** The digest fields this module reads. A subset of SessionDigest/Digest, so
 *  either shell can pass its own row straight in. */
export interface ActiveTiming {
  /** Credited working seconds across the session's whole life. */
  active_secs?: number;
  /** Credited working seconds in the current (or most recent) stretch. */
  run_secs?: number;
  /** Unix seconds when the current stretch began — for "started at", never for
   *  arithmetic: it counts the wall clock, which is the thing we are avoiding. */
  run_started?: number;
  /** Unix seconds of the last hook event. Credit stops here. */
  updated?: number;
}

/** How far past the last hook event a live row may keep counting. Mirrors
 *  MAX_CREDITED_GAP_SECS in canopy_hook.rs, and for the same reason: the time
 *  since the last event is inferred, not observed, and the inference decays.
 *  Bounding it means a row that quietly died can overstate its work by at most
 *  this much, rather than by however long the machine stays on. */
export const MAX_OPEN_GAP_SECS = 900;

export interface WorkingTime {
  /** Seconds in the current uninterrupted working stretch. */
  run: number;
  /** Seconds this session has spent working, over its whole life. */
  total: number;
}

/**
 * The two durations to display.
 *
 * `live` is the caller's answer to "is this agent still working right now?" —
 * on the desktop that is `effectiveState(...) === "working"`, which corroborates
 * the hook's claim against the process tree's CPU; on the portal it is the
 * digest's own state on an attached PTY. When it is true the open stretch since
 * the last event is added to both numbers, so the row ticks. When it is false
 * both freeze at what was actually credited, which is the honest reading for a
 * session that stopped without saying so.
 */
export function workingTime(
  t: ActiveTiming | undefined,
  now: number,
  live: boolean,
): WorkingTime {
  const run = Math.max(0, Math.floor(t?.run_secs ?? 0));
  const total = Math.max(0, Math.floor(t?.active_secs ?? 0));
  if (!live || !t?.updated) return { run, total };
  const open = Math.min(Math.max(0, Math.floor(now - t.updated)), MAX_OPEN_GAP_SECS);
  return { run: run + open, total: total + open };
}

/** True when there is any working time worth putting on screen. A session that
 *  has never left `idle` has nothing to say and should render no chip at all,
 *  rather than a `0:00` that looks like a stopped clock. */
export function hasWorkingTime(t: WorkingTime): boolean {
  return t.total > 0 || t.run > 0;
}

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** Stopwatch form — `0:43`, `12:07`, `1:04:22`, `27:14:02`. Hours run past 24
 *  rather than rolling into days: this is elapsed work, and "27:14:02" is
 *  immediately a duration where "1d 3:14" needs a beat to parse. */
export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** The same duration in words, for a tooltip that has room to be unambiguous —
 *  "1 hour 4 minutes" where the chip says "1:04:22". */
export function formatDurationWords(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? "" : "s"}`;
  if (s < 60) return unit(s, "second");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return unit(m, "minute");
  return m === 0 ? unit(h, "hour") : `${unit(h, "hour")} ${unit(m, "minute")}`;
}

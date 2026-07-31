// Reminders on scratchpad notes, as the UI sees them.
//
// The store (src-tauri/src/notes.rs) owns the time and the OS job; this owns
// everything a person reads and clicks. That split matters more here than
// elsewhere because the two halves speak different units and the boundary is
// where it goes wrong: the store is in epoch *seconds*, `Date` is in
// milliseconds, and `<input type="datetime-local">` is in neither — it is a
// local wall-clock string with no zone at all. Every conversion between those
// three lives here, tested, rather than being re-derived in a component.
//
// The presets are the actual feature. A date picker is the honest general
// answer and nobody sets a reminder that way: what people mean is "tonight",
// "tomorrow morning", "next week", and a form that makes them work out which
// Monday that is gets used once. The picker stays for the case none of them
// fit.

import type { NoteReminder, NoteDue } from "./ipc";

/** Epoch seconds, the unit the store speaks. */
export const nowSecs = (): number => Math.floor(Date.now() / 1000);

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The hour "morning" means, and the hour "this evening" means. Not settings:
 *  they are the defaults of a working day, and a preference nobody would find
 *  is worse than a default they can override with the picker. */
export const MORNING_HOUR = 9;
export const EVENING_HOUR = 18;

/** Set a local wall-clock time on a day, and return epoch seconds.
 *
 *  Via `Date` rather than arithmetic on the epoch, deliberately: adding
 *  86400 × n to a timestamp is wrong twice a year, and "tomorrow morning"
 *  landing at 08:00 the day the clocks go back is exactly the kind of small
 *  wrongness that makes people stop trusting a reminder. */
function atLocal(base: Date, addDays: number, hour: number): number {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + addDays);
  d.setHours(hour, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export interface Preset {
  id: string;
  label: string;
  /** Epoch seconds, resolved against the moment the menu is opened. */
  at: (now: number) => number;
}

/** The four in the menu, in the order someone scans them: soonest first.
 *
 *  "This evening" disappears rather than lying when the evening has already
 *  started — a row that silently means *tomorrow* evening is a reminder
 *  arriving 24 hours after you expected it. `presetsFor` does the filtering. */
export const PRESETS: Preset[] = [
  { id: "hour", label: "In an hour", at: (now) => now + HOUR },
  {
    id: "evening",
    label: "This evening",
    at: (now) => atLocal(new Date(now * 1000), 0, EVENING_HOUR),
  },
  {
    id: "tomorrow",
    label: "Tomorrow morning",
    at: (now) => atLocal(new Date(now * 1000), 1, MORNING_HOUR),
  },
  {
    id: "week",
    label: "Next Monday",
    at: (now) => {
      const d = new Date(now * 1000);
      // 0 = Sunday. Always at least one day out, so asking on a Monday means
      // the Monday after — "next Monday" is never today.
      const ahead = ((8 - d.getDay()) % 7) || 7;
      return atLocal(d, ahead, MORNING_HOUR);
    },
  },
];

/** The presets that are still in the future at `now`. */
export const presetsFor = (now: number): Preset[] =>
  PRESETS.filter((p) => p.at(now) > now);

// ---------- the picker ----------
//
// `<input type="datetime-local">` reads and writes `YYYY-MM-DDTHH:mm` in the
// user's own timezone with no offset. Both directions have to go through the
// local calendar; `toISOString().slice(0, 16)` is the tempting one-liner and is
// wrong by the UTC offset, which is how a picker shows 04:30 for a 10:00
// reminder in India.

const pad = (n: number) => String(n).padStart(2, "0");

/** Epoch seconds → the value a `datetime-local` input expects. */
export function toLocalInput(at: number): string {
  const d = new Date(at * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** What the input gave back → epoch seconds, or null if it is not a time.
 *  `new Date(value)` would parse it as UTC in some engines and local in
 *  others; the fields are read out and rebuilt locally so it cannot depend on
 *  that. */
export function fromLocalInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    0,
    0,
  );
  const secs = Math.floor(date.getTime() / 1000);
  return Number.isFinite(secs) ? secs : null;
}

/** The earliest a picker should accept: a minute out. Setting one for a time
 *  that has passed is refused by the store, and a form that lets you do it
 *  anyway just to show the error is a form that wasted your time. */
export const earliest = (now: number): string => toLocalInput(now + MIN);

// ---------- reading a time back ----------

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** A duration in the largest unit that still says something useful. */
function span(secs: number): string {
  if (secs < MIN) return "less than a minute";
  if (secs < HOUR) return plural(Math.round(secs / MIN), "minute");
  if (secs < DAY) return plural(Math.round(secs / HOUR), "hour");
  if (secs < 7 * DAY) return plural(Math.round(secs / DAY), "day");
  return plural(Math.round(secs / (7 * DAY)), "week");
}

const clock = (at: number) => {
  const d = new Date(at * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** What a row's chip says. Short, because it sits next to a title.
 *
 *  Overdue is phrased as a fact rather than a countdown ("was due yesterday",
 *  not "-1 day"): by the time you are reading it the alarm has already
 *  happened, and what you want to know is how stale the thing is. */
export function describe(at: number, now: number): string {
  if (at <= now) {
    const late = now - at;
    return late < MIN ? "due now" : `${span(late)} overdue`;
  }
  const then = new Date(at * 1000);
  const today = new Date(now * 1000);
  const tomorrow = new Date(now * 1000);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDay(then, today)) return `today ${clock(at)}`;
  if (sameDay(then, tomorrow)) return `tomorrow ${clock(at)}`;
  if (at - now < 7 * DAY)
    return `${then.toLocaleDateString(undefined, { weekday: "short" })} ${clock(at)}`;
  return `${then.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${clock(at)}`;
}

/** The long form, for the detail view where there is room to be unambiguous. */
export function describeFull(at: number, now: number): string {
  const when = new Date(at * 1000).toLocaleString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (at <= now) return `${when} — ${span(now - at)} ago`;
  return `${when} — in ${span(at - now)}`;
}

export const isOverdue = (r: NoteReminder, now: number): boolean => r.at <= now;

/** Notes sort by "needs you soonest": overdue first (oldest first, because the
 *  one that has waited longest is the one being ignored), then upcoming by
 *  time, then everything with no reminder in whatever order it arrived. */
export function reminderRank(
  r: NoteReminder | null | undefined,
  now: number,
): number {
  if (!r) return 2;
  return r.at <= now ? 0 : 1;
}

// ---------- what the app says when one fires ----------

/** Whether the app itself should announce this. `false` when launchd already
 *  did — the whole reason `system` is recorded on the reminder. Announcing it
 *  twice is the single most likely way this feature becomes annoying. */
export const shouldAnnounce = (due: NoteDue): boolean => !due.system;

/** The banner's two lines: what it is, then what you wrote. The note's own
 *  words come first when there are any — the title is already the tab you are
 *  about to land on. */
export function announcement(due: NoteDue): { title: string; body: string } {
  return {
    title: `Reminder — ${due.title}`,
    body: due.note.trim() || "You asked to be reminded about this note.",
  };
}

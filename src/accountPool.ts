// Which account a session moves to when it reaches a limit, and when an account
// is worth trying again. Pure: the caller supplies state and carries out moves.

export type AccountLimits = Record<string, { until: number; message?: string }>;

/** A handover types into a POSIX shell and relies on Unix job control to prove
 *  the agent stopped. Elsewhere the manual stop-and-relaunch path still applies. */
export const canHandOver = () => !/^win/i.test(globalThis.navigator?.platform ?? "");

export const limitKey = (cli: string, profile: string) => `${cli}:${profile}`;

/** Sent with the resume, as a CLI argument, so no terminal timing is involved. */
export const CONTINUE_PROMPT =
  "Your session moved to another account, which may have interrupted the last turn. Continue where you left off.";

/** How soon to look again when nothing says when a limit ends. */
const UNKNOWN_RESET_MS = 60 * 60_000;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Reads the CLI's "resets 4am", "resets 3:30pm" and "resets Nov 2 at 4am". */
export function parseResetTime(message: string, now: Date): number | null {
  const found = /resets\s+(?:([a-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(message);
  if (!found) return null;
  const [, month, day, hour, minute, half] = found;
  const hours = (Number(hour) % 12) + (half.toLowerCase() === "pm" ? 12 : 0);
  const at = new Date(now);
  at.setHours(hours, Number(minute ?? 0), 0, 0);
  if (month) {
    const index = MONTHS.indexOf(month.toLowerCase());
    if (index < 0) return null;
    at.setMonth(index, Number(day));
    if (at <= now) at.setFullYear(at.getFullYear() + 1);
  } else if (at <= now) {
    at.setDate(at.getDate() + 1);
  }
  return at.getTime();
}

export interface LimitWindow { used_percent: number; resets_at?: number | null }

/** When an account is worth trying again. Only a hint: a wrong guess costs one
 *  rejected turn, which reports the limit again. */
export function limitResetAt(message: string, windows: LimitWindow[], now: Date): number {
  const stated = parseResetTime(message, now);
  if (stated) return stated;
  const nowSeconds = now.getTime() / 1000;
  const full = windows
    .filter(w => w.used_percent >= 95 && (w.resets_at ?? 0) > nowSeconds)
    .map(w => w.resets_at! * 1000);
  return full.length ? Math.max(...full) : now.getTime() + UNKNOWN_RESET_MS;
}

/** For a CLI that reports no failure, or an account whose hook is missing, a
 *  spent window is the evidence. Rejected requests write no reading, which is
 *  why the last one is trusted. */
export function windowSpent(windows: LimitWindow[], now: Date): LimitWindow | null {
  const nowSeconds = now.getTime() / 1000;
  return windows.find(w => w.used_percent >= 99 && (w.resets_at ?? 0) > nowSeconds) ?? null;
}

const usable = (cli: string, profile: string, limits: AccountLimits, now: number) =>
  (limits[limitKey(cli, profile)]?.until ?? 0) <= now;

/** The next signed-in account after `from`, going round in order. Null when
 *  every account, `from` included, is at a limit. */
export function nextAccount(opts: {
  cli: string; from: string; order: string[]; signedIn: string[];
  limits: AccountLimits; now: number;
}): string | null {
  const { cli, from, order, signedIn, limits, now } = opts;
  const start = order.indexOf(from);
  const round = [...order.slice(start + 1), ...order.slice(0, start + 1)];
  return round.find(id => signedIn.includes(id) && usable(cli, id, limits, now)) ?? null;
}

/** When the first exhausted account comes back. */
export function earliestReset(cli: string, signedIn: string[], limits: AccountLimits, now: number): number {
  const times = signedIn.map(id => limits[limitKey(cli, id)]?.until ?? 0).filter(until => until > now);
  return times.length ? Math.min(...times) : now + UNKNOWN_RESET_MS;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Choices the resume command would otherwise drop, kept as the user spelled them. */
export function carriedFlags(names: readonly string[], command: string | undefined): string[] {
  if (!names.length) return [];
  const pattern = new RegExp(`(?:^|\\s)(${names.join("|")})(?:=|\\s+)('[^']*'|"[^"]*"|[^\\s;&|]+)`, "g");
  return [...(command ?? "").matchAll(pattern)].map(match => `${match[1]} ${match[2]}`);
}

/** The prompt goes straight after the id, because a variadic flag such as
 *  `--add-dir` would swallow it at the end of the line. */
export function withPrompt(command: string, sessionId: string, prompt: string): string {
  return command.split(" ").flatMap(word => (word === sessionId ? [word, quote(prompt)] : [word])).join(" ");
}

/** One line for the tab's own shell. The exports stay in that shell on purpose:
 *  it now belongs to the new account. A leading space keeps it out of history
 *  where the shell allows that, and ^U clears anything left on the prompt. */
export function handoverLine(opts: {
  cwd: string; set: [string, string][]; clear: string[]; command: string;
}): string {
  const { cwd, set, clear, command } = opts;
  const steps = [`cd ${quote(cwd)}`];
  if (set.length) steps.push(`export ${set.map(([key, value]) => `${key}=${quote(value)}`).join(" ")}`);
  if (clear.length) steps.push(`unset ${clear.join(" ")}`);
  return `\x15 ${[...steps, command].join(" && ")}\r`;
}

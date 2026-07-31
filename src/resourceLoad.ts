// Which numbers in the resource breakdown are worth a second look — the rule
// behind the red in the CPU/memory popup.
//
// "Abnormal" has to be scope-aware: 100% CPU is one saturated core, alarming
// for a single process and unremarkable as the sum of eight terminals. So the
// thresholds are per scope and absolute. A relative rule (top row, outlier
// against its peers) was the obvious alternative and is worse: it paints
// something red on a perfectly idle machine, and red that is always on stops
// meaning anything.
//
// CPU is percent of ONE core — the unit the process monitor reports — so a row
// covering several busy processes legitimately exceeds 100.

export type LoadScope = "proc" | "session" | "group" | "app";

const GIB = 1024 ** 3;

export interface LoadThreshold {
  /** Percent of one core, inclusive. */
  cpu: number;
  /** Bytes, inclusive. */
  mem: number;
}

export const LOAD_THRESHOLDS: Record<LoadScope, LoadThreshold> = {
  // One process pinning a whole core, or holding a gigabyte, is the shape of
  // a runaway build/language server rather than of an agent doing its job.
  proc: { cpu: 90, mem: 1 * GIB },
  // A session is a whole process tree (shell + CLI + whatever it spawned), so
  // it gets a little more rope than any single process in it.
  session: { cpu: 100, mem: 1.25 * GIB },
  // Project totals and core services: several cores' worth, or a large slice
  // of a typical 16 GB machine, before anyone needs to care.
  group: { cpu: 300, mem: 6 * GIB },
  app: { cpu: 300, mem: 6 * GIB },
};

export interface LoadFlags {
  /** This row's CPU is above its scope's threshold. */
  cpu: boolean;
  /** This row's memory is above its scope's threshold. */
  mem: boolean;
  /** Either of the above — the row deserves highlighting at all. */
  hot: boolean;
}

/** Flag a row's CPU and memory against the thresholds for its scope. */
export function loadFlags(
  scope: LoadScope,
  cpu: number,
  memBytes: number,
): LoadFlags {
  const t = LOAD_THRESHOLDS[scope];
  // NaN (a monitor tick that lost a field) must read as "fine", not as hot:
  // every comparison with NaN is false, which is exactly what we want.
  const hotCpu = cpu >= t.cpu;
  const hotMem = memBytes >= t.mem;
  return { cpu: hotCpu, mem: hotMem, hot: hotCpu || hotMem };
}

const fmtGb = (bytes: number) =>
  `${(bytes / GIB).toFixed(bytes % GIB === 0 ? 0 : 2)} GB`;

/** Why a row is red, for the hover title. "" when it isn't. */
export function loadNote(scope: LoadScope, flags: LoadFlags): string {
  if (!flags.hot) return "";
  const t = LOAD_THRESHOLDS[scope];
  const parts: string[] = [];
  if (flags.cpu) parts.push(`CPU is at or above ${t.cpu}% of one core`);
  if (flags.mem) parts.push(`memory is at or above ${fmtGb(t.mem)}`);
  return `Unusually heavy: ${parts.join(", and ")}.`;
}

/** Join a row's own tooltip with its load note, dropping whichever is empty. */
export function withLoadNote(
  title: string | undefined,
  note: string,
): string | undefined {
  if (!note) return title;
  return title ? `${title}\n\n${note}` : note;
}

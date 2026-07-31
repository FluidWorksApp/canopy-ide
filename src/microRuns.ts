// Micro-tasks that run without a tab. A one-shot job — review this PR, raise
// that one — used to open a terminal tab, take the front of the window, and
// close itself when it was done: a lot of ceremony for something the user
// launched precisely so they wouldn't have to watch it. Detached, the agent runs
// in a PTY nothing is attached to and the Tasks panel is its whole surface: the
// state dot, what it's doing, and what it reported when it finished.
//
// This module is the bookkeeping for those runs — which pty belongs to which
// history entry, and the one-liner each row shows. The lifecycle (spawning,
// job_done, reaping) lives in ProjectView, which owns the PTYs; keeping the data
// here means it can be reasoned about, and tested, on its own.

/** A micro-task in flight with no tab of its own. Keyed by pty id everywhere:
 *  that's the identity the hook stamps on its events, the MCP bridge sends with
 *  job_done, and the panel stops and attaches by. */
export interface MicroRun {
  ptyId: number;
  /** The task history entry this run writes its outcome into. */
  runId?: string;
  /** MicroTaskDef id — `review-pr`, `custom-<uuid>`. */
  taskId: string;
  label: string;
  icon?: string;
  /** Where the agent runs; a PR worktree for the tasks that edit files. */
  cwd: string;
  /** Agent CLI registry id, for the row's tooltip. */
  agent: string;
  /** The research entry this run is working on, when it is working on one.
   *  Carried on the run so that when it reports done, the entry can be moved
   *  off "researching" — a finished run whose entry still says it is being
   *  researched is the state a research list exists to not have. */
  researchId?: string;
  startedAt: number;
  /** The agent called job_done with "blocked": it wants the user. The run is
   *  still going — answering it is what the terminal is for — so this marks the
   *  row rather than ending it. */
  blocked?: boolean;
  /** Set once the user opens a terminal onto this run (a viewer attached to the
   *  same PTY). Lets the reap close what it opened, and the row say "showing". */
  viewTabId?: string;
}

/** Add a run, replacing any stale entry on the same pty — ids are recycled
 *  across a session, and two rows for one terminal would both try to reap it. */
export const withRun = (runs: MicroRun[], run: MicroRun): MicroRun[] => [
  ...runs.filter((r) => r.ptyId !== run.ptyId),
  run,
];

export const withoutRun = (runs: MicroRun[], ptyId: number): MicroRun[] =>
  runs.filter((r) => r.ptyId !== ptyId);

export const patchRun = (runs: MicroRun[], ptyId: number, patch: Partial<MicroRun>): MicroRun[] =>
  runs.map((r) => (r.ptyId === ptyId ? { ...r, ...patch } : r));

export const findRun = (runs: MicroRun[], ptyId: number | null | undefined): MicroRun | undefined =>
  ptyId == null ? undefined : runs.find((r) => r.ptyId === ptyId);

/** How long it's been running, in the shortest form that's still true. */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** The row's second line: what the task is doing, in the words the panel has.
 *  "Blocked" wins over everything — it is the one state that needs a human and
 *  the only reason to open the terminal. Otherwise the last tool the agent
 *  reached for, when a hook told us, else its lifecycle state. */
export function runNote(
  run: MicroRun,
  state: "working" | "waiting" | "idle" | "ended",
  lastStep: string | undefined,
  now: number,
): string {
  const age = elapsedLabel(now - run.startedAt);
  if (run.blocked || state === "waiting") return `Needs you · ${age}`;
  if (state === "ended") return `Wrapping up · ${age}`;
  if (lastStep) return `${lastStep} · ${age}`;
  return state === "working" ? `Working · ${age}` : `Started ${age} ago`;
}

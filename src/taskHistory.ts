// What became of every micro-task that ran. A micro-task's whole promise is
// that its terminal closes itself once the job is done (see reapMicroTask in
// ProjectView) — which also means the outcome, the PR link and everything that
// scrolled past are gone the moment it lands, with a toast as the only record.
// This is that record, kept.
//
// localStorage rather than the workspace file, same call as terminalMemory.ts:
// a convenience log whose corruption should cost nothing, and which is about
// how the user works rather than about any one project.

export type TaskRunStatus = "running" | "done" | "blocked" | "stopped";

export interface TaskRun {
  id: string;
  /** MicroTaskDef id — `raise-pr`, `custom-<uuid>`. Lets "run again" find it. */
  taskId: string;
  label: string;
  icon?: string;
  /** Agent CLI registry id (projects.ts), e.g. "claude". */
  agent: string;
  /** Where the agent ran; also where "run again" would run it. */
  cwd: string;
  projectId: string;
  /** Recorded, not looked up: the history outlives a project being closed or
   *  renamed, and an id alone tells the reader nothing. */
  projectName?: string;
  /** The brief it was launched with, minus the completion protocol. */
  brief: string;
  startedAt: number;
  endedAt?: number;
  status: TaskRunStatus;
  /** The agent's one-line canopy_job_done summary. */
  summary?: string;
  /** A URL the job produced (a PR, usually). */
  url?: string;
  /** Files the session touched, from its hook digest when there was one. */
  files?: string[];
  /** Tail of the terminal, plain text, captured just before the tab closed. */
  output?: string;
  /** The agent reported `blocked` at some point — it asked for the user. Set
   *  while the run is still going (blocked is not an ending: the user can
   *  answer and the task finishes), and read when the tab closes to tell an
   *  abandoned-while-waiting run from one that was simply called off. */
  askedForUser?: boolean;
}

const KEY = "canopy.taskHistory";

/** How many runs to keep. Past this the oldest are dropped. */
const MAX_RUNS = 200;

/** How many of those keep their captured output. An 8KB transcript on every one
 *  of 200 runs would be 1.6MB of a ~5MB localStorage budget shared with the
 *  workspace, settings and terminal memory — so the transcript ages out long
 *  before the record itself does. */
const MAX_WITH_OUTPUT = 60;

function read(): TaskRun[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as TaskRun[]) : [];
  } catch {
    return [];
  }
}

function write(runs: TaskRun[]) {
  // Newest first, so trimming is a slice and the panel needs no sort.
  const trimmed = runs.slice(0, MAX_RUNS).map((r, i) =>
    i < MAX_WITH_OUTPUT || r.output === undefined ? r : { ...r, output: undefined },
  );
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // Storage full or unavailable — losing a history entry is not worth
    // interrupting anyone over, and the task itself already ran.
  }
  // Fired here rather than by each caller so no write can forget it. `storage`
  // events only reach *other* tabs, which in a one-window desktop app is never.
  window.dispatchEvent(new CustomEvent(TASK_HISTORY_EVENT));
}

/** Emitted whenever the log changes, so panels showing a count refresh without
 *  polling localStorage. */
export const TASK_HISTORY_EVENT = "canopy:task-history";

const runId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Log a task as it launches, returning the id the finish is keyed on. Recorded
 *  at launch rather than at completion so a task that is stopped, or whose agent
 *  dies without ever reporting, still leaves a trace. */
export function recordTaskStart(run: Omit<TaskRun, "id" | "status" | "startedAt">): string {
  const id = runId();
  write([{ ...run, id, status: "running", startedAt: Date.now() }, ...read()]);
  return id;
}

/** Complete a run. A no-op for an unknown id, and — deliberately — for a run
 *  that already ended: the tab-close path fires after job_done on every
 *  successful task, and must not overwrite "done" with "stopped". */
export function recordTaskEnd(id: string, patch: Partial<Omit<TaskRun, "id">>): void {
  const runs = read();
  const i = runs.findIndex((r) => r.id === id);
  if (i === -1 || runs[i].status !== "running") return;
  runs[i] = { ...runs[i], ...patch, endedAt: patch.endedAt ?? Date.now() };
  write(runs);
}

/** Settle a run whose tab is closing without it ever having reported done.
 *  "Blocked" when the agent asked for the user and never got an answer, plain
 *  "stopped" otherwise — the difference between "it needed you" and "you called
 *  it off", which is the whole reason the Blocked filter exists. */
export function endAbandonedRun(id: string, output?: string): void {
  const runs = read();
  const run = runs.find((r) => r.id === id);
  if (!run || run.status !== "running") return;
  recordTaskEnd(id, { status: run.askedForUser ? "blocked" : "stopped", output });
}

/** Patch a run without settling its outcome — used for the captured terminal
 *  output (recorded when the tab closes, which is after the outcome is known)
 *  and for a blocked agent's note, where the run is still very much going. */
export function updateTaskRun(id: string, patch: Partial<Omit<TaskRun, "id" | "status">>): void {
  const runs = read();
  const i = runs.findIndex((r) => r.id === id);
  if (i === -1) return;
  runs[i] = { ...runs[i], ...patch };
  write(runs);
}

/** Settle anything left `running` by a previous app launch. Micro-task tabs are
 *  never restored, so a task in flight when Canopy quit has no terminal to come
 *  back to and no way to ever report — without this it stays `running` for
 *  good: invisible to the history tab (which lists only finished runs), yet
 *  still taking up one of the 200 slots. Call once, on startup, before anything
 *  new is recorded. */
export function sweepStaleRuns(): void {
  const runs = read();
  if (!runs.some((r) => r.status === "running")) return;
  write(
    runs.map((r) =>
      r.status === "running"
        ? { ...r, status: r.askedForUser ? "blocked" : "stopped", endedAt: r.endedAt ?? Date.now() }
        : r,
    ),
  );
}

/** Every run, newest first. */
export function taskRuns(): TaskRun[] {
  return read();
}

/** Runs that have finished — what the Completed section counts and lists. The
 *  log itself is app-wide (a task like "changelog entry" is about how you work,
 *  not about one repo), but every surface showing it is inside a project, so
 *  the default view is scoped and `projectId` is how. */
export function completedTaskRuns(projectId?: string): TaskRun[] {
  return read().filter(
    (r) => r.status !== "running" && (projectId === undefined || r.projectId === projectId),
  );
}

export function removeTaskRun(id: string): void {
  write(read().filter((r) => r.id !== id));
}

export function clearTaskHistory(): void {
  write([]);
}

/** The terminal tail with its dead space taken out.
 *
 *  What gets captured is a PTY's scrollback, and once the escape codes that
 *  drew over it are stripped, most of a screen is blank: a CLI that paints a
 *  status line and clears it leaves the rows behind. Rendered verbatim that was
 *  a 340px box holding one word at the top and one at the bottom, which reads
 *  as a broken panel rather than a quiet run. Trailing spaces go, runs of empty
 *  lines collapse to one, and the ends are trimmed — nothing that carries
 *  meaning is touched, since consecutive blank lines never do here. */
export function tidyOutput(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    // Blank lines off the ends, not whitespace: a plain trim() would eat the
    // first line's indentation and shunt it out of line with everything under
    // it, which in a terminal tail is exactly the structure you're reading for.
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

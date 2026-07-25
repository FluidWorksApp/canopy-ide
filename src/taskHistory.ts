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

/** Complete (or stop) a run. A no-op for an unknown id, and — deliberately —
 *  for a run that already ended: the tab-close path fires after job_done on
 *  every successful task, and must not overwrite "done" with "stopped". */
export function recordTaskEnd(id: string, patch: Partial<Omit<TaskRun, "id">>): void {
  const runs = read();
  const i = runs.findIndex((r) => r.id === id);
  if (i === -1 || runs[i].status !== "running") return;
  runs[i] = { ...runs[i], ...patch, endedAt: patch.endedAt ?? Date.now() };
  write(runs);
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

/** Every run, newest first. */
export function taskRuns(): TaskRun[] {
  return read();
}

/** Runs that have finished — what the Completed section counts and lists. */
export function completedTaskRuns(): TaskRun[] {
  return read().filter((r) => r.status !== "running");
}

export function removeTaskRun(id: string): void {
  write(read().filter((r) => r.id !== id));
}

export function clearTaskHistory(): void {
  write([]);
}

// What became of every micro-task that ran. A micro-task's whole promise is
// that its terminal closes itself once the job is done (see reapMicroTask in
// ProjectView) — which also means the outcome, the PR link and everything that
// scrolled past are gone the moment it lands, with a toast as the only record.
// This is that record, kept.
//
// TaskEnvelope is now the authority. localStorage below is read only as a
// one-shot compatibility source and emptied after the Rust store adopts it.
import * as ipc from "./ipc";
import type { TaskEnvelopeSummary, TaskReservation } from "./taskEnvelope";
import { TASK_ENVELOPES_EVENT } from "./taskEnvelopes";

export type TaskRunStatus = "running" | "done" | "blocked" | "stopped";

export interface TaskRun {
  id: string;
  /** MicroTaskDef id — `raise-pr`, `custom-<uuid>`. Lets "run again" find it. */
  taskId: string;
  label: string;
  icon?: string;
  /** What the agent called this run once it knew what the job was, and the
   *  glyph it picked to go with it (taskIdentity.ts). Kept beside `label`
   *  rather than overwriting it: the launcher's name is what the run was
   *  started as, and "run again" and the search index both want it. */
  title?: string;
  agentIcon?: string;
  /** A few words about what kind of work this was — the agent's own. */
  tags?: string[];
  /** The agent's one-line reading of the ask, recorded next to its answer. */
  asked?: string;
  /** Agent CLI registry id (projects.ts), e.g. "claude". */
  agent: string;
  /** Where the agent ran; also where "run again" would run it. */
  cwd: string;
  projectId: string;
  /** Recorded, not looked up: the history outlives a project being closed or
   *  renamed, and an id alone tells the reader nothing. */
  projectName?: string;
  /** PTY identity retained so the completion event can resolve its notification
   *  to this stable run id before the terminal is torn down. */
  ptyId?: number;
  /** Durable attempt behind this run. PTY/session ids are only live bindings. */
  attemptId?: string;
  /** App process that owns the live PTY; preserved across metadata patches so
   * a WebView reload cannot sweep a still-running Rust process. */
  appInstance?: string;
  /** Research run target, when this task is advancing one stored entry. */
  researchId?: string;
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
  /** Durable copy of output; raw text itself stays out of metadata. */
  outputArtifactId?: string;
  /** The CLI's own session id for this run — the conversation behind it.
   *
   *  Recorded while the run is still going, because nothing else will: a
   *  micro-task's session is forgotten the moment it ends (session_forget in
   *  reapMicroTask) and the pty→session binding dies with the PTY. The CLI's
   *  transcript survives both, so with this id the run can be picked up as an
   *  ordinary agent session — which is what "Continue as a session" does. */
  sessionId?: string;
  /** False when the run's working directory was a throwaway worktree the task
   *  deletes on its way out. `--resume <id>` is resolved inside the CLI's own
   *  config dir, keyed by the directory it ran in, so a conversation whose
   *  directory is gone cannot be reopened — and offering it would be a button
   *  that drops you into a CLI error. Absent means "not a throwaway". */
  ephemeralCwd?: boolean;
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

/** Parsed-runs cache, keyed on the raw stored string. The blob can approach
 *  half a megabyte (transcript tails), and read() is called by every open PR
 *  tab and Tasks panel on every history event — parsing it once per write
 *  instead of once per reader matters. Callers must not mutate the array. */
let cache: { raw: string | null; runs: TaskRun[] } | null = null;
let authoritative: TaskRun[] | null = null;
let hydrating: Promise<TaskRun[]> | null = null;
const persistQueues = new Map<string, Promise<void>>();
let refreshGeneration = 0;

export function resetTaskHistoryForTests(): void {
  cache = null;
  authoritative = null;
  hydrating = null;
}

function read(): TaskRun[] {
  if (authoritative) return authoritative;
  const raw = localStorage.getItem(KEY);
  if (cache && cache.raw === raw) return cache.runs;
  let runs: TaskRun[];
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    runs = Array.isArray(v) ? (v as TaskRun[]) : [];
  } catch {
    runs = [];
  }
  cache = { raw, runs };
  return runs;
}

function write(runs: TaskRun[]) {
  // Newest first, so trimming is a slice and the panel needs no sort.
  const trimmed = runs
    .slice(0, MAX_RUNS)
    .map((r, i) =>
      i < MAX_WITH_OUTPUT || r.output === undefined
        ? r
        : { ...r, output: undefined },
    );
  if (authoritative) {
    authoritative = trimmed;
  } else try {
    const s = JSON.stringify(trimmed);
    localStorage.setItem(KEY, s);
    cache = { raw: s, runs: trimmed };
  } catch {
    // Storage full or unavailable — losing a history entry is not worth
    // interrupting anyone over, and the task itself already ran.
    cache = null;
  }
  // Fired here rather than by each caller so no write can forget it. `storage`
  // events only reach *other* tabs, which in a one-window desktop app is never.
  window.dispatchEvent(new CustomEvent(TASK_HISTORY_EVENT));
}

const statusFromEnvelope = (
  status: TaskEnvelopeSummary["status"],
): TaskRunStatus =>
  status === "completed"
    ? "done"
    : status === "blocked"
      ? "blocked"
      : status === "running"
        ? "running"
        : "stopped";

function rowFromSummary(summary: TaskEnvelopeSummary): TaskRun | null {
  const metadata =
    summary.metadata && typeof summary.metadata === "object"
      ? (summary.metadata as Partial<TaskRun> & { history?: boolean })
      : null;
  if (!metadata?.history) return null;
  return {
    taskId: summary.kind,
    label: summary.title || summary.kind,
    agent: "unknown",
    cwd: "",
    projectId: summary.projectId,
    brief: "",
    ...metadata,
    id: summary.runId,
    status: statusFromEnvelope(summary.status),
    startedAt: metadata.startedAt ?? summary.createdAt,
    endedAt:
      summary.status === "running"
        ? undefined
        : (metadata.endedAt ?? summary.updatedAt),
  };
}

function metadataFor(run: TaskRun): Record<string, unknown> {
  const { output: _output, ...metadata } = run;
  return { ...metadata, history: true };
}

function persistRun(run: TaskRun): void {
  if (!authoritative) return;
  const previous = persistQueues.get(run.id) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      let durable = run;
      if (run.output && !run.outputArtifactId) {
        const artifact = await ipc.taskArtifactWrite({
          runId: run.id,
          attemptId: run.attemptId,
          kind: "terminal-output",
          content: run.output,
        });
        durable = { ...run, outputArtifactId: artifact.id };
        if (authoritative)
          authoritative = authoritative.map((candidate) =>
            candidate.id === run.id ? durable : candidate,
          );
      }
      await ipc.taskUpdateMetadata(run.id, metadataFor(durable));
    })
    .catch((error) => console.warn("task history persistence failed", error))
    .finally(() => {
      if (persistQueues.get(run.id) === next) persistQueues.delete(run.id);
    });
  persistQueues.set(run.id, next);
}

async function importLegacy(rows: TaskRun[], existing: TaskEnvelopeSummary[]) {
  const adopted = new Map(
    existing.flatMap((summary) => {
      const metadata = summary.metadata as { legacySourceId?: unknown } | undefined;
      return typeof metadata?.legacySourceId === "string"
        ? [[metadata.legacySourceId, summary] as const]
        : [];
    }),
  );
  for (const legacy of rows) {
    const prior = adopted.get(legacy.id);
    const reservation = prior
      ? await ipc.taskGet(prior.runId).then((detail) => {
          const attempt = detail?.attempts[0];
          if (!attempt) throw new Error(`Imported task ${prior.runId} has no attempt`);
          return { envelope: prior, attempt };
        })
      : await ipc.taskReserve({
          kind: legacy.taskId || "legacy-micro-task",
          projectId: legacy.projectId || "legacy",
          componentId: legacy.projectId || "legacy",
          worktreePath: legacy.cwd || ".",
          goal: legacy.brief || legacy.label,
          acceptance: [],
          taskClasses: { legacy: 1 },
          contextSummary: "Imported from the pre-TaskEnvelope task history.",
          riskClass: "legacy",
          authorityPolicy: {},
          failoverPolicy: { automatic: false },
          attemptCap: 1,
          title: legacy.title || legacy.label,
          metadata: {
            ...metadataFor(legacy),
            legacySourceId: legacy.id,
          },
          route: {
            cli: legacy.agent || "unknown",
            profileId: "default",
            harnessVersion: "legacy",
            promptVersion: "legacy",
            toolPolicyVersion: "legacy",
            executionMode: "pty",
          },
        });
    const outputArtifactId = legacy.output
      ? (
          await ipc.taskArtifactWrite({
            runId: reservation.envelope.runId,
            attemptId: reservation.attempt.attemptId,
            kind: "legacy-terminal-output",
            content: legacy.output,
          })
        ).id
      : legacy.outputArtifactId;
    await ipc.taskUpdateMetadata(reservation.envelope.runId, {
      ...metadataFor(legacy),
      legacySourceId: legacy.id,
      attemptId: reservation.attempt.attemptId,
      outputArtifactId,
    });
    const state =
      legacy.status === "done"
        ? "completed"
        : legacy.status === "blocked" || legacy.askedForUser
          ? "blocked"
          : "interrupted";
    if (["reserved", "launching", "running", "waiting"].includes(reservation.attempt.state))
      await ipc.taskAttemptSettle({
        attemptId: reservation.attempt.attemptId,
        state,
        failureClass: state === "completed" ? null : "route",
        failureCode: state === "completed" ? null : "legacy-import",
      });
  }
}

export async function refreshTaskHistory(): Promise<TaskRun[]> {
  const generation = ++refreshGeneration;
  const projected = (await ipc.taskListHistory(MAX_RUNS))
    .map(rowFromSummary)
    .filter((row): row is TaskRun => Boolean(row));
  const rows = await Promise.all(
    projected.map(async (run) =>
      run.outputArtifactId
        ? {
            ...run,
            output: await ipc.taskArtifactRead(run.outputArtifactId).catch(() => undefined),
          }
        : run,
    ),
  );
  if (generation !== refreshGeneration) return authoritative ?? rows;
  authoritative = rows;
  write(rows);
  return rows;
}

/** Adopt the old localStorage log exactly once. The source is removed only
 * after every row is durably present, so a failed migration retries safely. */
export function hydrateTaskHistory(): Promise<TaskRun[]> {
  if (authoritative) return Promise.resolve(authoritative);
  if (hydrating) return hydrating;
  hydrating = (async () => {
    const legacy = read();
    const existing = await ipc.taskListHistory(MAX_RUNS);
    await importLegacy(legacy, existing);
    localStorage.removeItem(KEY);
    cache = null;
    return refreshTaskHistory();
  })().finally(() => {
    hydrating = null;
  });
  return hydrating;
}

if (typeof window !== "undefined") {
  window.addEventListener(TASK_ENVELOPES_EVENT, () => {
    if (authoritative) void refreshTaskHistory();
  });
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
export function recordTaskStart(
  run: Omit<TaskRun, "id" | "status" | "startedAt">,
): string {
  const id = runId();
  write([{ ...run, id, status: "running", startedAt: Date.now() }, ...read()]);
  return id;
}

export function adoptTaskReservation(
  reservation: TaskReservation,
  run: Omit<TaskRun, "id" | "status" | "startedAt" | "attemptId">,
): TaskRun {
  const row: TaskRun = {
    ...run,
    id: reservation.envelope.runId,
    attemptId: reservation.attempt.attemptId,
    status: "running",
    startedAt: reservation.envelope.createdAt,
  };
  write([row, ...read().filter((candidate) => candidate.id !== row.id)]);
  persistRun(row);
  return row;
}

/** Complete a run. A no-op for an unknown id, and — deliberately — for a run
 *  that already ended: the tab-close path fires after job_done on every
 *  successful task, and must not overwrite "done" with "stopped". */
export function recordTaskEnd(
  id: string,
  patch: Partial<Omit<TaskRun, "id">>,
): void {
  const runs = [...read()];
  const i = runs.findIndex((r) => r.id === id);
  if (i === -1 || !["running", "blocked"].includes(runs[i].status)) return;
  runs[i] = { ...runs[i], ...patch, endedAt: patch.endedAt ?? Date.now() };
  write(runs);
  persistRun(runs[i]);
  const attemptId = runs[i].attemptId;
  if (attemptId) {
    const state =
      runs[i].status === "done"
        ? "completed"
        : runs[i].status === "blocked"
          ? "blocked"
          : "interrupted";
    void ipc
      .taskAttemptSettle({ attemptId, state })
      .catch(() => {});
  }
}

/** Settle a run whose tab is closing without it ever having reported done.
 *  "Blocked" when the agent asked for the user and never got an answer, plain
 *  "stopped" otherwise — the difference between "it needed you" and "you called
 *  it off", which is the whole reason the Blocked filter exists. */
export function endAbandonedRun(id: string, output?: string): void {
  const runs = read();
  const run = runs.find((r) => r.id === id);
  if (!run || run.status !== "running") return;
  recordTaskEnd(id, {
    status: run.askedForUser ? "blocked" : "stopped",
    output,
  });
}

/** Patch a run without settling its outcome — used for the captured terminal
 *  output (recorded when the tab closes, which is after the outcome is known)
 *  and for a blocked agent's note, where the run is still very much going. */
export function updateTaskRun(
  id: string,
  patch: Partial<Omit<TaskRun, "id" | "status">>,
): void {
  const runs = [...read()];
  const i = runs.findIndex((r) => r.id === id);
  if (i === -1) return;
  runs[i] = {
    ...runs[i],
    ...patch,
    ...(patch.output !== undefined ? { outputArtifactId: undefined } : {}),
  };
  write(runs);
  persistRun(runs[i]);
}

/** Settle anything left `running` by a previous app launch. Micro-task tabs are
 *  never restored, so a task in flight when Canopy quit has no terminal to come
 *  back to and no way to ever report — without this it stays `running` for
 *  good: invisible to the history tab (which lists only finished runs), yet
 *  still taking up one of the 200 slots. Call once, on startup, before anything
 *  new is recorded. */
export async function sweepStaleRuns(currentInstance?: string): Promise<void> {
  if (authoritative) {
    const instance = currentInstance ?? (await ipc.instanceId());
    await ipc.taskInterruptStale(instance).catch(() => 0);
    await refreshTaskHistory();
    return;
  }
  const runs = read();
  if (!runs.some((r) => r.status === "running")) return;
  write(
    runs.map((r) =>
      r.status === "running"
        ? {
            ...r,
            status: r.askedForUser ? "blocked" : "stopped",
            endedAt: r.endedAt ?? Date.now(),
          }
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
  return (
    read()
      .filter(
        (r) =>
          r.status !== "running" &&
          (projectId === undefined || r.projectId === projectId),
      )
      // By when it FINISHED, not when it started. The store is newest-first by
      // start time (recordTaskStart prepends), which is a different order the
      // moment two runs overlap: a review begun at 10:00 and still going at
      // 10:30 finishes after a one-liner begun at 10:20, and "what just came
      // back" is the question this list answers. Fall back to startedAt for a
      // run that never recorded an end.
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  );
}

/** What to call a run on screen: what the agent named it, else what it was
 *  launched as. One function so the rail, the sheet and the tab title cannot
 *  disagree about which of the two they are showing. */
export const runTitle = (run: TaskRun): string => run.title || run.label;

/** The glyph to put in front of it — the agent's pick over the task's, since a
 *  task's icon says what kind of job it was and the agent's says what this one
 *  actually turned out to be. */
export const runIcon = (run: TaskRun): string | undefined =>
  run.agentIcon || run.icon;

/** Can this run be picked back up as an ordinary agent session? Needs the
 *  conversation's id and a directory still on disk to resume it in. */
export const canResumeRun = (run: TaskRun): boolean =>
  Boolean(run.sessionId) && !run.ephemeralCwd;

export function removeTaskRun(id: string): void {
  if (authoritative) {
    void ipc
      .taskDelete(id)
      .then(() => refreshTaskHistory())
      .catch((error) => console.warn("task history delete failed", error));
    return;
  }
  write(read().filter((r) => r.id !== id));
}

export function clearTaskHistory(): void {
  const old = read();
  if (authoritative) {
    void Promise.all(
      old
        .filter((run) => run.status !== "running" && run.status !== "blocked")
        .map((run) => ipc.taskDelete(run.id)),
    )
      .then(() => refreshTaskHistory())
      .catch((error) => console.warn("task history clear failed", error));
    return;
  }
  write([]);
}

/** The path to actually open for a file a run touched.
 *
 *  A task that edits code runs in a worktree we create for it, and the brief's
 *  last instruction is to delete that worktree. So every path the hook digest
 *  recorded points somewhere that no longer exists, and the chip in the history
 *  row opened nothing at all — for exactly the runs that changed the most.
 *
 *  The work itself survives: the agent committed and pushed it, so the same
 *  relative path exists in the repo. The throwaway is always `<repo>-wt-pr-<n>`
 *  (see startPrAgent), which is what lets this map back. A worktree the user
 *  made themselves is left alone — it is still on disk, and its copy is the one
 *  the agent actually worked in. */
/*  The hook records a file *relative* to the session's cwd when it sits under
 *  it, and absolutely when it does not — so `files` is a mix, and the relative
 *  half arrived here as "src/foo.ts". Nothing joined it back on, so every chip
 *  for a file the run edited inside its own project opened nothing: fs_stat
 *  rejects a relative path, and openFile logs and returns. That was most of
 *  them, and it failed in silence.  */
export function resolveTaskFile(file: string, cwd: string): string {
  const absolute = file.startsWith("/") ? file : cwd ? `${cwd}/${file}` : file;
  const wt = /^(.*)-wt-pr-\d+$/.exec(cwd);
  if (!wt) return absolute;
  const repo = wt[1];
  if (!absolute.startsWith(`${cwd}/`)) return absolute;
  return `${repo}/${absolute.slice(cwd.length + 1)}`;
}

/** Is this path inside Canopy's research store?
 *
 *  Those artifacts are real and worth opening, but they live outside every
 *  registered workspace root by design, so the editor's reader cannot reach
 *  them — a chip pointing at one has to open the research entry instead, which
 *  is where the file means something anyway. */
export function researchEntryForFile(
  file: string,
): { projectId: string; id: string } | null {
  const m = /\/\.canopy\/research\/([^/]+)\/(\d{4}-[a-z0-9-]+)\//.exec(file);
  return m ? { projectId: m[1], id: m[2] } : null;
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

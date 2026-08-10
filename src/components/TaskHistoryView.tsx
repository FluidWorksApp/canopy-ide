// Every micro-task that has run, opened as a tab. A micro-task closes its own
// terminal the moment the job lands (see reapMicroTask in ProjectView), so this
// is the only place its outcome survives: the one-line job_done summary, the URL
// it produced, the files it touched, and the tail of what actually scrolled past.
//
// Search, filter, paginate. Still not a dashboard — the reason to open this is
// to find one run and read it — but a row now gets two lines instead of one, so
// the summary (the whole payload) isn't crushed into whatever gap is left
// between the title and the clock. The list sits in a fixed reading column for
// the same reason: full-bleed on a wide window put the title at one edge and its
// duration at the other, and nothing lined up with anything.
import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  canResumeRun,
  clearTaskHistory,
  completedTaskRuns,
  loadTaskRunOutput,
  removeTaskRun,
  resolveTaskFile,
  runIcon,
  runTitle,
  TASK_HISTORY_EVENT,
  tidyOutput,
  type TaskRun,
  type TaskRunStatus,
} from "../taskHistory";
import { AGENT_CLIS } from "../projects";
import {
  AgentIcon,
  AgentsIcon,
  DocumentIcon,
  GlobeIcon,
  PlayIcon,
  StopwatchIcon,
  TasksIcon,
  TrashIcon,
} from "./icons";
import { Button, Segmented, TextInput } from "./ui";
import { TaskEvidenceFold } from "./TaskEvidence";
import { basename } from "../paths";

const PER_PAGE = 25;

/** The three ways a run can have ended. `running` is a `TaskRunStatus` too, but
 *  a run still going has no place in a list of completed ones — so it is not a
 *  filter you can pick, and not a counter the header keeps. */
type Outcome = Exclude<TaskRunStatus, "running">;

const FILTERS: { id: Outcome | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "done", label: "Done" },
  { id: "blocked", label: "Blocked" },
  { id: "stopped", label: "Stopped" },
];

/** Compact relative age for a millisecond timestamp. */
function ago(ms: number): string {
  const d = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** A span of milliseconds as work time — seconds matter on a one-liner, so the
 *  short end keeps them and the long end drops them. */
function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The same span for a running total, where the seconds are noise. */
function durTotal(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** How long the agent took. Undefined end (a run that never reported) reads as
 *  a dash rather than a wrong duration. */
function took(run: TaskRun): string {
  return run.endedAt ? dur(run.endedAt - run.startedAt) : "—";
}

/** When a run landed — the key the list is ordered by, so it's also the one the
 *  row shows and the one the day headings are cut on. */
const landed = (run: TaskRun): number => run.endedAt ?? run.startedAt;

const DAY = 86_400_000;

/** Which day heading a run falls under. Calendar days, not rolling 24h windows:
 *  "yesterday" has to mean yesterday at 11pm too. */
function dayGroup(ms: number): string {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= midnight) return "Today";
  if (ms >= midnight - DAY) return "Yesterday";
  if (ms >= midnight - 6 * DAY) return "Earlier this week";
  if (ms >= midnight - 29 * DAY) return "Earlier this month";
  return "Older";
}

interface TaskHistoryViewProps {
  /** The project this tab was opened from — the only scope this view has. */
  projectId: string;
  /** Name of that project, for the header's scope line. */
  projectName: string;
  /** Launch this run's task again, in the directory it ran in. Only offered for
   *  runs from this project: the brief would otherwise be fired into another
   *  project's tree while being recorded against this one. */
  onRunAgain?: (run: TaskRun) => void;
  /** Reopen this run's conversation as an ordinary agent session, so the work
   *  carries on from where the one-shot stopped instead of starting over. */
  onContinueSession?: (run: TaskRun) => void;
  /** Open a path in the editor — the files an agent touched are clickable. */
  onOpenFile?: (path: string) => void;
  /** A run to open expanded, when the tab was opened from that run's row. */
  focus?: { runId: string; nonce: number };
}

export function TaskHistoryView({
  projectId,
  projectName,
  onRunAgain,
  onContinueSession,
  onOpenFile,
  focus,
}: TaskHistoryViewProps) {
  // The log is app-wide, the view is not: you opened this from a project, so
  // that project's work is what you meant, and it is all this view ever shows.
  const [runs, setRuns] = useState<TaskRun[]>(() => completedTaskRuns(projectId));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Outcome | "all">("all");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [loadingOutput, setLoadingOutput] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // Opened from a run's row: expand that run, and clear whatever search or
  // filter would hide it. Landing on an unfiltered list and leaving the reader
  // to find the row again is what clicking the row was meant to spare them.
  // Keyed on the nonce, so clicking the same row twice re-focuses it.
  useEffect(() => {
    if (!focus) return;
    setOpen(focus.runId);
    setQuery("");
    setFilter("all");
    setPage(0);
    // The row may be below the fold in a long history.
    const at = window.setTimeout(() => {
      document
        .querySelector(`[data-run-id="${CSS.escape(focus.runId)}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
    return () => window.clearTimeout(at);
  }, [focus?.nonce, focus?.runId, focus]);

  // A task finishing while this tab is open should land in the list — the whole
  // point is that you can leave it open and watch outcomes arrive.
  useEffect(() => {
    const refresh = () => setRuns(completedTaskRuns(projectId));
    refresh();
    window.addEventListener(TASK_HISTORY_EVENT, refresh);
    return () => window.removeEventListener(TASK_HISTORY_EVENT, refresh);
  }, [projectId]);

  // Durable terminal output is intentionally cold for older rows. Opening one
  // is the ownership signal to load it; taskHistory deduplicates the read and
  // keeps the app-wide retained-output string budget intact.
  useEffect(() => {
    if (!open) {
      setLoadingOutput(null);
      return;
    }
    const run = completedTaskRuns(projectId).find(
      (candidate) => candidate.id === open,
    );
    if (!run?.outputArtifactId || run.output) {
      setLoadingOutput((id) => (id === open ? null : id));
      return;
    }
    let current = true;
    setLoadingOutput(open);
    void loadTaskRunOutput(open).finally(() => {
      if (current) setRuns(completedTaskRuns(projectId));
      setLoadingOutput((id) => (id === open ? null : id));
    });
    return () => {
      current = false;
    };
  }, [open, projectId]);

  // What the header states and what the filter tabs count. Over the whole
  // scope, not the current filter — a count that moves when you click it is a
  // count you can't use to decide whether to click it.
  const tally = useMemo(() => {
    const t = { all: runs.length, done: 0, blocked: 0, stopped: 0, ms: 0 };
    for (const r of runs) {
      if (r.status === "done") t.done++;
      else if (r.status === "blocked") t.blocked++;
      else if (r.status === "stopped") t.stopped++;
      if (r.endedAt) t.ms += Math.max(0, r.endedAt - r.startedAt);
    }
    return t;
  }, [runs]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((r) => {
      if (filter !== "all" && r.status !== filter) return false;
      if (!q) return true;
      // Searches everything the user can see plus the brief and the transcript:
      // "that task where it said rate limit" has to find it. The agent's own
      // title, tags and reading of the ask are in here for the same reason —
      // they are the words a user is most likely to remember it by, since they
      // are the words the row showed them.
      return [
        r.label,
        r.title,
        r.summary,
        r.asked,
        r.brief,
        r.url,
        r.cwd,
        r.agent,
        r.output,
        ...(r.tags ?? []),
      ]
        .filter(Boolean)
        .some((s) => (s as string).toLowerCase().includes(q));
    });
  }, [runs, query, filter]);

  // Any change to the result set can leave the cursor past the end.
  const pages = Math.max(1, Math.ceil(matches.length / PER_PAGE));
  const current = Math.min(page, pages - 1);
  const shown = matches.slice(current * PER_PAGE, current * PER_PAGE + PER_PAGE);

  // Cut the page into days. The list is already ordered by when a run landed,
  // so this is a single pass and the headings can never interleave.
  const days: { day: string; runs: TaskRun[] }[] = [];
  for (const run of shown) {
    const day = dayGroup(landed(run));
    const last = days[days.length - 1];
    if (last && last.day === day) last.runs.push(run);
    else days.push({ day, runs: [run] });
  }

  const agentName = (id: string) => AGENT_CLIS.find((c) => c.id === id)?.name ?? id;
  const narrowed = query.trim() !== "" || filter !== "all";

  return (
    <div className="task-history">
      <div className="task-history-head">
        <div className="task-history-col">
          <div className="task-history-head-row">
            <h2 className="task-history-title">Completed tasks</h2>
            <span className="task-history-count">{runs.length}</span>
            <span className="status-spacer" />
            {confirmClear ? (
              <>
                <span className="task-history-note">Delete all {runs.length}?</span>
                <Button size="sm" onClick={() => setConfirmClear(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="danger"
                  onClick={() => {
                    clearTaskHistory();
                    setRuns([]);
                    setConfirmClear(false);
                  }}>
                  Delete them
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={runs.length === 0}
                onClick={() => setConfirmClear(true)}>
                <TrashIcon size={12} /> Clear history
              </Button>
            )}
          </div>

          {/* The shape of the log in one line: how it went, how much agent time
              it cost, and whose work it is. Same numbers as the filter tabs
              below, said as a sentence rather than as four counters. */}
          <div className="task-history-stats">
            {runs.length === 0 ? (
              <span>Nothing has finished here yet.</span>
            ) : (
              <>
                <span className="task-history-stat">
                  <i className="task-history-dot st-done" />
                  {tally.done} done
                </span>
                {tally.blocked > 0 && (
                  <span className="task-history-stat">
                    <i className="task-history-dot st-blocked" />
                    {tally.blocked} blocked
                  </span>
                )}
                {tally.stopped > 0 && (
                  <span className="task-history-stat">
                    <i className="task-history-dot st-stopped" />
                    {tally.stopped} stopped
                  </span>
                )}
                <span className="task-history-stat">
                  <StopwatchIcon size={11} />
                  {durTotal(tally.ms)} of agent time
                </span>
                <span className="task-history-stat task-history-scope-note">
                  in {projectName}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="task-history-filters">
        <div className="task-history-col task-history-filters-row">
          <TextInput
            search
            width="lg"
            aria-label="Search completed tasks"
            placeholder="Search summaries, briefs and output…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
          <Segmented
            aria-label="Filter by outcome"
            value={filter}
            onChange={(id) => {
              setFilter(id);
              setPage(0);
            }}
            options={FILTERS.map((f) => ({
              id: f.id,
              label: (
                <>
                  {f.label}
                  <span className="ctl-seg-count">{tally[f.id]}</span>
                </>
              ),
            }))}
          />
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="task-history-empty">
          <span className="task-history-empty-mark">
            <TasksIcon size={24} />
          </span>
          <span className="task-history-empty-title">
            {runs.length === 0 ? "No finished tasks yet" : "No task matches that"}
          </span>
          <span className="task-history-empty-note">
            {runs.length === 0
              ? "One-shot tasks land here when they finish — with what the agent reported and the tail of its terminal, which is otherwise gone the moment the tab closes itself."
              : "Nothing here answers to that search and filter. Widen one of them."}
          </span>
        </div>
      ) : (
        <div className="task-history-scroll">
          <div className="task-history-col task-history-list">
            {days.map(({ day, runs: dayRuns }) => (
              <section className="task-history-day" key={day}>
                <h3 className="task-history-day-head">
                  {day}
                  <span className="task-history-day-count">{dayRuns.length}</span>
                </h3>

                {dayRuns.map((run) => {
                  const expanded = open === run.id;
                  return (
                    <div
                      className={`task-history-row ${expanded ? "is-open" : ""}`}
                      key={run.id}
                      data-run-id={run.id}
                    >
                      <button
                        type="button"
                        className="task-history-summary"
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : run.id)}
                      >
                        {/* Outcome and kind in one mark: the glyph the agent
                            picked for the run, in the colour of how it ended.
                            Two separate dots said the same thing twice. */}
                        <span className={`task-history-mark st-${run.status}`} title={run.status}>
                          {runIcon(run) || "◆"}
                        </span>

                        <span className="task-history-body">
                          <span className="task-history-line">
                            {/* What the agent called it, if it got as far as
                                saying — with the launcher's own name kept in
                                the tooltip, since that is the one that says
                                which surface it was run from. */}
                            <span
                              className="task-history-label"
                              title={run.title ? `Launched as “${run.label}”` : undefined}
                            >
                              {runTitle(run)}
                            </span>
                            {/* Only the endings that aren't the happy one get
                                named. "Done" on nine rows out of twelve is a
                                word the eye has to skip past every time. */}
                            {run.status !== "done" && (
                              <span className={`task-history-state st-${run.status}`}>
                                {run.status}
                              </span>
                            )}
                            {run.tags?.map((t) => (
                              <span className="task-tag" key={t}>
                                {t}
                              </span>
                            ))}
                          </span>
                          {/* A line of its own. It used to share one with the
                              title and the tags and the clock, which left the
                              row's actual payload three words wide. */}
                          <span
                            className={`task-history-said ${run.summary ? "" : "is-silent"}`}
                          >
                            {run.summary ?? "No summary reported."}
                          </span>
                        </span>

                        <span className="task-history-times">
                          <span
                            className="task-history-when"
                            title={`Finished ${new Date(landed(run)).toLocaleString()}`}
                          >
                            {ago(landed(run))}
                          </span>
                          <span className="task-history-took" title="How long the agent worked">
                            <StopwatchIcon size={10} />
                            {took(run)}
                          </span>
                        </span>
                      </button>

                      {expanded && (
                        <div className="task-history-detail">
                          <div className="task-history-meta">
                            <span className="task-history-chiplet">
                              <AgentIcon id={run.agent} size={12} />
                              {agentName(run.agent)}
                            </span>
                            <span
                              className="task-history-chiplet task-history-path"
                              title={run.cwd}
                            >
                              {run.cwd}
                            </span>
                            {run.url && (
                              <a
                                className="task-history-chiplet task-history-link"
                                href={run.url}
                                onClick={(e) => {
                                  e.preventDefault();
                                  void openUrl(run.url as string);
                                }}
                              >
                                <GlobeIcon size={12} />
                                {run.url}
                              </a>
                            )}
                            <span className="status-spacer" />
                            {/* Only for this project's runs: re-running fires the
                                brief into `run.cwd`, and a run from elsewhere would
                                land in another project's tree while being recorded
                                against this one. */}
                            {/* The one-shot's exit door: the agent's transcript
                                outlives its terminal, so the conversation can be
                                picked up as an ordinary session rather than started
                                again from nothing. Offered only where it can actually
                                work — a run whose worktree was torn down has no
                                directory left to resume in. */}
                            {onContinueSession &&
                              canResumeRun(run) &&
                              run.projectId === projectId && (
                                <Button
                                  size="sm"
                                  title="Open this run's conversation as a normal agent session, with everything it worked out still in context"
                                  onClick={() => onContinueSession(run)}
                                >
                                  <AgentsIcon size={12} /> Continue as a session
                                </Button>
                              )}
                            {onRunAgain && run.projectId === projectId && (
                              <Button
                                size="sm"
                                title="Run this task again, in the same directory"
                                onClick={() => onRunAgain(run)}>
                                <PlayIcon size={12} /> Run again
                              </Button>
                            )}
                            <Button icon size="sm"
                              title="Forget this run"
                              onClick={() => {
                                removeTaskRun(run.id);
                                setRuns(completedTaskRuns());
                              }}>
                              <TrashIcon size={12} />
                            </Button>
                          </div>

                          {/* Three different things, and until now they arrived as
                              one undifferentiated column of grey text: what you asked
                              for, what the agent answered, and what scrolled past
                              while it worked. The answer is the reason you opened the
                              row, so it is the one that gets a mark of its own. */}
                          <div className="task-history-section">
                            <div className="task-history-section-head">You asked</div>
                            {/* The agent's own reading of the ask, above the brief it
                                read. A brief is several hundred words of launcher
                                prose and protocol, and recalling what a run was about
                                should not mean reading past all of it — and where the
                                two disagree, that is the most useful line on the
                                page: it is the misunderstanding, in writing, right
                                above the answer it produced. So where the agent left
                                a reading, that is what shows and the brief folds up
                                behind it; where it didn't, the brief is all there is
                                and it stays open. */}
                            {run.asked ? (
                              <>
                                <div className="task-history-asked">{run.asked}</div>
                                <details className="task-history-fold">
                                  <summary>
                                    <span className="task-history-caret">›</span>
                                    The brief it was given
                                  </summary>
                                  <div className="task-history-brief">{run.brief}</div>
                                </details>
                              </>
                            ) : (
                              <div className="task-history-brief">{run.brief}</div>
                            )}
                          </div>

                          <div className="task-history-section is-report">
                            <div className="task-history-section-head">
                              <AgentsIcon size={11} /> The agent reported
                            </div>
                            {/* The row truncates this to one line — it is the row's
                                job to be scannable. The full text has to live
                                somewhere, and this is the somewhere. */}
                            <div className="task-history-report">
                              {run.summary ?? "It finished without reporting a summary."}
                            </div>
                          </div>

                          {run.files && run.files.length > 0 && (
                            <div className="task-history-section">
                              <div className="task-history-section-head">
                                Files it touched
                                <span className="task-history-section-count">
                                  {run.files.length}
                                </span>
                              </div>
                              <div className="task-history-files">
                                {run.files.map((f) => {
                                  // The recorded path may point into a worktree that
                                  // no longer exists; the committed file does.
                                  const at = resolveTaskFile(f, run.cwd);
                                  return (
                                    <button
                                      key={f}
                                      type="button"
                                      className="task-history-file"
                                      title={at}
                                      onClick={() => onOpenFile?.(at)}
                                    >
                                      <DocumentIcon size={11} />
                                      {basename(at)}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {run.output ? (
                            /* Shut by default. The answer above is what you opened
                               the row for; the tail is the evidence behind it, and
                               only sometimes what you want. Left open it pushed every
                               other run off the screen. */
                            <details className="task-history-section task-history-fold task-history-tail">
                              <summary className="task-history-section-head">
                                <span className="task-history-caret">›</span>
                                Terminal tail
                                <span className="task-history-section-count">
                                  {tidyOutput(run.output).split("\n").length} lines
                                </span>
                              </summary>
                              <pre className="task-history-output">
                                {tidyOutput(run.output)}
                              </pre>
                            </details>
                          ) : run.outputArtifactId ? (
                            <div className="task-history-note">
                              {loadingOutput === run.id
                                ? "Loading the terminal tail…"
                                : "Open this run again to load its terminal tail."}
                            </div>
                          ) : (
                            <div className="task-history-note">
                              The terminal output for this run is no longer kept — only the
                              most recent runs hold on to theirs.
                            </div>
                          )}

                          {/* The terminal tail above is what the agent SAID.
                              This is what Canopy independently observed: the
                              route each attempt actually ran on, what was
                              checked, what the verdict was, and the artifacts
                              kept to back it up. All of it was being written
                              and none of it was being read. */}
                          <TaskEvidenceFold runId={run.id} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            ))}

            {/* A list that just stops halfway down a tall window looks like it
                failed to load the rest. One hairline says it didn't. */}
            {pages === 1 && (
              <div className="task-history-end">
                {narrowed
                  ? `${matches.length} of ${runs.length} runs`
                  : `All ${runs.length} runs`}
              </div>
            )}
          </div>
        </div>
      )}

      {pages > 1 && (
        <div className="task-history-pager">
          <div className="task-history-col task-history-pager-row">
            <Button size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
              ‹ Newer
            </Button>
            <span className="task-history-note">
              {current * PER_PAGE + 1}–{current * PER_PAGE + shown.length} of {matches.length}
            </span>
            <Button
              size="sm"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}>
              Older ›
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

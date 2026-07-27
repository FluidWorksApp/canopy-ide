// Every micro-task that has run, opened as a tab. A micro-task closes its own
// terminal the moment the job lands (see reapMicroTask in ProjectView), so this
// is the only place its outcome survives: the one-line job_done summary, the URL
// it produced, the files it touched, and the tail of what actually scrolled past.
//
// Search, filter, paginate. Kept deliberately plain — the reason to open this is
// to find one run and read it, not to admire the list.
import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  clearTaskHistory,
  completedTaskRuns,
  removeTaskRun,
  resolveTaskFile,
  TASK_HISTORY_EVENT,
  tidyOutput,
  type TaskRun,
  type TaskRunStatus,
} from "../taskHistory";
import { AGENT_CLIS } from "../projects";
import { AgentsIcon, PlayIcon, TrashIcon } from "./icons";

const PER_PAGE = 25;

const FILTERS: { id: TaskRunStatus | "all"; label: string }[] = [
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

/** How long the agent took. Undefined end (a run that never reported) reads as
 *  a dash rather than a wrong duration. */
function took(run: TaskRun): string {
  if (!run.endedAt) return "—";
  const s = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

interface TaskHistoryViewProps {
  /** The project this tab was opened from — the default scope. */
  projectId: string;
  /** Name of that project, for the "everywhere" view's per-row label. */
  projectName: string;
  /** Launch this run's task again, in the directory it ran in. Only offered for
   *  runs from this project: the brief would otherwise be fired into another
   *  project's tree while being recorded against this one. */
  onRunAgain?: (run: TaskRun) => void;
  /** Open a path in the editor — the files an agent touched are clickable. */
  onOpenFile?: (path: string) => void;
  /** A run to open expanded, when the tab was opened from that run's row. */
  focus?: { runId: string; nonce: number };
}

export function TaskHistoryView({
  projectId,
  projectName,
  onRunAgain,
  onOpenFile,
  focus,
}: TaskHistoryViewProps) {
  // The log is app-wide, the view is not: you opened this from a project, so
  // that project's work is what you meant. "Everywhere" is one click away.
  const [everywhere, setEverywhere] = useState(false);
  const [runs, setRuns] = useState<TaskRun[]>(() => completedTaskRuns(projectId));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskRunStatus | "all">("all");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
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
    const refresh = () => setRuns(completedTaskRuns(everywhere ? undefined : projectId));
    refresh();
    window.addEventListener(TASK_HISTORY_EVENT, refresh);
    return () => window.removeEventListener(TASK_HISTORY_EVENT, refresh);
  }, [everywhere, projectId]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((r) => {
      if (filter !== "all" && r.status !== filter) return false;
      if (!q) return true;
      // Searches everything the user can see plus the brief and the transcript:
      // "that task where it said rate limit" has to find it.
      return [r.label, r.summary, r.brief, r.url, r.cwd, r.agent, r.output]
        .filter(Boolean)
        .some((s) => (s as string).toLowerCase().includes(q));
    });
  }, [runs, query, filter]);

  // Any change to the result set can leave the cursor past the end.
  const pages = Math.max(1, Math.ceil(matches.length / PER_PAGE));
  const current = Math.min(page, pages - 1);
  const shown = matches.slice(current * PER_PAGE, current * PER_PAGE + PER_PAGE);

  const agentName = (id: string) => AGENT_CLIS.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="task-history">
      <div className="task-history-head">
        <span className="task-history-title">Completed tasks</span>
        <span className="badge">{runs.length}</span>
        <span className="status-spacer" />
        {confirmClear ? (
          <>
            <span className="task-history-note">Delete all {runs.length}?</span>
            <button className="btn" onClick={() => setConfirmClear(false)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              onClick={() => {
                clearTaskHistory();
                setRuns([]);
                setConfirmClear(false);
              }}
            >
              Clear history
            </button>
          </>
        ) : (
          <button
            className="btn"
            disabled={runs.length === 0}
            onClick={() => setConfirmClear(true)}
          >
            Clear history
          </button>
        )}
      </div>

      <div className="task-history-filters">
        <input
          className="agent-query-input"
          placeholder="Search summaries, briefs and output…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`task-history-chip ${filter === f.id ? "task-history-chip-on" : ""}`}
            onClick={() => {
              setFilter(f.id);
              setPage(0);
            }}
          >
            {f.label}
          </button>
        ))}
        <span className="status-spacer" />
        <button
          className={`task-history-chip ${everywhere ? "task-history-chip-on" : ""}`}
          title={
            everywhere
              ? `Showing tasks from every project — click for ${projectName} only`
              : "Tasks run in your other projects too"
          }
          onClick={() => {
            setEverywhere((v) => !v);
            setPage(0);
          }}
        >
          All projects
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="tree-empty">
          {runs.length === 0
            ? "Nothing here yet. One-shot tasks land here when they finish — with what the agent reported and the tail of its terminal, which is otherwise gone the moment the tab closes itself."
            : "No task matches that."}
        </div>
      ) : (
        <div className="task-history-list">
          {shown.map((run) => {
            const expanded = open === run.id;
            return (
              <div
                className={`task-history-row ${expanded ? "is-open" : ""}`}
                key={run.id}
                data-run-id={run.id}
              >
                <div
                  className="task-history-summary"
                  onClick={() => setOpen(expanded ? null : run.id)}
                >
                  <span className={`task-history-dot st-${run.status}`} title={run.status} />
                  <span className="task-icon">{run.icon || "◆"}</span>
                  <span className="task-history-label">{run.label}</span>
                  {/* Only in the everywhere view — in the scoped one every row
                      is this project and the chip would be noise on all of them. */}
                  {everywhere && (
                    <span className="task-history-project" title={run.cwd}>
                      {run.projectName ?? run.cwd.split("/").filter(Boolean).pop()}
                    </span>
                  )}
                  <span className="task-history-said">{run.summary ?? "No summary reported."}</span>
                  <span className="task-history-when" title={new Date(run.startedAt).toLocaleString()}>
                    {ago(run.startedAt)}
                  </span>
                  <span className="task-history-took">{took(run)}</span>
                </div>

                {expanded && (
                  <div className="task-history-detail">
                    <div className="task-history-meta">
                      <span>{agentName(run.agent)}</span>
                      <span className="task-history-path" title={run.cwd}>
                        {run.cwd}
                      </span>
                      {run.url && (
                        <a
                          href={run.url}
                          onClick={(e) => {
                            e.preventDefault();
                            void openUrl(run.url as string);
                          }}
                        >
                          {run.url}
                        </a>
                      )}
                      <span className="status-spacer" />
                      {/* Only for this project's runs: re-running fires the
                          brief into `run.cwd`, and a run from elsewhere would
                          land in another project's tree while being recorded
                          against this one. */}
                      {onRunAgain && run.projectId === projectId && (
                        <button
                          className="btn"
                          title="Run this task again, in the same directory"
                          onClick={() => onRunAgain(run)}
                        >
                          <PlayIcon size={12} /> Run again
                        </button>
                      )}
                      <button
                        className="btn-icon"
                        title="Forget this run"
                        onClick={() => {
                          removeTaskRun(run.id);
                          setRuns(completedTaskRuns());
                        }}
                      >
                        <TrashIcon size={12} />
                      </button>
                    </div>

                    {/* Three different things, and until now they arrived as
                        one undifferentiated column of grey text: what you asked
                        for, what the agent answered, and what scrolled past
                        while it worked. The answer is the reason you opened the
                        row, so it is the one that gets a mark of its own. */}
                    <div className="task-history-section">
                      <div className="task-history-section-head">You asked</div>
                      <div className="task-history-brief">{run.brief}</div>
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
                        <div className="task-history-section-head">Files it touched</div>
                        <div className="task-history-files">
                          {run.files.map((f) => {
                            // The recorded path may point into a worktree that
                            // no longer exists; the committed file does.
                            const at = resolveTaskFile(f, run.cwd);
                            return (
                              <button
                                key={f}
                                className="task-history-file"
                                title={at}
                                onClick={() => onOpenFile?.(at)}
                              >
                                {at.split("/").pop()}
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
                      <details className="task-history-section task-history-tail">
                        <summary className="task-history-section-head">
                          <span className="task-history-tail-caret">›</span>
                          Terminal tail
                          <span className="task-history-tail-size">
                            {tidyOutput(run.output).split("\n").length} lines
                          </span>
                        </summary>
                        <pre className="task-history-output">
                          {tidyOutput(run.output)}
                        </pre>
                      </details>
                    ) : (
                      <div className="task-history-note">
                        The terminal output for this run is no longer kept — only the
                        most recent runs hold on to theirs.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {pages > 1 && (
        <div className="task-history-pager">
          <button className="btn" disabled={current === 0} onClick={() => setPage(current - 1)}>
            ‹ Newer
          </button>
          <span className="task-history-note">
            {current * PER_PAGE + 1}–{current * PER_PAGE + shown.length} of {matches.length}
          </span>
          <button
            className="btn"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
          >
            Older ›
          </button>
        </div>
      )}
    </div>
  );
}

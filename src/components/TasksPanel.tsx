// Tasks sidebar section: the home of micro-tasks. Four parts — the micro-task
// tabs running right now (focus / stop), the ones that have finished (a count
// and the last few, opening the full history tab), the tasks the user wrote
// themselves (run / edit / delete, stored in settings), and the built-ins,
// listed so they're discoverable but run from their own surface (Raise PR lives
// on a branch tab, where its payload comes from). Running a custom task asks for
// the optional extra context — and the directory, when the project has more
// than one component — then hands off to ProjectView's startMicroTask.
import { useEffect, useState } from "react";
import {
  MICRO_TASKS,
  type CustomMicroTask,
} from "../microTasks";
import { getSettings, updateSettings } from "../settings";
import { completedTaskRuns, TASK_HISTORY_EVENT, type TaskRun } from "../taskHistory";
import { PlayIcon, StopIcon, TrashIcon } from "./icons";

export interface RunningMicroTask {
  tabId: string;
  title: string;
  state: "working" | "waiting" | "idle" | "ended";
  icon?: string;
}

interface TasksPanelProps {
  components: { label: string; path: string }[];
  running: RunningMicroTask[];
  /** Prefill for the create form — set when the user right-clicks selected
   *  terminal text → "New task from selection". The nonce distinguishes two
   *  seeds with identical text, so the form re-opens each time. */
  seed?: { brief: string; nonce: number } | null;
  /** Bring the task's terminal tab forward. */
  onFocus: (tabId: string) => void;
  /** Close the task's tab (kills its agent; the session is forgotten). */
  onStop: (tabId: string) => void;
  /** Launch a custom task in `dir` with the user's extra context. */
  onRunCustom: (task: CustomMicroTask, dir: string, query: string) => void;
  /** Open the completed-tasks tab — the full searchable history. */
  onOpenHistory: () => void;
  /** Scopes the Completed count to this project's runs. */
  projectId: string;
}

/** The edit form's working copy — also the "new task" state when id is "". */
type Draft = { id: string; label: string; icon: string; placeholder: string; brief: string };

const emptyDraft = (): Draft => ({ id: "", label: "", icon: "", placeholder: "", brief: "" });

export function TasksPanel({
  components,
  running,
  seed,
  onFocus,
  onStop,
  onRunCustom,
  onOpenHistory,
  projectId,
}: TasksPanelProps) {
  const [custom, setCustom] = useState<CustomMicroTask[]>(() => getSettings().customMicroTasks);
  const [draft, setDraft] = useState<Draft | null>(null);
  // A task finishing has to move the count here even though the panel didn't
  // do anything — the whole lifecycle happens in a tab the user has left.
  // Scoped to this project, like the tab it opens: a count in a project's
  // sidebar that included other projects' work would just be wrong.
  const [done, setDone] = useState<TaskRun[]>(() => completedTaskRuns(projectId));
  useEffect(() => {
    const refresh = () => setDone(completedTaskRuns(projectId));
    refresh();
    window.addEventListener(TASK_HISTORY_EVENT, refresh);
    return () => window.removeEventListener(TASK_HISTORY_EVENT, refresh);
  }, [projectId]);

  // A seed from "New task from selection" opens the create form with the
  // selected text as the brief; the user names it and tweaks from there. Also
  // fires on first mount — the panel mounts lazily, often *because* the seed
  // just flipped the rail to Tasks.
  useEffect(() => {
    if (seed) setDraft({ ...emptyDraft(), brief: seed.brief });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);
  /** Which task row has its run controls (context + dir) expanded. */
  const [runOpen, setRunOpen] = useState<string | null>(null);
  const [runQuery, setRunQuery] = useState("");
  const [runDir, setRunDir] = useState("");

  const save = (next: CustomMicroTask[]) => {
    setCustom(next);
    updateSettings({ customMicroTasks: next });
  };

  const submitDraft = () => {
    if (!draft || !draft.label.trim() || !draft.brief.trim()) return;
    const task: CustomMicroTask = {
      id: draft.id || crypto.randomUUID(),
      label: draft.label.trim(),
      icon: draft.icon.trim(),
      placeholder: draft.placeholder.trim(),
      brief: draft.brief.trim(),
    };
    save(draft.id ? custom.map((c) => (c.id === draft.id ? task : c)) : [...custom, task]);
    setDraft(null);
  };

  const runRow = (task: CustomMicroTask) => {
    const open = runOpen === task.id;
    return (
      <div key={task.id}>
        <div className="task-row">
          <span className="task-icon">{task.icon || "◆"}</span>
          <span className="task-label" title={task.brief}>
            {task.label}
          </span>
          <button
            className="btn-icon"
            title="Run this task"
            onClick={() => {
              setRunOpen(open ? null : task.id);
              setRunQuery("");
              setRunDir(components[0]?.path ?? "");
            }}
          >
            <PlayIcon size={12} />
          </button>
          <button
            className="btn-icon"
            title="Edit"
            onClick={() => {
              setDraft({
                id: task.id,
                label: task.label,
                icon: task.icon,
                placeholder: task.placeholder,
                brief: task.brief,
              });
              setRunOpen(null);
            }}
          >
            ✎
          </button>
          <button
            className="btn-icon"
            title="Delete this task"
            onClick={() => save(custom.filter((c) => c.id !== task.id))}
          >
            <TrashIcon size={12} />
          </button>
        </div>
        {open && (
          <div className="task-run-form">
            {components.length > 1 && (
              <select
                className="task-run-dir"
                value={runDir}
                onChange={(e) => setRunDir(e.target.value)}
                title="Where the agent runs"
              >
                {components.map((c) => (
                  <option key={c.path} value={c.path}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
            <input
              autoFocus
              className="agent-query-input"
              placeholder={task.placeholder || "Anything to add…"}
              value={runQuery}
              onChange={(e) => setRunQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onRunCustom(task, runDir || (components[0]?.path ?? ""), runQuery.trim());
                  setRunOpen(null);
                }
                if (e.key === "Escape") setRunOpen(null);
              }}
            />
            <button
              className="btn btn-accent"
              onClick={() => {
                onRunCustom(task, runDir || (components[0]?.path ?? ""), runQuery.trim());
                setRunOpen(null);
              }}
            >
              Go
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="side-panel">
      <div className="side-panel-head">
        <span>Tasks</span>
        <button
          className="btn-icon"
          title="New task"
          onClick={() => setDraft(draft && !draft.id ? null : emptyDraft())}
        >
          ＋
        </button>
      </div>

      {running.length > 0 && (
        <>
          <div className="ticket-state-head">
            Running
            <span className="badge">{running.length}</span>
          </div>
          {running.map((r) => (
            <div className="task-row" key={r.tabId}>
              <span className={`agent-state-dot st-${r.state}`} title={r.state} />
              <span
                className="task-label task-label-link"
                title="Show this task's terminal"
                onClick={() => onFocus(r.tabId)}
              >
                {r.icon ? `${r.icon} ` : ""}
                {r.title}
              </span>
              <button className="btn-icon" title="Stop and close" onClick={() => onStop(r.tabId)}>
                <StopIcon size={12} />
              </button>
            </div>
          ))}
        </>
      )}

      {done.length > 0 && (
        <>
          <div className="ticket-state-head">
            Completed
            <span className="badge">{done.length}</span>
            <span className="status-spacer" />
            <button
              className="btn-icon"
              title="Open the full history — search, filter, and read what each task reported"
              onClick={onOpenHistory}
            >
              ⤢
            </button>
          </div>
          {/* The last few, as a way in. Everything else is a click away — the
              panel is not the place to page through a hundred finished jobs. */}
          {done.slice(0, 3).map((r) => (
            <div className="task-row" key={r.id}>
              <span className={`task-done-dot st-${r.status}`} title={r.status} />
              <span
                className="task-label task-label-link"
                title={r.summary ?? "No summary reported."}
                onClick={onOpenHistory}
              >
                {r.icon ? `${r.icon} ` : ""}
                {r.label}
              </span>
            </div>
          ))}
        </>
      )}

      {draft && (
        <div className="task-edit-form">
          <input
            autoFocus
            className="agent-query-input"
            placeholder="Task name — the button's label"
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
          <textarea
            className="task-brief-input"
            placeholder="The job, in your words: what the agent should do, and how it knows it's done. It runs once, reports, and its terminal closes."
            rows={4}
            value={draft.brief}
            onChange={(e) => setDraft({ ...draft, brief: e.target.value })}
          />
          <input
            className="agent-query-input"
            placeholder="Run-time hint, e.g. “Anything to add…” (optional)"
            title="Placeholder shown in the context box when you run this task"
            value={draft.placeholder}
            onChange={(e) => setDraft({ ...draft, placeholder: e.target.value })}
          />
          <div className="confirm-actions">
            <button className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button
              className="btn btn-accent"
              disabled={!draft.label.trim() || !draft.brief.trim()}
              onClick={submitDraft}
            >
              {draft.id ? "Save" : "Create"}
            </button>
          </div>
        </div>
      )}

      <div className="ticket-state-head">
        Your tasks
        <span className="badge">{custom.length}</span>
      </div>
      {custom.length === 0 && !draft ? (
        <div className="tree-empty">
          One-shot jobs an agent runs and reports back on — the terminal closes
          itself when the job is done. Create one with ＋.
        </div>
      ) : (
        custom.map(runRow)
      )}

      <div className="ticket-state-head">Built-in</div>
      {MICRO_TASKS.map((t) => (
        <div className="task-row" key={t.id}>
          <span className="task-icon">{t.icon}</span>
          <span
            className="task-label task-label-dim"
            title={`Runs from its own surface — ${t.surfaceNote ?? "see its tab"}, which supplies what it works on`}
          >
            {t.label}
          </span>
          {t.surfaceNote && <span className="task-note">{t.surfaceNote}</span>}
        </div>
      ))}
    </div>
  );
}

// Tasks sidebar section: the home of micro-tasks. Four parts — the micro-task
// tabs running right now (focus / stop), the ones that have finished (a count
// and the last few, opening the full history tab), the tasks the user wrote
// themselves (run / edit / delete, stored in settings), and the built-ins,
// listed so they're discoverable but run from their own surface (Raise PR lives
// on a branch tab, where its payload comes from). Running a custom task asks for
// the optional extra context — and the directory, when the project has more
// than one component — then hands off to ProjectView's startMicroTask.
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CUSTOM_TASKS_EVENT,
  EFFECT_HEADING,
  MICRO_TASKS,
  type CustomMicroTask,
  type TaskEffect,
} from "../microTasks";
import { BUILT_IN_HEADING, CUSTOM_HEADING } from "../taskMenu";
import { getSettings, updateSettings } from "../settings";
import { completedTaskRuns, TASK_HISTORY_EVENT, type TaskRun } from "../taskHistory";
import { PlayIcon, StopIcon, TrashIcon } from "./icons";

/** A task in flight. Detached runs (the usual kind) carry a `ptyId` and no tab —
 *  this row is the only place they appear, so it has to say what a tab would
 *  have: what it's doing, whether it needs you, and how to look at it. A run
 *  that kept its tab (an agent that can't report its own ending) carries a
 *  `tabId` instead and is focused rather than attached to. */
export interface RunningMicroTask {
  tabId?: string;
  ptyId?: number;
  title: string;
  state: "working" | "waiting" | "idle" | "ended";
  icon?: string;
  /** One line under the title: the last tool it used, or that it needs you. */
  note?: string;
  blocked?: boolean;
  /** A terminal is already open on this run. */
  watching?: boolean;
}

interface TasksPanelProps {
  components: { label: string; path: string }[];
  running: RunningMicroTask[];
  /** Prefill for a composer — set when the user right-clicks selected terminal
   *  text → "New Task…" (mode "save") or "One-off task…" (mode "once"), which
   *  decides which of the two opens. The nonce distinguishes two seeds with
   *  identical text, so the composer re-opens each time. */
  seed?: { brief: string; mode?: "save" | "once"; nonce: number } | null;
  /** Look at the task: focus its tab, or open a terminal onto a detached run. */
  onShow: (task: RunningMicroTask) => void;
  /** Call the task off (kills its agent; the session is forgotten). */
  onStop: (task: RunningMicroTask) => void;
  /** Launch a custom task in `dir` with the user's extra context. */
  onRunCustom: (task: CustomMicroTask, dir: string, query: string) => void;
  /** Run a brief once, without adding it to the list. */
  onRunOneOff: (brief: string, dir: string) => void;
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
  onShow,
  onStop,
  onRunCustom,
  onRunOneOff,
  onOpenHistory,
  projectId,
}: TasksPanelProps) {
  const [custom, setCustom] = useState<CustomMicroTask[]>(() => getSettings().customMicroTasks);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The one-off composer's brief while it's open, or null when it's shut. A
   *  task nobody is keeping still deserves the same box to write it in. */
  const [oneOff, setOneOff] = useState<string | null>(null);
  const [oneOffDir, setOneOffDir] = useState("");
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

  // A seed from a right-click opens the composer it asked for, with the clicked
  // subject as the brief: the create form (the user names it and tweaks from
  // there) or the one-off box. Also fires on first mount — the panel mounts
  // lazily, often *because* the seed just flipped the rail to Tasks.
  useEffect(() => {
    if (!seed) return;
    if (seed.mode === "once") {
      setDraft(null);
      setOneOffDir(components[0]?.path ?? "");
      setOneOff(seed.brief);
    } else {
      setOneOff(null);
      setDraft({ ...emptyDraft(), brief: seed.brief });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);

  const runOneOff = () => {
    const brief = (oneOff ?? "").trim();
    if (!brief) return;
    onRunOneOff(brief, oneOffDir || (components[0]?.path ?? ""));
    setOneOff(null);
  };
  /** Which task row has its run controls (context + dir) expanded. */
  const [runOpen, setRunOpen] = useState<string | null>(null);
  const [runQuery, setRunQuery] = useState("");
  const [runDir, setRunDir] = useState("");

  // Saved tasks belong to the user, not to a project, so a task written here
  // has to appear in every other project's panel too — and those panels stay
  // mounted behind the one in front, holding whatever list they read at mount.
  useEffect(() => {
    const refresh = () => setCustom(getSettings().customMicroTasks);
    window.addEventListener(CUSTOM_TASKS_EVENT, refresh);
    return () => window.removeEventListener(CUSTOM_TASKS_EVENT, refresh);
  }, []);

  const save = (next: CustomMicroTask[]) => {
    setCustom(next);
    updateSettings({ customMicroTasks: next });
    window.dispatchEvent(new Event(CUSTOM_TASKS_EVENT));
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
        <span className="task-head-actions">
        <button
          className="btn-icon"
          title="Run a one-off task — type the job, it runs once, nothing is saved"
          onClick={() => {
            setOneOff((v) => (v == null ? "" : null));
            setOneOffDir(components[0]?.path ?? "");
            setDraft(null);
          }}
        >
          ⚡
        </button>
        <button
          className="btn-icon"
          title="New task"
          onClick={() => {
            setDraft(draft && !draft.id ? null : emptyDraft());
            setOneOff(null);
          }}
        >
          ＋
        </button>
        </span>
      </div>

      {running.length > 0 && (
        <>
          <div className="ticket-state-head">
            Running
            <span className="badge">{running.length}</span>
          </div>
          {running.map((r) => (
            <div
              className={`task-row task-row-running${r.blocked ? " task-row-blocked" : ""}`}
              key={r.tabId ?? `pty:${r.ptyId}`}
            >
              <span className={`agent-state-dot st-${r.state}`} title={r.state} />
              {/* The whole row opens the run: a task with no tab needs one
                  obvious way in, and "where is it?" is the first thing anyone
                  asks about work that isn't on screen. */}
              <span
                className="task-label task-label-link"
                title={
                  r.watching
                    ? "Show the terminal you have open on this task"
                    : r.blocked
                      ? "This task is waiting on you — open its terminal to answer"
                      : "Watch this task's terminal"
                }
                onClick={() => onShow(r)}
              >
                {r.icon ? `${r.icon} ` : ""}
                {r.title}
                {r.note && <span className="task-note-inline">{r.note}</span>}
              </span>
              <button
                className="btn-icon"
                title="Stop this task"
                onClick={() => onStop(r)}
              >
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
          {/* The last few with what they reported — a task that ran unwatched
              has nowhere else to say it, and "3 blocking, 2 nits" in the panel
              is the whole point of having sent it off. Everything else is a
              click away; the panel is not the place to page through a hundred
              finished jobs. */}
          {done.slice(0, 3).map((r) => (
            <div className="task-row task-row-done" key={r.id}>
              <span className={`task-done-dot st-${r.status}`} title={r.status} />
              <span
                className="task-label task-label-link"
                title={r.summary ?? "No summary reported."}
                onClick={onOpenHistory}
              >
                {r.icon ? `${r.icon} ` : ""}
                {r.label}
                {r.summary && <span className="task-note-inline">{r.summary}</span>}
              </span>
              {r.url && (
                <button
                  className="btn-icon"
                  title={`Open ${r.url}`}
                  onClick={() => void openUrl(r.url as string)}
                >
                  ↗
                </button>
              )}
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

      {oneOff != null && (
        <div className="task-edit-form">
          <textarea
            autoFocus
            className="task-brief-input"
            placeholder="The job, in your words. It runs once, reports, and its terminal closes — nothing is saved to the list."
            rows={4}
            value={oneOff}
            onChange={(e) => setOneOff(e.target.value)}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter submits; plain Enter is a newline, since a brief
              // typed here is usually a paragraph rather than a line.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runOneOff();
              if (e.key === "Escape") setOneOff(null);
            }}
          />
          {components.length > 1 && (
            <select
              className="task-run-dir"
              value={oneOffDir}
              onChange={(e) => setOneOffDir(e.target.value)}
              title="Where the agent runs"
            >
              {components.map((c) => (
                <option key={c.path} value={c.path}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <div className="confirm-actions">
            <button className="btn" onClick={() => setOneOff(null)}>
              Cancel
            </button>
            <button className="btn btn-accent" disabled={!oneOff.trim()} onClick={runOneOff}>
              Run once
            </button>
          </div>
        </div>
      )}

      <div className="ticket-state-head">
        {CUSTOM_HEADING}
        <span className="badge">{custom.length}</span>
      </div>
      {custom.length === 0 && !draft ? (
        <div className="tree-empty">
          One-shot jobs an agent runs and reports back on — the terminal closes
          itself when the job is done. Create one with ＋, or run one without
          keeping it with ⚡.
        </div>
      ) : (
        custom.map(runRow)
      )}

      {/* Grouped by what each one DOES, not by what it is called: four of these
          are some flavour of "review", and the difference that matters is
          whether anything leaves your machine. The surface note moves into the
          tooltip — it read as information but was "on a PR tab" seven times. */}
      <div className="ticket-state-head">{BUILT_IN_HEADING}</div>
      {(["reads", "posts", "pushes"] as TaskEffect[]).map((effect) => {
        const group = MICRO_TASKS.filter((t) => (t.effect ?? "reads") === effect);
        if (!group.length) return null;
        return (
          <div className="task-effect-group" key={effect}>
            <div className={`task-effect-head is-${effect}`}>{EFFECT_HEADING[effect]}</div>
            {group.map((t) => (
              <div
                className="task-row task-row-built-in"
                key={t.id}
                title={`Runs from its own surface — ${t.surfaceNote ?? "see its tab"}, which supplies what it works on`}
              >
                <span className="task-icon">{t.icon}</span>
                <span className="task-label task-label-dim">{t.label}</span>
                {t.blurb && <span className="task-blurb">{t.blurb}</span>}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

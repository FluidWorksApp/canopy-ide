// Tasks sidebar section: the home of micro-tasks. Four parts — the micro-task
// tabs running right now (focus / stop), the ones that have finished (a count
// and the last few, opening the full history tab), the tasks the user wrote
// themselves (run / edit / delete, stored on the project), and the built-ins,
// listed so they're discoverable but run from their own surface (Raise PR lives
// on a branch tab, where its payload comes from). Running a custom task asks for
// the optional extra context — and the directory, when the project has more
// than one component — then hands off to ProjectView's startMicroTask.
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  EFFECT_HEADING,
  MICRO_TASKS,
  type CustomMicroTask,
  type TaskEffect,
} from "../microTasks";
import { BUILT_IN_HEADING } from "../taskMenu";
import {
  completedTaskRuns,
  TASK_HISTORY_EVENT,
  type TaskRun,
} from "../taskHistory";
import { PlayIcon, StopIcon, TrashIcon } from "./icons";
import { Button } from "./ui";

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
  /** Open the full history. Given a run id, expand that run when it opens —
   *  a row you clicked should not make you find it again in the list. */
  onOpenHistory: (focus?: string) => void;
  /** The tasks this project keeps. Owned by the project, so editing one is a
   *  workspace save, not a settings write — and a task written here doesn't
   *  turn up in a project it makes no sense in. */
  custom: CustomMicroTask[];
  onSaveCustom: (next: CustomMicroTask[]) => void;
  /** Scopes the Completed count to this project's runs. */
  projectId: string;
}

/** The edit form's working copy — also the "new task" state when id is "". */
type Draft = {
  id: string;
  label: string;
  icon: string;
  placeholder: string;
  brief: string;
};

/** How many finished runs the panel shows. Enough to cover a working session
 *  without the rail turning into a log — everything older is one click away in
 *  the history sheet, which is built for reading a hundred of them. */
const PANEL_DONE = 10;

const emptyDraft = (): Draft => ({
  id: "",
  label: "",
  icon: "",
  placeholder: "",
  brief: "",
});

export function TasksPanel({
  components,
  running,
  seed,
  onShow,
  onStop,
  onRunCustom,
  onRunOneOff,
  onOpenHistory,
  custom,
  onSaveCustom,
  projectId,
}: TasksPanelProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The one-off composer's brief while it's open, or null when it's shut. A
   *  task nobody is keeping still deserves the same box to write it in. */
  const [oneOff, setOneOff] = useState<string | null>(null);
  const [oneOffDir, setOneOffDir] = useState("");
  // A task finishing has to move the count here even though the panel didn't
  // do anything — the whole lifecycle happens in a tab the user has left.
  // Scoped to this project, like the tab it opens: a count in a project's
  // sidebar that included other projects' work would just be wrong.
  const [done, setDone] = useState<TaskRun[]>(() =>
    completedTaskRuns(projectId),
  );
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

  const openNewTask = () => {
    setDraft(draft && !draft.id ? null : emptyDraft());
    setOneOff(null);
  };

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

  const save = onSaveCustom;

  const submitDraft = () => {
    if (!draft || !draft.label.trim() || !draft.brief.trim()) return;
    const task: CustomMicroTask = {
      id: draft.id || crypto.randomUUID(),
      label: draft.label.trim(),
      icon: draft.icon.trim(),
      placeholder: draft.placeholder.trim(),
      brief: draft.brief.trim(),
    };
    save(
      draft.id
        ? custom.map((c) => (c.id === draft.id ? task : c))
        : [...custom, task],
    );
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
          <Button icon
            title="Run this task"
            onClick={() => {
              setRunOpen(open ? null : task.id);
              setRunQuery("");
              setRunDir(components[0]?.path ?? "");
            }}>
            <PlayIcon size={12} />
          </Button>
          <Button icon
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
            }}>
            ✎
          </Button>
          <Button icon
            title="Delete this task"
            onClick={() => save(custom.filter((c) => c.id !== task.id))}>
            <TrashIcon size={12} />
          </Button>
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
                  onRunCustom(
                    task,
                    runDir || (components[0]?.path ?? ""),
                    runQuery.trim(),
                  );
                  setRunOpen(null);
                }
                if (e.key === "Escape") setRunOpen(null);
              }}
            />
            <Button variant="accent"
              onClick={() => {
                onRunCustom(
                  task,
                  runDir || (components[0]?.path ?? ""),
                  runQuery.trim(),
                );
                setRunOpen(null);
              }}>
              Go
            </Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="side-panel">
      {/* No actions up here, and none on Completed either. Every completed row
          already opens the history at itself, so an expand icon beside the
          heading was a third way through the same door. */}
      <div className="side-panel-head">
        <span>Tasks</span>
      </div>

      {running.length > 0 && (
        <section className="task-section">
          <div className="ticket-state-head">
            Running
            <span className="badge">{running.length}</span>
          </div>
          {running.map((r) => (
            <div
              className={`task-row task-row-running${r.blocked ? " task-row-blocked" : ""}`}
              key={r.tabId ?? `pty:${r.ptyId}`}
            >
              <span
                className={`agent-state-dot st-${r.state}`}
                title={r.state}
              />
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
              <Button icon
                title="Stop this task"
                onClick={() => onStop(r)}>
                <StopIcon size={12} />
              </Button>
            </div>
          ))}
        </section>
      )}

      {done.length > 0 && (
        <section className="task-section">
          <div className="ticket-state-head">
            Completed
            <span className="badge">{done.length}</span>
          </div>
          {/* The recent ones with what they reported — a task that ran
              unwatched has nowhere else to say it, and "3 blocking, 2 nits" in
              the panel is the whole point of having sent it off. Capped,
              because this list only ever grows: the rail is for what just
              happened, and the sheet is where the whole history lives. */}
          {done.slice(0, PANEL_DONE).map((r) => (
            <div className="task-row task-row-done" key={r.id}>
              <span
                className={`task-done-dot st-${r.status}`}
                title={r.status}
              />
              {/* Opens the history *at this run*. Clicking a specific row and
                  landing on an undifferentiated list means finding it again by
                  eye, which is the one thing clicking the row should have
                  spared you. */}
              <span
                className="task-label task-label-link"
                title={r.summary ?? "No summary reported."}
                onClick={() => onOpenHistory(r.id)}
              >
                {r.icon ? `${r.icon} ` : ""}
                {r.label}
                {r.summary && (
                  <span className="task-note-inline">{r.summary}</span>
                )}
              </span>
              {r.url && (
                <Button icon
                  title={`Open ${r.url}`}
                  onClick={() => void openUrl(r.url as string)}>
                  ↗
                </Button>
              )}
            </div>
          ))}
          {/* The way to the whole history, and the only one the panel needs now
              that a row opens the sheet at itself. It says how many are behind
              it, so a capped list never reads as the complete one. */}
          {done.length > PANEL_DONE && (
            <button className="task-done-more" onClick={() => onOpenHistory()}>
              Show all {done.length}
            </button>
          )}
        </section>
      )}

      <section className="task-section">
        <div className="ticket-state-head">
          Your tasks
          <span className="badge">{custom.length}</span>
          <span className="status-spacer" />
          <Button icon
            title="New task — saved to this project"
            onClick={openNewTask}>
            ＋
          </Button>
        </div>
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
              onChange={(e) =>
                setDraft({ ...draft, placeholder: e.target.value })
              }
            />
            <div className="confirm-actions">
              <Button onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button variant="accent"
                disabled={!draft.label.trim() || !draft.brief.trim()}
                onClick={submitDraft}>
                {draft.id ? "Save" : "Create"}
              </Button>
            </div>
          </div>
        )}

        {custom.length === 0 && !draft ? (
          // "Nothing saved yet" describes the data and not the feature: it
          // tells someone who has never made one neither what a task here is
          // nor why they would want it. This says both, and is the way in.
          <button className="task-empty-cta" onClick={openNewTask}>
            Write a job once and run it anywhere in the IDE — on a file, a
            branch, a PR, or the changes you're reading.
            <span className="task-empty-cta-go">New task</span>
          </button>
        ) : (
          custom.map(runRow)
        )}
      </section>

      <section className="task-section">
        <div className="ticket-state-head">
          One-off
          <span className="status-spacer" />
          <Button size="sm"
            title="Type a job, run it once — nothing is saved to the list"
            onClick={() => {
              setOneOff((v) => (v == null ? "" : null));
              setOneOffDir(components[0]?.path ?? "");
              setDraft(null);
            }}>
            ⚡ Run once
          </Button>
        </div>
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
              <Button onClick={() => setOneOff(null)}>
                Cancel
              </Button>
              <Button variant="accent"
                disabled={!oneOff.trim()}
                onClick={runOneOff}>
                Run once
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Grouped by what each one DOES, not by what it is called: several are
          some flavour of "review", and the difference that matters is whether
          anything leaves your machine. The surface note is in the tooltip — as
          a visible column it read as information but said "on a PR tab" seven
          times over. */}
      <section className="task-section">
        <div className="ticket-state-head">{BUILT_IN_HEADING}</div>
        {(["reads", "posts", "pushes"] as TaskEffect[]).map((effect) => {
          const group = MICRO_TASKS.filter(
            (t) => (t.effect ?? "reads") === effect,
          );
          if (!group.length) return null;
          return (
            <div className="task-effect-group" key={effect}>
              {group.map((t) => (
                <div
                  className={`task-row task-row-built-in is-${effect}`}
                  key={t.id}
                  title={`${t.blurb ?? ""} ${EFFECT_HEADING[effect]}. Runs from its own surface — ${t.surfaceNote ?? "see its tab"}, which supplies what it works on.`.trim()}
                >
                  <span className="task-icon">{t.icon}</span>
                  <span className="task-label task-label-dim">{t.label}</span>
                </div>
              ))}
            </div>
          );
        })}
      </section>
    </div>
  );
}

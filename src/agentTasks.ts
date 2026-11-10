// An agent's own task list, as the hook recorded it in the session digest
// (canopy_hook.rs `tasks_from_todo_write`). Shaped after T3 Code's plan steps
// (pending | running | completed) so the card can read "Tasks 2/5 · current".

export type TaskStatus = "pending" | "running" | "completed";

export interface AgentTask {
  text: string;
  status: TaskStatus;
}

export interface TaskSummary {
  total: number;
  done: number;
  running: number;
  pending: number;
  /** The step in progress, else the first one still pending. */
  current: AgentTask | null;
}

const STATUSES = new Set<TaskStatus>(["pending", "running", "completed"]);

/** Digest data is read from disk; trust none of it. Unknown statuses are
 *  pending, blank entries are dropped, and the list is bounded. */
export function normalizeTasks(raw: unknown): AgentTask[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentTask[] = [];
  for (const item of raw) {
    if (out.length >= 50) break;
    if (!item || typeof item !== "object") continue;
    const { text, status } = item as { text?: unknown; status?: unknown };
    if (typeof text !== "string") continue;
    // The text can be typed into a terminal (Focus / Complete), so control
    // characters, newlines and escape sequences become spaces.
    const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
    if (!clean) continue;
    out.push({
      text: clean.slice(0, 200),
      status: STATUSES.has(status as TaskStatus) ? (status as TaskStatus) : "pending",
    });
  }
  return out;
}

export function summarizeTasks(tasks: AgentTask[]): TaskSummary {
  const done = tasks.filter((t) => t.status === "completed").length;
  const running = tasks.filter((t) => t.status === "running").length;
  return {
    total: tasks.length,
    done,
    running,
    pending: tasks.length - done - running,
    current:
      tasks.find((t) => t.status === "running") ??
      tasks.find((t) => t.status === "pending") ??
      null,
  };
}

/** One line for the collapsed row. */
export function taskHeadline(s: TaskSummary): string {
  if (s.total === 0) return "No tasks";
  const base = `${s.done} done · ${s.total - s.done} pending`;
  return s.total === s.done ? `All ${s.total} done` : base;
}

/** What the "focus on this" action sends the agent. The agent keeps its list;
 *  this only asks it to work this item next, so the other work is paused, not
 *  dropped. */
export function focusPrompt(task: AgentTask): string {
  return `Please focus on this task next and finish it before continuing with the others: ${task.text}`;
}

export function completePrompt(task: AgentTask): string {
  return `Please complete this task now: ${task.text}. Mark it done in your task list when it is finished.`;
}

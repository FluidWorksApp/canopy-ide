// An agent's own task list, as the hook recorded it in the session digest
// (canopy_hook.rs `tasks_from_todo_write`). Shaped after T3 Code's plan steps
// (pending | running | completed) so the card can read "Tasks 2/5 · current".

export type TaskStatus = "pending" | "running" | "completed";

export interface AgentTask {
  text: string;
  status: TaskStatus;
  /** A request the person made that the agent never listed. */
  fromUser?: boolean;
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
      status: STATUSES.has(status as TaskStatus)
        ? (status as TaskStatus)
        : "pending",
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

/** One line for the collapsed row: all three states, so "pending" is not a
 *  blur of work under way and work not begun. */
export function taskHeadline(s: TaskSummary): string {
  if (s.total === 0) return "No tasks";
  if (s.total === s.done) return `All ${s.total} done`;
  return `${s.done} done · ${s.running} in progress · ${s.pending} not started`;
}

/** What the "focus on this" action sends the agent. The agent keeps its list;
 *  this only asks it to work this item next, so the other work is paused, not
 *  dropped. */
export function focusPrompt(task: AgentTask): string {
  return `Please focus on this task next and finish it before continuing with the others: ${task.text}`;
}

/** Hand the task to a sub agent so this agent can carry on. */
export function subAgentPrompt(task: AgentTask): string {
  return `Please run this task as a sub agent (canopy_spawn_agent, or your own sub-agent tool). Give it the context it needs, and mark the task done in your task list when it reports back: ${task.text}`;
}

export function completePrompt(task: AgentTask): string {
  return `Please complete this task now: ${task.text}. Mark it done in your task list when it is finished.`;
}

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );

/** True when two task texts are about the same thing (most words shared). */
export function sameTask(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let hit = 0;
  for (const w of x) if (y.has(w)) hit++;
  return hit / Math.min(x.size, y.size) >= 0.6;
}

/** The agent's tasks plus the person's requests the agent did not list. */
export function withRequests(
  tasks: AgentTask[],
  requests: readonly { title: string; status: "open" | "done" }[],
): AgentTask[] {
  const extra: AgentTask[] = requests
    .filter((r) => !tasks.some((t) => sameTask(t.text, r.title)))
    .map((r) => ({
      text: r.title,
      status: r.status === "done" ? "completed" : "pending",
      fromUser: true,
    }));
  return [...tasks, ...extra];
}

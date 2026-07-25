// The "Tasks ▸" row every right-click menu carries. One shape everywhere:
// write a new task about what you clicked, then the tasks you can run on it —
// the built-ins this surface offers (raise the PR for this branch, review this
// PR) followed by the ones you saved. Surfaces don't know about micro-tasks;
// they take a ready-made MenuItem from ProjectView, which owns the launcher.
import type { MenuItem } from "./components/ContextMenu";
import type { CustomMicroTask } from "./microTasks";
import { getSettings } from "./settings";

export interface TaskMenuOptions {
  /** Opening words of the create form's brief — what the user clicked, said
   *  in the agent's terms ("On branch x: ", "In `/path`: "). */
  seed: string;
  /** Ready-to-run tasks that make sense on this row, in menu order. */
  runnable?: { label: string; icon?: string; run: () => void }[];
  onNewTask: (brief: string) => void;
  onRunSaved: (task: CustomMicroTask) => void;
}

export function taskMenuItem(o: TaskMenuOptions): MenuItem {
  // Read at build time — the menu is built on the right-click, so a task saved
  // a moment ago in the Tasks panel is already here.
  const saved = getSettings().customMicroTasks;
  const runnable = o.runnable ?? [];
  const items: MenuItem[] = [{ label: "New Task…", onClick: () => o.onNewTask(o.seed) }];
  if (runnable.length > 0 || saved.length > 0) {
    items.push({ separator: true });
    for (const r of runnable) {
      items.push({ label: `${r.icon ?? "◆"} ${r.label}`, onClick: r.run });
    }
    for (const t of saved) {
      items.push({ label: `${t.icon || "◆"} ${t.label}`, onClick: () => o.onRunSaved(t) });
    }
  }
  return { label: "Tasks", submenu: items };
}

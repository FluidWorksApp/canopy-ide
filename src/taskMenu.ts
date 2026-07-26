// The "Tasks ▸" row every right-click menu carries, and the grouping every
// other task list follows. One shape everywhere: write a new task about what
// you clicked, run one on the spot without saving it, then the tasks
// themselves — the ones you wrote under "Custom tasks", the ones Canopy ships
// under "Built-in tasks". Surfaces don't know about micro-tasks; they take a
// ready-made MenuItem from ProjectView, which owns the launcher.
import type { MenuItem } from "./components/ContextMenu";
import { MICRO_TASKS, type CustomMicroTask } from "./microTasks";
import { getSettings } from "./settings";

/** One runnable row. `run` absent means this surface can't supply the task's
 *  payload — the row is still listed, because a built-in that disappears when
 *  it doesn't apply reads as a missing feature rather than a missing PR, and
 *  `note` says where it does run. */
export interface TaskChoice {
  id: string;
  label: string;
  icon?: string;
  run?: () => void;
  note?: string;
}

/** The two groups, in the order every surface shows them: what you wrote
 *  first, what Canopy ships second. */
export interface TaskGroups {
  custom: TaskChoice[];
  builtIn: TaskChoice[];
}

export const CUSTOM_HEADING = "Custom tasks";
export const BUILT_IN_HEADING = "Built-in tasks";

/** Build both groups for a surface. `builtIns` is what this surface can
 *  actually run (a PR tab knows its PR); every other built-in is listed
 *  unrunnable, carrying its `surfaceNote` so the row says where it does run. */
export function taskGroups(o: {
  builtIns?: TaskChoice[];
  onRunSaved: (task: CustomMicroTask) => void;
}): TaskGroups {
  // Read at build time — the menu is built on the right-click, so a task saved
  // a moment ago in the Tasks panel is already here.
  const saved = getSettings().customMicroTasks;
  const offered = o.builtIns ?? [];
  const taken = new Set(offered.map((b) => b.id));
  return {
    custom: saved.map((t) => ({
      id: `custom-${t.id}`,
      label: t.label,
      icon: t.icon || "◆",
      run: () => o.onRunSaved(t),
    })),
    builtIn: [
      ...offered,
      ...MICRO_TASKS.filter((t) => !taken.has(t.id)).map((t) => ({
        id: t.id,
        label: t.label,
        icon: t.icon,
        note: t.surfaceNote ? `runs ${t.surfaceNote}` : undefined,
      })),
    ],
  };
}

export interface TaskMenuOptions {
  /** Opening words of the create form's brief — what the user clicked, said
   *  in the agent's terms ("On branch x: ", "In `/path`: "). */
  seed: string;
  /** Ready-to-run built-ins that make sense on this row, in menu order. */
  runnable?: TaskChoice[];
  onNewTask: (brief: string) => void;
  /** Compose and run a one-off about this row — nothing saved to the registry. */
  onOneOff: (brief: string) => void;
  onRunSaved: (task: CustomMicroTask) => void;
}

export function taskMenuItem(o: TaskMenuOptions): MenuItem {
  const { custom, builtIn } = taskGroups({ builtIns: o.runnable, onRunSaved: o.onRunSaved });
  const row = (c: TaskChoice): MenuItem => ({
    label: `${c.icon ?? "◆"} ${c.label}`,
    onClick: c.run,
    disabled: !c.run,
    hint: c.run ? undefined : c.note,
  });
  const items: MenuItem[] = [
    { label: "New Task…", onClick: () => o.onNewTask(o.seed) },
    { label: "⚡ One-off task…", onClick: () => o.onOneOff(o.seed) },
  ];
  if (custom.length > 0) {
    items.push({ separator: true, label: CUSTOM_HEADING }, ...custom.map(row));
  }
  if (builtIn.length > 0) {
    items.push({ separator: true, label: BUILT_IN_HEADING }, ...builtIn.map(row));
  }
  return { label: "Tasks", submenu: items };
}

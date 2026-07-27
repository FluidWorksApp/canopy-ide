// The "Tasks ▸" row every right-click menu carries, and the grouping every
// other task list follows. One shape everywhere: write a new task about what
// you clicked, run one on the spot without saving it, then the tasks
// themselves — the ones you wrote under "Custom tasks", the ones Canopy ships
// under "Built-in tasks". Surfaces don't know about micro-tasks; they take a
// ready-made MenuItem from ProjectView, which owns the launcher.
import type { MenuItem } from "./components/ContextMenu";
import { MICRO_TASKS, type CustomMicroTask } from "./microTasks";

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
export const ONE_OFF_HEADING = "One-off task";

/** Build both groups for a surface. `builtIns` is what this surface can
 *  actually run (a PR tab knows its PR); every other built-in is listed
 *  unrunnable, carrying its `surfaceNote` so the row says where it does run. */
export function taskGroups(o: {
  builtIns?: TaskChoice[];
  /** The project's own custom tasks — passed in rather than read here, because
   *  they belong to the project this menu was opened in. */
  saved?: CustomMicroTask[];
  onRunSaved: (task: CustomMicroTask) => void;
}): TaskGroups {
  const saved = o.saved ?? [];
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

/** Is there an actual task to offer, beyond the two composers?
 *
 *  A control whose only job is to list tasks should not exist when the list is
 *  empty — a caret that opens "New Task… / One-off task…" is a caret promising
 *  a menu and delivering the two things the surface could already do. */
export function hasTasksToList(o: {
  saved?: CustomMicroTask[];
  runnable?: TaskChoice[];
}): boolean {
  return (o.saved?.length ?? 0) > 0 || (o.runnable ?? []).some((r) => r.run);
}

export interface TaskMenuOptions {
  /** Opening words of the create form's brief — what the user clicked, said
   *  in the agent's terms ("On branch x: ", "In `/path`: "). */
  seed: string;
  /** Ready-to-run built-ins that make sense on this row, in menu order. */
  runnable?: TaskChoice[];
  /** This project's custom tasks. */
  saved?: CustomMicroTask[];
  onNewTask: (brief: string) => void;
  /** Compose and run a one-off about this row — nothing saved to the registry. */
  onOneOff: (brief: string) => void;
  onRunSaved: (task: CustomMicroTask) => void;
}

/** The rows themselves: write one, run one unsaved, then what already exists.
 *  Split out from `taskMenuItem` so a surface that IS the task menu — the Run
 *  task caret on a diff — shows them directly instead of behind another
 *  "Tasks ▸" hop into a submenu of one. */
export function taskMenuItems(o: TaskMenuOptions): MenuItem[] {
  const { custom, builtIn } = taskGroups({
    builtIns: o.runnable,
    saved: o.saved,
    onRunSaved: o.onRunSaved,
  });
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
  // Listing an unrunnable built-in earns its place next to runnable ones: it
  // says the feature exists and where to find it. A section where NONE of them
  // can run says only "here are eight things you cannot do", which is worse
  // than not offering the section at all — on a diff, every PR task is in that
  // state, and the menu was a wall of grey.
  if (builtIn.some((b) => b.run)) {
    items.push({ separator: true, label: BUILT_IN_HEADING }, ...builtIn.map(row));
  }
  return items;
}

export function taskMenuItem(o: TaskMenuOptions): MenuItem {
  return { label: "Tasks", submenu: taskMenuItems(o) };
}

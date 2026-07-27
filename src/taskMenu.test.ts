import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_HEADING,
  CUSTOM_HEADING,
  hasTasksToList,
  taskGroups,
  taskMenuItem,
} from "./taskMenu";
import { MICRO_TASKS, type CustomMicroTask } from "./microTasks";

const saved: CustomMicroTask = {
  id: "abc",
  label: "Prod DB Backup",
  icon: "◆",
  placeholder: "",
  brief: "Back the database up.",
};

beforeEach(() => {
  localStorage.clear();
});

describe("taskGroups", () => {
  it("lists every built-in, even the ones this surface can't run", () => {
    const { builtIn } = taskGroups({ onRunSaved: () => {} });
    expect(builtIn.map((c) => c.id)).toEqual(MICRO_TASKS.map((t) => t.id));
    // Unrunnable here, but the row says where it does run rather than vanishing.
    for (const c of builtIn) {
      expect(c.run).toBeUndefined();
      expect(c.note).toContain("runs on a");
    }
  });

  it("prefers the surface's own version of a built-in it can run", () => {
    const run = vi.fn();
    const { builtIn } = taskGroups({
      builtIns: [{ id: "review-pr", label: "Review PR #42", icon: "⌕", run }],
      onRunSaved: () => {},
    });
    expect(builtIn).toHaveLength(MICRO_TASKS.length);
    const review = builtIn.filter((c) => c.id === "review-pr");
    expect(review).toHaveLength(1); // offered once, not once per source
    expect(review[0].label).toBe("Review PR #42");
    review[0].run?.();
    expect(run).toHaveBeenCalled();
  });

  it("lists the project's own saved tasks, and none when it has none", () => {
    expect(taskGroups({ onRunSaved: () => {} }).custom).toEqual([]);
    const onRunSaved = vi.fn();
    const { custom } = taskGroups({ saved: [saved], onRunSaved });
    expect(custom.map((c) => c.label)).toEqual(["Prod DB Backup"]);
    custom[0].run?.();
    expect(onRunSaved).toHaveBeenCalledWith(saved);
  });
});

describe("taskMenuItem", () => {
  const menu = (over: Partial<Parameters<typeof taskMenuItem>[0]> = {}) =>
    taskMenuItem({
      seed: "On branch x: ",
      onNewTask: () => {},
      onOneOff: () => {},
      onRunSaved: () => {},
      ...over,
    }).submenu ?? [];

  // A surface that can run at least one built-in — a PR tab, say. The whole
  // built-in group hangs on that, so every test about it supplies one.
  const here = [{ id: "review-pr", label: "Review PR", icon: "R", run: () => {} }];

  it("offers both composers, then segregates the two groups", () => {
    const items = menu({ saved: [saved], runnable: here });
    expect(items[0].label).toBe("New Task\u2026");
    expect(items[1].label).toContain("One-off task\u2026");
    const headings = items.filter((i) => i.separator).map((i) => i.label);
    expect(headings).toEqual([CUSTOM_HEADING, BUILT_IN_HEADING]);
    const custom = items.indexOf(items.find((i) => i.label === "\u25c6 Prod DB Backup")!);
    expect(custom).toBeGreaterThan(items.findIndex((i) => i.label === CUSTOM_HEADING));
    expect(custom).toBeLessThan(items.findIndex((i) => i.label === BUILT_IN_HEADING));
  });

  it("drops the custom heading when nothing is saved, keeps the built-ins", () => {
    const headings = menu({ runnable: here })
      .filter((i) => i.separator)
      .map((i) => i.label);
    expect(headings).toEqual([BUILT_IN_HEADING]);
  });

  it("drops the whole built-in group where none of them can run", () => {
    // On a diff every built-in belongs to a branch or a PR tab, so the group
    // was eight greyed rows saying "here are things you cannot do". One
    // unrunnable row beside runnable ones is useful; a section of nothing but
    // unrunnable ones is not.
    const items = menu({ saved: [saved] });
    expect(items.filter((i) => i.separator).map((i) => i.label)).toEqual([CUSTOM_HEADING]);
    expect(items.some((i) => i.label?.includes("Raise PR"))).toBe(false);
    expect(items[0].label).toBe("New Task\u2026");
  });

  it("seeds the one-off composer with what was right-clicked", () => {
    const onOneOff = vi.fn();
    menu({ onOneOff })[1].onClick?.();
    expect(onOneOff).toHaveBeenCalledWith("On branch x: ");
  });

  it("disables a built-in it can't run and hints why", () => {
    const raise = menu({ runnable: here }).find((i) => i.label?.includes("Raise PR"));
    expect(raise?.disabled).toBe(true);
    expect(raise?.onClick).toBeUndefined();
    expect(raise?.hint).toContain("branch tab");
  });
});

describe("hasTasksToList", () => {
  it("is false when the menu would hold only the two composers", () => {
    // The caret exists to list tasks. With none to list it opens onto "New
    // Task… / One-off task…" — two things the surface offers anyway — so the
    // surface drops the caret and keeps the plain button.
    expect(hasTasksToList({})).toBe(false);
    expect(hasTasksToList({ saved: [] })).toBe(false);
    // Built-ins that exist but cannot run here do not count as a list.
    expect(
      hasTasksToList({ runnable: [{ id: "review-pr", label: "Review PR" }] }),
    ).toBe(false);
  });

  it("is true as soon as there is one thing you could actually run", () => {
    expect(hasTasksToList({ saved: [saved] })).toBe(true);
    expect(
      hasTasksToList({ runnable: [{ id: "review-pr", label: "Review PR", run: () => {} }] }),
    ).toBe(true);
  });
});

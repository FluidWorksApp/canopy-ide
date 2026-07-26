import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_HEADING, CUSTOM_HEADING, taskGroups, taskMenuItem } from "./taskMenu";
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

  it("offers both composers, then segregates the two groups", () => {
    const items = menu({ saved: [saved] });
    expect(items[0].label).toBe("New Task…");
    expect(items[1].label).toContain("One-off task…");
    const headings = items.filter((i) => i.separator).map((i) => i.label);
    expect(headings).toEqual([CUSTOM_HEADING, BUILT_IN_HEADING]);
    // Custom comes first, and every built-in is still listed under its own head.
    const custom = items.indexOf(items.find((i) => i.label === "◆ Prod DB Backup")!);
    expect(custom).toBeGreaterThan(items.findIndex((i) => i.label === CUSTOM_HEADING));
    expect(custom).toBeLessThan(items.findIndex((i) => i.label === BUILT_IN_HEADING));
  });

  it("drops the custom heading when nothing is saved, keeps the built-ins", () => {
    const headings = menu()
      .filter((i) => i.separator)
      .map((i) => i.label);
    expect(headings).toEqual([BUILT_IN_HEADING]);
  });

  it("seeds the one-off composer with what was right-clicked", () => {
    const onOneOff = vi.fn();
    menu({ onOneOff })[1].onClick?.();
    expect(onOneOff).toHaveBeenCalledWith("On branch x: ");
  });

  it("disables a built-in it can't run and hints why", () => {
    const raise = menu().find((i) => i.label?.includes("Raise PR"));
    expect(raise?.disabled).toBe(true);
    expect(raise?.onClick).toBeUndefined();
    expect(raise?.hint).toContain("branch tab");
  });
});

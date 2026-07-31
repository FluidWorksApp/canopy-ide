// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TasksPanel, type RunningMicroTask } from "./TasksPanel";
import type { CustomMicroTask } from "../microTasks";

// A micro-task runs with no tab now, so this panel is the whole of it: if a row
// doesn't say what the task is doing, or its buttons act on the wrong run,
// there is no terminal to fall back on. These cover that contract.

const panel = (over: Partial<React.ComponentProps<typeof TasksPanel>> = {}) => {
  const props = {
    components: [{ label: "app", path: "/repo" }],
    running: [] as RunningMicroTask[],
    onShow: vi.fn(),
    onStop: vi.fn(),
    onRunCustom: vi.fn(),
    onRunOneOff: vi.fn(),
    onOpenHistory: vi.fn(),
    custom: [] as CustomMicroTask[],
    onSaveCustom: vi.fn(),
    projectId: "p1",
    ...over,
  };
  render(<TasksPanel {...props} />);
  return props;
};

const detached: RunningMicroTask = {
  ptyId: 12,
  title: "Review PR",
  state: "working",
  icon: "⌕",
  note: "Bash · 2m",
};

describe("the project's own tasks", () => {
  const mine: CustomMicroTask = {
    id: "abc",
    label: "Prod DB Backup",
    icon: "◆",
    placeholder: "",
    brief: "Back the database up.",
  };

  it("lists what this project was handed, not an app-wide list", () => {
    panel({ custom: [mine] });
    expect(screen.getByText("Prod DB Backup")).toBeTruthy();
  });

  it("shows none when this project has none, whatever its neighbours saved", () => {
    panel({ custom: [] });
    expect(screen.queryByText("Prod DB Backup")).toBeNull();
  });

  it("hands a delete back to the owner rather than writing settings", () => {
    const props = panel({ custom: [mine] });
    fireEvent.click(screen.getByTitle("Delete this task"));
    expect(props.onSaveCustom).toHaveBeenCalledWith([]);
  });
});

describe("the Running list", () => {
  it("shows a detached run with what it is doing, and opens it on click", () => {
    const props = panel({ running: [detached] });
    expect(screen.getByText("Bash · 2m")).toBeTruthy();
    // Scoped to the running row: "Review PR" is also in the built-ins list
    // below, which is a read-only entry and not what a click here means.
    const row = document.querySelector(".task-row-running .task-label-link");
    fireEvent.click(row as Element);
    expect(props.onShow).toHaveBeenCalledWith(expect.objectContaining({ ptyId: 12 }));
  });

  it("hands the stopped run back whole, so the caller knows which pty to kill", () => {
    const props = panel({
      running: [detached, { tabId: "t9", title: "Fix CI", state: "idle" }],
    });
    const stops = screen.getAllByTitle("Stop this task");
    expect(stops).toHaveLength(2);
    fireEvent.click(stops[0]);
    expect(props.onStop).toHaveBeenCalledWith(expect.objectContaining({ ptyId: 12 }));
    fireEvent.click(stops[1]);
    expect(props.onStop).toHaveBeenCalledWith(expect.objectContaining({ tabId: "t9" }));
  });

  it("marks a run that is waiting on the user", () => {
    const { container } = render(
      <TasksPanel
        components={[]}
        running={[{ ...detached, blocked: true, note: "Needs you · 4m" }]}
        onShow={vi.fn()}
        onStop={vi.fn()}
        onRunCustom={vi.fn()}
        onRunOneOff={vi.fn()}
        onOpenHistory={vi.fn()}
        custom={[]}
        onSaveCustom={vi.fn()}
        projectId="p1"
      />,
    );
    expect(container.querySelector(".task-row-blocked")).toBeTruthy();
    expect(screen.getByText("Needs you · 4m")).toBeTruthy();
  });

  it("keeps a row per run when two tasks share a title", () => {
    // Keyed by pty, not by name: two "Review PR" runs are two rows.
    const { container } = render(
      <TasksPanel
        components={[]}
        running={[detached, { ...detached, ptyId: 13 }]}
        onShow={vi.fn()}
        onStop={vi.fn()}
        onRunCustom={vi.fn()}
        onRunOneOff={vi.fn()}
        onOpenHistory={vi.fn()}
        custom={[]}
        onSaveCustom={vi.fn()}
        projectId="p1"
      />,
    );
    expect(container.querySelectorAll(".task-row-running")).toHaveLength(2);
  });
});

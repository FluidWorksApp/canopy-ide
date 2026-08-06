import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HibernationView } from "./HibernationView";
import { buildSnapshot } from "../hibernation";
import type { Project } from "../projects";
import type { SubTab } from "./ProjectView/helpers";

const project: Project = {
  id: "p1",
  name: "canopy",
  components: [{ id: "cmp-app", label: "app", path: "/repo" }],
};

const tabs: SubTab[] = [
  { id: "a", type: "terminal", cwd: "/repo", title: "claude", ptyId: 7, command: "claude" },
  { id: "d", type: "terminal", cwd: "/repo", title: "dev", ptyId: 8, command: "npm run dev", run: true },
  {
    id: "f",
    type: "file",
    file: {
      path: "/repo/src/App.tsx",
      name: "App.tsx",
      kind: "code",
      view: "source",
      dirty: false,
      external: null,
      bytes: null,
    },
  },
];

const snapshot = buildSnapshot({
  tabs,
  activeTabId: "a",
  sideTab: "files",
  sidePinned: false,
  worktree: null,
  sessionFor: () => "sess-1",
});

describe("the wake screen", () => {
  it("says what is asleep before it wakes anything", () => {
    render(
      <HibernationView
        project={project}
        snapshot={snapshot}
        progress={null}
        onWake={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(screen.getByText("canopy is hibernating")).toBeInTheDocument();
    // One agent conversation, one terminal, one file — counted separately,
    // because "3 tabs" tells you nothing about what you are about to restart.
    expect(screen.getByText("agent session")).toBeInTheDocument();
    expect(screen.getByText("terminal")).toBeInTheDocument();
    expect(screen.getByText("file")).toBeInTheDocument();
  });

  it("wakes on the button, and only on the button", () => {
    const onWake = vi.fn();
    const onDiscard = vi.fn();
    render(
      <HibernationView
        project={project}
        snapshot={snapshot}
        progress={null}
        onWake={onWake}
        onDiscard={onDiscard}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /wake the project/i }));
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("stays on screen while the workspace rebuilds behind it, ticking steps off", () => {
    const { rerender } = render(
      <HibernationView
        project={project}
        snapshot={snapshot}
        progress={{ done: 1, total: 3, label: "Restarting dev", finished: false }}
        onWake={() => {}}
        onDiscard={() => {}}
      />,
    );
    // The wake screen replaces its own controls rather than closing: a second
    // "wake" mid-restore would start the whole thing again.
    expect(screen.queryByRole("button", { name: /wake the project/i })).toBeNull();
    expect(screen.getByText("Waking canopy")).toBeInTheDocument();
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    // Every step is listed, done ones ticked, the rest still waiting.
    expect(screen.getByText("Resuming Claude Code in repo")).toBeInTheDocument();
    expect(screen.getByText("Reopening App.tsx")).toBeInTheDocument();

    rerender(
      <HibernationView
        project={project}
        snapshot={snapshot}
        progress={{ done: 3, total: 3, label: "Ready", finished: true }}
        onWake={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(screen.getByText("Ready")).toBeInTheDocument();
    // The frost only dissolves once everything is actually back.
    expect(document.querySelector(".hib-thawed")).not.toBeNull();
  });

  it("offers a way out for a snapshot you no longer want", () => {
    const onDiscard = vi.fn();
    render(
      <HibernationView
        project={project}
        snapshot={snapshot}
        progress={null}
        onWake={() => {}}
        onDiscard={onDiscard}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /discard the snapshot/i }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});

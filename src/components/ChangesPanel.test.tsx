// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChangesPanel, type ChangeGroup } from "./ChangesPanel";
import type { FileChange } from "../ipc";

// Discard is the only thing this panel does that can't be undone — an untracked
// file isn't even in git's reflog. These cover the way in (right-click), the
// gate (confirm), and that the right file is the one thrown away.

const file = (over: Partial<FileChange> = {}): FileChange => ({
  path: "src/app.ts",
  abs: "/repo/src/app.ts",
  status: " M",
  staged: false,
  untracked: false,
  conflicted: false,
  ...over,
});

const group = (files: FileChange[]): ChangeGroup => ({
  component: "app",
  repo: "/repo",
  files,
});

const panel = (over: Partial<React.ComponentProps<typeof ChangesPanel>> = {}) => {
  const props = {
    groups: [group([file()])],
    loading: false,
    onOpen: vi.fn(),
    onRefresh: vi.fn(),
    onDiscard: vi.fn(),
    ...over,
  };
  render(<ChangesPanel {...props} />);
  return props;
};

const rightClickRow = () =>
  fireEvent.contextMenu(document.querySelector(".change-row") as Element);

describe("the row's right-click menu", () => {
  it("offers Discard for a tracked file, and Delete for one git has never seen", () => {
    panel();
    rightClickRow();
    expect(screen.getByText("Discard changes")).toBeTruthy();
  });

  it("names the untracked case for what it is — deleting the file", () => {
    panel({ groups: [group([file({ untracked: true, status: "??" })])] });
    rightClickRow();
    expect(screen.getByText("Delete this file")).toBeTruthy();
  });

  it("leaves Discard out when the caller can't handle it", () => {
    panel({ onDiscard: undefined });
    rightClickRow();
    expect(screen.queryByText("Discard changes")).toBeNull();
  });

  it("offers Unstage for a staged file rather than Stage", () => {
    panel({ groups: [group([file({ staged: true, status: "M " })])], onUnstage: vi.fn() });
    rightClickRow();
    expect(screen.getByText("Unstage")).toBeTruthy();
    expect(screen.queryByText("Stage")).toBeNull();
  });
});

describe("discarding", () => {
  it("asks before throwing anything away, and does nothing if you cancel", () => {
    const props = panel();
    rightClickRow();
    fireEvent.click(screen.getByText("Discard changes"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(props.onDiscard).not.toHaveBeenCalled();
  });

  it("hands back the file and its repo once confirmed", () => {
    const props = panel();
    rightClickRow();
    fireEvent.click(screen.getByText("Discard changes"));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(props.onDiscard).toHaveBeenCalledWith("/repo", expect.objectContaining({
      path: "src/app.ts",
      untracked: false,
    }));
  });

  it("says out loud that an untracked file can't come back", () => {
    panel({ groups: [group([file({ untracked: true, status: "??" })])] });
    rightClickRow();
    fireEvent.click(screen.getByText("Delete this file"));
    expect(screen.getByText(/nothing can bring it back/)).toBeTruthy();
  });
});

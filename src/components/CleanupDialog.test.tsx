import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CleanupDialog } from "./CleanupDialog";
import * as ipc from "../ipc";

vi.mock("../ipc", () => ({
  cleanupScan: vi.fn(),
  cleanupRun: vi.fn(),
  onCleanupProgress: vi.fn(),
}));

const GB = 1024 ** 3;

const scan = {
  workspaces: [
    {
      path: "/repo",
      name: "repo",
      branch: "main",
      main: true,
      dirty: 0,
      busy: true,
      asleep: false,
      idle_days: 1,
      landed: null,
      bytes: GB,
      recommended_bytes: 0,
    },
    {
      path: "/repo/.claude/worktrees/old",
      name: "old",
      branch: "feat/old",
      main: false,
      dirty: 0,
      busy: false,
      asleep: false,
      idle_days: 2,
      landed: "already merged into origin/main",
      bytes: 2 * GB,
      recommended_bytes: 2 * GB,
    },
  ],
  targets: [
    {
      path: "/repo/node_modules",
      name: "node_modules",
      rel: "node_modules",
      category: "deps" as const,
      bytes: GB,
      files: 40_000,
      idle_days: 0,
      regenerate: "npm install",
      workspace: "/repo",
      recommended: false,
      hold: "a terminal or agent is live in this workspace",
      partial: false,
    },
    {
      path: "/repo/.claude/worktrees/old/node_modules",
      name: "node_modules",
      rel: "node_modules",
      category: "deps" as const,
      bytes: 2 * GB,
      files: 40_000,
      idle_days: 2,
      regenerate: "npm install",
      workspace: "/repo/.claude/worktrees/old",
      recommended: true,
      hold: null,
      partial: false,
    },
  ],
  bytes: 3 * GB,
  recommended_bytes: 2 * GB,
  skipped: [],
  truncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(ipc.onCleanupProgress).mockImplementation(
    (async () => () => {}) as never,
  );
  vi.mocked(ipc.cleanupScan).mockResolvedValue(scan as never);
  vi.mocked(ipc.cleanupRun).mockResolvedValue({
    removed: ["/repo/.claude/worktrees/old/node_modules"],
    bytes: 2 * GB,
    failed: [],
    refused: [],
    trashed: true,
  } as never);
});

const open = () =>
  render(
    <CleanupDialog
      open
      roots={["/repo"]}
      busy={["/repo"]}
      asleep={[]}
      onClose={() => {}}
    />,
  );

describe("CleanupDialog", () => {
  it("scans on open and offers only what Rust recommended", async () => {
    open();
    expect(ipc.cleanupScan).toHaveBeenCalledWith(["/repo"], ["/repo"], []);
    // The idle workspace's install is the whole selection: 2 GB of the 3 found.
    await screen.findByText("Move 2.0 GB to Trash");
    // ...and the busy one is still listed, with the reason it isn't offered.
    expect(
      screen.getByText("a terminal or agent is live in this workspace"),
    ).toBeTruthy();
    expect(screen.getByText("in use")).toBeTruthy();
    // ...and the merged workspace says why its install is ticked.
    expect(screen.getByText("done")).toBeTruthy();
  });

  it("deletes exactly the ticked rows, and nothing else", async () => {
    open();
    const button = await screen.findByText("Move 2.0 GB to Trash");
    fireEvent.click(button);
    await waitFor(() =>
      expect(ipc.cleanupRun).toHaveBeenCalledWith(
        ["/repo/.claude/worktrees/old/node_modules"],
        true,
      ),
    );
    await screen.findByText(/Moved 1 directory to the Trash/);
  });

  it("carries the ticked total when a held row is added by hand", async () => {
    open();
    await screen.findByText("Move 2.0 GB to Trash");
    // The busy workspace's row: the user overrules us, which must be possible.
    const rows = screen.getAllByRole("checkbox");
    // [0] is the trash toggle, then group/row boxes in render order.
    fireEvent.click(rows[rows.length - 1]);
    await screen.findByText("Move 3.0 GB to Trash");
  });

  it("switches to an outright delete when the Trash is unticked", async () => {
    open();
    await screen.findByText("Move 2.0 GB to Trash");
    fireEvent.click(screen.getByLabelText("Move to Trash instead of deleting"));
    const button = await screen.findByText("Delete 2.0 GB");
    fireEvent.click(button);
    await waitFor(() =>
      expect(ipc.cleanupRun).toHaveBeenCalledWith(
        ["/repo/.claude/worktrees/old/node_modules"],
        false,
      ),
    );
  });

  it("says so when there is nothing to reclaim", async () => {
    vi.mocked(ipc.cleanupScan).mockResolvedValue({
      workspaces: [],
      targets: [],
      bytes: 0,
      recommended_bytes: 0,
      skipped: [],
      truncated: false,
    } as never);
    open();
    await screen.findByText(/No installs, build output or caches were found/);
    expect(screen.queryByText(/Move .* to Trash/)).toBeNull();
  });

  it("shows a progress bar while the scan walks, and drops it after", async () => {
    let emit: ((p: ipc.CleanupProgress) => void) | undefined;
    vi.mocked(ipc.onCleanupProgress).mockImplementation((async (
      cb: (p: ipc.CleanupProgress) => void,
    ) => {
      emit = cb;
      return () => {};
    }) as never);
    let finish!: (s: typeof scan) => void;
    vi.mocked(ipc.cleanupScan).mockReturnValue(
      new Promise((r) => {
        finish = r;
      }) as never,
    );
    open();
    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    await waitFor(() => expect(emit).toBeDefined());
    act(() =>
      emit!({ workspace: "/repo/.claude/worktrees/old", done: 3, total: 12 }),
    );
    expect(screen.getByText("3 of 12 · old")).toBeTruthy();
    expect(
      screen.getByRole("progressbar").getAttribute("aria-valuenow"),
    ).toBe("3");
    act(() => finish(scan));
    await screen.findByText("Move 2.0 GB to Trash");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("surfaces a scan that failed instead of an empty list", async () => {
    vi.mocked(ipc.cleanupScan).mockRejectedValue("no project folders to scan");
    open();
    await screen.findByText("no project folders to scan");
  });
});

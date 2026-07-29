// @vitest-environment jsdom
//
// The Git panel's claim after the merge: branches and workspaces are one list.
// These cover that claim end to end — that a branch with a folder of its own
// appears once rather than twice, that clicking a row picks the right operation
// without asking the user which kind of thing they clicked, and that starting a
// feature sets its workspace up instead of leaving a checkout that won't build.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitPanel } from "./GitPanel";
import type * as ipcTypes from "../ipc";

const ipc = vi.hoisted(() => ({
  gitRepos: vi.fn(),
  gitRepoStatus: vi.fn(),
  gitBranches: vi.fn(),
  gitLog: vi.fn(),
  gitWorktrees: vi.fn(),
  gitWorktreeBootstrap: vi.fn(),
  gitWorktreeRemove: vi.fn(),
  workspaceRemove: vi.fn(),
  onFsChange: vi.fn(),
  fsReveal: vi.fn(),
  gitPull: vi.fn(),
  gitPush: vi.fn(),
  gitFetch: vi.fn(),
  gitBranchDelete: vi.fn(),
  gitBranchDeleteRemote: vi.fn(),
}));
vi.mock("../ipc", () => ipc);

const switchTo = vi.hoisted(() => vi.fn());
const openThere = vi.hoisted(() => vi.fn());
const cleanupWorkspaces = vi.hoisted(() => vi.fn());
vi.mock("../useBranchSwitch", () => ({
  useBranchSwitch: () => ({
    switchTo,
    openThere,
    cleanupWorkspaces,
    ask: vi.fn().mockResolvedValue("cancel"),
    version: 0,
  }),
}));

const REPO = "/w/repo";

const branch = (
  over: Partial<ipcTypes.BranchInfo> & { name: string },
): ipcTypes.BranchInfo => ({
  current: false,
  remote_only: false,
  synced: true,
  subject: "a commit",
  protected: false,
  ...over,
});

const worktree = (
  over: Partial<ipcTypes.WorktreeInfo> & { path: string },
): ipcTypes.WorktreeInfo => ({
  name: over.path.split("/").pop() ?? "",
  head: "abc1234",
  branch: null,
  detached: false,
  bare: false,
  locked: null,
  prunable: null,
  is_main: false,
  dirty: 0,
  ...over,
});

const onOpenPreview = vi.fn();
const onOpenTerminal = vi.fn();
const onNotice = vi.fn();

function panel(
  branches: ipcTypes.BranchInfo[],
  worktrees: ipcTypes.WorktreeInfo[],
  props: { activeWorktree?: string | null; serverCwds?: string[] } = {},
) {
  ipc.gitRepos.mockResolvedValue([
    { path: REPO, name: "repo", components: ["app"], branch: "main", detached: false },
  ]);
  ipc.gitRepoStatus.mockResolvedValue({ detached: false, upstream: "origin/main" });
  ipc.gitBranches.mockResolvedValue(branches);
  ipc.gitLog.mockResolvedValue([]);
  ipc.gitWorktrees.mockResolvedValue(worktrees);
  ipc.onFsChange.mockResolvedValue(() => {});
  render(
    <GitPanel
      visible
      components={[{ label: "app", path: REPO }]}
      activeWorktree={props.activeWorktree ?? null}
      serverCwds={props.serverCwds ?? []}
      agentCwds={[]}
      onOpenPreview={onOpenPreview}
      onOpenCommit={vi.fn()}
      onOpenBranch={vi.fn()}
      onOpenTerminal={onOpenTerminal}
      onNotice={onNotice}
    />,
  );
}

const row = (name: string) =>
  screen.getByText(name).closest(".ws-row") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("one list", () => {
  it("shows a branch with a workspace once, not once per list", async () => {
    panel(
      [branch({ name: "main", current: true }), branch({ name: "feat/a" })],
      [
        worktree({ path: REPO, branch: "main", is_main: true }),
        worktree({ path: "/w/repo-wt-feat-a", branch: "feat/a", dirty: 3 }),
      ],
    );
    await waitFor(() => expect(screen.getAllByText("feat/a")).toHaveLength(1));
    // And it says, on the one row, both of the things the two lists used to.
    expect(row("feat/a").textContent).toContain("own space");
    expect(row("feat/a").textContent).toContain("±3");
  });

  it("has no Worktrees tab left to go to", async () => {
    panel([branch({ name: "main", current: true })], []);
    await waitFor(() => expect(screen.getByText("Branches")).toBeTruthy());
    expect(screen.queryByText("Worktrees")).toBeNull();
  });
});

describe("one click", () => {
  it("opens a branch that has its own workspace there, rather than moving it", async () => {
    panel(
      [branch({ name: "main", current: true }), branch({ name: "feat/a" })],
      [
        worktree({ path: REPO, branch: "main", is_main: true }),
        worktree({ path: "/w/repo-wt-feat-a", branch: "feat/a" }),
      ],
    );
    await waitFor(() => expect(screen.getByText("feat/a")).toBeTruthy());
    fireEvent.click(row("feat/a"));
    // Moving the branch here would take it away from whatever is working in it.
    expect(openThere).toHaveBeenCalledWith(REPO, "/w/repo-wt-feat-a", "feat/a");
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("switches to a branch that has no workspace of its own", async () => {
    panel(
      [branch({ name: "main", current: true }), branch({ name: "old" })],
      [worktree({ path: REPO, branch: "main", is_main: true })],
    );
    await waitFor(() => expect(screen.getByText("old")).toBeTruthy());
    fireEvent.click(row("old"));
    expect(switchTo).toHaveBeenCalledWith(REPO, { kind: "branch", branch: "old" });
    expect(openThere).not.toHaveBeenCalled();
  });

  it("does nothing when you click the one you are already in", async () => {
    panel(
      [branch({ name: "main", current: true }), branch({ name: "feat/a" })],
      [
        worktree({ path: REPO, branch: "main", is_main: true }),
        worktree({ path: "/w/repo-wt-feat-a", branch: "feat/a" }),
      ],
      { activeWorktree: "/w/repo-wt-feat-a" },
    );
    await waitFor(() => expect(screen.getByText("feat/a")).toBeTruthy());
    fireEvent.click(row("feat/a"));
    expect(openThere).not.toHaveBeenCalled();
    expect(switchTo).not.toHaveBeenCalled();
  });
});

describe("parallel", () => {
  it("offers the preview of a workspace that is actually serving", async () => {
    panel(
      [branch({ name: "main", current: true }), branch({ name: "feat/a" })],
      [
        worktree({ path: REPO, branch: "main", is_main: true }),
        worktree({ path: "/w/repo-wt-feat-a", branch: "feat/a" }),
      ],
      { serverCwds: ["/w/repo-wt-feat-a"] },
    );
    const port = await screen.findByTitle(/open its preview/i);
    fireEvent.click(port);
    expect(onOpenPreview).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/localhost:\d+$/),
    );
    // A row does not open a preview by being clicked — the chip does, and only
    // the chip, or scanning the list would keep navigating you somewhere.
    expect(openThere).not.toHaveBeenCalled();
  });

  it("holds a distinct port for each workspace, and never the main one", async () => {
    panel(
      [
        branch({ name: "main", current: true }),
        branch({ name: "feat/a" }),
        branch({ name: "feat/b" }),
      ],
      [
        worktree({ path: REPO, branch: "main", is_main: true }),
        worktree({ path: "/w/repo-wt-feat-a", branch: "feat/a" }),
        worktree({ path: "/w/repo-wt-feat-b", branch: "feat/b" }),
      ],
    );
    await waitFor(() => expect(screen.getByText("feat/b")).toBeTruthy());
    const portOf = (name: string) =>
      row(name).querySelector(".ws-port")?.textContent ?? "";
    expect(portOf("feat/a")).not.toBe(portOf("feat/b"));
    expect(portOf("feat/a")).not.toBe(portOf("main"));
  });
});

describe("starting a feature", () => {
  const startFeature = async (name: string) => {
    const input = await screen.findByPlaceholderText(/name a new feature/i);
    fireEvent.change(input, { target: { value: name } });
    fireEvent.click(screen.getByText("Start"));
  };

  it("sets the new workspace up, so it can run", async () => {
    switchTo.mockResolvedValue({ kind: "settled", path: "/w/repo-wt-feat-c" });
    ipc.gitWorktreeBootstrap.mockResolvedValue({
      carried: [".env"],
      cloned: ["node_modules"],
      install: null,
      note: null,
    });
    panel(
      [branch({ name: "main", current: true })],
      [worktree({ path: REPO, branch: "main", is_main: true })],
    );
    await startFeature("feat/c");
    await waitFor(() =>
      expect(ipc.gitWorktreeBootstrap).toHaveBeenCalledWith(REPO, "/w/repo-wt-feat-c"),
    );
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        expect.stringContaining("set up"),
        "success",
      ),
    );
  });

  it("puts the install somewhere you can watch it when cloning wasn't possible", async () => {
    switchTo.mockResolvedValue({ kind: "settled", path: "/w/repo-wt-feat-d" });
    ipc.gitWorktreeBootstrap.mockResolvedValue({
      carried: [],
      cloned: [],
      install: "npm ci",
      note: "Couldn't clone dependencies: not APFS",
    });
    panel(
      [branch({ name: "main", current: true })],
      [worktree({ path: REPO, branch: "main", is_main: true })],
    );
    await startFeature("feat/d");
    await waitFor(() =>
      expect(onOpenTerminal).toHaveBeenCalledWith("/w/repo-wt-feat-d", "feat/d"),
    );
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("npm ci"), "info");
  });

  it("leaves the workspace standing when setting it up fails", async () => {
    switchTo.mockResolvedValue({ kind: "settled", path: "/w/repo-wt-feat-e" });
    ipc.gitWorktreeBootstrap.mockRejectedValue("disk full");
    panel(
      [branch({ name: "main", current: true })],
      [worktree({ path: REPO, branch: "main", is_main: true })],
    );
    await startFeature("feat/e");
    // A workspace that exists but isn't set up is still a workspace: say what
    // didn't happen rather than tearing down what did.
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        expect.stringContaining("disk full"),
        "error",
      ),
    );
  });

  it("doesn't try to set up a workspace the switch never made", async () => {
    switchTo.mockResolvedValue({ kind: "refused", detail: "name taken" });
    panel(
      [branch({ name: "main", current: true })],
      [worktree({ path: REPO, branch: "main", is_main: true })],
    );
    await startFeature("feat/f");
    await waitFor(() => expect(switchTo).toHaveBeenCalled());
    expect(ipc.gitWorktreeBootstrap).not.toHaveBeenCalled();
  });
});

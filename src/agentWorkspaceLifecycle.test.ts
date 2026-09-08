import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentWorkspaceRoot,
  pickReusableWorkspace,
  reapDecision,
  reuseAgentWorkspace,
} from "./agentWorkspaceLifecycle";
import type { BranchWork, WorktreeInfo } from "./ipc";

const mocks = vi.hoisted(() => ({
  gitWorktrees: vi.fn(),
  gitWorkAudit: vi.fn(),
  gitWorktreeRealign: vi.fn(),
}));
vi.mock("./ipc", () => mocks);

const worktree = (over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  path: "/repo-wt-agent",
  name: "repo-wt-agent",
  head: "abc",
  branch: "agent/claude-20260821-0",
  detached: false,
  bare: false,
  locked: null,
  prunable: null,
  is_main: false,
  dirty: 0,
  ...over,
});

const work = (over: Partial<BranchWork> = {}): BranchWork => ({
  branch: "agent/claude-20260821-0",
  worktree: "/repo-wt-agent",
  is_main: false,
  prunable: false,
  current: false,
  dirty: 0,
  ahead: 0,
  behind: 0,
  upstream: null,
  upstream_gone: false,
  merged: false,
  protected: false,
  last_commit: "",
  age_days: 0,
  subject: "",
  author: "",
  ...over,
});

describe("agentWorkspaceRoot", () => {
  const repos = ["/gh/canopy", "/gh/other"];

  it("recovers the workspace root from a path inside it", () => {
    expect(agentWorkspaceRoot("/gh/canopy-wt-agent-claude-1/src", repos)).toEqual({
      repo: "/gh/canopy",
      root: "/gh/canopy-wt-agent-claude-1",
    });
    expect(agentWorkspaceRoot("/gh/canopy-wt-agent-claude-1", repos)).toEqual({
      repo: "/gh/canopy",
      root: "/gh/canopy-wt-agent-claude-1",
    });
  });

  it("answers null for the checkout itself and for unrelated paths", () => {
    expect(agentWorkspaceRoot("/gh/canopy", repos)).toBeNull();
    expect(agentWorkspaceRoot("/gh/canopy/src", repos)).toBeNull();
    expect(agentWorkspaceRoot("/elsewhere/thing", repos)).toBeNull();
  });
});

describe("reapDecision", () => {
  it("keeps anything that is not an agent workspace", () => {
    expect(reapDecision(undefined, undefined).kind).toBe("keep");
    expect(reapDecision(worktree({ is_main: true }), work()).kind).toBe("keep");
    expect(
      reapDecision(worktree({ branch: "feat/thing" }), work({ branch: "feat/thing" })).kind,
    ).toBe("keep");
    expect(reapDecision(worktree({ locked: "in use" }), work()).kind).toBe("keep");
    expect(reapDecision(worktree(), undefined).kind).toBe("keep");
    expect(reapDecision(worktree(), work({ protected: true })).kind).toBe("keep");
  });

  it("removes a pristine workspace, branch and all", () => {
    expect(reapDecision(worktree(), work())).toEqual({
      kind: "remove",
      branch: "agent/claude-20260821-0",
      deleteBranch: true,
    });
  });

  it("removes a pushed-clean workspace but keeps its branch", () => {
    expect(
      reapDecision(worktree(), work({ upstream: "origin/agent/claude-20260821-0" })),
    ).toEqual({
      kind: "remove",
      branch: "agent/claude-20260821-0",
      deleteBranch: false,
    });
  });

  it("treats a merged branch as safe even with commits beyond upstream", () => {
    expect(
      reapDecision(
        worktree(),
        work({ merged: true, ahead: 2, upstream: "origin/agent/claude-20260821-0" }),
      ),
    ).toEqual({
      kind: "remove",
      branch: "agent/claude-20260821-0",
      deleteBranch: true,
    });
  });

  it("asks about uncommitted files and unpushed commits", () => {
    expect(reapDecision(worktree({ dirty: 3 }), work({ dirty: 3 }))).toEqual({
      kind: "ask",
      branch: "agent/claude-20260821-0",
      dirty: 3,
      unpushed: 0,
    });
    expect(reapDecision(worktree(), work({ ahead: 2 }))).toEqual({
      kind: "ask",
      branch: "agent/claude-20260821-0",
      dirty: 0,
      unpushed: 2,
    });
  });
});

describe("pickReusableWorkspace", () => {
  it("picks the newest pristine workspace for the same CLI", () => {
    const older = worktree({ path: "/a", branch: "agent/claude-20260820-0" });
    const newer = worktree({ path: "/b", branch: "agent/claude-20260821-0" });
    const picked = pickReusableWorkspace(
      "claude",
      [older, newer],
      [work({ branch: older.branch! }), work({ branch: newer.branch! })],
    );
    expect(picked?.path).toBe("/b");
  });

  it("refuses other CLIs, dirt, own commits, pushes, locks, and stale records", () => {
    const cases: [WorktreeInfo, BranchWork][] = [
      [worktree({ branch: "agent/codex-1" }), work({ branch: "agent/codex-1" })],
      [worktree({ dirty: 1 }), work({ dirty: 1 })],
      [worktree(), work({ ahead: 1 })],
      [worktree(), work({ upstream: "origin/x" })],
      [worktree({ locked: "held" }), work()],
      [worktree({ prunable: "gone" }), work()],
      [worktree({ is_main: true }), work()],
    ];
    for (const [w, b] of cases)
      expect(pickReusableWorkspace("claude", [w], [b])).toBeNull();
  });

  it("refuses a worktree with no audit row", () => {
    expect(pickReusableWorkspace("claude", [worktree()], [])).toBeNull();
  });
});

describe("reuseAgentWorkspace", () => {
  beforeEach(() => vi.clearAllMocks());

  it("realigns and returns the picked workspace", async () => {
    mocks.gitWorktrees.mockResolvedValue([worktree()]);
    mocks.gitWorkAudit.mockResolvedValue({ base: "main", counts_degraded: false, items: [work()] });
    mocks.gitWorktreeRealign.mockResolvedValue("ok");
    await expect(reuseAgentWorkspace("/repo", "claude")).resolves.toBe("/repo-wt-agent");
    expect(mocks.gitWorktreeRealign).toHaveBeenCalledWith("/repo", "/repo-wt-agent");
  });

  it("answers null when the realign is refused", async () => {
    mocks.gitWorktrees.mockResolvedValue([worktree()]);
    mocks.gitWorkAudit.mockResolvedValue({ base: "main", counts_degraded: false, items: [work()] });
    mocks.gitWorktreeRealign.mockRejectedValue(new Error("workspace has its own commits"));
    await expect(reuseAgentWorkspace("/repo", "claude")).resolves.toBeNull();
  });

  it("answers null with nothing to reuse", async () => {
    mocks.gitWorktrees.mockResolvedValue([]);
    mocks.gitWorkAudit.mockResolvedValue({ base: "main", counts_degraded: false, items: [] });
    await expect(reuseAgentWorkspace("/repo", "claude")).resolves.toBeNull();
    expect(mocks.gitWorktreeRealign).not.toHaveBeenCalled();
  });
});

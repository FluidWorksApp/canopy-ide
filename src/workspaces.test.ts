import { beforeEach, describe, expect, it } from "vitest";
import type * as ipc from "./ipc";
import {
  basePort,
  ensureLeases,
  leasedPort,
  portEnv,
  portForCwd,
  releaseLease,
  workspaceRows,
  type WorkspaceContext,
} from "./workspaces";

const REPO = "/w/repo";

const branch = (over: Partial<ipc.BranchInfo> & { name: string }): ipc.BranchInfo => ({
  current: false,
  remote_only: false,
  synced: true,
  subject: "a commit",
  protected: false,
  ...over,
});

const worktree = (
  over: Partial<ipc.WorktreeInfo> & { path: string },
): ipc.WorktreeInfo => ({
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

const ctx = (over: Partial<WorkspaceContext> = {}): WorkspaceContext => ({
  repo: REPO,
  activePath: null,
  serverCwds: [],
  agentCwds: [],
  ports: {},
  ...over,
});

beforeEach(() => localStorage.clear());

describe("workspaceRows", () => {
  it("shows a branch once, whether or not it has a workspace", () => {
    const rows = workspaceRows(
      [branch({ name: "main", current: true }), branch({ name: "feat/a" })],
      [
        worktree({ path: REPO, branch: "main", is_main: true }),
        worktree({ path: "/w/repo-wt-feat-a", branch: "feat/a", dirty: 4 }),
      ],
      ctx(),
    );
    expect(rows.map((r) => r.branch)).toEqual(["main", "feat/a"]);
    // The join is what makes one row able to answer both questions.
    const a = rows.find((r) => r.branch === "feat/a")!;
    expect(a.path).toBe("/w/repo-wt-feat-a");
    expect(a.main).toBe(false);
    expect(a.dirty).toBe(4);
  });

  it("gives a branch checked out in the repo itself the repo's own path", () => {
    const rows = workspaceRows(
      [branch({ name: "main", current: true })],
      [worktree({ path: REPO, branch: "main", is_main: true })],
      ctx(),
    );
    expect(rows[0].path).toBe(REPO);
    expect(rows[0].main).toBe(true);
  });

  it("leaves a branch with no checkout pathless rather than dropping it", () => {
    const rows = workspaceRows(
      [branch({ name: "old" }), branch({ name: "fix/x", remote_only: true, synced: false })],
      [],
      ctx(),
    );
    expect(rows.find((r) => r.branch === "old")!.path).toBeNull();
    expect(rows.find((r) => r.branch === "fix/x")!.remoteOnly).toBe(true);
  });

  it("keeps a detached workspace that matches no branch", () => {
    const rows = workspaceRows(
      [branch({ name: "main", current: true })],
      [
        worktree({ path: REPO, branch: "main", is_main: true }),
        worktree({ path: "/w/repo-wt-pr-12", detached: true, head: "deadbeefcafe" }),
      ],
      ctx(),
    );
    const pr = rows.find((r) => r.path === "/w/repo-wt-pr-12")!;
    expect(pr.detached).toBe(true);
    expect(pr.branch).toContain("deadbee");
  });

  it("keeps a workspace whose folder is gone — it still holds the branch", () => {
    const rows = workspaceRows(
      [branch({ name: "main", current: true })],
      [
        worktree({ path: REPO, branch: "main", is_main: true }),
        worktree({ path: "/w/gone", branch: "feat/lost", prunable: "gone" }),
      ],
      ctx(),
    );
    const lost = rows.find((r) => r.branch === "feat/lost")!;
    expect(lost.missing).toBe(true);
  });

  it("counts only the servers and agents inside each workspace", () => {
    const rows = workspaceRows(
      [branch({ name: "main", current: true }), branch({ name: "feat/a" })],
      [
        worktree({ path: REPO, branch: "main", is_main: true }),
        worktree({ path: "/w/repo-wt-feat-a", branch: "feat/a" }),
      ],
      ctx({
        serverCwds: ["/w/repo-wt-feat-a", "/w/repo-wt-feat-a/api"],
        agentCwds: ["/w/repo-wt-feat-a", "/w/elsewhere"],
      }),
    );
    const a = rows.find((r) => r.branch === "feat/a")!;
    expect(a.running).toBe(2);
    expect(a.agents).toBe(1);
    // A prefix that isn't a path boundary is not "inside".
    const main = rows.find((r) => r.branch === "main")!;
    expect(main.running).toBe(0);
  });

  it("orders by what you're looking at, not by what's happening", () => {
    const rows = workspaceRows(
      [
        branch({ name: "main", current: true }),
        branch({ name: "feat/a" }),
        branch({ name: "old" }),
        branch({ name: "fix/x", remote_only: true, synced: false }),
      ],
      [
        worktree({ path: REPO, branch: "main", is_main: true }),
        worktree({ path: "/w/repo-wt-feat-a", branch: "feat/a", dirty: 99 }),
      ],
      ctx({ activePath: "/w/repo-wt-feat-a" }),
    );
    expect(rows.map((r) => r.branch)).toEqual(["feat/a", "main", "old", "fix/x"]);
  });
});

describe("port leases", () => {
  it("never hands a workspace the main checkout's port", () => {
    const port = leasedPort(REPO, "/w/repo-wt-a")!;
    expect(port).toBeGreaterThan(basePort());
  });

  it("is stable for the same workspace and distinct between workspaces", () => {
    const a = leasedPort(REPO, "/w/repo-wt-a");
    const b = leasedPort(REPO, "/w/repo-wt-b");
    expect(a).not.toBe(b);
    expect(leasedPort(REPO, "/w/repo-wt-a")).toBe(a);
  });

  it("reuses a released number instead of drifting upward", () => {
    const a = leasedPort(REPO, "/w/repo-wt-a");
    leasedPort(REPO, "/w/repo-wt-b");
    releaseLease(REPO, "/w/repo-wt-a");
    expect(leasedPort(REPO, "/w/repo-wt-c")).toBe(a);
  });

  it("keeps repos out of each other's way", () => {
    // Same offset in two repos is fine — you can't have both checked out at
    // this path, and the alternative is one repo starving the other.
    expect(leasedPort("/w/one", "/w/one-wt-a")).toBe(leasedPort("/w/two", "/w/two-wt-a"));
  });

  it("ensureLeases gives the main checkout the base port", () => {
    const ports = ensureLeases(REPO, [
      { path: REPO, is_main: true },
      { path: "/w/repo-wt-a", is_main: false },
    ]);
    expect(ports[REPO]).toBe(basePort());
    expect(ports["/w/repo-wt-a"]).toBeGreaterThan(basePort());
  });

  it("resolves a run's port from the workspace containing it", () => {
    const trees = [
      { path: REPO, is_main: true },
      { path: "/w/repo-wt-a", is_main: false },
    ];
    expect(portForCwd(REPO, "/w/repo-wt-a/frontend", trees)).toBe(
      leasedPort(REPO, "/w/repo-wt-a"),
    );
    // The repo's own checkout keeps the project's own port, untouched.
    expect(portForCwd(REPO, `${REPO}/frontend`, trees)).toBeNull();
    expect(portForCwd(REPO, "/w/somewhere-else", trees)).toBeNull();
  });

  it("spells the port every way a dev server might read it", () => {
    expect(Object.fromEntries(portEnv(5174))).toMatchObject({
      PORT: "5174",
      VITE_PORT: "5174",
    });
    expect(portEnv(null)).toEqual([]);
  });
});

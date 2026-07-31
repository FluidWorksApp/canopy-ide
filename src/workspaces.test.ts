import { beforeEach, describe, expect, it } from "vitest";
import type * as ipc from "./ipc";
import {
  agentsIn,
  basePort,
  ensureLeases,
  leasedPort,
  portEnv,
  portForCwd,
  principalAgent,
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

  it("names the agents in a workspace, when the caller can resolve them", () => {
    const claude = {
      sessionId: "s1",
      ptyId: 7,
      name: "claude",
      state: "working" as const,
    };
    const rows = workspaceRows(
      [branch({ name: "main", current: true }), branch({ name: "feat/a" })],
      [
        worktree({ path: REPO, branch: "main", is_main: true }),
        worktree({ path: "/w/repo-wt-feat-a", branch: "feat/a" }),
      ],
      ctx({ agentsAt: (d) => (d === "/w/repo-wt-feat-a" ? [claude] : []) }),
    );
    expect(rows.find((r) => r.branch === "feat/a")!.agentList).toEqual([claude]);
    expect(rows.find((r) => r.branch === "main")!.agentList).toEqual([]);
  });

  it("leaves the list empty when nobody can say who is where", () => {
    const rows = workspaceRows(
      [branch({ name: "main", current: true })],
      [worktree({ path: REPO, branch: "main", is_main: true })],
      ctx(),
    );
    expect(rows[0].agentList).toEqual([]);
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

describe("who is working where", () => {
  const d = (over: Record<string, unknown>) => ({
    session_id: "s1",
    cwd: "/w/repo-wt-a",
    agent: "claude",
    surface: "7",
    instance: "inst-1",
    state: "working",
    ...over,
  });

  it("ties an agent to the workspace its cwd is in", () => {
    const found = agentsIn("/w/repo-wt-a", [d({})], "inst-1");
    expect(found).toEqual([
      { sessionId: "s1", ptyId: 7, name: "claude", state: "working" },
    ]);
  });

  it("keeps an agent that cd'd deeper inside the workspace", () => {
    expect(agentsIn("/w/repo-wt-a", [d({ cwd: "/w/repo-wt-a/src" })], "inst-1")).toHaveLength(1);
  });

  it("does not take an agent from a sibling workspace", () => {
    expect(agentsIn("/w/repo-wt-a", [d({ cwd: "/w/repo-wt-b" })], "inst-1")).toEqual([]);
    // A path that merely shares a prefix is not inside.
    expect(agentsIn("/w/repo-wt-a", [d({ cwd: "/w/repo-wt-abc" })], "inst-1")).toEqual([]);
  });

  it("drops a session from another app launch — its pty id names someone else", () => {
    expect(agentsIn("/w/repo-wt-a", [d({ instance: "inst-0" })], "inst-1")).toEqual([]);
  });

  it("drops ended sessions — you cannot hand a server to one", () => {
    expect(agentsIn("/w/repo-wt-a", [d({ state: "ended" })], "inst-1")).toEqual([]);
  });

  it("survives a session with no terminal behind it", () => {
    const [a] = agentsIn("/w/repo-wt-a", [d({ surface: undefined })], "inst-1");
    expect(a.ptyId).toBeNull();
  });

  it("picks the one mid-turn as the row's principal", () => {
    const agents = agentsIn(
      "/w/repo-wt-a",
      [
        d({ session_id: "idle", surface: "1", state: "idle" }),
        d({ session_id: "busy", surface: "2", state: "working" }),
      ],
      "inst-1",
    );
    expect(principalAgent(agents)?.sessionId).toBe("busy");
    expect(principalAgent([])).toBeNull();
  });

  // This used to read the other way round, and it was the only list in the app
  // that did: a crashed agent still claiming "working" would sit on the row
  // while the agent actually stopped at a permission prompt went unmentioned.
  it("prefers the one blocked on you over the one merely working", () => {
    const agents = agentsIn(
      "/w/repo-wt-a",
      [
        d({ session_id: "busy", surface: "1", state: "working" }),
        d({ session_id: "blocked", surface: "2", state: "waiting" }),
      ],
      "inst-1",
    );
    expect(principalAgent(agents)?.sessionId).toBe("blocked");
  });
});

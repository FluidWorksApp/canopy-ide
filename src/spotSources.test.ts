import { describe, expect, it, vi } from "vitest";

const gitBranches = vi.fn();
const gitWorktrees = vi.fn();

// Only the two git calls the branch source makes are faked; every other source
// keeps the real module, so the registry tests below still exercise what ships.
vi.mock("./ipc", async (orig) => ({
  ...(await orig<typeof import("./ipc")>()),
  gitBranches: (repo: string) => gitBranches(repo),
  gitWorktrees: (repo: string) => gitWorktrees(repo),
}));

import {
  actionRows,
  branchRows,
  deferredRows,
  instantRows,
  registerSpotSource,
  sessionRows,
  spotGroupOrder,
  spotSources,
  tabRows,
  type SpotContext,
  type SpotQuery,
  type SpotRow,
} from "./spotSources";
import type { SubTab } from "./components/ProjectView/helpers";

const term = (id: string, title: string, ptyId: number): SubTab => ({
  id,
  type: "terminal",
  cwd: "/repo",
  title,
  ptyId,
});

const ctx = (over: Partial<SpotContext> = {}): SpotContext => ({
  components: [{ label: "app", path: "/repo" }],
  tabs: [term("t1", "dev server", 1), term("t2", "tests", 2)],
  serverGroups: [],
  digests: [],
  projectId: "p1",
  clis: [{ id: "claude", name: "Claude Code" }],
  installed: { claude: true },
  ...over,
});

describe("actionRows", () => {
  it("pins the run-task row first on any non-empty query", () => {
    const rows = actionRows("fix the flaky test", ctx());
    expect(rows[0].action).toEqual({
      type: "run-task",
      brief: "fix the flaky test",
    });
    // Pinned by score, so no launcher match can rank above it.
    expect(Math.min(...rows.map((r) => r.score))).toBe(rows[0].score);
  });

  it("offers no run-task row with nothing typed", () => {
    const rows = actionRows("", ctx());
    expect(rows.some((r) => r.action.type === "run-task")).toBe(false);
    expect(rows.some((r) => r.action.type === "new-shell")).toBe(true);
  });

  it("folds the launcher entries in and filters them", () => {
    const rows = actionRows("claude", ctx());
    expect(
      rows.some(
        (r) => r.action.type === "launch-cli" && r.action.cliId === "claude",
      ),
    ).toBe(true);
    expect(rows.some((r) => r.action.type === "new-preview")).toBe(false);
  });
});

describe("tabRows", () => {
  it("matches open tabs by their display label", () => {
    const rows = tabRows("dev", ctx());
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toEqual({ type: "focus-tab", tabId: "t1" });
  });
});

describe("sessionRows", () => {
  it("finds a session by what was said in it, and drops micro-task runs", () => {
    const digests = [
      {
        session_id: "s1",
        agent: "claude",
        branch: "feat/x",
        prompts: ["refactor the relay handshake"],
      },
      {
        session_id: "s2",
        agent: "claude",
        prompts: ["refactor the relay handshake"],
        micro: true,
      },
    ];
    const rows = sessionRows("relay handshake", ctx({ digests }));
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toMatchObject({
      type: "open-session",
      digest: { session_id: "s1" },
    });
  });
});

describe("branchRows", () => {
  const branch = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    current: false,
    remote_only: false,
    synced: true,
    subject: "",
    protected: false,
    ...over,
  });
  const worktree = (path: string, name: string, over: Record<string, unknown> = {}) => ({
    path,
    name,
    head: "6ccd544",
    branch: name,
    detached: false,
    bare: false,
    locked: null,
    prunable: null,
    is_main: false,
    dirty: 0,
    ...over,
  });
  // The source caches on the repo list (two git processes per repo), so each
  // case brings its own repo path rather than reaching into the cache.
  const wire = (repo: string, branches: unknown[], worktrees: unknown[] = []) => {
    gitBranches.mockImplementation(async (r: string) => (r === repo ? branches : []));
    gitWorktrees.mockImplementation(async (r: string) => (r === repo ? worktrees : []));
  };

  it("finds a branch and hands the switch to the shared flow", async () => {
    wire("/repo-a", [
      branch("main", { current: true, subject: "init", protected: true }),
      branch("feat/relay", { subject: "rework the relay handshake" }),
    ]);
    const rows = await branchRows("relay", ["/repo-a"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toEqual({
      type: "switch-branch",
      repo: "/repo-a",
      branch: "feat/relay",
    });
    expect(rows[0].kind).toBe("branch");
    expect(rows[0].detail).toContain("rework the relay handshake");
  });

  it("never offers the branch you are already on", async () => {
    wire("/repo-b", [branch("main", { current: true, subject: "init" })]);
    expect(await branchRows("main", ["/repo-b"])).toEqual([]);
  });

  it("says another workspace has it before you click, not after", async () => {
    wire(
      "/repo-c",
      [branch("feat/x", { subject: "wip" })],
      [
        worktree("/repo-c", "main", { is_main: true }),
        worktree("/repo-c-wt-feat-x", "feat/x"),
      ],
    );
    const rows = await branchRows("feat/x", ["/repo-c"]);
    expect(rows[0].detail).toContain("in another workspace");
    expect(rows[0].detail).toContain("wip");
  });
});

// ---------- the registry ----------
// What a plugin gets. Every test here registers through the same door a
// third-party source would and unregisters in the same breath — a leaked
// source would show up in every later test's rows.

const req = (query: string, over: Partial<SpotQuery> = {}): SpotQuery => ({
  query,
  ctx: ctx(),
  corpus: [],
  roots: ["/repo"],
  ...over,
});

const row = (id: string, group: string): SpotRow => ({
  id,
  group,
  title: id,
  score: 0,
  action: { type: "custom", run: () => {} },
});

describe("the source registry", () => {
  it("asks a registered instant source on every keystroke", () => {
    const rows = vi.fn(() => [row("plug:1", "Plugin")]);
    const off = registerSpotSource({
      id: "plug",
      group: "Plugin",
      timing: "instant",
      rows,
    });
    try {
      expect(instantRows(req("anything")).map((r) => r.id)).toContain("plug:1");
      expect(rows).toHaveBeenCalledWith(expect.objectContaining({ query: "anything" }));
    } finally {
      off();
    }
    expect(instantRows(req("anything")).map((r) => r.id)).not.toContain("plug:1");
  });

  it("places a source before another one, and the section order follows", () => {
    const off = registerSpotSource(
      { id: "plug", group: "Plugin", timing: "instant", rows: () => [] },
      { before: "tabs" },
    );
    try {
      const order = spotGroupOrder();
      expect(order.indexOf("Plugin")).toBeLessThan(order.indexOf("Open Tabs"));
      expect(order.indexOf("Plugin")).toBeGreaterThan(order.indexOf("Actions"));
    } finally {
      off();
    }
    expect(spotGroupOrder()).not.toContain("Plugin");
  });

  it("honours minQuery rather than asking on an empty box", () => {
    const rows = vi.fn(() => []);
    const off = registerSpotSource({
      id: "plug",
      group: "Plugin",
      timing: "instant",
      minQuery: 3,
      rows,
    });
    try {
      instantRows(req("ab"));
      expect(rows).not.toHaveBeenCalled();
      instantRows(req("abc"));
      expect(rows).toHaveBeenCalledOnce();
    } finally {
      off();
    }
  });

  it("keeps the palette alive when a source throws or rejects", async () => {
    const offSync = registerSpotSource({
      id: "bad-sync",
      group: "Bad",
      timing: "instant",
      rows: () => {
        throw new Error("boom");
      },
    });
    const offAsync = registerSpotSource({
      id: "bad-async",
      group: "Bad",
      timing: "deferred",
      rows: () => Promise.reject(new Error("boom")),
    });
    try {
      // The built-in instant sources still answer around the bad one.
      expect(instantRows(req("dev")).some((r) => r.action.type === "focus-tab")).toBe(true);
      await expect(deferredRows(req("dev"))).resolves.toEqual(expect.any(Array));
    } finally {
      offSync();
      offAsync();
    }
  });

  it("registers every built-in through the same door", () => {
    // No privileged path: if this drifts, something started bypassing the
    // registry and the palette stopped being extensible in that spot.
    expect(spotSources().map((s) => s.id)).toContain("actions");
    expect(spotSources().every((s) => typeof s.rows === "function")).toBe(true);
  });

  it("carries the branch source, debounced like the other git-shaped ones", () => {
    // ⌘K is the "from wherever we are" surface; without this row it is the one
    // place you cannot switch a branch from.
    const branches = spotSources().find((s) => s.id === "branches");
    expect(branches?.group).toBe("Branches");
    expect(branches?.timing).toBe("deferred");
    expect(spotGroupOrder()).toContain("Branches");
  });
});

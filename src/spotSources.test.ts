import { afterEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import type * as ipcTypes from "./ipc";

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
  clipRows,
  indexRows,
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
import * as clipboardStore from "./clipboardStore";

afterEach(() => vi.restoreAllMocks());

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

  it("offers what you typed as either a task or a research run", () => {
    // The two things a typed sentence can be sent off as, side by side, so the
    // choice is one keystroke rather than a different surface. They are
    // genuinely different jobs — one changes code and disappears, the other
    // answers a question and leaves the answer behind.
    const rows = actionRows("why is startup slow", ctx());
    const kinds = rows.slice(0, 2).map((r) => r.action.type);
    expect(kinds).toEqual(["run-task", "start-research"]);
    expect(rows[1].action).toEqual({
      type: "start-research",
      question: "why is startup slow",
    });
    // Both outrank every launcher entry, and the task keeps the top spot.
    expect(rows[0].score).toBeLessThan(rows[1].score);
    expect(rows[1].score).toBeLessThan(Math.min(...rows.slice(2).map((r) => r.score)));
  });

  it("offers neither with nothing typed", () => {
    const rows = actionRows("", ctx());
    expect(rows.some((r) => r.action.type === "run-task")).toBe(false);
    expect(rows.some((r) => r.action.type === "start-research")).toBe(false);
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

  it("carries research, and answers instantly so it can pre-empt a duplicate", () => {
    // The point of research in ⌘K is to catch someone before they go and find
    // out something already known. A debounced source would land after they
    // have started typing the question into a task — instant is the whole
    // value, and the cache research.ts keeps is what makes it affordable.
    const research = spotSources().find((s) => s.id === "research");
    expect(research?.group).toBe("Research");
    expect(research?.timing).toBe("instant");
    expect(spotGroupOrder()).toContain("Research");
    // Above tickets and PRs: "we already looked into this" outranks the work
    // items when both match.
    const order = spotGroupOrder();
    expect(order.indexOf("Research")).toBeLessThan(order.indexOf("Tickets"));
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

describe("what the user switched off", () => {
  it("stops asking a disabled source, and asks it again when re-enabled", () => {
    const rows = vi.fn(() => []);
    const off = registerSpotSource({
      id: "plug-off",
      group: "Plugin",
      timing: "instant",
      rows,
    });
    try {
      localStorage.setItem(
        "canopy.settings",
        JSON.stringify({ spotDisabledSources: ["plug-off"] }),
      );
      instantRows(req("dev"));
      expect(rows).not.toHaveBeenCalled();
      // The rest of the palette is unaffected — one source off is not the
      // palette off.
      expect(instantRows(req("dev")).some((r) => r.action.type === "focus-tab")).toBe(true);

      localStorage.setItem("canopy.settings", JSON.stringify({ spotDisabledSources: [] }));
      instantRows(req("dev"));
      expect(rows).toHaveBeenCalled();
    } finally {
      off();
      localStorage.clear();
    }
  });

  it("drops a disabled deferred source without touching its neighbours", async () => {
    const rows = vi.fn(async () => []);
    const off = registerSpotSource({
      id: "plug-slow",
      group: "Plugin",
      timing: "deferred",
      rows,
    });
    try {
      localStorage.setItem(
        "canopy.settings",
        JSON.stringify({ spotDisabledSources: ["plug-slow"] }),
      );
      await deferredRows(req("dev"));
      expect(rows).not.toHaveBeenCalled();
    } finally {
      off();
      localStorage.clear();
    }
  });
});

describe("indexRows", () => {
  const hit = (over: Partial<ipcTypes.SpotIndexHit> = {}): ipcTypes.SpotIndexHit => ({
    kind: "transcript",
    key: "s-1",
    agent: "codex",
    cwd: "/repo",
    title: "",
    snippet: "the retry loop",
    meta: "/Users/dev/.codex/sessions/2026/07/29/rollout-x.jsonl",
    ts: 1000,
    ...over,
  });

  it("opens a conversation even when no digest describes it", async () => {
    // The whole point of indexing every agent: a hit whose session Canopy has
    // no hook record for used to be dropped, which is how entire CLIs went
    // missing from search while their transcripts sat in the index.
    vi.spyOn(ipc, "spotSearch").mockResolvedValue([hit()]);
    const rows = await indexRows("retry", ctx(), ["/repo"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toMatchObject({
      type: "open-session",
      digest: { session_id: "s-1", agent: "codex", cwd: "/repo" },
    });
    expect(rows[0].kind).toBe("agent:codex");
  });

  it("prefers the digest when there is one", async () => {
    vi.spyOn(ipc, "spotSearch").mockResolvedValue([hit()]);
    const digest = {
      session_id: "s-1",
      agent: "codex",
      cwd: "/repo",
      branch: "feat/retry",
    } as ipcTypes.SessionDigest;
    const rows = await indexRows("retry", ctx({ digests: [digest] }), ["/repo"]);
    expect(rows[0].title).toContain("feat/retry");
    expect((rows[0].action as { digest: ipcTypes.SessionDigest }).digest).toBe(digest);
  });

  it("opens aider's history file, which is all aider has", async () => {
    vi.spyOn(ipc, "spotSearch").mockResolvedValue([
      hit({ agent: "aider", key: "/repo/.aider.chat.history.md#2026", meta: "/repo/.aider.chat.history.md" }),
    ]);
    const rows = await indexRows("retry", ctx(), ["/repo"]);
    expect(rows[0].action).toEqual({
      type: "open-file",
      path: "/repo/.aider.chat.history.md",
    });
  });

  it("drops a terminal hit whose tab is gone rather than showing a dead row", async () => {
    vi.spyOn(ipc, "spotSearch").mockResolvedValue([
      hit({ kind: "terminal", key: "pty:99", agent: "terminal" }),
    ]);
    expect(await indexRows("retry", ctx(), ["/repo"])).toEqual([]);
  });

  it("scopes to the open project unless told otherwise", async () => {
    const spy = vi.spyOn(ipc, "spotSearch").mockResolvedValue([]);
    await indexRows("retry", ctx(), ["/repo"]);
    expect(spy).toHaveBeenCalledWith("retry", 14, ["/repo"], false);

    localStorage.setItem(
      "canopy.settings",
      JSON.stringify({ spotSearchAllProjects: true }),
    );
    await indexRows("retry", ctx(), ["/repo"]);
    expect(spy).toHaveBeenLastCalledWith("retry", 14, ["/repo"], true);
    localStorage.clear();
  });
});

describe("clipRows", () => {
  const clip = (
    id: number,
    preview: string,
    over: Partial<ipcTypes.Clip> = {},
  ): ipcTypes.Clip => ({
    id,
    ts: Math.floor(Date.now() / 1000),
    preview,
    chars: preview.length,
    lines: 1,
    project: "p1",
    ...over,
  });

  const withClips = (clips: ipcTypes.Clip[]) =>
    vi.spyOn(clipboardStore, "getSnapshot").mockReturnValue(clips);

  it("offers the most recent clips with nothing typed — the whole recall story", () => {
    withClips([clip(1, "npm run typecheck"), clip(2, "git rebase -i main")]);
    const rows = clipRows("", ctx());
    expect(rows.map((r) => r.title)).toEqual([
      "npm run typecheck",
      "git rebase -i main",
    ]);
    expect(rows[0].group).toBe("Clipboard");
  });

  it("carries the id and never the text — Enter fetches the clip", () => {
    withClips([clip(7, "a snippet")]);
    expect(clipRows("snip", ctx())[0].action).toEqual({
      type: "paste-clip",
      clipId: 7,
    });
  });

  it("ranks this project's clips first, but keeps the others", () => {
    withClips([
      clip(1, "from elsewhere", { project: "p2" }),
      clip(2, "from here", { project: "p1" }),
    ]);
    const rows = clipRows("", ctx());
    expect(rows.map((r) => r.title)).toEqual(["from here", "from elsewhere"]);
    expect(rows[1].detail).toContain("another project");
  });

  it("matches on what the clip says", () => {
    withClips([clip(1, "npm run typecheck"), clip(2, "cargo test --lib")]);
    expect(clipRows("cargo", ctx()).map((r) => r.id)).toEqual(["clip:2"]);
  });

  it("has nothing to show when the feature is off", () => {
    withClips([]);
    expect(clipRows("anything", ctx())).toEqual([]);
  });
});

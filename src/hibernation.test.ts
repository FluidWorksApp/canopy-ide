import { beforeEach, describe, expect, it } from "vitest";
import {
  buildSnapshot,
  clearHibernation,
  hibernationOf,
  isHibernating,
  snapshotSummary,
  snapshotTabs,
  terminalLaunch,
  wakeSteps,
  writeHibernation,
  type ProjectSnapshot,
  type TerminalSnapshot,
} from "./hibernation";
import type { SubTab } from "./components/ProjectView/helpers";

const term = (over: Partial<Extract<SubTab, { type: "terminal" }>> = {}): SubTab =>
  ({
    id: over.id ?? "t1",
    type: "terminal",
    cwd: "/repo",
    title: "shell",
    ptyId: 7,
    ...over,
  }) as SubTab;

const fileTab = (path: string, view: "source" | "diff" = "source"): SubTab => ({
  id: `f-${path}`,
  type: "file",
  file: {
    path,
    name: path.split("/").pop()!,
    kind: "code",
    view,
    dirty: false,
    external: null,
    bytes: null,
  },
});

describe("snapshotTabs", () => {
  it("binds an agent terminal to the conversation running in it", () => {
    const snap = snapshotTabs([term({ command: "claude", ptyId: 7 })], (pty) =>
      pty === 7 ? "sess-42" : undefined,
    );
    expect(snap).toEqual([
      {
        kind: "terminal",
        cwd: "/repo",
        command: "claude",
        title: "shell",
        icon: undefined,
        run: undefined,
        agentId: "claude",
        sessionId: "sess-42",
        attachId: undefined,
      },
    ]);
  });

  it("reads the session out of a resume command when no hook has spoken", () => {
    // A terminal restored moments ago has a session id in its command line but
    // has not yet emitted an event, so the live map knows nothing about it.
    const [t] = snapshotTabs([term({ command: "claude --resume sess-9", ptyId: null })]);
    expect(t).toMatchObject({ agentId: "claude", sessionId: "sess-9" });
  });

  it("never carries a session id for a plain shell", () => {
    const [t] = snapshotTabs([term({ command: "npm run dev", ptyId: 7 })], () => "sess-42");
    expect(t).toMatchObject({ agentId: undefined, sessionId: undefined });
  });

  it("prefers the user's own tab name over whatever the shell repainted", () => {
    const [t] = snapshotTabs([term({ title: "zsh", customTitle: "api server" })]);
    expect(t).toMatchObject({ title: "api server" });
  });

  it("drops the tabs that must not come back", () => {
    const kept = snapshotTabs([
      // One-shot: waking it would re-run a task that already finished.
      term({ id: "m", command: "claude", micro: { taskId: "raise-pr" } }),
      // A finished build is output to read, not work to resume.
      term({ id: "r", command: "npm run build", run: true, exited: true, exitCode: 0 }),
      // Someone else's live session — nothing here can restore it.
      { id: "c", type: "collab", doc: "d1", name: "App.tsx", ownerName: "sam" },
      { id: "s", type: "shared-project", doc: "d2", name: "web", ownerName: "sam" },
      term({ id: "keep", command: "npm run dev", run: true }),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ run: true, command: "npm run dev" });
  });

  it("keeps every kind of document tab, in order", () => {
    const kinds = snapshotTabs([
      fileTab("/repo/App.tsx", "diff"),
      { id: "p", type: "preview", url: "http://localhost:5173", annotations: [] },
      { id: "h", type: "task-history" },
      { id: "i", type: "instructions", focus: "CLAUDE.md" },
      { id: "ch", type: "chat", peer: null, name: "everyone" },
    ]).map((t) => t.kind);
    expect(kinds).toEqual(["file", "preview", "task-history", "instructions", "chat"]);
  });
});

describe("buildSnapshot", () => {
  it("re-points the active tab at the index it lands on after drops", () => {
    const snap = buildSnapshot({
      tabs: [
        term({ id: "micro", command: "claude", micro: { taskId: "x" } }),
        fileTab("/repo/a.ts"),
        fileTab("/repo/b.ts"),
      ],
      activeTabId: "f-/repo/b.ts",
      sideTab: "files",
      collapsed: false,
      worktree: null,
      now: 1_700_000_000_000,
    });
    expect(snap.tabs).toHaveLength(2);
    expect(snap.activeIndex).toBe(1);
    expect(snap.at).toBe(1_700_000_000_000);
  });

  it("records no active tab when the one in front was dropped", () => {
    const snap = buildSnapshot({
      tabs: [term({ id: "micro", command: "claude", micro: { taskId: "x" } })],
      activeTabId: "micro",
      sideTab: "agents",
      collapsed: true,
      worktree: { repo: "/repo", path: "/repo-wt-fix", branch: "fix" },
    });
    expect(snap.activeIndex).toBeNull();
    expect(snap.worktree).toEqual({ repo: "/repo", path: "/repo-wt-fix", branch: "fix" });
  });
});

describe("terminalLaunch", () => {
  const t = (over: Partial<TerminalSnapshot> = {}): TerminalSnapshot => ({
    kind: "terminal",
    cwd: "/repo",
    title: "claude",
    ...over,
  });

  it("comes back mid-conversation when there is one to resume", () => {
    expect(t({ agentId: "claude", sessionId: "s1" })).toBeTruthy();
    expect(terminalLaunch(t({ agentId: "claude", sessionId: "s1", command: "claude" }))).toEqual({
      command: "claude --resume s1",
      resumed: true,
    });
  });

  it("starts the CLI fresh when its session can't be reopened by id", () => {
    // aider has no verified resume-by-id syntax, so the registry offers none.
    expect(terminalLaunch(t({ agentId: "aider", sessionId: "s1", command: "aider" }))).toEqual({
      command: "aider",
      resumed: false,
    });
  });

  it("replays a plain command as it was", () => {
    expect(terminalLaunch(t({ command: "npm run dev", run: true }))).toEqual({
      command: "npm run dev",
      resumed: false,
    });
  });
});

describe("snapshotSummary + wakeSteps", () => {
  const snap = buildSnapshot({
    tabs: [
      term({ id: "a", command: "claude", ptyId: 7 }),
      term({ id: "s", command: "npm run dev", run: true, title: "dev" }),
      fileTab("/repo/src/App.tsx"),
      { id: "p", type: "preview", url: "http://localhost:5173", annotations: [] },
    ],
    activeTabId: "a",
    sideTab: "files",
    collapsed: false,
    worktree: null,
    sessionFor: () => "sess-1",
  });

  it("counts what is asleep", () => {
    expect(snapshotSummary(snap)).toEqual({
      agents: 1,
      terminals: 1,
      files: 1,
      views: 1,
      total: 4,
    });
  });

  it("keeps the tab order and says what each step is doing", () => {
    expect(wakeSteps(snap).map((s) => s.label)).toEqual([
      "Resuming Claude Code in repo",
      "Restarting dev",
      "Reopening App.tsx",
      "Reloading preview of http://localhost:5173",
    ]);
  });

  it("summarises nothing as nothing", () => {
    expect(snapshotSummary(null).total).toBe(0);
    expect(wakeSteps(null)).toEqual([]);
  });
});

describe("the store", () => {
  beforeEach(() => localStorage.clear());

  const snap = (): ProjectSnapshot =>
    buildSnapshot({
      tabs: [fileTab("/repo/a.ts")],
      activeTabId: null,
      sideTab: "files",
      collapsed: false,
      worktree: null,
    });

  it("round-trips a snapshot and reports the project asleep", () => {
    expect(writeHibernation("p1", snap())).toBe(true);
    expect(isHibernating("p1")).toBe(true);
    expect(hibernationOf("p1")?.tabs).toHaveLength(1);
    clearHibernation("p1");
    expect(isHibernating("p1")).toBe(false);
    expect(hibernationOf("p1")).toBeNull();
  });

  it("wakes nothing from a snapshot it doesn't understand", () => {
    localStorage.setItem(
      "canopy.hibernation.v1",
      JSON.stringify({ p1: { version: 99, tabs: [{ kind: "file" }] } }),
    );
    expect(isHibernating("p1")).toBe(false);
  });

  it("survives a corrupt store", () => {
    localStorage.setItem("canopy.hibernation.v1", "{not json");
    expect(hibernationOf("p1")).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  SETTLED_TTL_MS,
  clearSettled,
  dueForCleanup,
  flagUnsaved,
  inProject,
  markSettled,
  resetSettledCache,
  settledSessions,
  type SettledSession,
} from "./settledSessions";

const entry = (over: Partial<SettledSession> = {}): SettledSession => ({
  id: "a",
  resumable: true,
  agentId: "claude",
  title: "Claude Code",
  cwd: "/repo-wt-x",
  worktree: { repo: "/repo", root: "/repo-wt-x" },
  settledAt: 1_000,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  resetSettledCache();
});

describe("settled sessions", () => {
  it("persists, replaces by id, flags and clears", () => {
    markSettled(entry());
    markSettled(entry({ settledAt: 2_000 }));
    resetSettledCache();
    expect(settledSessions()).toHaveLength(1);
    expect(settledSessions()[0].settledAt).toBe(2_000);
    flagUnsaved("a", { dirty: 1, unpushed: 0 });
    expect(settledSessions()[0].unsaved).toEqual({ dirty: 1, unpushed: 0 });
    clearSettled("a");
    expect(settledSessions()).toEqual([]);
  });

  it("is due for cleanup only after a day", () => {
    const list = [entry({ id: "old", settledAt: 0 }), entry({ id: "new", settledAt: 10 })];
    expect(dueForCleanup(list, SETTLED_TTL_MS + 5).map((s) => s.id)).toEqual(["old"]);
  });

  it("belongs to the project its folder or worktree repo is in", () => {
    expect(inProject(entry(), ["/repo"])).toBe(true);
    expect(inProject(entry({ worktree: undefined, cwd: "/repo/sub" }), ["/repo"])).toBe(true);
    expect(inProject(entry({ worktree: undefined, cwd: "/other" }), ["/repo"])).toBe(false);
  });

  it("survives junk in storage", () => {
    localStorage.setItem("canopy.settled-sessions.v1", "{not json");
    expect(settledSessions()).toEqual([]);
  });
});

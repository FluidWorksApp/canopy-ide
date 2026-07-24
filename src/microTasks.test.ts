import { describe, expect, it } from "vitest";
import {
  customTaskDef,
  microTaskProtocol,
  oneLine,
  raisePrTask,
  type RaisePrPayload,
} from "./microTasks";
import { isStopFor } from "./notifications";
import type * as ipc from "./ipc";

const branch = (over: Partial<ipc.BranchWork> = {}): ipc.BranchWork => ({
  branch: "feat/micro-tasks",
  worktree: null,
  is_main: false,
  prunable: false,
  current: true,
  dirty: 0,
  ahead: 3,
  behind: 0,
  upstream: "origin/feat/micro-tasks",
  upstream_gone: false,
  merged: false,
  protected: false,
  last_commit: "abc123",
  age_days: 1,
  subject: "Add micro tasks",
  author: "sam",
  ...over,
});

const payload = (over: Partial<ipc.BranchWork> = {}): RaisePrPayload => ({
  repo: "/repo",
  branch: branch(over),
});

describe("raisePrTask.buildContext", () => {
  it("stays on one line even with a multiline user query", () => {
    const ctx = raisePrTask.buildContext(payload(), "first line\nsecond line\r\nthird");
    expect(ctx).not.toMatch(/[\r\n]/);
    expect(ctx).toContain('The user adds: "first line second line third"');
  });

  it("asks for a push when the branch is ahead or has no upstream", () => {
    expect(raisePrTask.buildContext(payload({ ahead: 2 }), "")).toContain("git push -u origin");
    expect(raisePrTask.buildContext(payload({ upstream: null, ahead: 0 }), "")).toContain(
      "git push -u origin",
    );
    expect(raisePrTask.buildContext(payload({ ahead: 0 }), "")).not.toContain("git push");
  });

  it("always creates the PR via gh and forbids new commits", () => {
    const ctx = raisePrTask.buildContext(payload(), "");
    expect(ctx).toContain("gh pr create");
    expect(ctx).toContain("Do not commit");
    expect(ctx).toContain("canopy_job_done");
  });

  it("omits the user-adds clause when nothing was typed", () => {
    expect(raisePrTask.buildContext(payload(), "")).not.toContain("The user adds");
    expect(raisePrTask.buildContext(payload(), "   ")).not.toContain("The user adds");
  });

  it("runs in the worktree when the branch has one, else the repo", () => {
    expect(raisePrTask.cwd(payload())).toBe("/repo");
    expect(raisePrTask.cwd(payload({ worktree: "/repo-wt-x" }))).toBe("/repo-wt-x");
  });
});

describe("microTaskProtocol", () => {
  it("names the tool, both statuses, and the no-MCP fallback", () => {
    const p = microTaskProtocol();
    expect(p).toContain("canopy_job_done");
    expect(p).toContain('"done"');
    expect(p).toContain('"blocked"');
    expect(p).toContain("JOB DONE:");
    expect(p).not.toMatch(/[\r\n]/);
  });
});

describe("oneLine", () => {
  it("collapses all whitespace runs to single spaces", () => {
    expect(oneLine("  a\n\nb\t c \r\n ")).toBe("a b c");
  });
});

describe("customTaskDef", () => {
  const custom = {
    id: "abc",
    label: "Changelog",
    icon: "",
    placeholder: "",
    brief: "Add a changelog entry\nfor the latest release.",
  };

  it("adapts a user task: defaults, one-lined brief, dir payload", () => {
    const def = customTaskDef(custom);
    expect(def.id).toBe("custom-abc");
    expect(def.icon).toBe("◆");
    expect(def.placeholder).toBe("Anything to add…");
    expect(def.cwd({ dir: "/proj" })).toBe("/proj");
    const ctx = def.buildContext({ dir: "/proj" }, "keep it\nshort");
    expect(ctx).not.toMatch(/[\r\n]/);
    expect(ctx).toContain("Add a changelog entry for the latest release.");
    expect(ctx).toContain('The user adds: "keep it short"');
  });

  it("omits the user-adds clause when nothing was typed", () => {
    expect(customTaskDef(custom).buildContext({ dir: "/p" }, "")).not.toContain("The user adds");
  });
});

describe("isStopFor", () => {
  const stop = (pty: number | undefined, event = "Stop") =>
    JSON.stringify({ session_id: "s1", hook_event_name: event, canopy_pty: pty });

  it("matches Stop from the same terminal only", () => {
    expect(isStopFor(stop(7), 7)).toBe(true);
    expect(isStopFor(stop(8), 7)).toBe(false);
    expect(isStopFor(stop(undefined), 7)).toBe(false);
  });

  it("treats codex turn-complete as a stop too", () => {
    expect(
      isStopFor(JSON.stringify({ type: "agent-turn-complete", canopy_pty: 7 }), 7),
    ).toBe(true);
  });

  it("ignores other events and malformed lines", () => {
    expect(isStopFor(stop(7, "PostToolUse"), 7)).toBe(false);
    expect(isStopFor("not json", 7)).toBe(false);
  });
});

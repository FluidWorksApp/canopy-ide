import { describe, expect, it } from "vitest";
import {
  machineBadge,
  parseMachineSessions,
  rememberableTab,
  sessionsNeedingTabs,
  workspacesToJoin,
  closedKey,
  withoutClosed,
} from "./allWorkspaceTabs";

describe("parseMachineSessions", () => {
  it("keeps well-formed rows and drops the rest", () => {
    expect(
      parseMachineSessions([
        { id: 3, cwd: "/w", title: "claude" },
        { id: "x" },
        null,
        { id: -1 },
        { id: 4 },
      ]),
    ).toEqual([{ id: 3, cwd: "/w", title: "claude" }, { id: 4 }]);
    expect(parseMachineSessions("nonsense")).toEqual([]);
  });
});

describe("sessionsNeedingTabs", () => {
  const sessions = [{ id: 1 }, { id: 2 }, { id: 3 }];
  it("skips sessions a placeholder already holds, on that machine only", () => {
    const tabs = [
      {
        type: "terminal",
        machine: "remote:w",
        ptyId: null,
        reconnect: { sessionId: 1 },
      },
      {
        type: "terminal",
        machine: "remote:other",
        ptyId: null,
        reconnect: { sessionId: 2 },
      },
      { type: "file" },
    ];
    expect(
      sessionsNeedingTabs("remote:w", sessions, tabs).map((s) => s.id),
    ).toEqual([2, 3]);
  });
  it("wants a tab for every session when there are none", () => {
    expect(
      sessionsNeedingTabs("remote:w", sessions, []).map((s) => s.id),
    ).toEqual([1, 2, 3]);
  });
});

describe("machineBadge", () => {
  it("is short and never empty", () => {
    expect(machineBadge("Coraa Workstation Production")).toHaveLength(14);
    expect(machineBadge("  ")).toBe("workspace");
  });
});

describe("workspacesToJoin", () => {
  const list = [
    { id: "a", state: "ready" },
    { id: "own", state: "ready" },
    { id: "asleep", state: "stopped" },
    { id: "view-only", state: "ready", access: { canConnect: false } },
  ];
  it("never reads the window's own workspace as a second machine", () => {
    expect(workspacesToJoin(list, "own").map((w) => w.id)).toEqual(["a"]);
  });
  it("takes every running, connectable workspace when the window is local", () => {
    expect(workspacesToJoin(list).map((w) => w.id)).toEqual(["a", "own"]);
  });
});

describe("rememberableTab", () => {
  it("keeps the window's own terminals", () => {
    expect(rememberableTab({})).toBe(true);
  });
  it("leaves out terminals shown only because All workspaces is on", () => {
    expect(rememberableTab({ viaAll: true, machine: "remote:w" })).toBe(false);
    expect(rememberableTab({ viaAll: true })).toBe(false);
  });
  it("leaves out terminals running on another machine, including this Mac from a workspace window", () => {
    expect(rememberableTab({ machine: "remote:w" })).toBe(false);
    expect(rememberableTab({ machine: "local" })).toBe(false);
  });
});

describe("withoutClosed", () => {
  const sessions = [{ id: 1 }, { id: 2 }];

  it("keeps a closed session out of the next refresh", () => {
    const closed = new Set([closedKey("ws", 1)]);
    expect(withoutClosed("ws", sessions, closed).map((x) => x.id)).toEqual([2]);
  });

  it("still lists a new session on the same workspace", () => {
    const closed = new Set([closedKey("ws", 1)]);
    expect(
      withoutClosed("ws", [...sessions, { id: 3 }], closed).map((x) => x.id),
    ).toEqual([2, 3]);
  });

  it("forgets a closed session once it is gone, and leaves other machines alone", () => {
    const closed = new Set([closedKey("ws", 1), closedKey("other", 9)]);
    withoutClosed("ws", [{ id: 2 }], closed);
    expect(closed.has(closedKey("ws", 1))).toBe(false);
    expect(closed.has(closedKey("other", 9))).toBe(true);
  });
});

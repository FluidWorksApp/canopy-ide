import { describe, expect, it } from "vitest";
import { machineBadge, parseMachineSessions, sessionsNeedingTabs } from "./allWorkspaceTabs";

describe("parseMachineSessions", () => {
  it("keeps well-formed rows and drops the rest", () => {
    expect(parseMachineSessions([{ id: 3, cwd: "/w", title: "claude" }, { id: "x" }, null, { id: -1 }, { id: 4 }])).toEqual([
      { id: 3, cwd: "/w", title: "claude" },
      { id: 4 },
    ]);
    expect(parseMachineSessions("nonsense")).toEqual([]);
  });
});

describe("sessionsNeedingTabs", () => {
  const sessions = [{ id: 1 }, { id: 2 }, { id: 3 }];
  it("skips sessions a placeholder already holds, on that machine only", () => {
    const tabs = [
      { type: "terminal", machine: "remote:w", ptyId: null, reconnect: { sessionId: 1 } },
      { type: "terminal", machine: "remote:other", ptyId: null, reconnect: { sessionId: 2 } },
      { type: "file" },
    ];
    expect(sessionsNeedingTabs("remote:w", sessions, tabs).map((s) => s.id)).toEqual([2, 3]);
  });
  it("wants a tab for every session when there are none", () => {
    expect(sessionsNeedingTabs("remote:w", sessions, []).map((s) => s.id)).toEqual([1, 2, 3]);
  });
});

describe("machineBadge", () => {
  it("is short and never empty", () => {
    expect(machineBadge("Coraa Workstation Production")).toHaveLength(14);
    expect(machineBadge("  ")).toBe("workspace");
  });
});

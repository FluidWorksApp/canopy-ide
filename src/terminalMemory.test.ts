// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  rememberTerminals,
  rememberedTerminalState,
  rememberedTerminals,
  terminalResumeCards,
} from "./terminalMemory";
import type { Restorable } from "./restorable";

describe("terminal memory", () => {
  beforeEach(() => localStorage.clear());

  it("reads the legacy flat terminal array", () => {
    localStorage.setItem(
      "canopy.terminals",
      JSON.stringify({ p1: [{ cwd: "/repo", title: "shell" }] }),
    );
    expect(rememberedTerminals("p1")).toEqual([{ cwd: "/repo", title: "shell" }]);
    expect(rememberedTerminalState("p1").terminalGroups).toEqual({});
  });

  it("stores terminals with their multiplexed layout", () => {
    const group = {
      id: "g1",
      activeTabId: "b",
      root: {
        type: "split" as const,
        id: "s1",
        axis: "horizontal" as const,
        ratio: 0.5,
        first: { type: "leaf" as const, tabId: "a" },
        second: { type: "leaf" as const, tabId: "b" },
      },
    };
    rememberTerminals(
      "p1",
      [
        { cwd: "/repo", title: "Claude", tabId: "a", paneGroup: "g1" },
        { cwd: "/repo", title: "Codex", tabId: "b", paneGroup: "g1" },
      ],
      { g1: group },
    );
    expect(rememberedTerminalState("p1")).toEqual({
      terminals: [
        { cwd: "/repo", title: "Claude", tabId: "a", paneGroup: "g1" },
        { cwd: "/repo", title: "Codex", tabId: "b", paneGroup: "g1" },
      ],
      terminalGroups: { g1: group },
    });
  });

  it("round-trips exact session and account identity per pane", () => {
    rememberTerminals("p1", [
      {
        cwd: "/repo",
        title: "Claude",
        sessionId: "session-a",
        profile: "work",
      },
    ]);
    expect(rememberedTerminals("p1")[0]).toMatchObject({
      sessionId: "session-a",
      profile: "work",
    });
  });

  it("round-trips configured run identity", () => {
    rememberTerminals("p1", [
      {
        cwd: "/repo",
        title: "Dev",
        command: "npm run dev",
        run: true,
        componentId: "cmp-web",
        runCommandId: "run-dev",
      },
    ]);

    expect(rememberedTerminals("p1")[0]).toMatchObject({
      componentId: "cmp-web",
      runCommandId: "run-dev",
    });
  });
});

const restorable = (sessionId: string, cwd = "/repo"): Restorable => ({
  digest: { session_id: sessionId, updated: 1 } as Restorable["digest"],
  agentId: "claude",
  cwd,
  command: `claude --resume ${sessionId}`,
  prompt: sessionId,
  profile: "default",
  superseded: [],
});

describe("terminalResumeCards", () => {
  const group = {
    id: "g1",
    activeTabId: "b",
    zoomedTabId: "b",
    root: {
      type: "split" as const,
      id: "s1",
      axis: "vertical" as const,
      ratio: 0.35,
      first: { type: "leaf" as const, tabId: "a" },
      second: { type: "leaf" as const, tabId: "b" },
    },
  };

  it("groups panes and matches same-cwd sessions by exact id", () => {
    const cards = terminalResumeCards(
      [
        { cwd: "/repo", command: "claude", title: "A", tabId: "a", paneGroup: "g1", sessionId: "sa" },
        { cwd: "/repo", command: "claude", title: "B", tabId: "b", paneGroup: "g1", sessionId: "sb" },
      ],
      { g1: group },
      [restorable("sb"), restorable("sa")],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].leaves.map((leaf) => leaf.restorable?.digest.session_id)).toEqual(["sa", "sb"]);
    expect(cards[0].group).toEqual(group);
  });

  it("derives exact ids from legacy resume commands", () => {
    const cards = terminalResumeCards(
      [{ cwd: "/old", command: "claude --resume legacy", title: "Claude" }],
      {},
      [restorable("legacy", "/new")],
    );
    expect(cards[0].leaves[0].restorable?.digest.session_id).toBe("legacy");
  });

  it("never guesses a known mismatched session by cwd and agent", () => {
    const cards = terminalResumeCards(
      [{ cwd: "/repo", command: "claude", title: "Old", sessionId: "old" }],
      {},
      [restorable("new")],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].leaves[0].remembered).toBeUndefined();
    expect(cards[0].leaves[0].restorable?.digest.session_id).toBe("new");
  });

  it("collapses a partial group to a standalone card", () => {
    const cards = terminalResumeCards(
      [{ cwd: "/repo", title: "shell", tabId: "a", paneGroup: "g1" }],
      { g1: group },
      [],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].group).toBeUndefined();
    expect(cards[0].leaves).toHaveLength(1);
  });
});

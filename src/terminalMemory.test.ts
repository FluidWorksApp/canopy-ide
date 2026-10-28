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

  // The record behind the bug: an agent tab that came back from a renderer
  // recovery without its command, then was snapshotted without a session id.
  // It kept only the agent's opening prompt as its title.
  const lostIdentity = {
    cwd: "/repo",
    title: "what were the features we launched in 0.4.10 &…",
    promptName: "what were the features we launched in 0.4.10 &…",
    icon: "⌨",
    run: false,
    tabId: "t1",
    ptyId: 3,
    sessionGeneration: 3,
    instance: "launch-a",
  };
  const onSurface = (sessionId: string, surface: string, instance?: string, updated = 1) => ({
    ...restorable(sessionId),
    digest: { session_id: sessionId, surface, instance, updated } as Restorable["digest"],
  });

  it("pairs a record with no session id to the conversation its own pty last ran", () => {
    const cards = terminalResumeCards(
      [lostIdentity],
      {},
      [onSurface("685a", "3", "launch-a")],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].leaves).toHaveLength(1);
    expect(cards[0].leaves[0].restorable?.digest.session_id).toBe("685a");
    // Resumed, so the conversation's names are still the right ones.
    expect(cards[0].leaves[0].remembered?.promptName).toBe(lostIdentity.promptName);
  });

  it("does not pair by pty number across launches or without an instance", () => {
    for (const r of [onSurface("other", "3", "launch-b"), onSurface("old", "3")]) {
      const cards = terminalResumeCards([lostIdentity], {}, [r]);
      expect(cards).toHaveLength(2);
      expect(cards[0].leaves[0].restorable).toBeUndefined();
      expect(cards[1].leaves[0].restorable?.digest.session_id).toBe(r.digest.session_id);
    }
  });

  it("follows a conversation that moved to a new session id in the same terminal", () => {
    const cards = terminalResumeCards(
      [{ ...lostIdentity, sessionId: "old-id" }],
      {},
      [onSurface("new-id", "3", "launch-a")],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].leaves[0].restorable?.digest.session_id).toBe("new-id");
  });

  it("never turns a run-rail row into an agent resume", () => {
    const cards = terminalResumeCards(
      [{ ...lostIdentity, run: true, command: "npm run dev" }],
      {},
      [onSurface("685a", "3", "launch-a")],
    );
    expect(cards).toHaveLength(2);
    expect(cards[0].leaves[0].restorable).toBeUndefined();
  });

  it("takes the newest conversation when one pty ran several", () => {
    const cards = terminalResumeCards(
      [lostIdentity],
      {},
      [onSurface("first", "3", "launch-a", 1), onSurface("second", "3", "launch-a", 2)],
    );
    expect(cards[0].leaves[0].restorable?.digest.session_id).toBe("second");
  });

  it("a row that reopens without its conversation drops the conversation's names", () => {
    const cards = terminalResumeCards([lostIdentity], {}, []);
    const t = cards[0].leaves[0].remembered!;
    expect(t.title).toBe("");
    expect(t.promptName).toBeUndefined();
    expect(t.tabId).toBe("t1");
  });

  it("keeps a name the user chose on a row that cannot resume", () => {
    const cards = terminalResumeCards(
      [{ ...lostIdentity, userName: "release notes", agentName: "Agent title" }],
      {},
      [],
    );
    const t = cards[0].leaves[0].remembered!;
    expect(t.title).toBe("release notes");
    expect(t.userName).toBe("release notes");
    expect(t.agentName).toBeUndefined();
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

import { describe, expect, it } from "vitest";
import type * as ipc from "./ipc";
import type { Restorable } from "./restorable";
import { terminalResumeCards, type RememberedTerminal } from "./terminalMemory";
import { hostLiveTerminals, withoutLiveSessions } from "./terminalRecovery";
import { namePatch } from "./tabName";
import type { TerminalGroup } from "./terminalGroups";

const instance = "remote-coraa";
const live: RememberedTerminal = {
  tabId: "tab-claude",
  ptyId: 12,
  sessionGeneration: 12,
  instance,
  cwd: "/workspace/coraa-agent",
  command: "claude --resume 'sess-live'",
  sessionId: "sess-live",
  title: "claude",
  promptName: "Where are we at?",
};
const shell: RememberedTerminal = {
  tabId: "tab-shell",
  ptyId: 13,
  sessionGeneration: 13,
  instance,
  cwd: "/workspace/coraa-agent",
  title: "what are you waiting on me",
  ...namePatch({}, "user", "what are you waiting on me"),
};
const ended: RememberedTerminal = {
  tabId: "tab-old",
  ptyId: 4,
  sessionGeneration: 4,
  instance,
  cwd: "/workspace/coraa-agent",
  title: "old shell",
};
const memory = { terminals: [live, shell, ended], terminalGroups: {} };
const hostSessions = [
  { ptyId: 12, sessionGeneration: 12, cwd: "/workspace/coraa-agent", title: "claude" },
  { ptyId: 13, sessionGeneration: 13, cwd: "/workspace/coraa-agent", title: "bash" },
];

function restorable(sessionId: string, digest: Partial<ipc.SessionDigest> = {}): Restorable {
  return {
    digest: { session_id: sessionId, ...digest } as ipc.SessionDigest,
    agentId: "claude",
    cwd: "/workspace/coraa-agent",
    command: `claude --resume '${sessionId}'`,
    prompt: sessionId,
    profile: "default",
    superseded: [],
  } as Restorable;
}

describe("switching to a workspace with live terminals", () => {
  it("names every live, unattached terminal from the cached snapshot at once", () => {
    const plan = hostLiveTerminals(memory, hostSessions, new Set(), instance);
    expect(plan.decided).toBe(true);
    expect(plan.reconnecting).toEqual([
      { ptyId: 12, name: "Where are we at?" },
      { ptyId: 13, name: "what are you waiting on me" },
    ]);
  });

  it("stops listing a terminal as reconnecting once its tab is attached", () => {
    const plan = hostLiveTerminals(memory, hostSessions, new Set([12]), instance);
    expect(plan.reconnecting.map((t) => t.ptyId)).toEqual([13]);
    expect(plan.tabIds).toEqual(new Set(["tab-claude", "tab-shell"]));
  });

  it("offers no restore until live and ended terminals can be told apart", () => {
    expect(hostLiveTerminals(memory, hostSessions, new Set(), null).decided).toBe(false);
    expect(hostLiveTerminals(memory, [], new Set(), null).decided).toBe(true);
  });

  it("never offers a session that is live on the host, and still offers ended ones", () => {
    const restorables = [
      restorable("sess-live"),
      restorable("sess-surface", { surface: "13", instance }),
      restorable("sess-gone", { surface: "9", instance }),
      restorable("sess-other-instance", { surface: "12", instance: "remote-other" }),
    ];
    const plan = hostLiveTerminals(memory, hostSessions, new Set(), instance);
    const cards = withoutLiveSessions(
      terminalResumeCards(memory.terminals, {}, restorables),
      plan,
      instance,
    );
    const offered = cards.flatMap((card) =>
      card.leaves.map((leaf) => leaf.restorable?.digest.session_id ?? leaf.remembered?.tabId),
    );
    expect(offered).toEqual(["tab-old", "sess-gone", "sess-other-instance"]);
  });

  it("breaks a split with a live member into single rows for the ended panes", () => {
    const group: TerminalGroup = {
      id: "mux",
      activeTabId: "tab-shell",
      root: {
        type: "split",
        id: "s",
        axis: "vertical",
        ratio: 0.5,
        first: { type: "leaf", tabId: "tab-shell" },
        second: { type: "leaf", tabId: "tab-old" },
      },
    };
    const rows = [
      { ...shell, paneGroup: "mux" },
      { ...ended, paneGroup: "mux" },
    ];
    const plan = hostLiveTerminals(
      { terminals: rows, terminalGroups: { mux: group } },
      hostSessions,
      new Set(),
      instance,
    );
    const cards = withoutLiveSessions(
      terminalResumeCards(rows, { mux: group }, []),
      plan,
      instance,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].group).toBeUndefined();
    expect(cards[0].leaves.map((leaf) => leaf.remembered?.tabId)).toEqual(["tab-old"]);
  });
});

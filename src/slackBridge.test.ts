import { describe, expect, it, vi } from "vitest";
import { HOLD_LIMIT_MS, MAX_FOLLOW_UPS, createSlackBridge, slackEnvelope, slackFollowUpEnvelope } from "./slackBridge";
import type { SlackHubItem } from "./ipc";

function setup(ask?: (shown: string, wire: string) => Promise<{ text: string; failed: boolean }>) {
  let id = 0;
  const deps = {
    companionName: () => "Ash",
    ask: vi.fn(ask ?? (async () => ({ text: "done", failed: false }))),
    reply: vi.fn(async () => {}),
    approval: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    newId: () => `proposal-${++id}`,
  };
  return { bridge: createSlackBridge(deps), deps };
}

const message = (id: string, text: string, over: Partial<Extract<SlackHubItem, { kind: "message" }>> = {}): SlackHubItem => ({
  id,
  kind: "message",
  senderLabel: "Sam",
  senderRole: "me",
  channelType: "im",
  text,
  created: 1,
  ...over,
});
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("requests from the Slack hub", () => {
  it("runs a request and hands the reply back for its item", async () => {
    const { bridge, deps } = setup();
    bridge.receive([message("item-0001", "what is failing in CI?")]);
    await bridge.idle();
    expect(deps.ask).toHaveBeenCalledWith("Slack · Sam: what is failing in CI?", expect.stringContaining("the owner of this Canopy"), {
      origin: "slack:item-0001",
    });
    expect(deps.reply).toHaveBeenCalledWith("item-0001", "done");
  });

  it("never runs an item twice when its lease brings it back", async () => {
    const { bridge, deps } = setup();
    bridge.receive([message("item-0001", "hi")]);
    bridge.receive([message("item-0001", "hi")]);
    await bridge.idle();
    expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it("frames a teammate as not the owner", async () => {
    const { bridge, deps } = setup();
    bridge.receive([message("item-0002", "deploy staging", { senderLabel: "Priya", senderRole: "teammate", channelType: "channel" })]);
    await bridge.idle();
    expect(deps.ask.mock.calls[0][1]).toMatch(/Priya, a teammate — not the owner.*in a Slack channel/);
    expect(deps.ask.mock.calls[0][1]).toMatch(/\n\ndeploy staging$/);
  });

  it("runs requests one at a time", async () => {
    let release!: () => void;
    const order: string[] = [];
    const { bridge } = setup(async (shown) => {
      order.push(`start ${shown}`);
      if (shown.endsWith("one")) await new Promise<void>((r) => (release = r));
      order.push(`end ${shown}`);
      return { text: "ok", failed: false };
    });
    bridge.receive([message("item-0001", "one"), message("item-0002", "two")]);
    await flush();
    release();
    await bridge.idle();
    expect(order).toEqual(["start Slack · Sam: one", "end Slack · Sam: one", "start Slack · Sam: two", "end Slack · Sam: two"]);
  });

  it("answers in Slack when the companion cannot be reached", async () => {
    const { bridge, deps } = setup(async () => {
      throw new Error("not running");
    });
    bridge.receive([message("item-0003", "hi")]);
    await bridge.idle();
    expect(deps.reply).toHaveBeenCalledWith("item-0003", "I couldn't reach Ash: not running");
  });
});

describe("approvals in Slack", () => {
  async function midTurn() {
    let finish!: () => void;
    const ctx = setup(() => new Promise((r) => (finish = () => r({ text: "finished", failed: false }))));
    ctx.bridge.receive([message("item-0009", "deploy")]);
    await flush();
    return { ...ctx, finish: () => finish() };
  }

  it("is only offered during a Slack turn", () => {
    expect(setup().bridge.confirm({ action: "Start a server" })).toBeNull();
  });

  it("posts to the turn's item and resolves on the hub's answer", async () => {
    const { bridge, deps, finish } = await midTurn();
    const ask = bridge.confirm({ action: "Start a server", project: "api" })!;
    expect(deps.approval).toHaveBeenCalledWith("item-0009", "proposal-1", { action: "Start a server", project: "api" });
    bridge.receive([{ id: "answer-001", kind: "answer", proposalId: "proposal-1", accepted: true, by: "Sam" }]);
    await expect(ask.answer).resolves.toEqual({ accepted: true });
    finish();
    await bridge.idle();
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it("an answer in Canopy closes the Slack question; a finished turn denies what is left", async () => {
    const { bridge, deps, finish } = await midTurn();
    const first = bridge.confirm({ action: "A" })!;
    first.cancel(true);
    await expect(first.answer).resolves.toEqual({ accepted: true });
    expect(deps.cancel).toHaveBeenCalledWith("proposal-1", true);
    const second = bridge.confirm({ action: "B" })!;
    finish();
    await expect(second.answer).resolves.toEqual({ accepted: false });
    await bridge.idle();
    expect(deps.cancel).toHaveBeenCalledWith("proposal-2", false);
  });

  it("ignores an answer for a question nobody is waiting on", async () => {
    const { bridge, finish } = await midTurn();
    bridge.receive([{ id: "answer-002", kind: "answer", proposalId: "proposal-x", accepted: true, by: "Sam" }]);
    finish();
    await bridge.idle();
  });
});

// The bug this exists for: a Slack request the companion handed to an agent
// got "I've asked Fern" posted as the thread's one reply, and Fern's answer had
// nowhere to go.
describe("a request handed to an agent", () => {
  type Ask = (shown: string, wire: string, opts?: { origin?: string; from?: string }) => Promise<{ text: string; failed: boolean }>;
  function delegating(answers: string[], open: () => string[]) {
    let turn = 0;
    const ask = vi.fn<Ask>(async () => ({ text: answers[Math.min(turn++, answers.length - 1)], failed: false }));
    const deps = {
      companionName: () => "Ash",
      ask,
      reply: vi.fn(async () => {}),
      approval: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      newId: () => "proposal-1",
      openRequests: vi.fn(async () => open()),
      ack: vi.fn(async () => {}),
    };
    return { bridge: createSlackBridge(deps), deps };
  }

  it("holds the thread's one reply until the agent answers, then posts the follow-up's answer", async () => {
    let open = ["cr_1"];
    const { bridge, deps } = delegating(["I've asked Fern.", "Fern says CI is green."], () => open);
    bridge.receive([message("item-0001", "is CI green?")]);
    await bridge.idle();
    expect(deps.reply).not.toHaveBeenCalled();
    expect(deps.ack).toHaveBeenCalledWith("item-0001");

    open = [];
    expect(bridge.followUp("slack:item-0001", "green", "[canopy: reply from Fern …]\n\ngreen", "Fern · terminal 7")).toBe(true);
    await bridge.idle();
    const [shown, wire, opts] = deps.ask.mock.calls[1];
    expect(shown).toBe("green");
    expect(wire).toBe(`${slackFollowUpEnvelope({ senderLabel: "Sam", senderRole: "me" })}\n\n[canopy: reply from Fern …]\n\ngreen`);
    expect(opts).toEqual({ origin: "slack:item-0001", from: "Fern · terminal 7" });
    expect(deps.reply).toHaveBeenCalledTimes(1);
    expect(deps.reply).toHaveBeenCalledWith("item-0001", "Fern says CI is green.");
  });

  it("waits for every request the turn made", async () => {
    let open = ["cr_1", "cr_2"];
    const { bridge, deps } = delegating(["Asked both.", "One is in.", "Both are in."], () => open);
    bridge.receive([message("item-0002", "status?")]);
    await bridge.idle();
    open = ["cr_2"];
    bridge.followUp("slack:item-0002", "a", "a", "Fern · terminal 7");
    await bridge.idle();
    expect(deps.reply).not.toHaveBeenCalled();
    open = [];
    bridge.followUp("slack:item-0002", "b", "b", "Moss · terminal 8");
    await bridge.idle();
    expect(deps.reply).toHaveBeenCalledTimes(1);
    expect(deps.reply).toHaveBeenCalledWith("item-0002", "Both are in.");
  });

  it("still finishes in the thread when the agent answers before the turn has ended", async () => {
    let release!: () => void;
    let turn = 0;
    const { deps } = setup(async () => {
      if (turn++ === 0) {
        await new Promise<void>((r) => (release = r));
        return { text: "I've asked Fern.", failed: false };
      }
      return { text: "Fern says done.", failed: false };
    });
    const withOpen = createSlackBridge({ ...deps, openRequests: async () => [] });
    withOpen.receive([message("item-0003", "do it")]);
    await flush();
    // The request is already answered by the time the turn ends, so the
    // bridge's open list is empty — the queued follow-up is what holds it.
    expect(withOpen.followUp("slack:item-0003", "done", "done", "Fern · terminal 7")).toBe(true);
    release();
    await withOpen.idle();
    await withOpen.idle();
    expect(deps.reply).toHaveBeenCalledTimes(1);
    expect(deps.reply).toHaveBeenCalledWith("item-0003", "Fern says done.");
  });

  it("does not claim a reply whose thread it is not holding", () => {
    const { bridge } = delegating(["x"], () => []);
    expect(bridge.followUp("slack:item-nope", "a", "a", "Fern")).toBe(false);
    expect(bridge.followUp("chat", "a", "a", "Fern")).toBe(false);
  });

  it("posts once when nothing was handed off, exactly as before", async () => {
    const { bridge, deps } = delegating(["Here you go."], () => []);
    bridge.receive([message("item-0004", "hi")]);
    await bridge.idle();
    expect(deps.reply).toHaveBeenCalledWith("item-0004", "Here you go.");
    expect(deps.ack).not.toHaveBeenCalled();
  });

  it("answers anyway after a bounded number of follow-ups", async () => {
    const { bridge, deps } = delegating(["again"], () => ["cr_forever"]);
    bridge.receive([message("item-0005", "loop")]);
    await bridge.idle();
    for (let i = 0; i < MAX_FOLLOW_UPS; i++) {
      expect(bridge.followUp("slack:item-0005", "r", "r", "Fern")).toBe(true);
      await bridge.idle();
    }
    expect(deps.reply).toHaveBeenCalledTimes(1);
    expect(bridge.followUp("slack:item-0005", "r", "r", "Fern")).toBe(false);
  });

  it("never leaves a thread unanswered when the expiry never arrives", async () => {
    vi.useFakeTimers();
    try {
      const { bridge, deps } = delegating(["I've asked Fern."], () => ["cr_1"]);
      bridge.receive([message("item-0006", "hello")]);
      await vi.waitFor(() => expect(deps.ack).toHaveBeenCalled());
      vi.advanceTimersByTime(HOLD_LIMIT_MS);
      await bridge.idle();
      expect(deps.reply).toHaveBeenCalledWith("item-0006", "I've asked Fern.\n\n(No answer came back from the agent in time.)");
      expect(bridge.followUp("slack:item-0006", "late", "late", "Fern")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the envelope", () => {
  it("names the owner and where they wrote", () => {
    expect(slackEnvelope({ senderLabel: "Sam", senderRole: "me", channelType: "im" })).toMatch(/Sam, the owner of this Canopy, in a direct message/);
  });
});

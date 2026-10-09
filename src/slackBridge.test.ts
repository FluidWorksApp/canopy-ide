import { describe, expect, it, vi } from "vitest";
import { createSlackBridge, slackEnvelope } from "./slackBridge";
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
    expect(deps.ask).toHaveBeenCalledWith("Slack · Sam: what is failing in CI?", expect.stringContaining("the owner of this Canopy"));
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

describe("the envelope", () => {
  it("names the owner and where they wrote", () => {
    expect(slackEnvelope({ senderLabel: "Sam", senderRole: "me", channelType: "im" })).toMatch(/Sam, the owner of this Canopy, in a direct message/);
  });
});

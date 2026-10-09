import { describe, expect, it, vi } from "vitest";
import {
  APPROVE_ACTION,
  DENY_ACTION,
  UNLINKED_REPLY_WINDOW_MS,
  createSlackBridge,
  linkedPeople,
  requestText,
  slackEnvelope,
} from "./slackBridge";
import type { SlackPerson } from "./settings";
import type { SlackMessage } from "./ipc";

const ME: SlackPerson = { slackUserId: "UOWNER1", label: "Sam", role: "me" };
const MATE: SlackPerson = { slackUserId: "UMATE01", label: "Priya", role: "teammate" };

function setup(over: { ask?: (shown: string, wire: string) => Promise<{ text: string; failed: boolean }> } = {}) {
  let clock = 1_000;
  let id = 0;
  const posts: { channel: string; threadTs: string | null; text: string; blocks?: unknown[] }[] = [];
  const updates: { channel: string; ts: string; text: string }[] = [];
  const deps = {
    people: () => [ME, MATE],
    ownerName: () => "Sam",
    companionName: () => "Ash",
    ask: vi.fn(over.ask ?? (async () => ({ text: "done", failed: false }))),
    post: vi.fn(async (channel: string, threadTs: string | null, text: string, blocks?: unknown[]) => {
      posts.push({ channel, threadTs, text, blocks });
      return `ts${posts.length}`;
    }),
    update: vi.fn(async (channel: string, ts: string, text: string) => {
      updates.push({ channel, ts, text });
    }),
    now: () => clock,
    newId: () => `p${++id}`,
  };
  const bridge = createSlackBridge(deps);
  return { bridge, deps, posts, updates, tick: (ms: number) => (clock += ms) };
}

const dm = (user: string, text: string, over: Partial<SlackMessage> = {}): SlackMessage => ({
  channel: "D1",
  channelType: "im",
  user,
  text,
  ts: "1.1",
  threadTs: null,
  mention: false,
  ...over,
});

describe("who reaches the companion", () => {
  it("forwards a linked person's request and posts the reply back", async () => {
    const { bridge, deps, posts } = setup();
    bridge.onMessage(dm(ME.slackUserId, "what is failing in CI?"));
    await bridge.idle();
    expect(deps.ask).toHaveBeenCalledWith("Slack · Sam: what is failing in CI?", expect.stringContaining("the owner of this Canopy"));
    expect(posts).toEqual([{ channel: "D1", threadTs: null, text: "done", blocks: undefined }]);
  });

  it("tells an unlinked person once per window and forwards nothing", async () => {
    const { bridge, deps, posts, tick } = setup();
    bridge.onMessage(dm("USTRANGE", "rm -rf everything"));
    bridge.onMessage(dm("USTRANGE", "please"));
    await bridge.idle();
    expect(deps.ask).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toMatch(/linked in Canopy/);
    tick(UNLINKED_REPLY_WINDOW_MS);
    bridge.onMessage(dm("USTRANGE", "again"));
    expect(posts).toHaveLength(2);
  });

  it("answers a channel mention in its thread and strips the mention", async () => {
    const { bridge, deps, posts } = setup();
    bridge.onMessage(dm(MATE.slackUserId, "<@UBOT123> review PR 12", { channel: "C9", channelType: "channel", ts: "5.5", mention: true }));
    await bridge.idle();
    expect(deps.ask.mock.calls[0][1]).toMatch(/a teammate of Sam — not the owner/);
    expect(deps.ask.mock.calls[0][1]).toMatch(/\n\nreview PR 12$/);
    expect(posts[0]).toMatchObject({ channel: "C9", threadTs: "5.5" });
  });

  it("runs requests one at a time", async () => {
    let release!: () => void;
    const order: string[] = [];
    const { bridge } = setup({
      ask: async (shown) => {
        order.push(`start ${shown}`);
        if (shown.endsWith("one")) await new Promise<void>((r) => (release = r));
        order.push(`end ${shown}`);
        return { text: "ok", failed: false };
      },
    });
    bridge.onMessage(dm(ME.slackUserId, "one"));
    bridge.onMessage(dm(ME.slackUserId, "two"));
    await Promise.resolve();
    await Promise.resolve();
    release();
    await bridge.idle();
    expect(order).toEqual(["start Slack · Sam: one", "end Slack · Sam: one", "start Slack · Sam: two", "end Slack · Sam: two"]);
  });

  it("says so when the companion cannot be reached", async () => {
    const { bridge, posts } = setup({ ask: async () => { throw new Error("not running"); } });
    bridge.onMessage(dm(ME.slackUserId, "hi"));
    await bridge.idle();
    expect(posts[0].text).toBe("I couldn't reach Ash: not running");
  });
});

describe("approvals from Slack", () => {
  async function midTurn() {
    let finish!: () => void;
    const ctx = setup({
      ask: () => new Promise((r) => (finish = () => r({ text: "finished", failed: false }))),
    });
    ctx.bridge.onMessage(dm(MATE.slackUserId, "deploy staging"));
    await Promise.resolve();
    await Promise.resolve();
    return { ...ctx, finish: () => finish() };
  }

  it("is only offered during a Slack turn", () => {
    const { bridge } = setup();
    expect(bridge.confirm({ action: "Start a server" })).toBeNull();
  });

  it("only the owner can approve, even when a teammate asked", async () => {
    const { bridge, posts, updates, finish } = await midTurn();
    const ask = bridge.confirm({ action: "Start a server", project: "api" })!;
    expect(posts[0].blocks).toBeDefined();
    const answered = vi.fn();
    void ask.answer.then(answered);
    bridge.onAction({ actionId: APPROVE_ACTION, value: "p1", user: MATE.slackUserId, channel: "D1", messageTs: "ts1" });
    await Promise.resolve();
    expect(answered).not.toHaveBeenCalled();
    expect(posts.at(-1)!.text).toMatch(/Only Sam can approve/);
    bridge.onAction({ actionId: APPROVE_ACTION, value: "p1", user: ME.slackUserId, channel: "D1", messageTs: "ts1" });
    await expect(ask.answer).resolves.toEqual({ accepted: true });
    await Promise.resolve();
    expect(updates[0].text).toMatch(/Approved by Sam/);
    finish();
  });

  it("an answer in Canopy closes the Slack question, and a finished turn denies what is left", async () => {
    const { bridge, finish, updates } = await midTurn();
    const first = bridge.confirm({ action: "A" })!;
    first.cancel(false);
    await expect(first.answer).resolves.toEqual({ accepted: false });
    const second = bridge.confirm({ action: "B" })!;
    finish();
    await expect(second.answer).resolves.toEqual({ accepted: false });
    await bridge.idle();
    await Promise.resolve();
    expect(updates.map((u) => u.text)).toEqual(["A — Declined in Canopy.", "B — Expired — the request finished without an answer."]);
  });

  it("a deny press denies, and unknown buttons do nothing", async () => {
    const { bridge, finish } = await midTurn();
    const ask = bridge.confirm({ action: "X" })!;
    bridge.onAction({ actionId: "other", value: "p1", user: ME.slackUserId, channel: "D1", messageTs: "t" });
    bridge.onAction({ actionId: DENY_ACTION, value: "p1", user: ME.slackUserId, channel: "D1", messageTs: "t" });
    await expect(ask.answer).resolves.toEqual({ accepted: false });
    finish();
  });
});

describe("helpers", () => {
  it("never turns a malformed people list into an allow-all", () => {
    expect(linkedPeople(null)).toEqual([]);
    expect(linkedPeople([{ slackUserId: "*", role: "me", label: "x" }, { slackUserId: "U1234", role: "admin", label: "y" }, ME])).toEqual([ME]);
  });

  it("strips mentions and caps a request", () => {
    expect(requestText("<@U123ABC>  hi <@W99> there ")).toBe("hi  there");
    expect(requestText("x".repeat(9000))).toHaveLength(8000);
  });

  it("frames the owner and a teammate differently", () => {
    expect(slackEnvelope(ME, "im", "Sam")).toMatch(/owner of this Canopy\), in a direct message/);
    expect(slackEnvelope(MATE, "channel", "Sam")).toMatch(/not the owner.*needs Sam's approval/);
  });
});

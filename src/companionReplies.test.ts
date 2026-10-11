import { describe, expect, it, vi } from "vitest";
import { createCompanionReplies, replyEnvelope, replyFrom, replyShown } from "./companionReplies";
import { createSlackBridge } from "./slackBridge";
import type { CompanionReplyEvent, SlackHubItem } from "./ipc";

const reply = (over: Partial<CompanionReplyEvent> = {}): CompanionReplyEvent => ({
  requestId: "cr_0123456789abcdef0123456789abcdef",
  ptyId: 7,
  terminalName: "Fern",
  cwd: "/repo",
  origin: null,
  expired: false,
  text: "CI is green on main.",
  ...over,
});

describe("an agent's reply as the companion reads it", () => {
  it("is attributed to the agent, not the owner, and carries its text after the frame", () => {
    const wire = replyEnvelope(reply());
    expect(wire).toMatch(/^\[canopy: reply from Fern, the agent in \/repo \(terminal 7\) to your request cr_0123/);
    expect(wire).toContain("not a message from the owner");
    expect(wire.endsWith("]\n\nCI is green on main.")).toBe(true);
    expect(replyFrom(reply())).toBe("Fern · terminal 7");
    expect(replyFrom(reply({ terminalName: null }))).toBe("agent · terminal 7");
    expect(replyShown(reply())).toBe("CI is green on main.");
  });

  it("says plainly when the request went unanswered", () => {
    const e = reply({ expired: true, text: null });
    expect(replyEnvelope(e)).toMatch(/went unanswered for 10 minutes and has expired/);
    expect(replyEnvelope(e)).toContain("canopy_server_output(7)");
    expect(replyShown(e)).toMatch(/Didn't answer request cr_0123/);
  });
});

describe("where a reply goes", () => {
  it("is a turn in the companion's panel when the request began there", () => {
    const deps = { slackFollowUp: vi.fn(() => false), observe: vi.fn(async () => {}) };
    createCompanionReplies(deps).handle(reply());
    expect(deps.slackFollowUp).not.toHaveBeenCalled();
    expect(deps.observe).toHaveBeenCalledWith("CI is green on main.", replyEnvelope(reply()), "Fern · terminal 7");
  });

  it("goes to the Slack bridge when it claims the origin, and nowhere else", () => {
    const deps = { slackFollowUp: vi.fn(() => true), observe: vi.fn(async () => {}) };
    createCompanionReplies(deps).handle(reply({ origin: "slack:item-0001" }));
    expect(deps.slackFollowUp).toHaveBeenCalledWith("slack:item-0001", "CI is green on main.", expect.any(String), "Fern · terminal 7");
    expect(deps.observe).not.toHaveBeenCalled();
  });

  it("falls back to the panel when Slack no longer holds the thread", () => {
    const deps = { slackFollowUp: vi.fn(() => false), observe: vi.fn(async () => {}) };
    createCompanionReplies(deps).handle(reply({ origin: "slack:item-gone" }));
    expect(deps.observe).toHaveBeenCalledTimes(1);
  });
});

// The production failure end to end, with fakes at both edges: a Slack request,
// a companion turn that delegates, the agent's reply, and one Slack post that
// carries the agent's answer.
describe("a Slack request answered by an agent", () => {
  it("reaches the Slack thread through the bridge", async () => {
    const open = new Set<string>();
    const asked: Array<{ shown: string; wire: string; opts?: { origin?: string; from?: string } }> = [];
    const bridgeDeps = {
      companionName: () => "Ash",
      ask: vi.fn(async (shown: string, wire: string, opts?: { origin?: string; from?: string }) => {
        asked.push({ shown, wire, opts });
        if (asked.length === 1) {
          // The companion dispatches during its turn; the bridge records the
          // request under this turn's origin.
          open.add(opts!.origin!);
          return { text: "I've asked Fern to check.", failed: false };
        }
        return { text: "Fern checked: CI is green on main.", failed: false };
      }),
      reply: vi.fn(async () => {}),
      approval: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      newId: () => "proposal-1",
      openRequests: vi.fn(async (origin: string) => (open.has(origin) ? ["cr_x"] : [])),
      ack: vi.fn(async () => {}),
    };
    const bridge = createSlackBridge(bridgeDeps);
    const observe = vi.fn(async () => {});
    const replies = createCompanionReplies({
      slackFollowUp: (origin, shown, wire, from) => bridge.followUp(origin, shown, wire, from),
      observe,
    });
    const item: SlackHubItem = {
      id: "item-0042",
      kind: "message",
      senderLabel: "Priya",
      senderRole: "teammate",
      channelType: "channel",
      text: "is CI green?",
      created: 1,
    };

    bridge.receive([item]);
    await bridge.idle();
    expect(bridgeDeps.reply).not.toHaveBeenCalled();

    // The agent answers; the bridge marks the request answered first.
    open.clear();
    replies.handle(reply({ origin: "slack:item-0042", text: "green" }));
    await bridge.idle();

    expect(observe).not.toHaveBeenCalled();
    expect(asked[1].opts).toEqual({ origin: "slack:item-0042", from: "Fern · terminal 7" });
    expect(asked[1].wire).toContain("Priya (a teammate, not the owner)");
    expect(asked[1].wire).toContain("[canopy: reply from Fern");
    expect(bridgeDeps.reply).toHaveBeenCalledTimes(1);
    expect(bridgeDeps.reply).toHaveBeenCalledWith("item-0042", "Fern checked: CI is green on main.");
  });
});

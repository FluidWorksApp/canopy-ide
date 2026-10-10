import { afterEach, describe, expect, it, vi } from "vitest";

const hub = vi.fn();
vi.mock("./ipc", () => ({ slackHub: (...args: unknown[]) => hub(...args) }));
let finish: (() => void) | null = null;
vi.mock("./companionSession", () => ({
  askCompanion: () => new Promise((r) => (finish = () => r({ text: "ok", failed: false }))),
}));
vi.mock("./companion", () => ({ companionName: () => "Ash" }));

import { slackConfirm, startSlack } from "./slackLive";

afterEach(() => vi.useRealTimers());

describe("the live Slack wiring", () => {
  it("sends an approval's action as `summary`, never as the hub's `action`", async () => {
    hub.mockImplementation(async (action: string) => {
      if (action === "status") return { configured: true, installs: [], linked: [{ team: "T1", teamName: "T", slackUser: "U1" }] };
      if (action === "poll") {
        hub.mockImplementation(async (a: string) => (a === "poll" ? { items: [] } : {}));
        return { items: [{ id: "item-00001", kind: "message", senderLabel: "Sam", senderRole: "me", channelType: "im", text: "deploy", created: 1 }] };
      }
      return {};
    });
    const stop = startSlack();
    await vi.waitFor(() => expect(finish).not.toBeNull());
    const ask = slackConfirm({ action: "Run tests", project: "api" });
    expect(ask).not.toBeNull();
    await vi.waitFor(() => expect(hub).toHaveBeenCalledWith("approval", expect.objectContaining({ id: "item-00001", summary: "Run tests", project: "api", detail: null })));
    const call = hub.mock.calls.find(([a]) => a === "approval")!;
    expect(call[1]).not.toHaveProperty("action");
    finish!();
    stop();
  });
});

// Ported from T3 Code (MIT) packages/client-runtime/src/preview/serverBrowserStream.test.ts
// (pingdotgg/t3code d5290e9). The control and pointer cases are T3's; the file
// chooser and download cases are not ported (no Canopy counterpart). The
// ticket cases cover Canopy's one-use stream URLs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewStreamClient, type PreviewStreamControl } from "./browserStream";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  static all: FakeSocket[] = [];
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
    FakeSocket.all.push(this);
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
  closeWith(code: number) {
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}

let tickets = 0;
const target = {
  streamUrl: vi.fn(async (path: string) => `ws://host.test/v1/stream?ticket=t${++tickets}&path=${encodeURIComponent(path)}`),
  maxWidth: 800,
  maxHeight: 600,
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("preview stream control", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeSocket);
    FakeSocket.all = [];
  });
  afterEach(() => vi.unstubAllGlobals());
  const connect = async () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
    });
    await settle();
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };
  const agent: PreviewStreamControl = { canOperate: true, controller: "agent", generation: 1, dialog: null };

  it("does not grant control from malformed dialog metadata", async () => {
    const { client, socket, onControl } = await connect();
    socket.message(
      JSON.stringify({ type: "control", ...agent, controller: "you", dialog: { type: "prompt", message: 42, defaultValue: "" } }),
    );
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", async () => {
    const { client, socket, onFrame } = await connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("revokes input immediately on release and exposes pending dialog state", async () => {
    const { client, socket, onControl } = await connect();
    const owned = { ...agent, controller: "you" as const, dialog: { type: "prompt", message: "Name?", defaultValue: "initial" } };
    socket.control(owned);
    expect(onControl).toHaveBeenLastCalledWith(owned);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(client.send({ type: "releaseControl" })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(client.send({ type: "text", text: "late input" })).toBe(false);
    expect(client.send({ type: "dialog", accept: false })).toBe(false);
    client.stop();
  });

  it("lets an agent-owned viewer ask for control but nothing else", async () => {
    const { client, socket } = await connect();
    socket.control(agent);
    expect(client.send({ type: "mouse", action: "down", x: 1, y: 1, button: "left", buttons: 1, clickCount: 1, modifiers: 0 })).toBe(false);
    expect(client.send({ type: "takeControl" })).toBe(true);
    expect(socket.sent).toEqual(['{"type":"takeControl"}']);
    client.stop();
  });
});

describe("preview stream agent pointer", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports where the agent moves and clicks, ignoring malformed points", async () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, { onFrame: vi.fn(), onPointer, onViewport: vi.fn(), onConnectedChange: vi.fn() });
    await settle();
    FakeSocket.current.message(JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }));
    FakeSocket.current.message(JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }));
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({ phase: "click", x: 140, y: 50, sequence: 2 });
  });
});

describe("Canopy stream tickets", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeSocket);
    FakeSocket.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks for the viewer's size and mints a new ticket for every connect, with T3's backoff", async () => {
    const streamUrl = vi.fn(async (path: string) => `ws://host.test/v1/stream?ticket=${streamUrl.mock.calls.length}&p=${path}`);
    const client = createPreviewStreamClient({ streamUrl, maxWidth: 2560.4, maxHeight: 1600, interactive: false }, { onFrame: vi.fn(), onViewport: vi.fn(), onConnectedChange: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(streamUrl).toHaveBeenLastCalledWith("/browser/stream?maxWidth=2560&maxHeight=1600&interactive=false");
    // A refused upgrade (1006 before open) retries with a new ticket after 500 ms, then 1 s.
    FakeSocket.current.closeWith(1006);
    await vi.advanceTimersByTimeAsync(499);
    expect(streamUrl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(streamUrl).toHaveBeenCalledTimes(2);
    expect(FakeSocket.all.map((socket) => socket.url.split("&")[0])).toEqual(["ws://host.test/v1/stream?ticket=1", "ws://host.test/v1/stream?ticket=2"]);
    FakeSocket.current.closeWith(1008);
    await vi.advanceTimersByTimeAsync(1000);
    expect(streamUrl).toHaveBeenCalledTimes(3);
    client.stop();
  });

  it("retries a ticket that cannot be minted and stops for good when the page is gone", async () => {
    const streamUrl = vi.fn().mockRejectedValueOnce(new Error("Host request failed (503)")).mockResolvedValue("ws://host.test/v1/stream?ticket=x");
    const onGone = vi.fn();
    createPreviewStreamClient({ streamUrl, maxWidth: 800, maxHeight: 600 }, { onFrame: vi.fn(), onViewport: vi.fn(), onConnectedChange: vi.fn(), onGone });
    await vi.advanceTimersByTimeAsync(500);
    expect(streamUrl).toHaveBeenCalledTimes(2);
    expect(FakeSocket.all).toHaveLength(1);
    FakeSocket.current.closeWith(4404);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onGone).toHaveBeenCalledOnce();
    expect(streamUrl).toHaveBeenCalledTimes(2);
  });
});

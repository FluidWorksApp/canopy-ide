import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_MS, STALE_MS, Wire } from "./wire";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  send = vi.fn();
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(_url: string) { FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeSocket.instances = []; });

describe("authenticated host wire", () => {
  it("gets a new ticket on reconnect and ignores stale socket messages", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ticket: "one-use-ticket" }) });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("WebSocket", FakeSocket);
    const wire = new Wire("bearer"), received = vi.fn();
    wire.on(received); wire.connect();
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeSocket.instances[0]; first.open();
    expect(wire.send({ t: "hello" })).toBe(true);
    first.close();
    expect(wire.send({ t: "act" })).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.instances[1]; second.open();
    first.onmessage?.({ data: '{"t":"stale"}' });
    second.onmessage?.({ data: '{"t":"current"}' });
    expect(received).toHaveBeenCalledExactlyOnceWith({ t: "current" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith("/remote/ws-ticket", { method: "POST", headers: { authorization: "Bearer bearer" } });
    second.bufferedAmount = 1024 * 1024 + 1;
    expect(wire.send({ t: "act" })).toBe(false);
    wire.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not log a new session out when an old ticket request returns 401", async () => {
    let rejectOld!: (response: unknown) => void;
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { rejectOld = resolve; }))
      .mockResolvedValue({ ok: true, json: async () => ({ ticket: "new" }) }));
    vi.stubGlobal("WebSocket", FakeSocket);
    const wire = new Wire("token"); wire.onAuthFail = vi.fn();
    wire.connect(); wire.connect();
    rejectOld({ status: 401 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(wire.onAuthFail).not.toHaveBeenCalled();
    wire.close();
  });

  const ticketed = () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ticket: "t" }) });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("WebSocket", FakeSocket);
    return fetch;
  };
  const sent = (socket: FakeSocket) => socket.send.mock.calls.map(([raw]) => JSON.parse(raw as string));

  it("notices a socket that went silent (sleep, network switch) and reconnects instead of sending into it", async () => {
    const fetch = ticketed();
    const wire = new Wire("bearer"), status = vi.fn();
    wire.onStatus = status;
    wire.connect();
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeSocket.instances[0]; first.open();
    // Half-open: the browser still reports OPEN, but nothing comes back.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(sent(first)).toContainEqual({ t: "ping" });
    await vi.advanceTimersByTimeAsync(STALE_MS + HEARTBEAT_MS);
    expect(status).toHaveBeenLastCalledWith(false);
    expect(wire.connected).toBe(false);
    expect(wire.send({ t: "input", pty: 1, data: "x" })).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances).toHaveLength(2);
    wire.close();
  });

  it("keeps a quiet socket that answers its heartbeat", async () => {
    const fetch = ticketed();
    const wire = new Wire("bearer");
    wire.connect();
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeSocket.instances[0]; socket.open();
    socket.send.mockImplementation((raw: string) => {
      if (JSON.parse(raw).t === "ping") queueMicrotask(() => socket.onmessage?.({ data: '{"t":"pong"}' }));
    });
    await vi.advanceTimersByTimeAsync(STALE_MS * 4);
    expect(wire.connected).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    wire.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconnects at once when the page comes back rather than waiting out a long backoff", async () => {
    const fetch = ticketed();
    fetch.mockRejectedValue(new Error("offline"));
    const wire = new Wire("bearer");
    wire.connect();
    // Several failed attempts while the phone was asleep: the backoff is now long.
    await vi.advanceTimersByTimeAsync(60_000);
    const before = fetch.mock.calls.length;
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ticket: "t" }) });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.mock.calls.length).toBe(before + 1);
    wire.close();
  });
});

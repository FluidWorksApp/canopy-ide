import { afterEach, describe, expect, it, vi } from "vitest";
import { Wire } from "./wire";

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
});

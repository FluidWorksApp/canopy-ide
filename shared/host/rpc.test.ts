import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRpc } from "./rpc";
import { fakeWire } from "../../src/test/fakeHostWire";


afterEach(() => vi.useRealTimers());

describe("shared host RPC", () => {
  it("uses different operation ids across clients and matches out-of-order responses", async () => {
    const a = fakeWire(), b = fakeWire();
    const ra = makeRpc(a.wire), rb = makeRpc(b.wire);
    const first = ra.call("store_load"), second = ra.call("git_status"), other = rb.call("store_load");
    const ids = [a.send.mock.calls[0][0].id, a.send.mock.calls[1][0].id, b.send.mock.calls[0][0].id];
    expect(new Set(ids).size).toBe(3);
    a.receive({ t: "act-ack", id: ids[1], ok: true, result: ["modified"] });
    a.receive({ t: "act-ack", id: ids[0], ok: true, result: "workspace" });
    b.receive({ t: "act-ack", id: ids[2], ok: true, result: "other" });
    await expect(first).resolves.toBe("workspace");
    await expect(second).resolves.toEqual(["modified"]);
    await expect(other).resolves.toBe("other");
    ra.dispose(); rb.dispose();
  });

  it("fails pending mutations on disconnect without replaying them on reconnect", async () => {
    const f = fakeWire(), rpc = makeRpc(f.wire);
    const result = rpc.call("pty_spawn_detached");
    f.status(false);
    await expect(result).rejects.toThrow("may have completed");
    await expect(rpc.call("store_load")).rejects.toThrow("disconnected");
    f.status(true);
    expect(f.send).toHaveBeenCalledTimes(1);
    rpc.dispose();
  });

  it("settles immediately when the browser refuses a send", async () => {
    const f = fakeWire(), rpc = makeRpc(f.wire);
    f.send.mockReturnValue(false);
    const busy = vi.fn(); rpc.onBusy(busy);
    await expect(rpc.call("store_load")).rejects.toThrow("send queue");
    expect(busy.mock.calls.map(([value]) => value)).toEqual([false, true, false]);
    rpc.dispose();
  });

  it("releases subscriptions, deadlines and pending calls on disposal", async () => {
    vi.useFakeTimers();
    const f = fakeWire(), rpc = makeRpc(f.wire);
    const result = rpc.call("store_load");
    rpc.dispose();
    await expect(result).rejects.toThrow("closed");
    expect(f.subscriptions()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(rpc.call("store_load")).rejects.toThrow("disconnected");
  });
});

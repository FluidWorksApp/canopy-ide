import { describe, expect, it, vi } from "vitest";
import { fakeWire } from "../../src/test/fakeHostWire";
import { socketTerminals } from "./pty";

const viewer = () => ({ onData: vi.fn(), onReset: vi.fn(), onSize: vi.fn(), onGone: vi.fn() });

describe("socket terminal subscriptions", () => {
  it("reattaches after reconnect without spawning or killing the host process", () => {
    const f = fakeWire(), transport = socketTerminals(f.wire), view = viewer();
    const detach = transport.attachPty(7, view);
    f.receive({ t: "pty", pty: 7, b64: btoa("hello") });
    expect(view.onData).toHaveBeenCalledOnce();
    expect(Array.from(view.onData.mock.calls[0][0])).toEqual([104, 101, 108, 108, 111]);
    f.status(false); f.status(true);
    f.receive({ t: "pty-reset", pty: 7 });
    f.receive({ t: "pty-size", pty: 7, cols: 80, rows: 24 });
    expect(view.onReset).toHaveBeenCalledOnce();
    expect(view.onSize).toHaveBeenCalledWith(80, 24);
    expect(f.send.mock.calls.map(([m]) => m)).toEqual([{ t: "attach", pty: 7 }, { t: "attach", pty: 7 }]);
    detach(); transport.dispose();
    expect(f.subscriptions()).toBe(0);
  });

  it("does not detach a shared PTY until its last view closes", () => {
    const f = fakeWire(), transport = socketTerminals(f.wire);
    const a = viewer(), b = viewer();
    const closeA = transport.attachPty(9, a), closeB = transport.attachPty(9, b);
    f.send.mockClear();
    closeA();
    expect(f.send).not.toHaveBeenCalled();
    f.receive({ t: "pty-gone", pty: 9 });
    expect(a.onGone).not.toHaveBeenCalled();
    expect(b.onGone).toHaveBeenCalledOnce();
    closeB(); closeB();
    expect(f.send.mock.calls.map(([m]) => m)).toEqual([{ t: "detach", pty: 9 }]);
    transport.dispose();
  });
});

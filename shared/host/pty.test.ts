import { describe, expect, it, vi } from "vitest";
import { fakeWire } from "../../src/test/fakeHostWire";
import { INPUT_BACKLOG_CHARS, INPUT_BACKLOG_MS, socketTerminals } from "./pty";

const viewer = () => ({ onData: vi.fn(), onReset: vi.fn(), onSize: vi.fn(), onGone: vi.fn(), onNotice: vi.fn() });

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

describe("remote input while the host socket is unavailable", () => {
  const inputs = (send: ReturnType<typeof vi.fn>) =>
    send.mock.calls.map(([m]) => m).filter(m => m.t === "input").map(m => m.data);

  it("keeps keystrokes typed during a reconnect and sends them in order once the socket is back", () => {
    const f = fakeWire(), transport = socketTerminals(f.wire), view = viewer();
    transport.attachPty(3, view);
    transport.writePty(3, "l");
    f.status(false);
    transport.writePty(3, "s");
    transport.writePty(3, "\r");
    expect(view.onNotice).toHaveBeenLastCalledWith(expect.stringMatching(/reconnecting/i));
    f.send.mockClear();
    f.status(true);
    const sent = f.send.mock.calls.map(([m]) => m);
    // Reattach first, then the backlog, oldest first.
    expect(sent[0]).toEqual({ t: "attach", pty: 3 });
    expect(inputs(f.send)).toEqual(["s", "\r"]);
    expect(view.onNotice).toHaveBeenLastCalledWith(null);
    transport.dispose();
  });

  it("retries input the socket refused under backpressure without waiting for a reconnect", () => {
    vi.useFakeTimers();
    try {
      const f = fakeWire(), transport = socketTerminals(f.wire);
      transport.attachPty(3, viewer());
      f.send.mockImplementationOnce(() => false);
      transport.writePty(3, "x");
      expect(inputs(f.send)).toEqual(["x"]);
      vi.advanceTimersByTime(1000);
      expect(inputs(f.send)).toEqual(["x", "x"]);
      transport.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("bounds the backlog and says so rather than silently discarding input", () => {
    const f = fakeWire(), transport = socketTerminals(f.wire), view = viewer();
    transport.attachPty(3, view);
    f.status(false);
    transport.writePty(3, "a".repeat(INPUT_BACKLOG_CHARS));
    transport.writePty(3, "overflow");
    expect(view.onNotice).toHaveBeenLastCalledWith(expect.stringMatching(/couldn't send/i));
    f.send.mockClear();
    f.status(true);
    expect(inputs(f.send)).toEqual(["a".repeat(INPUT_BACKLOG_CHARS)]);
    // Once connected, the view still learns that part of what was typed is gone.
    expect(view.onNotice).toHaveBeenLastCalledWith(expect.stringMatching(/not sent/i));
    transport.dispose();
  });

  it("does not replay input that waited longer than the backlog window", () => {
    vi.useFakeTimers();
    try {
      const f = fakeWire(), transport = socketTerminals(f.wire), view = viewer();
      transport.attachPty(3, view);
      f.status(false);
      transport.writePty(3, "y\r");
      vi.advanceTimersByTime(INPUT_BACKLOG_MS + 1);
      f.send.mockClear();
      f.status(true);
      expect(inputs(f.send)).toEqual([]);
      expect(view.onNotice).toHaveBeenLastCalledWith(expect.stringMatching(/not sent/i));
      transport.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("shows an input error the host reports instead of dropping it silently", () => {
    const f = fakeWire(), transport = socketTerminals(f.wire), view = viewer();
    transport.attachPty(3, view);
    f.receive({ t: "input-error", pty: 3, error: "terminal 3 is not accepting input" });
    expect(view.onNotice).toHaveBeenLastCalledWith(expect.stringContaining("terminal 3 is not accepting input"));
    transport.dispose();
  });
});

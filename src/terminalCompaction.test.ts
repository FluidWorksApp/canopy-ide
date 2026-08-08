import { describe, expect, it, vi } from "vitest";
import {
  TerminalCompactionController,
  utf8BytesThroughLimit,
  type TerminalCompactionSurface,
} from "./terminalCompaction";
import { TerminalStreamLedger } from "./terminalStreamLedger";

class FakeSurface implements TerminalCompactionSurface {
  events: string[] = [];
  state = "history\u001b[?2004h";
  pendingDrain: (() => void) | null = null;
  pendingRestore: (() => void) | null = null;

  drain = (done: () => void) => {
    this.events.push("drain-queued");
    this.pendingDrain = done;
  };
  serialize = () => {
    this.events.push("serialized");
    return this.state;
  };
  clearCells = () => {
    this.events.push("cells-cleared");
    this.state = "";
  };
  restore = (snapshot: string, done: () => void) => {
    this.events.push("restore-queued");
    this.state = snapshot;
    this.pendingRestore = done;
  };
}

const harness = (surface = new FakeSurface(), maxSerializedBytes = 1_024) => {
  let timer: (() => void) | null = null;
  const compacted = vi.fn();
  const attempted = vi.fn();
  let reserved = 0;
  let budgetAvailable = true;
  const reserve = vi.fn((bytes: number) => {
    if (!budgetAvailable) return false;
    reserved += bytes;
    return true;
  });
  const release = vi.fn((bytes: number) => {
    reserved -= bytes;
  });
  const rejectedTooLarge = vi.fn();
  const rejectedGlobalBudget = vi.fn();
  const failed = vi.fn();
  const restored = vi.fn();
  const controller = new TerminalCompactionController(surface, {
    idleMs: 10,
    maxSerializedBytes,
    setTimer: (callback) => {
      timer = callback;
      return 1;
    },
    clearTimer: () => {
      timer = null;
    },
    metrics: {
      attempted,
      reserve,
      release,
      compacted,
      rejectedTooLarge,
      rejectedGlobalBudget,
      failed,
      restored,
    },
  });
  return {
    surface,
    controller,
    compacted,
    attempted,
    reserve,
    release,
    rejectedTooLarge,
    rejectedGlobalBudget,
    failed,
    restored,
    reserved: () => reserved,
    denyBudget: () => {
      budgetAvailable = false;
    },
    fireTimer: () => timer?.(),
  };
};

describe("hidden terminal compaction", () => {
  it("drains parsing, compacts, then restores before show resolves", async () => {
    const h = harness();
    h.controller.hide();
    h.fireTimer();
    expect(h.surface.events).toEqual(["drain-queued"]);

    h.surface.pendingDrain?.();
    expect(h.surface.events).toEqual([
      "drain-queued",
      "serialized",
      "cells-cleared",
    ]);
    expect(h.attempted).toHaveBeenCalledOnce();
    expect(h.compacted).toHaveBeenCalledOnce();
    expect(h.reserved()).toBe(15);

    let shown = false;
    const show = h.controller.show().then(() => {
      shown = true;
      h.surface.events.push("native-attach-allowed");
    });
    expect(shown).toBe(false);
    expect(h.surface.events.at(-1)).toBe("restore-queued");
    h.surface.pendingRestore?.();
    await show;
    expect(h.surface.state).toBe("history\u001b[?2004h");
    expect(h.surface.events.at(-1)).toBe("native-attach-allowed");
    expect(h.restored).toHaveBeenCalledWith(15);
    expect(h.reserved()).toBe(0);
  });

  it("a show that beats the parser barrier cannot clear live cells", async () => {
    const h = harness();
    h.controller.hide();
    h.fireTimer();
    await h.controller.show();
    h.surface.pendingDrain?.();

    expect(h.surface.events).toEqual(["drain-queued"]);
    expect(h.surface.state).toContain("history");
    expect(h.compacted).not.toHaveBeenCalled();
  });

  it("keeps the live xterm intact when serialization exceeds the cap", () => {
    const surface = new FakeSurface();
    surface.state = "🙂".repeat(10);
    const h = harness(surface, 16);
    h.controller.hide();
    h.fireTimer();
    h.surface.pendingDrain?.();

    expect(h.surface.events).toEqual(["drain-queued", "serialized"]);
    expect(h.surface.state).toBe("🙂".repeat(10));
    expect(h.rejectedTooLarge).toHaveBeenCalledWith(20);
    expect(h.compacted).not.toHaveBeenCalled();
  });

  it("leaves cells untouched when the serializer fails", () => {
    const surface = new FakeSurface();
    surface.serialize = () => {
      surface.events.push("serialized");
      throw new Error("unsupported extended attribute");
    };
    const h = harness(surface);
    h.controller.hide();
    h.fireTimer();
    h.surface.pendingDrain?.();
    expect(surface.events).toEqual(["drain-queued", "serialized"]);
    expect(surface.state).toContain("history");
    expect(h.failed).toHaveBeenCalledOnce();
    expect(h.compacted).not.toHaveBeenCalled();
  });

  it("leaves cells live when the process-wide payload budget is full", () => {
    const h = harness();
    h.denyBudget();
    h.controller.hide();
    h.fireTimer();
    h.surface.pendingDrain?.();
    expect(h.surface.events).toEqual(["drain-queued", "serialized"]);
    expect(h.surface.state).toContain("history");
    expect(h.rejectedGlobalBudget).toHaveBeenCalledOnce();
    expect(h.compacted).not.toHaveBeenCalled();
  });

  it("hide during restoration queues later compaction behind the restore", async () => {
    const h = harness();
    h.controller.hide();
    h.fireTimer();
    h.surface.pendingDrain?.();
    const showing = h.controller.show();
    h.controller.hide();
    h.fireTimer();
    expect(h.surface.events.at(-1)).toBe("drain-queued");
    h.surface.pendingRestore?.();
    await showing;
    h.surface.pendingDrain?.();
    expect(h.surface.events.slice(-2)).toEqual(["serialized", "cells-cleared"]);
  });

  it("dispose settles a queued restore and releases its reservation exactly once", async () => {
    const h = harness();
    h.controller.hide();
    h.fireTimer();
    h.surface.pendingDrain?.();
    const showing = h.controller.show();
    const restoreCallback = h.surface.pendingRestore;
    expect(h.reserved()).toBe(15);

    h.controller.dispose();
    await showing;
    expect(h.reserved()).toBe(0);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.restored).not.toHaveBeenCalled();

    // xterm normally drops this callback with its disposed write queue. Even
    // if a surface calls it late, the stored finisher is idempotent.
    restoreCallback?.();
    restoreCallback?.();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.restored).not.toHaveBeenCalled();
  });

  it("settles and releases once when restore throws synchronously", async () => {
    const surface = new FakeSurface();
    surface.restore = () => {
      surface.events.push("restore-threw");
      throw new Error("terminal already disposed");
    };
    const h = harness(surface);
    h.controller.hide();
    h.fireTimer();
    surface.pendingDrain?.();

    await expect(h.controller.show()).resolves.toBeUndefined();
    expect(surface.events.at(-1)).toBe("restore-threw");
    expect(h.failed).toHaveBeenCalledOnce();
    expect(h.restored).not.toHaveBeenCalled();
    expect(h.reserved()).toBe(0);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("restores old VT state before replaying exactly the unseen native suffix", async () => {
    const native = "beforeafter";
    const ledger = new TerminalStreamLedger();
    const surface = new FakeSurface();
    surface.state = native.slice(0, 6);
    expect(ledger.accept(1, 1, 6)).toBe(true);
    const h = harness(surface);
    h.controller.hide();
    h.fireTimer();
    surface.pendingDrain?.();

    let attached = false;
    const showing = h.controller.show().then(() => {
      attached = true;
      surface.events.push("native-attach-allowed");
      const after = ledger.replayAfter() ?? 0;
      const suffix = native.slice(after);
      expect(ledger.accept(2, 2, native.length)).toBe(true);
      surface.state += suffix;
    });
    expect(attached).toBe(false);
    expect(surface.state).toBe("before");
    surface.pendingRestore?.();
    await showing;

    expect(surface.state).toBe(native);
    expect(ledger.replayAfter()).toBe(native.length);
    expect(surface.events.indexOf("restore-queued")).toBeLessThan(
      surface.events.indexOf("native-attach-allowed"),
    );
  });
});

describe("UTF-8 compaction bound", () => {
  it("counts ASCII, BMP and surrogate-pair content without allocating bytes", () => {
    expect(utf8BytesThroughLimit("aé界🙂", 20)).toEqual({ bytes: 10, exceeded: false });
    expect(utf8BytesThroughLimit("🙂🙂", 4)).toEqual({ bytes: 8, exceeded: true });
  });
});

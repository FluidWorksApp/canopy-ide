import { describe, expect, it, vi } from "vitest";
import {
  TerminalCompactionController,
  utf8BytesThroughLimit,
  type TerminalCompactionSurface,
} from "./terminalCompaction";
import {
  TerminalRetentionRegistry,
  type TerminalRetentionTracker,
} from "./terminalRetention";
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
  it("bounds 32 hidden terminals globally while a visible and rogue producer keep exact output", async () => {
    const payloadBytes = 16;
    const registry = new TerminalRetentionRegistry(payloadBytes * 4);
    const sample = (visible: boolean) => ({
      visible,
      normalRows: 5_024,
      alternateRows: 0,
      cols: 80,
      viewportRows: 24,
      configuredScrollbackRows: 5_000,
    });
    const visibleTracker = registry.track(sample(true));
    const visibleSurface = new FakeSurface();
    const visibleController = new TerminalCompactionController(visibleSurface, {
      metrics: trackerMetrics(visibleTracker),
    });
    const hidden = Array.from({ length: 32 }, (_, index) => {
      const surface = new FakeSurface();
      surface.state = `term-${index.toString().padStart(2, "0")}-history!`;
      expect(surface.state.length).toBe(payloadBytes);
      const tracker = registry.track(sample(false));
      let timer: (() => void) | null = null;
      const controller = new TerminalCompactionController(surface, {
        maxSerializedBytes: payloadBytes,
        metrics: trackerMetrics(tracker),
        setTimer: (callback) => {
          timer = callback;
          return 1;
        },
        clearTimer: () => {
          timer = null;
        },
      });
      return { controller, surface, tracker, fire: () => timer?.() };
    });

    for (const terminal of hidden) {
      terminal.controller.hide();
      terminal.fire();
      terminal.surface.pendingDrain?.();
    }

    expect(visibleController.compactNow()).toBe(false);
    expect(visibleSurface.state).toBe("history\u001b[?2004h");
    expect(registry.snapshot()).toMatchObject({
      instances: 33,
      visibleInstances: 1,
      hiddenInstances: 32,
      compactionAttempts: 32,
      compactionSuccesses: 4,
      compactionRejectedGlobalBudget: 28,
      compactedPayloadBytes: payloadBytes * 4,
      compactedPayloadBytesHighWater: payloadBytes * 4,
    });

    // Hidden PTY output does not parse into the compacted xterm. Model a rogue
    // producer filling native replay while the renderer retains only its VT
    // snapshot, then require exact one-time replay after restoration.
    const rogue = hidden[0];
    const ledger = new TerminalStreamLedger();
    let native = `term-00-history!`;
    expect(ledger.accept(1, 1, native.length)).toBe(true);
    for (let chunk = 0; chunk < 2_000; chunk += 1) {
      native += `\r\nrogue-${chunk.toString().padStart(4, "0")}`;
    }
    const showing = rogue.controller.show();
    rogue.surface.pendingRestore?.();
    await showing;
    const unseen = native.slice(ledger.replayAfter() ?? 0);
    expect(ledger.accept(2, 2, native.length)).toBe(true);
    rogue.surface.state += unseen;
    expect(rogue.surface.state).toBe(native);
    expect(registry.snapshot().compactedPayloadBytes).toBe(payloadBytes * 3);

    // Releasing one restored reservation admits one previously rejected
    // terminal, keeping the aggregate at—not above—the process-wide ceiling.
    const retry = hidden[4];
    expect(retry.controller.compactNow()).toBe(true);
    retry.fire();
    retry.surface.pendingDrain?.();
    expect(registry.snapshot()).toMatchObject({
      compactionSuccesses: 5,
      compactedPayloadBytes: payloadBytes * 4,
      compactedPayloadBytesHighWater: payloadBytes * 4,
    });

    visibleController.dispose();
    visibleTracker.dispose();
    for (const terminal of hidden) {
      terminal.controller.dispose();
      terminal.tracker.dispose();
    }
    expect(registry.snapshot()).toMatchObject({
      instances: 0,
      compactedPayloadBytes: 0,
    });
  });

  it("preserves exact output through repeated hidden compaction and reattach cycles", async () => {
    const h = harness(new FakeSurface(), 256 * 1024);
    const ledger = new TerminalStreamLedger();
    let native = h.surface.state;
    let epoch = 1;

    for (let cycle = 0; cycle < 1_000; cycle += 1) {
      const visible = `\r\nvisible-${cycle.toString().padStart(4, "0")}`;
      const visibleEnd = native.length + visible.length;
      expect(ledger.accept(epoch, epoch, visibleEnd)).toBe(true);
      native += visible;
      h.surface.state += visible;

      h.controller.hide();
      h.fireTimer();
      h.surface.pendingDrain?.();

      // The child remains live while its renderer viewer is detached. These
      // bytes exist only in the bounded native replay ring until show settles.
      const hidden = `\r\nhidden-${cycle.toString().padStart(4, "0")}`;
      native += hidden;
      epoch += 1;
      const showing = h.controller.show();
      h.surface.pendingRestore?.();
      await showing;

      const replayAfter = ledger.replayAfter() ?? 0;
      const suffix = native.slice(replayAfter);
      expect(ledger.accept(epoch, epoch, native.length)).toBe(true);
      h.surface.state += suffix;
      expect(h.surface.state).toBe(native);
      expect(h.reserved()).toBe(0);
    }

    expect(h.compacted).toHaveBeenCalledTimes(1_000);
    expect(h.restored).toHaveBeenCalledTimes(1_000);
    expect(ledger.replayAfter()).toBe(native.length);
  });

  it("advances hidden idle compaction under pressure but never compacts visible state", async () => {
    const h = harness();
    expect(h.controller.compactNow()).toBe(false);
    h.controller.hide();
    expect(h.controller.compactNow()).toBe(true);
    h.fireTimer();
    h.surface.pendingDrain?.();
    expect(h.compacted).toHaveBeenCalledOnce();

    const shown = h.controller.show();
    h.surface.pendingRestore?.();
    await shown;
    expect(h.controller.compactNow()).toBe(false);
  });

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

function trackerMetrics(tracker: TerminalRetentionTracker) {
  return {
    attempted: tracker.compactionAttempted,
    reserve: tracker.reserveCompaction,
    release: tracker.releaseCompaction,
    compacted: tracker.compacted,
    rejectedTooLarge: tracker.compactionRejected,
    rejectedGlobalBudget: tracker.compactionBudgetRejected,
    failed: tracker.compactionFailed,
    restored: tracker.restored,
  };
}

describe("UTF-8 compaction bound", () => {
  it("counts ASCII, BMP and surrogate-pair content without allocating bytes", () => {
    expect(utf8BytesThroughLimit("aé界🙂", 20)).toEqual({ bytes: 10, exceeded: false });
    expect(utf8BytesThroughLimit("🙂🙂", 4)).toEqual({ bytes: 8, exceeded: true });
  });
});

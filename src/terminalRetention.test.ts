import { describe, expect, it } from "vitest";
import { TerminalRetentionRegistry } from "./terminalRetention";

const sample = (
  visible: boolean,
  normalRows: number,
  alternateRows = 0,
  cols = 80,
) => ({
  visible,
  normalRows,
  alternateRows,
  cols,
  viewportRows: 24,
  configuredScrollbackRows: 5_000,
});

describe("terminal retention metrics", () => {
  it("reports buffer shape without retaining terminal identity or content", () => {
    const registry = new TerminalRetentionRegistry();
    const first = registry.track(sample(false, 5_024));
    const second = registry.track(sample(true, 24, 24, 120));
    first.parsedWrite();
    first.parsedWrite();

    expect(registry.snapshot()).toEqual({
      instances: 2,
      instancesHighWater: 2,
      visibleInstances: 1,
      hiddenInstances: 1,
      hiddenInstancesHighWater: 1,
      normalRows: 5_048,
      alternateRows: 24,
      viewportRows: 48,
      retainedScrollbackRows: 5_000,
      retainedScrollbackRowsHighWater: 5_000,
      configuredScrollbackRows: 10_000,
      estimatedBufferCells: 5_024 * 80 + 48 * 120,
      estimatedBufferCellsHighWater: 5_024 * 80 + 48 * 120,
      parsedWriteBatches: 2,
      compactionAttempts: 0,
      compactionSuccesses: 0,
      compactionRejectedTooLarge: 0,
      compactionRejectedGlobalBudget: 0,
      compactionFailures: 0,
      compactionRestores: 0,
      compactedPayloadBytes: 0,
      compactedPayloadBudgetBytes: 64 * 1024 * 1024,
      compactedPayloadBytesHighWater: 0,
    });
    expect(JSON.stringify(registry.snapshot())).not.toContain("terminal output");

    first.dispose();
    second.dispose();
    expect(registry.snapshot()).toMatchObject({
      instances: 0,
      visibleInstances: 0,
      hiddenInstances: 0,
      normalRows: 0,
      alternateRows: 0,
      viewportRows: 0,
      retainedScrollbackRows: 0,
      estimatedBufferCells: 0,
      instancesHighWater: 2,
      parsedWriteBatches: 2,
    });
  });

  it("moves one tracker between hidden and visible without double counting", () => {
    const registry = new TerminalRetentionRegistry();
    const tracker = registry.track(sample(false, 4_000));
    tracker.update(sample(true, 5_024));

    expect(registry.snapshot()).toMatchObject({
      instances: 1,
      visibleInstances: 1,
      hiddenInstances: 0,
      normalRows: 5_024,
      viewportRows: 24,
      retainedScrollbackRows: 5_000,
      estimatedBufferCells: 5_024 * 80,
      hiddenInstancesHighWater: 1,
    });

    tracker.dispose();
    tracker.dispose();
    tracker.update(sample(false, 1));
    tracker.parsedWrite();
    expect(registry.snapshot()).toMatchObject({
      instances: 0,
      hiddenInstances: 0,
      normalRows: 0,
      parsedWriteBatches: 0,
    });
  });

  it("sanitizes invalid public measurements instead of poisoning aggregates", () => {
    const registry = new TerminalRetentionRegistry();
    registry.track({
      visible: false,
      normalRows: Number.NaN,
      alternateRows: -10,
      cols: Number.POSITIVE_INFINITY,
      viewportRows: 24,
      configuredScrollbackRows: 5_000.9,
    });
    expect(registry.snapshot()).toMatchObject({
      normalRows: 0,
      alternateRows: 0,
      configuredScrollbackRows: 5_000,
      estimatedBufferCells: 0,
    });
  });

  it("accounts bounded compacted payloads and releases them on restore", () => {
    const registry = new TerminalRetentionRegistry();
    const tracker = registry.track(sample(false, 5_024));
    tracker.compactionAttempted();
    expect(tracker.reserveCompaction(400_000)).toBe(true);
    tracker.compacted();
    expect(registry.snapshot()).toMatchObject({
      compactionAttempts: 1,
      compactionSuccesses: 1,
      compactedPayloadBytes: 400_000,
      compactedPayloadBytesHighWater: 400_000,
    });
    tracker.restored(400_000);
    tracker.releaseCompaction(400_000);
    tracker.compactionAttempted();
    tracker.compactionRejected();
    tracker.compactionAttempted();
    tracker.compactionFailed();
    expect(registry.snapshot()).toMatchObject({
      compactionAttempts: 3,
      compactionRestores: 1,
      compactionRejectedTooLarge: 1,
      compactionFailures: 1,
      compactedPayloadBytes: 0,
      compactedPayloadBytesHighWater: 400_000,
    });
  });

  it("globally bounds compacted strings and reopens admission after release", () => {
    const registry = new TerminalRetentionRegistry(10);
    const first = registry.track(sample(false, 24));
    const second = registry.track(sample(false, 24));
    const third = registry.track(sample(false, 24));
    expect(first.reserveCompaction(6)).toBe(true);
    expect(second.reserveCompaction(5)).toBe(false);
    second.compactionBudgetRejected();
    expect(third.reserveCompaction(4)).toBe(true);
    expect(registry.snapshot()).toMatchObject({
      compactedPayloadBudgetBytes: 10,
      compactedPayloadBytes: 10,
      compactedPayloadBytesHighWater: 10,
      compactionRejectedGlobalBudget: 1,
    });

    first.releaseCompaction(6);
    expect(second.reserveCompaction(5)).toBe(true);
    second.dispose();
    third.dispose();
    expect(registry.snapshot().compactedPayloadBytes).toBe(0);
  });
});

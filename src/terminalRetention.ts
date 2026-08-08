/**
 * Content-free accounting for xterm objects retained by the renderer.
 *
 * This deliberately measures buffer shape rather than claiming JavaScript
 * heap bytes: xterm cells have variable-width strings, attributes, links and
 * engine overhead that public APIs cannot size accurately. The aggregate is
 * constant-size and retains no terminal ids, text, URLs or per-write history.
 */
export interface TerminalRetentionSample {
  visible: boolean;
  normalRows: number;
  alternateRows: number;
  cols: number;
  viewportRows: number;
  configuredScrollbackRows: number;
}

export interface TerminalRetentionSnapshot {
  instances: number;
  instancesHighWater: number;
  visibleInstances: number;
  hiddenInstances: number;
  hiddenInstancesHighWater: number;
  normalRows: number;
  alternateRows: number;
  viewportRows: number;
  retainedScrollbackRows: number;
  retainedScrollbackRowsHighWater: number;
  configuredScrollbackRows: number;
  estimatedBufferCells: number;
  estimatedBufferCellsHighWater: number;
  parsedWriteBatches: number;
  compactionAttempts: number;
  compactionSuccesses: number;
  compactionRejectedTooLarge: number;
  compactionRejectedGlobalBudget: number;
  compactionFailures: number;
  compactionRestores: number;
  compactedPayloadBytes: number;
  compactedPayloadBudgetBytes: number;
  compactedPayloadBytesHighWater: number;
}

const count = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

const normalized = (sample: TerminalRetentionSample): TerminalRetentionSample => ({
  visible: sample.visible,
  normalRows: count(sample.normalRows),
  alternateRows: count(sample.alternateRows),
  cols: count(sample.cols),
  viewportRows: count(sample.viewportRows),
  configuredScrollbackRows: count(sample.configuredScrollbackRows),
});

const cells = (sample: TerminalRetentionSample) =>
  (sample.normalRows + sample.alternateRows) * sample.cols;

const empty = (): TerminalRetentionSnapshot => ({
  instances: 0,
  instancesHighWater: 0,
  visibleInstances: 0,
  hiddenInstances: 0,
  hiddenInstancesHighWater: 0,
  normalRows: 0,
  alternateRows: 0,
  viewportRows: 0,
  retainedScrollbackRows: 0,
  retainedScrollbackRowsHighWater: 0,
  configuredScrollbackRows: 0,
  estimatedBufferCells: 0,
  estimatedBufferCellsHighWater: 0,
  parsedWriteBatches: 0,
  compactionAttempts: 0,
  compactionSuccesses: 0,
  compactionRejectedTooLarge: 0,
  compactionRejectedGlobalBudget: 0,
  compactionFailures: 0,
  compactionRestores: 0,
  compactedPayloadBytes: 0,
  compactedPayloadBudgetBytes: 0,
  compactedPayloadBytesHighWater: 0,
});

export interface TerminalRetentionTracker {
  update: (sample: TerminalRetentionSample) => void;
  parsedWrite: () => void;
  compactionAttempted: () => void;
  compactionFailed: () => void;
  reserveCompaction: (bytes: number) => boolean;
  releaseCompaction: (bytes: number) => void;
  compacted: () => void;
  compactionRejected: () => void;
  compactionBudgetRejected: () => void;
  restored: (bytes: number) => void;
  dispose: () => void;
}

export class TerminalRetentionRegistry {
  private state = empty();

  constructor(compactedPayloadBudgetBytes = 64 * 1024 * 1024) {
    this.state.compactedPayloadBudgetBytes = count(compactedPayloadBudgetBytes);
  }

  track(initial: TerminalRetentionSample): TerminalRetentionTracker {
    let current = normalized(initial);
    let disposed = false;
    let compactedBytes = 0;
    this.add(current);
    this.state.instances += 1;
    this.state.instancesHighWater = Math.max(
      this.state.instancesHighWater,
      this.state.instances,
    );

    return {
      update: (next) => {
        if (disposed) return;
        this.remove(current);
        current = normalized(next);
        this.add(current);
      },
      parsedWrite: () => {
        if (!disposed) this.state.parsedWriteBatches += 1;
      },
      compactionAttempted: () => {
        if (!disposed) this.state.compactionAttempts += 1;
      },
      compactionFailed: () => {
        if (!disposed) this.state.compactionFailures += 1;
      },
      reserveCompaction: (bytes) => {
        if (disposed || compactedBytes > 0) return false;
        const bounded = count(bytes);
        if (
          bounded > this.state.compactedPayloadBudgetBytes ||
          this.state.compactedPayloadBytes + bounded >
            this.state.compactedPayloadBudgetBytes
        ) {
          return false;
        }
        compactedBytes = bounded;
        this.state.compactedPayloadBytes += bounded;
        this.state.compactedPayloadBytesHighWater = Math.max(
          this.state.compactedPayloadBytesHighWater,
          this.state.compactedPayloadBytes,
        );
        return true;
      },
      releaseCompaction: (bytes) => {
        if (disposed) return;
        const released = Math.min(compactedBytes, count(bytes));
        compactedBytes -= released;
        this.state.compactedPayloadBytes = Math.max(
          0,
          this.state.compactedPayloadBytes - released,
        );
      },
      compacted: () => {
        if (!disposed) this.state.compactionSuccesses += 1;
      },
      compactionRejected: () => {
        if (!disposed) this.state.compactionRejectedTooLarge += 1;
      },
      compactionBudgetRejected: () => {
        if (!disposed) this.state.compactionRejectedGlobalBudget += 1;
      },
      restored: (_bytes) => {
        if (disposed) return;
        this.state.compactionRestores += 1;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.remove(current);
        this.state.instances = Math.max(0, this.state.instances - 1);
        this.state.compactedPayloadBytes = Math.max(
          0,
          this.state.compactedPayloadBytes - compactedBytes,
        );
        compactedBytes = 0;
      },
    };
  }

  snapshot(): TerminalRetentionSnapshot {
    return { ...this.state };
  }

  private add(sample: TerminalRetentionSample): void {
    if (sample.visible) this.state.visibleInstances += 1;
    else this.state.hiddenInstances += 1;
    this.state.hiddenInstancesHighWater = Math.max(
      this.state.hiddenInstancesHighWater,
      this.state.hiddenInstances,
    );
    this.state.normalRows += sample.normalRows;
    this.state.alternateRows += sample.alternateRows;
    this.state.viewportRows += sample.viewportRows;
    this.state.retainedScrollbackRows += Math.max(
      0,
      sample.normalRows - sample.viewportRows,
    );
    this.state.retainedScrollbackRowsHighWater = Math.max(
      this.state.retainedScrollbackRowsHighWater,
      this.state.retainedScrollbackRows,
    );
    this.state.configuredScrollbackRows += sample.configuredScrollbackRows;
    this.state.estimatedBufferCells += cells(sample);
    this.state.estimatedBufferCellsHighWater = Math.max(
      this.state.estimatedBufferCellsHighWater,
      this.state.estimatedBufferCells,
    );
  }

  private remove(sample: TerminalRetentionSample): void {
    if (sample.visible) {
      this.state.visibleInstances = Math.max(0, this.state.visibleInstances - 1);
    } else {
      this.state.hiddenInstances = Math.max(0, this.state.hiddenInstances - 1);
    }
    this.state.normalRows = Math.max(0, this.state.normalRows - sample.normalRows);
    this.state.alternateRows = Math.max(
      0,
      this.state.alternateRows - sample.alternateRows,
    );
    this.state.viewportRows = Math.max(
      0,
      this.state.viewportRows - sample.viewportRows,
    );
    this.state.retainedScrollbackRows = Math.max(
      0,
      this.state.retainedScrollbackRows -
        Math.max(0, sample.normalRows - sample.viewportRows),
    );
    this.state.configuredScrollbackRows = Math.max(
      0,
      this.state.configuredScrollbackRows - sample.configuredScrollbackRows,
    );
    this.state.estimatedBufferCells = Math.max(
      0,
      this.state.estimatedBufferCells - cells(sample),
    );
  }
}

/** Process-lifetime renderer aggregate, readable by diagnostics and soak tests. */
export const terminalRetentionRegistry = new TerminalRetentionRegistry();

export const terminalRetentionMetrics = (): TerminalRetentionSnapshot =>
  terminalRetentionRegistry.snapshot();

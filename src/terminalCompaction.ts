/** Hidden terminals keep their PTY alive but may compact xterm's cell graph. */
export const TERMINAL_COMPACT_IDLE_MS = 60_000;
/** UTF-8 bytes retained per compacted terminal; larger states stay live. */
export const TERMINAL_COMPACT_MAX_BYTES = 4 * 1024 * 1024;

export interface TerminalCompactionSurface {
  /** Queue a barrier behind every xterm write already accepted. */
  drain: (done: () => void) => void;
  /** Serialize normal/alternate buffers, cursor, attributes and terminal modes. */
  serialize: () => string;
  /** Release the heavyweight cell graph only after serialization succeeds. */
  clearCells: () => void;
  /** Reparse the serialized VT state into xterm. */
  restore: (snapshot: string, done: () => void) => void;
}

export interface TerminalCompactionMetricsSink {
  attempted: () => void;
  reserve: (bytes: number) => boolean;
  release: (bytes: number) => void;
  compacted: () => void;
  rejectedTooLarge: (observedBytes: number) => void;
  rejectedGlobalBudget: () => void;
  failed: () => void;
  restored: (bytes: number) => void;
}

export interface TerminalCompactionOptions {
  idleMs?: number;
  maxSerializedBytes?: number;
  metrics?: TerminalCompactionMetricsSink;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** Count UTF-8 without allocating a second multi-megabyte byte array. */
export function utf8BytesThroughLimit(
  value: string,
  limit: number,
): { bytes: number; exceeded: boolean } {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
    if (bytes > limit) return { bytes, exceeded: true };
  }
  return { bytes, exceeded: false };
}

const noopMetrics: TerminalCompactionMetricsSink = {
  attempted: () => {},
  reserve: () => true,
  release: () => {},
  compacted: () => {},
  rejectedTooLarge: () => {},
  rejectedGlobalBudget: () => {},
  failed: () => {},
  restored: () => {},
};

/**
 * Race-safe state machine around xterm's asynchronous parser queue.
 *
 * A hide schedules one compaction. The timer first queues an empty write as a
 * parser barrier; a show invalidates both the timer and that callback. Restore
 * writes are queued before the caller is allowed to attach native replay.
 */
export class TerminalCompactionController {
  private readonly surface: TerminalCompactionSurface;
  private readonly idleMs: number;
  private readonly maxBytes: number;
  private readonly metrics: TerminalCompactionMetricsSink;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private timer: unknown = null;
  private epoch = 0;
  private hidden = false;
  private disposed = false;
  private snapshot: { vt: string; bytes: number } | null = null;
  private restoring: Promise<void> | null = null;
  private finishRestore: (() => void) | null = null;
  private reservedBytes = 0;

  constructor(
    surface: TerminalCompactionSurface,
    options: TerminalCompactionOptions = {},
  ) {
    this.surface = surface;
    this.idleMs = options.idleMs ?? TERMINAL_COMPACT_IDLE_MS;
    this.maxBytes = options.maxSerializedBytes ?? TERMINAL_COMPACT_MAX_BYTES;
    this.metrics = options.metrics ?? noopMetrics;
    this.setTimer =
      options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer =
      options.clearTimer ?? ((timer) => clearTimeout(timer as number));
  }

  hide(): void {
    if (this.disposed) return;
    this.hidden = true;
    const epoch = ++this.epoch;
    this.cancelTimer();
    this.scheduleCompaction(epoch, this.idleMs);
  }

  /** Pressure relief may advance the hidden-idle timer, but never touches a
   * visible/restoring/already-compacted terminal. */
  compactNow(): boolean {
    if (
      this.disposed ||
      !this.hidden ||
      this.snapshot != null ||
      this.restoring != null
    ) {
      return false;
    }
    const epoch = ++this.epoch;
    this.cancelTimer();
    this.scheduleCompaction(epoch, 0);
    return true;
  }

  /** Resolve only after VT restoration, before native output may reattach. */
  show(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.hidden = false;
    this.epoch += 1;
    this.cancelTimer();
    if (this.restoring) return this.restoring;
    const saved = this.snapshot;
    if (!saved) return Promise.resolve();
    this.snapshot = null;
    // makeRestoreCompletion runs in a separate lexical scope that never sees
    // the VT string. xterm's parser queue necessarily owns `saved.vt` while
    // parsing, but our callback retains only the byte count.
    const completion = this.makeRestoreCompletion(saved.bytes);
    try {
      this.surface.restore(saved.vt, completion.restored);
    } catch {
      if (!this.disposed) this.metrics.failed();
      completion.cancelled();
    }
    return completion.promise;
  }

  private makeRestoreCompletion(bytes: number): {
    promise: Promise<void>;
    restored: () => void;
    cancelled: () => void;
  } {
    let resolveRestore = () => {};
    const restoring = new Promise<void>((resolve) => {
      resolveRestore = resolve;
    });
    this.restoring = restoring;
    let finished = false;
    const finish = (restored: boolean) => {
      if (finished) return;
      finished = true;
      this.finishRestore = null;
      if (restored && !this.disposed) this.metrics.restored(bytes);
      this.releaseReservation();
      this.restoring = null;
      resolveRestore();
    };
    const restored = () => finish(true);
    const cancelled = () => finish(false);
    this.finishRestore = cancelled;
    return { promise: restoring, restored, cancelled };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.cancelTimer();
    this.snapshot = null;
    this.finishRestore?.();
    this.releaseReservation();
  }

  private currentHidden(epoch: number): boolean {
    return !this.disposed && this.hidden && this.epoch === epoch;
  }

  private scheduleCompaction(epoch: number, delayMs: number): void {
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.currentHidden(epoch) || this.snapshot) return;
      this.surface.drain(() => this.compactAfterDrain(epoch));
    }, delayMs);
  }

  private compactAfterDrain(epoch: number): void {
    if (!this.currentHidden(epoch) || this.snapshot) return;
    this.metrics.attempted();
    let vt: string;
    try {
      vt = this.surface.serialize();
    } catch {
      this.metrics.failed();
      return;
    }
    const measured = utf8BytesThroughLimit(vt, this.maxBytes);
    if (measured.exceeded) {
      this.metrics.rejectedTooLarge(measured.bytes);
      return;
    }
    if (!this.metrics.reserve(measured.bytes)) {
      this.metrics.rejectedGlobalBudget();
      return;
    }
    this.reservedBytes = measured.bytes;
    this.snapshot = { vt, bytes: measured.bytes };
    try {
      this.surface.clearCells();
    } catch {
      this.snapshot = null;
      this.releaseReservation();
      this.metrics.failed();
      return;
    }
    this.metrics.compacted();
  }

  private cancelTimer(): void {
    if (this.timer == null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private releaseReservation(): void {
    if (this.reservedBytes <= 0) return;
    this.metrics.release(this.reservedBytes);
    this.reservedBytes = 0;
  }
}

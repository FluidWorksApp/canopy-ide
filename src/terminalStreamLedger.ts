/**
 * Small, framework-free state machine for a terminal's native output stream.
 *
 * xterm parses writes asynchronously. The replay cursor therefore advances when
 * xterm accepts a write into its ordered queue, not when that write's callback
 * eventually runs: hiding and immediately showing the pane in between must not
 * request the already-queued bytes a second time. Pending acknowledgements are
 * keyed by stream epoch so a late callback can never release a replacement
 * attachment's native backpressure.
 */
export class TerminalStreamLedger {
  private cursor: number | null = null;
  private readonly pendingAcks = new Map<number, number>();

  /** Native offset to resume after, or null for a brand-new xterm. */
  replayAfter(): number | null {
    return this.cursor;
  }

  /** Record bytes accepted by xterm, refusing a callback from a stale stream. */
  accept(epoch: number, currentEpoch: number, end: number): boolean {
    if (epoch !== currentEpoch) return false;
    this.cursor = Math.max(this.cursor ?? 0, end);
    return true;
  }

  /** xterm consumed bytes before the native attachment generation was known. */
  addPendingAck(epoch: number, bytes: number): void {
    this.pendingAcks.set(epoch, (this.pendingAcks.get(epoch) ?? 0) + bytes);
  }

  /** Adopt exactly this epoch's early acknowledgements. */
  takePendingAck(epoch: number): number {
    const bytes = this.pendingAcks.get(epoch) ?? 0;
    this.pendingAcks.delete(epoch);
    return bytes;
  }

  /** A cancelled attachment's acknowledgements belong to nobody else. */
  discard(epoch: number): void {
    this.pendingAcks.delete(epoch);
  }
}

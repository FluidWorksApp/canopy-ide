import { describe, expect, it } from "vitest";
import { TerminalStreamLedger } from "./terminalStreamLedger";

class DelayedXterm {
  painted = "";
  private queued: Array<() => void> = [];

  write(text: string, done: () => void): void {
    this.queued.push(() => {
      this.painted += text;
      done();
    });
  }

  flush(): void {
    for (const write of this.queued.splice(0)) write();
  }
}

describe("terminal stream replay ledger", () => {
  it("does not replay an xterm write when hide/show beats its completion callback", () => {
    const native = "beforeafter";
    const ledger = new TerminalStreamLedger();
    const xterm = new DelayedXterm();
    let epoch = 1;
    let earlyAck = 0;
    const firstEpoch = epoch;

    const first = { start: 0, end: 6, text: native.slice(0, 6) };
    expect(ledger.accept(epoch, epoch, first.end)).toBe(true);
    xterm.write(first.text, () => {
      // The pane was detached before this delayed parser callback. Its native
      // attachment is gone, so these bytes must not acknowledge a later one.
      if (firstEpoch === epoch) earlyAck += first.text.length;
    });

    // Hide, then immediately show while "before" is still queued in xterm.
    epoch += 1;
    ledger.discard(1);
    const replayAfter = ledger.replayAfter();
    expect(replayAfter).toBe(6);

    const replay = native.slice(replayAfter ?? 0);
    expect(ledger.accept(epoch, epoch, native.length)).toBe(true);
    xterm.write(replay, () => ledger.addPendingAck(epoch, replay.length));
    xterm.flush();

    expect(xterm.painted).toBe(native);
    expect(earlyAck).toBe(0);
    expect(ledger.takePendingAck(epoch)).toBe(replay.length);
    expect(ledger.takePendingAck(1)).toBe(0);
  });

  it("ignores delivery from a detached epoch", () => {
    const ledger = new TerminalStreamLedger();
    expect(ledger.accept(4, 5, 99)).toBe(false);
    expect(ledger.replayAfter()).toBeNull();
  });

  it("forgets early acknowledgements when an unresolved attach is hidden", () => {
    const ledger = new TerminalStreamLedger();
    ledger.addPendingAck(7, 4_096);
    ledger.discard(7);
    expect(ledger.takePendingAck(7)).toBe(0);
  });
});

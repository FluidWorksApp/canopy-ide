import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PACE, nextDelay, startSpotIndexJob } from "./spotIndexJob";
import { mockCommands } from "./test/setup";

describe("nextDelay", () => {
  it("presses on while there is a backlog and settles once there isn't", () => {
    expect(nextDelay({ ok: true, pending: 5_000_000 }, 0)).toBe(
      DEFAULT_PACE.catchUpMs,
    );
    expect(nextDelay({ ok: true, pending: 0 }, 0)).toBe(DEFAULT_PACE.idleMs);
    // Caught up is not done: this cadence is what prunes deleted transcripts,
    // a switched-off agent and anything past the retention window.
    expect(DEFAULT_PACE.idleMs).toBeGreaterThan(DEFAULT_PACE.catchUpMs);
  });

  it("backs off per consecutive failure, up to a ceiling", () => {
    const fail = { ok: false, pending: 0 };
    expect(nextDelay(fail, 1)).toBe(DEFAULT_PACE.backoffMs);
    expect(nextDelay(fail, 2)).toBe(DEFAULT_PACE.backoffMs * 2);
    expect(nextDelay(fail, 9)).toBe(DEFAULT_PACE.maxBackoffMs);
  });
});

describe("startSpotIndexJob", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const pace = {
    catchUpMs: 100,
    idleMs: 1000,
    backoffMs: 500,
    maxBackoffMs: 2000,
  };

  it("keeps reading while bytes are pending, then drops to the heartbeat", async () => {
    const calls: unknown[] = [];
    // A backlog on the first pass, nothing left from the second on.
    const pendingFor = [8_000_000, 0, 0, 0];
    mockCommands({
      spot_ingest: (args: unknown) => {
        calls.push(args);
        return {
          more: false,
          pending: pendingFor[calls.length - 1] ?? 0,
          messages: 1,
          terminals: 0,
          research: 0,
          pruned: 0,
        };
      },
    });
    const stop = startSpotIndexJob(() => ["/repo"], pace, 10);

    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(1);
    // Still pending after the first pass: the next one is a catch-up away.
    await vi.advanceTimersByTimeAsync(pace.catchUpMs);
    expect(calls).toHaveLength(2);
    // Nothing left now, so the heartbeat pace applies — no pass at catch-up
    // speed, one once the heartbeat is due.
    await vi.advanceTimersByTimeAsync(pace.catchUpMs);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(pace.idleMs);
    expect(calls).toHaveLength(3);
    stop();
  });

  it("stops for good when stopped, including mid-pass", async () => {
    let calls = 0;
    mockCommands({
      spot_ingest: () => {
        calls += 1;
        return {
          more: false,
          pending: 100,
          messages: 0,
          terminals: 0,
          research: 0,
          pruned: 0,
        };
      },
    });
    const stop = startSpotIndexJob(() => [], pace, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);
    stop();
    await vi.advanceTimersByTimeAsync(pace.idleMs * 5);
    expect(calls).toBe(1);
  });

  it("reads the roots at every pass, not the ones it started with", async () => {
    const seen: string[][] = [];
    mockCommands({
      spot_ingest: (args: unknown) => {
        seen.push((args as { roots: string[] }).roots);
        return {
          more: false,
          pending: 1,
          messages: 0,
          terminals: 0,
          research: 0,
          pruned: 0,
        };
      },
    });
    let roots = ["/a"];
    const stop = startSpotIndexJob(() => roots, pace, 10);
    await vi.advanceTimersByTimeAsync(10);
    roots = ["/a", "/b"];
    await vi.advanceTimersByTimeAsync(pace.catchUpMs);
    stop();
    expect(seen).toEqual([["/a"], ["/a", "/b"]]);
  });
});

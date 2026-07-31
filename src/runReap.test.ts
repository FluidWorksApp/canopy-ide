import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHORE_REAP_MS,
  reapsOnExit,
  scheduleReap,
  stillReapable,
  type ReapableRun,
} from "./runReap";

const chore = (over: Partial<ReapableRun> = {}): ReapableRun => ({
  run: true,
  chore: true,
  ...over,
});

describe("finished runs that close themselves", () => {
  it("takes away a chore that worked", () => {
    expect(reapsOnExit(chore(), 0)).toBe(true);
  });

  it("keeps a chore that failed — the scrollback is why you'd look", () => {
    expect(reapsOnExit(chore(), 1)).toBe(false);
    expect(reapsOnExit(chore(), 127)).toBe(false);
    // Killed, or an ending the pty couldn't report: not a success.
    expect(reapsOnExit(chore(), null)).toBe(false);
  });

  it("keeps every run that isn't a chore", () => {
    // A dev server, a build, an agent's canopy_start_server: exiting cleanly is
    // not the same as having nothing left to say.
    expect(reapsOnExit({ run: true }, 0)).toBe(false);
    expect(reapsOnExit({}, 0)).toBe(false);
  });

  it("leaves the ✓ up long enough to be seen", () => {
    // Zero would read as a run that vanished rather than one that finished.
    expect(CHORE_REAP_MS).toBeGreaterThan(1000);
    expect(CHORE_REAP_MS).toBeLessThan(10_000);
  });
});

describe("the second look, when the timer fires", () => {
  it("closes a chore still sitting on its success", () => {
    expect(stillReapable(chore({ exited: true, exitCode: 0 }))).toBe(true);
  });

  it("spares one that was run again inside the grace window", () => {
    // Restart clears exited/exitCode and puts a live process on the same tab.
    expect(stillReapable(chore({ exited: false, exitCode: undefined }))).toBe(
      false,
    );
  });

  it("spares a chore whose re-run failed", () => {
    expect(stillReapable(chore({ exited: true, exitCode: 1 }))).toBe(false);
  });

  it("does nothing for a tab that has already gone", () => {
    expect(stillReapable(undefined)).toBe(false);
  });
});

describe("arming the self-close", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** The view's side of the wiring: a tab it can look up, and a close it counts. */
  const harness = (tab: ReapableRun) => {
    const state: { tab: ReapableRun | undefined } = { tab };
    const closed: string[] = [];
    const timers = new Map<string, number>();
    return {
      state,
      closed,
      timers,
      arm: (code: number | null) =>
        scheduleReap(
          "t1",
          code,
          state.tab as ReapableRun,
          timers,
          () => state.tab,
          (id) => closed.push(id),
        ),
    };
  };

  it("closes the chip once the grace window is up", () => {
    const h = harness(chore({ exited: true, exitCode: 0 }));
    h.arm(0);
    vi.advanceTimersByTime(CHORE_REAP_MS - 1);
    expect(h.closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.closed).toEqual(["t1"]);
    expect(h.timers.size).toBe(0);
  });

  it("leaves a run that was started again inside the window", () => {
    const h = harness(chore({ exited: true, exitCode: 0 }));
    h.arm(0);
    // "Run again" — the tab is live once more on the same id.
    h.state.tab = chore({ exited: false, exitCode: undefined });
    vi.advanceTimersByTime(CHORE_REAP_MS * 2);
    expect(h.closed).toEqual([]);
  });

  it("keeps one timer per tab across a re-run", () => {
    const h = harness(chore({ exited: true, exitCode: 0 }));
    h.arm(0);
    h.arm(0);
    expect(h.timers.size).toBe(1);
    vi.advanceTimersByTime(CHORE_REAP_MS);
    expect(h.closed).toEqual(["t1"]);
  });

  it("arms nothing for a failure, or for a run that isn't a chore", () => {
    const failed = harness(chore({ exited: true, exitCode: 1 }));
    failed.arm(1);
    const server = harness({ run: true, exited: true, exitCode: 0 });
    server.arm(0);
    vi.advanceTimersByTime(CHORE_REAP_MS * 2);
    expect(failed.closed).toEqual([]);
    expect(server.closed).toEqual([]);
    expect(failed.timers.size + server.timers.size).toBe(0);
  });
});

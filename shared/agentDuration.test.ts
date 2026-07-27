import { describe, expect, it } from "vitest";
import {
  MAX_OPEN_GAP_SECS,
  formatDuration,
  formatDurationWords,
  hasWorkingTime,
  workingTime,
} from "./agentDuration";

const NOW = 1_800_000_000;

describe("workingTime", () => {
  it("reads the credited numbers straight off a settled session", () => {
    expect(
      workingTime({ active_secs: 3_600, run_secs: 300, updated: NOW - 50 }, NOW, false),
    ).toEqual({ run: 300, total: 3_600 });
  });

  it("adds the open stretch to both numbers while the agent is working", () => {
    expect(
      workingTime({ active_secs: 3_600, run_secs: 300, updated: NOW - 20 }, NOW, true),
    ).toEqual({ run: 320, total: 3_620 });
  });

  // The whole point of freezing: a session that stopped without a Stop event
  // keeps `state: "working"` on disk forever. Counting from that would show a
  // dead agent racking up days of "work".
  it("does not count past the last event once the caller says it is not live", () => {
    expect(
      workingTime({ active_secs: 600, run_secs: 600, updated: NOW - 86_400 }, NOW, false),
    ).toEqual({ run: 600, total: 600 });
  });

  it("caps how far a live row extrapolates past its last event", () => {
    const t = workingTime({ active_secs: 60, run_secs: 60, updated: NOW - 86_400 }, NOW, true);
    expect(t).toEqual({ run: 60 + MAX_OPEN_GAP_SECS, total: 60 + MAX_OPEN_GAP_SECS });
  });

  it("is zero for a session that never worked", () => {
    expect(workingTime(undefined, NOW, true)).toEqual({ run: 0, total: 0 });
    expect(workingTime({ updated: NOW - 10 }, NOW, false)).toEqual({ run: 0, total: 0 });
  });

  // A digest whose `updated` is in the future (clock skew, or a machine that
  // moved timezone mid-session) must not subtract time.
  it("never goes backwards on a future timestamp", () => {
    expect(workingTime({ active_secs: 10, run_secs: 10, updated: NOW + 500 }, NOW, true)).toEqual({
      run: 10,
      total: 10,
    });
  });

  it("ignores negative values a corrupt digest might carry", () => {
    expect(workingTime({ active_secs: -5, run_secs: -5 }, NOW, false)).toEqual({
      run: 0,
      total: 0,
    });
  });

  it("cannot extrapolate a digest with no last-event stamp", () => {
    expect(workingTime({ active_secs: 100, run_secs: 100 }, NOW, true)).toEqual({
      run: 100,
      total: 100,
    });
  });
});

describe("hasWorkingTime", () => {
  it("is false only when both numbers are zero", () => {
    expect(hasWorkingTime({ run: 0, total: 0 })).toBe(false);
    expect(hasWorkingTime({ run: 0, total: 12 })).toBe(true);
    expect(hasWorkingTime({ run: 3, total: 0 })).toBe(true);
  });
});

describe("formatDuration", () => {
  it("reads as a stopwatch", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(43)).toBe("0:43");
    expect(formatDuration(727)).toBe("12:07");
    expect(formatDuration(3_862)).toBe("1:04:22");
  });

  it("runs hours past a day rather than rolling into days", () => {
    expect(formatDuration(98_042)).toBe("27:14:02");
  });

  it("floors fractions and clamps below zero", () => {
    expect(formatDuration(59.9)).toBe("0:59");
    expect(formatDuration(-10)).toBe("0:00");
  });
});

describe("formatDurationWords", () => {
  it("spells the duration out for a tooltip", () => {
    expect(formatDurationWords(1)).toBe("1 second");
    expect(formatDurationWords(43)).toBe("43 seconds");
    expect(formatDurationWords(727)).toBe("12 minutes");
    expect(formatDurationWords(3_600)).toBe("1 hour");
    expect(formatDurationWords(3_862)).toBe("1 hour 4 minutes");
    expect(formatDurationWords(98_042)).toBe("27 hours 14 minutes");
  });
});

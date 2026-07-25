import { describe, expect, it } from "vitest";
import {
  effectiveState,
  silenceLabel,
  QUIET_CPU_PERCENT,
  STALE_AFTER_SECS,
} from "./agentState";

const NOW = 1_800_000_000;
const agoSecs = (s: number) => NOW - s;

describe("effectiveState", () => {
  it("passes through every state the hook stream can end on its own", () => {
    for (const state of ["waiting", "idle", "ended"]) {
      expect(
        effectiveState({ state, updated: agoSecs(86_400), cpu: 0, now: NOW }),
        `${state} is ended by an event, so age says nothing about it`,
      ).toBe(state);
    }
  });

  it("believes a working session that is still emitting events", () => {
    expect(effectiveState({ state: "working", updated: agoSecs(5), cpu: 0, now: NOW })).toBe(
      "working",
    );
  });

  // The reported bug: codex hit its usage limit, printed the error, returned to
  // its prompt and fired no Stop. Its digest sat at "working", 14 minutes old,
  // with the process at 0% CPU — and the panel pulsed green the whole time.
  it("stops believing a working session that has gone quiet in both senses", () => {
    expect(effectiveState({ state: "working", updated: agoSecs(840), cpu: 0, now: NOW })).toBe(
      "stale",
    );
  });

  it("keeps believing a long tool call that is burning CPU", () => {
    expect(
      effectiveState({ state: "working", updated: agoSecs(3_600), cpu: 90, now: NOW }),
      "an hour into a build is still working",
    ).toBe("working");
  });

  it("keeps believing a quiet session that simply hasn't been quiet for long", () => {
    expect(
      effectiveState({
        state: "working",
        updated: agoSecs(STALE_AFTER_SECS - 1),
        cpu: 0,
        now: NOW,
      }),
      "a pause while the model responds is not a stopped session",
    ).toBe("working");
  });

  it("treats the thresholds as exclusive on the side that keeps believing", () => {
    expect(
      effectiveState({ state: "working", updated: agoSecs(STALE_AFTER_SECS), cpu: 0, now: NOW }),
    ).toBe("stale");
    expect(
      effectiveState({
        state: "working",
        updated: agoSecs(STALE_AFTER_SECS),
        cpu: QUIET_CPU_PERCENT,
        now: NOW,
      }),
      "at the CPU threshold there is still something running",
    ).toBe("working");
  });

  it("leaves a digest with no timestamp alone rather than ageing it from nothing", () => {
    expect(effectiveState({ state: "working", cpu: 0, now: NOW })).toBe("working");
  });

  it("has nothing to say about a session with no recorded state", () => {
    expect(effectiveState({ updated: agoSecs(99_999), cpu: 0, now: NOW })).toBeUndefined();
  });

  it("does not resurrect a state from a clock that ran backwards", () => {
    expect(
      effectiveState({ state: "working", updated: NOW + 600, cpu: 0, now: NOW }),
      "a future timestamp is not five minutes of silence",
    ).toBe("working");
  });
});

describe("silenceLabel", () => {
  it("scales the unit to the gap", () => {
    expect(silenceLabel(agoSecs(840), NOW)).toBe("14m");
    expect(silenceLabel(agoSecs(7_200), NOW)).toBe("2h");
    expect(silenceLabel(agoSecs(172_800), NOW)).toBe("2d");
  });

  it("says something rather than NaN when there is no timestamp", () => {
    expect(silenceLabel(undefined, NOW)).toBe("some time");
  });
});

import { describe, expect, it } from "vitest";
import {
  AGENT_WATCHDOG_LIMITS,
  judgeAgents,
  type AgentSample,
} from "./agentWatchdog";

const T0 = 1_700_000_000_000;

const sample = (over: Partial<AgentSample>): AgentSample => ({
  at: T0,
  ptyId: 7,
  sessionId: "s-1",
  state: "working",
  reason: null,
  stateSince: T0,
  blockedSince: null,
  seen: false,
  ...over,
});

describe("W1 — sustained quiet", () => {
  const quiet = (forMs: number) =>
    sample({
      state: "unknown",
      reason: "went-quiet",
      stateSince: T0,
      at: T0 + forMs,
    });

  it("stays silent under the threshold and fires past it", () => {
    expect(judgeAgents([quiet(AGENT_WATCHDOG_LIMITS.stallQuietMs - 1)])).toEqual([]);
    const [inc] = judgeAgents([quiet(AGENT_WATCHDOG_LIMITS.stallQuietMs)]);
    expect(inc.code).toBe("W1");
    expect(inc.since).toBe(T0);
  });

  it("keeps one key for one episode across ticks", () => {
    const a = judgeAgents([quiet(AGENT_WATCHDOG_LIMITS.stallQuietMs)]);
    const b = judgeAgents([quiet(AGENT_WATCHDOG_LIMITS.stallQuietMs + 60_000)]);
    expect(a[0].key).toBe(b[0].key);
  });

  it("a new episode gets a new key", () => {
    const first = judgeAgents([quiet(AGENT_WATCHDOG_LIMITS.stallQuietMs)])[0];
    const later = judgeAgents([
      sample({
        state: "unknown",
        reason: "went-quiet",
        stateSince: T0 + 600_000,
        at: T0 + 600_000 + AGENT_WATCHDOG_LIMITS.stallQuietMs,
      }),
    ])[0];
    expect(later.key).not.toBe(first.key);
  });

  it("structural unknowns never stall — an alarm that is always on is off", () => {
    for (const reason of ["cli-cannot-report", "never-reported", "store-only"]) {
      expect(
        judgeAgents([
          sample({
            state: "unknown",
            reason,
            stateSince: T0,
            at: T0 + AGENT_WATCHDOG_LIMITS.stallQuietMs * 10,
          }),
        ]),
      ).toEqual([]);
    }
  });

  it("a working session never stalls regardless of duration", () => {
    expect(
      judgeAgents([
        sample({ state: "working", at: T0 + AGENT_WATCHDOG_LIMITS.stallQuietMs * 10 }),
      ]),
    ).toEqual([]);
  });
});

describe("W2 — blocked and unseen", () => {
  const blocked = (forMs: number, seen: boolean) =>
    sample({ blockedSince: T0, seen, at: T0 + forMs });

  it("escalates an unseen block past the threshold", () => {
    expect(judgeAgents([blocked(AGENT_WATCHDOG_LIMITS.blockedUnseenMs - 1, false)])).toEqual([]);
    const [inc] = judgeAgents([blocked(AGENT_WATCHDOG_LIMITS.blockedUnseenMs, false)]);
    expect(inc.code).toBe("W2");
    expect(inc.since).toBe(T0);
  });

  it("a seen block is being handled at human speed", () => {
    expect(judgeAgents([blocked(AGENT_WATCHDOG_LIMITS.blockedUnseenMs * 10, true)])).toEqual([]);
  });

  it("W1 and W2 can hold at once — a quiet session can also be sitting on a prompt", () => {
    const both = judgeAgents([
      sample({
        state: "unknown",
        reason: "went-quiet",
        stateSince: T0,
        blockedSince: T0,
        seen: false,
        at: T0 + AGENT_WATCHDOG_LIMITS.stallQuietMs,
      }),
    ]);
    expect(both.map((i) => i.code).sort()).toEqual(["W1", "W2"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  INITIAL_VIBE_SERVER_HEALTH,
  VIBE_SERVER_CRASH_WINDOW_MS,
  VIBE_SERVER_LOG_TAIL_CHARS,
  judgeVibeServerExit,
  resetVibeServerHealth,
  vibeServerLogTail,
} from "./vibeServerHealth";

const TARGET = "/repo:component:dev:npm run dev";
const fail = (state = INITIAL_VIBE_SERVER_HEALTH, at = 1_000) =>
  judgeVibeServerExit(state, TARGET, {
    at,
    exitCode: 1,
    requested: false,
  });

describe("vibe server crash policy", () => {
  it("repairs from the first failure, then identifies a nearby third as a crash loop", () => {
    const first = fail();
    const second = fail(first.state, 2_000);
    const third = fail(second.state, 3_000);
    expect(first.action).toBe("repair");
    expect(second.action).toBe("repair");
    expect(third.action).toBe("crash-loop");
    expect(third.state.halted).toBe(true);
  });

  it("does not restart again after the loop has latched", () => {
    const first = fail();
    const second = fail(first.state, 2_000);
    const third = fail(second.state, 3_000);
    expect(fail(third.state, 4_000).action).toBe("ignore");
  });

  it("ages old failures out without a timer", () => {
    const first = fail();
    const later = fail(first.state, 1_000 + VIBE_SERVER_CRASH_WINDOW_MS);
    expect(later.action).toBe("repair");
    expect(later.state.failures).toEqual([1_000 + VIBE_SERVER_CRASH_WINDOW_MS]);
  });

  it("ignores and resets requested or successful exits", () => {
    const failed = fail().state;
    for (const sample of [
      { at: 2_000, exitCode: 1, requested: true },
      { at: 2_000, exitCode: 0, requested: false },
    ]) {
      expect(judgeVibeServerExit(failed, TARGET, sample)).toEqual({
        state: resetVibeServerHealth(TARGET),
        action: "ignore",
      });
    }
  });

  it("starts a new episode when target, checkout, or command fingerprint changes", () => {
    const failed = fail().state;
    const changed = judgeVibeServerExit(failed, `${TARGET}:changed`, {
      at: 2_000,
      exitCode: 1,
      requested: false,
    });
    expect(changed.action).toBe("repair");
    expect(changed.state.failures).toEqual([2_000]);
  });

  it("an explicit restart re-arms a halted episode", () => {
    expect(resetVibeServerHealth(TARGET)).toEqual({
      targetKey: TARGET,
      failures: [],
      halted: false,
    });
  });

  it("caps durable logs to their newest 8,000 characters", () => {
    const text = `old${"x".repeat(VIBE_SERVER_LOG_TAIL_CHARS)}new`;
    const tail = vibeServerLogTail(text);
    expect(tail).toHaveLength(VIBE_SERVER_LOG_TAIL_CHARS);
    expect(tail.endsWith("new")).toBe(true);
    expect(tail.startsWith("old")).toBe(false);
  });
});

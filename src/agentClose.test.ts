import { describe, expect, it } from "vitest";
import {
  pendingAgentTabIds,
  remainingCloseSeconds,
  type PendingAgentClose,
} from "./agentClose";

describe("agent close grace period", () => {
  it("derives a stable ceiling countdown from an absolute deadline", () => {
    expect(remainingCloseSeconds(10_000, 0)).toBe(10);
    expect(remainingCloseSeconds(10_000, 1)).toBe(10);
    expect(remainingCloseSeconds(10_000, 9_001)).toBe(1);
    expect(remainingCloseSeconds(10_000, 10_001)).toBe(0);
  });

  it("collects every hidden tab across independent close transactions", () => {
    const close = (id: string, tabIds: string[]): PendingAgentClose => ({
      id,
      tabIds,
      title: id,
      deadline: 10_000,
      restoreTabId: tabIds[0],
      groups: {},
    });
    const ids = pendingAgentTabIds(
      new Map([
        ["one", close("one", ["a"])],
        ["group", close("group", ["b", "c"])],
      ]),
    );

    expect([...ids]).toEqual(["a", "b", "c"]);
  });
});

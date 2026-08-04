// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  rememberTerminals,
  rememberedTerminalState,
  rememberedTerminals,
} from "./terminalMemory";

describe("terminal memory", () => {
  beforeEach(() => localStorage.clear());

  it("reads the legacy flat terminal array", () => {
    localStorage.setItem(
      "canopy.terminals",
      JSON.stringify({ p1: [{ cwd: "/repo", title: "shell" }] }),
    );
    expect(rememberedTerminals("p1")).toEqual([{ cwd: "/repo", title: "shell" }]);
    expect(rememberedTerminalState("p1").terminalGroups).toEqual({});
  });

  it("stores terminals with their multiplexed layout", () => {
    const group = {
      id: "g1",
      activeTabId: "b",
      root: {
        type: "split" as const,
        id: "s1",
        axis: "horizontal" as const,
        ratio: 0.5,
        first: { type: "leaf" as const, tabId: "a" },
        second: { type: "leaf" as const, tabId: "b" },
      },
    };
    rememberTerminals(
      "p1",
      [
        { cwd: "/repo", title: "Claude", tabId: "a", paneGroup: "g1" },
        { cwd: "/repo", title: "Codex", tabId: "b", paneGroup: "g1" },
      ],
      { g1: group },
    );
    expect(rememberedTerminalState("p1")).toEqual({
      terminals: [
        { cwd: "/repo", title: "Claude", tabId: "a", paneGroup: "g1" },
        { cwd: "/repo", title: "Codex", tabId: "b", paneGroup: "g1" },
      ],
      terminalGroups: { g1: group },
    });
  });
});

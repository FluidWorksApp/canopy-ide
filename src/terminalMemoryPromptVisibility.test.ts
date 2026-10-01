import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettings } from "./settings";
import {
  dismissTerminalMemoryPromptsForWindow,
  subscribeTerminalMemoryPromptVisibility,
  terminalMemoryPromptsVisible,
} from "./terminalMemoryPromptVisibility";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("terminal memory prompt visibility", () => {
  it("is on by default and can be disabled persistently in Settings", () => {
    expect(terminalMemoryPromptsVisible()).toBe(true);
    updateSettings({ terminalMemoryPromptsEnabled: false });
    expect(terminalMemoryPromptsVisible()).toBe(false);
  });

  it("stays dismissed for the rest of the current window", () => {
    dismissTerminalMemoryPromptsForWindow();
    expect(terminalMemoryPromptsVisible()).toBe(false);

    updateSettings({ terminalMemoryPromptsEnabled: true });
    expect(terminalMemoryPromptsVisible()).toBe(false);
  });

  it("notifies subscribers for both Settings changes and window dismissal", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalMemoryPromptVisibility(listener);

    updateSettings({ terminalMemoryPromptsEnabled: false });
    dismissTerminalMemoryPromptsForWindow();

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

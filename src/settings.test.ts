import { beforeEach, describe, expect, it } from "vitest";
import {
  formatHotkey,
  getSettings,
  DEFAULT_DICTATION_HOTKEY,
  TERMINAL_SCROLLBACK_MAX_ROWS,
  TERMINAL_SCROLLBACK_MIN_ROWS,
  type Hotkey,
  keyLabel,
  matchesHotkey,
  updateSettings,
} from "./settings";

beforeEach(() => {
  localStorage.clear();
});

describe("getSettings / updateSettings", () => {
  it("returns defaults when nothing is stored", () => {
    const s = getSettings();
    expect(s.scrollback).toBe(5_000);
    expect(s.theme).toBe("gotham");
    expect(s.trackerKeys).toEqual({});
    expect(s.tabSwitchMode).toBe("recent");
    expect(s.restoreUserClosedSessions).toBe(false);
    expect(s.agentAskForAttention).toBe(false);
    expect(s.notificationPopupsEnabled).toBe(true);
    expect(s.dictationTriggerMode).toBe("hold");
    expect(s.dictationModKey).toBe("ShiftLeft");
  });

  it("overlays stored values and clamps scrollback to its renderer bound", () => {
    updateSettings({ scrollback: 500 });
    const s = getSettings();
    expect(s.scrollback).toBe(TERMINAL_SCROLLBACK_MIN_ROWS);
    expect(s.fontSize).toBe(13); // untouched default still present

    localStorage.setItem(
      "canopy.settings",
      JSON.stringify({ scrollback: Number.MAX_SAFE_INTEGER }),
    );
    expect(getSettings().scrollback).toBe(TERMINAL_SCROLLBACK_MAX_ROWS);
  });

  it("round-trips a patch through localStorage", () => {
    updateSettings({
      theme: "gotham",
      customAccent: "#ff0000",
      tabSwitchMode: "order",
      restoreUserClosedSessions: true,
      agentAskForAttention: false,
      notificationPopupsEnabled: false,
    });
    const s = getSettings();
    expect(s.theme).toBe("gotham");
    expect(s.customAccent).toBe("#ff0000");
    expect(s.tabSwitchMode).toBe("order");
    expect(s.restoreUserClosedSessions).toBe(true);
    expect(s.agentAskForAttention).toBe(false);
    expect(s.notificationPopupsEnabled).toBe(false);
  });

  it("merges successive patches rather than replacing the whole object", () => {
    updateSettings({ theme: "gotham" });
    updateSettings({ maxLiveAgents: 3 });
    const s = getSettings();
    expect(s.theme).toBe("gotham");
    expect(s.maxLiveAgents).toBe(3);
  });

  it("falls back to defaults on corrupt stored JSON", () => {
    localStorage.setItem("canopy.settings", "{not json");
    expect(getSettings().scrollback).toBe(5_000);
  });

  it("migrates the former default combo and reserved Command trigger", () => {
    localStorage.setItem(
      "canopy.settings",
      JSON.stringify({
        dictationTriggerMode: "combo",
        dictationHotkey: DEFAULT_DICTATION_HOTKEY,
        dictationModKey: "MetaRight",
      }),
    );
    const s = getSettings();
    expect(s.dictationTriggerMode).toBe("hold");
    expect(s.dictationModKey).toBe("ShiftLeft");
  });

  it("preserves a customized combo during trigger migration", () => {
    const custom = { ...DEFAULT_DICTATION_HOTKEY, code: "KeyQ" };
    localStorage.setItem(
      "canopy.settings",
      JSON.stringify({
        dictationTriggerMode: "combo",
        dictationHotkey: custom,
      }),
    );
    const s = getSettings();
    expect(s.dictationTriggerMode).toBe("combo");
    expect(s.dictationHotkey).toEqual(custom);
  });

  it("migrates the earlier macOS Command-D default", () => {
    localStorage.setItem(
      "canopy.settings",
      JSON.stringify({
        dictationTriggerMode: "combo",
        dictationHotkey: {
          meta: true,
          ctrl: false,
          alt: false,
          shift: false,
          code: "KeyD",
        },
      }),
    );
    expect(getSettings().dictationTriggerMode).toBe("hold");
  });
});

describe("keyLabel", () => {
  it("humanizes KeyboardEvent.code values", () => {
    expect(keyLabel("KeyD")).toBe("D");
    expect(keyLabel("Digit1")).toBe("1");
    expect(keyLabel("Enter")).toBe("Enter");
  });
});

describe("matchesHotkey", () => {
  const hotkey: Hotkey = { meta: true, ctrl: false, alt: false, shift: false, code: "KeyD" };

  it("matches when code and every modifier flag agree", () => {
    const e = { code: "KeyD", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(matchesHotkey(e as KeyboardEvent, hotkey)).toBe(true);
  });

  it("rejects when a modifier differs", () => {
    const e = { code: "KeyD", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false };
    expect(matchesHotkey(e as KeyboardEvent, hotkey)).toBe(false);
  });

  it("rejects when the key code differs", () => {
    const e = { code: "KeyE", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(matchesHotkey(e as KeyboardEvent, hotkey)).toBe(false);
  });
});

describe("formatHotkey", () => {
  it("renders the key label and includes any set modifiers", () => {
    // Platform-dependent glyphs (⌘ vs Win) — assert the key letter is always
    // present and that a plain single-key hotkey formats to just that letter.
    const plain: Hotkey = { meta: false, ctrl: false, alt: false, shift: false, code: "KeyD" };
    expect(formatHotkey(plain)).toBe("D");
    expect(formatHotkey({ ...plain, shift: true })).toContain("D");
  });
});

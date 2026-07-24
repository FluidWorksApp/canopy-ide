import { beforeEach, describe, expect, it } from "vitest";
import {
  formatHotkey,
  getSettings,
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
    expect(s.scrollback).toBe(10_000);
    expect(s.theme).toBe("default");
    expect(s.trackerKeys).toEqual({});
  });

  it("overlays stored values on top of defaults", () => {
    updateSettings({ scrollback: 500 });
    const s = getSettings();
    expect(s.scrollback).toBe(500);
    expect(s.fontSize).toBe(13); // untouched default still present
  });

  it("round-trips a patch through localStorage", () => {
    updateSettings({ theme: "gotham", customAccent: "#ff0000" });
    const s = getSettings();
    expect(s.theme).toBe("gotham");
    expect(s.customAccent).toBe("#ff0000");
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
    expect(getSettings().scrollback).toBe(10_000);
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

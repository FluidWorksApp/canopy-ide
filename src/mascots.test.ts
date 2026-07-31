import { beforeEach, describe, expect, it } from "vitest";
import { ASH_STATES, ashGlyph } from "./ash";
import {
  DEFAULT_MASCOT,
  MASCOTS,
  currentMascot,
  mascotDef,
  mascotGlyph,
  type MascotId,
} from "./mascots";
import { DEFAULTS, getSettings, updateSettings } from "./settings";

beforeEach(() => {
  localStorage.clear();
});

describe("the registry", () => {
  it("ships Ash", () => {
    expect(MASCOTS.map((m) => m.id)).toContain("ash");
  });

  it("has no duplicate ids", () => {
    expect(new Set(MASCOTS.map((m) => m.id)).size).toBe(MASCOTS.length);
  });

  it("gives every mascot something to show in the picker", () => {
    for (const m of MASCOTS) {
      expect(m.label.length, m.id).toBeGreaterThan(0);
      expect(m.note.length, m.id).toBeGreaterThan(0);
    }
  });

  it("names a default that actually exists", () => {
    expect(MASCOTS.some((m) => m.id === DEFAULT_MASCOT)).toBe(true);
  });

  // settings.ts writes the literal "ash" rather than importing DEFAULT_MASCOT,
  // because mascots.ts reads getSettings() and a value import back would be a
  // live cycle evaluated while DEFAULTS is being built. This is the guard that
  // keeps the two honest.
  it("agrees with the settings default", () => {
    expect(DEFAULTS.mascot).toBe(DEFAULT_MASCOT);
  });
});

describe("choosing one", () => {
  it("defaults to Ash with nothing stored", () => {
    expect(currentMascot()).toBe("ash");
    expect(getSettings().mascot).toBe("ash");
  });

  it("follows the setting", () => {
    updateSettings({ mascot: "ash" });
    expect(currentMascot()).toBe("ash");
  });

  it("falls back when the stored id names a mascot this build dropped", () => {
    // A blank space where a face was is worse than the wrong face.
    updateSettings({ mascot: "a-mascot-from-a-later-build" as MascotId });
    expect(currentMascot()).toBe(DEFAULT_MASCOT);
    expect(mascotDef().id).toBe(DEFAULT_MASCOT);
  });
});

describe("mascotGlyph", () => {
  it("gives Ash's forms for Ash", () => {
    for (const state of ASH_STATES) {
      expect(mascotGlyph(state, "ash"), state).toBe(ashGlyph(state));
    }
  });

  it("covers every state in the vocabulary", () => {
    for (const state of ASH_STATES) {
      expect(mascotGlyph(state), state).toMatch(/^\[..\]$/);
    }
  });

  it("reads the setting when no mascot is named", () => {
    updateSettings({ mascot: "ash" });
    expect(mascotGlyph("needs")).toBe(ashGlyph("needs"));
  });
});

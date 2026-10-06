import { describe, expect, it } from "vitest";
import {
  isSessionNameTheme,
  SESSION_NAME_THEMES,
  sessionNameThemeDef,
} from "./sessionNameThemes";

describe("session name themes", () => {
  it("offers distinct, honest four-name previews", () => {
    expect(SESSION_NAME_THEMES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(SESSION_NAME_THEMES.map((theme) => theme.id)).size).toBe(
      SESSION_NAME_THEMES.length,
    );
    for (const theme of SESSION_NAME_THEMES) {
      expect(theme.preview).toHaveLength(4);
      expect(new Set(theme.preview).size).toBe(4);
    }
  });

  it("validates persisted ids and resolves their definitions", () => {
    expect(isSessionNameTheme("wizardry")).toBe(true);
    expect(isSessionNameTheme("space-potato")).toBe(false);
    expect(sessionNameThemeDef("android").preview[0]).toBe("Cupcake");
  });
});

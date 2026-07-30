import { describe, expect, it } from "vitest";
import { THEMES, type Theme } from "./settings";
import { terminalTheme } from "./terminalThemes";

/** Every skin needs a palette of its own. The switch in match_palette falls
 *  through to Default, so a skin added to THEMES without one is silent: the
 *  app recolours, the terminal quietly stays Tokyo Night. Pinning the
 *  backgrounds catches that — they're the one slot no two skins share. */
describe("terminalTheme", () => {
  const skins = THEMES.map((t) => t.id).filter(
    (id): id is Exclude<Theme, "auto" | "custom"> =>
      id !== "auto" && id !== "custom",
  );

  it("gives every skin its own terminal background", () => {
    const backgrounds = skins.map((id) => terminalTheme(id).background);
    expect(new Set(backgrounds).size).toBe(skins.length);
  });

  it("dresses Vitrine in the glass skin's own palette", () => {
    const t = terminalTheme("vitrine");
    expect(t.background).toBe("#08090c");
    expect(t.cursor).toBe("#b4f04a");
  });

  it("substitutes a custom accent into the cursor on any skin", () => {
    const t = terminalTheme("vitrine", "#ff00ff");
    expect(t.cursor).toBe("#ff00ff");
    expect(t.blue).toBe("#ff00ff");
    // The rest of the skin is untouched.
    expect(t.background).toBe("#08090c");
  });
});

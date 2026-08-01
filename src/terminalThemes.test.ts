import { describe, expect, it } from "vitest";
import { terminalTheme } from "./terminalThemes";

/** Only the resolution rules live here. That every skin HAS a palette of its
 *  own is skins.test.ts's job now — a skin declares its terminal colours in
 *  src/skins/<id>.ts, so the two facts belong in different tests. */
describe("terminalTheme", () => {
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

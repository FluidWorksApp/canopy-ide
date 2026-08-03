import { describe, it, expect } from "vitest";
import { digitFromCode, digitFromEvent, hintModifierOnly } from "./useHeldModifier";
import { IS_MAC } from "./platform";

/** A KeyboardEvent stand-in — only the modifier flags matter here. */
const ev = (mods: Partial<KeyboardEvent>) =>
  ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  }) as KeyboardEvent;

/** The tab layer's modifier, per platform: ⌘ on macOS, Ctrl everywhere else. */
const tabMod = IS_MAC ? { metaKey: true } : { ctrlKey: true };
/** The other one, which must never be mistaken for it. */
const otherMod = IS_MAC ? { ctrlKey: true } : { metaKey: true };

describe("digitFromCode", () => {
  it("reads the number row and the numpad", () => {
    expect(digitFromCode("Digit1")).toBe(1);
    expect(digitFromCode("Digit9")).toBe(9);
    expect(digitFromCode("Numpad3")).toBe(3);
  });

  it("ignores 0 and non-digits — ⌘0 is zoom reset, not a tenth tab", () => {
    expect(digitFromCode("Digit0")).toBeNull();
    expect(digitFromCode("Numpad0")).toBeNull();
    expect(digitFromCode("KeyN")).toBeNull();
    expect(digitFromCode("ArrowLeft")).toBeNull();
  });
});

describe("digitFromEvent", () => {
  it("recognises an Option-modified digit when WebKit omits code", () => {
    expect(
      digitFromEvent(ev({ code: "", key: "£", keyCode: 51, altKey: true })),
    ).toBe(3);
  });
});

describe("hintModifierOnly", () => {
  it("recognises each layer's own modifier", () => {
    expect(hintModifierOnly(ev(tabMod), "tabs")).toBe(true);
    expect(hintModifierOnly(ev({ altKey: true }), "projects")).toBe(true);
  });

  it("keeps the two layers apart", () => {
    expect(hintModifierOnly(ev({ altKey: true }), "tabs")).toBe(false);
    expect(hintModifierOnly(ev(tabMod), "projects")).toBe(false);
    expect(hintModifierOnly(ev(otherMod), "tabs")).toBe(false);
  });

  it("rejects chords — ⌘⇧N and Ctrl+⌘→ belong to someone else", () => {
    expect(hintModifierOnly(ev({ ...tabMod, shiftKey: true }), "tabs")).toBe(
      false,
    );
    expect(hintModifierOnly(ev({ ...tabMod, altKey: true }), "tabs")).toBe(
      false,
    );
    expect(hintModifierOnly(ev({ ...tabMod, ...otherMod }), "tabs")).toBe(false);
    // AltGr arrives as Ctrl+Alt on Windows/Linux — not a projects hint.
    expect(hintModifierOnly(ev({ altKey: true, ctrlKey: true }), "projects")).toBe(
      false,
    );
  });

  it("rejects a bare keypress", () => {
    expect(hintModifierOnly(ev({}), "tabs")).toBe(false);
    expect(hintModifierOnly(ev({}), "projects")).toBe(false);
  });
});

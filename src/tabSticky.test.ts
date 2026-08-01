import { describe, expect, it } from "vitest";
import { NUB_W, pinOffset, pinnedThrough, revealScroll, samePins } from "./tabSticky";

// A chip 60px wide, followed by three 100px tabs — one run of the strip.
const CHIP = 60;

describe("pinOffset", () => {
  it("stacks each chip after the ones already pinned", () => {
    expect(pinOffset(0)).toBe(0);
    expect(pinOffset(1)).toBe(NUB_W);
    expect(pinOffset(3)).toBe(3 * NUB_W);
  });
});

describe("pinnedThrough", () => {
  // Three runs: chips at 0, 400 and 900 in strip coordinates.
  const anchors = [0, 400, 900];

  it("pins nothing while the strip is at rest", () => {
    expect(pinnedThrough(0, anchors)).toBe(-1);
  });

  it("pins the first chip as soon as the strip moves off it", () => {
    expect(pinnedThrough(1, anchors)).toBe(0);
    expect(pinnedThrough(300, anchors)).toBe(0);
  });

  it("hands over only when the next chip reaches its own place in the pile", () => {
    // Chip 1 pins at NUB_W, so it is still riding in the flow at 400 - NUB_W…
    expect(pinnedThrough(400 - NUB_W, anchors)).toBe(0);
    // …and pinned one pixel later.
    expect(pinnedThrough(400 - NUB_W + 1, anchors)).toBe(1);
  });

  it("keeps every earlier chip pinned however far the strip scrolls", () => {
    // The whole strip scrolled past: all three are in the pile, the last one
    // shown in full, and nothing has been pushed off the left edge.
    expect(pinnedThrough(5000, anchors)).toBe(2);
  });

  it("has nothing to pin when the strip has no chips", () => {
    expect(pinnedThrough(500, [])).toBe(-1);
  });
});

describe("revealScroll", () => {
  const VIEW = 400;

  it("leaves a tab already in clear view alone", () => {
    expect(revealScroll(0, VIEW, 160, 100, CHIP)).toBeNull();
  });

  it("scrolls a tab out from under the pinned chip, not merely on screen", () => {
    // Scrolled to 200: a tab at 160 sits left of the pin (200 + 60 = 260), so
    // scrollIntoView would call it visible while the chip covers it.
    expect(revealScroll(200, VIEW, 160, 100, CHIP)).toBe(160 - CHIP - 8);
  });

  it("clears the nubs of the runs before it, not just its own chip", () => {
    // Third run: two nubs, then its own chip. A reveal that only cleared the
    // chip would park the tab under the pile that grew in front of it.
    const pinned = pinOffset(2) + CHIP;
    expect(revealScroll(400, VIEW, 300, 100, pinned)).toBe(300 - pinned - 8);
  });

  it("scrolls a tab off the right edge back into view", () => {
    expect(revealScroll(0, VIEW, 380, 100, CHIP)).toBe(380 + 100 - VIEW + 8);
  });

  it("never asks for a negative scroll", () => {
    expect(revealScroll(10, VIEW, 0, 100, CHIP)).toBe(0);
  });

  it("needs no clearance when the run has no chip", () => {
    expect(revealScroll(160, VIEW, 160, 100, 0)).toBeNull();
  });
});

describe("samePins", () => {
  it("is true for identical readings, so a scroll that changes nothing is free", () => {
    expect(samePins({ a: true }, { a: true })).toBe(true);
    expect(samePins({}, {})).toBe(true);
  });

  it("is false when a chip joins or leaves the pile", () => {
    expect(samePins({ a: true }, { a: true, b: true })).toBe(false);
    expect(samePins({ a: true, b: true }, { a: true })).toBe(false);
    expect(samePins({}, { a: true })).toBe(false);
  });

  it("is false when the pile is the same size but holds different chips", () => {
    expect(samePins({ a: true }, { b: true })).toBe(false);
  });
});

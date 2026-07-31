import { describe, expect, it } from "vitest";
import { revealScroll, sameOverflow, stackOverflow, type TabExtent } from "./tabSticky";

// A group whose chip is 60px wide, followed by three 100px tabs.
const CHIP = 60;
const tabs: TabExtent[] = [
  { id: "a", left: 60, width: 100 },
  { id: "b", left: 160, width: 100 },
  { id: "c", left: 260, width: 100 },
];

describe("stackOverflow", () => {
  it("is not stuck while the group starts at or after the left edge", () => {
    expect(stackOverflow(0, 0, CHIP, tabs).stuck).toBe(false);
    expect(stackOverflow(50, 80, CHIP, tabs).stuck).toBe(false);
  });

  it("is stuck once the group's start has scrolled past the left edge", () => {
    expect(stackOverflow(120, 0, CHIP, tabs).stuck).toBe(true);
  });

  it("hides nothing when the strip is at rest", () => {
    expect(stackOverflow(0, 0, CHIP, tabs).hidden).toEqual([]);
  });

  it("counts a tab hidden only once it has cleared the pinned chip", () => {
    // Tab 'a' ends at 160. At scrollLeft 99 the chip covers up to 159 — one
    // pixel of 'a' still shows, so it is still reachable.
    expect(stackOverflow(99, 0, CHIP, tabs).hidden).toEqual([]);
    expect(stackOverflow(100, 0, CHIP, tabs).hidden).toEqual(["a"]);
    expect(stackOverflow(200, 0, CHIP, tabs).hidden).toEqual(["a", "b"]);
    expect(stackOverflow(300, 0, CHIP, tabs).hidden).toEqual(["a", "b", "c"]);
  });

  it("treats a chipless group as having nothing painted over its tabs", () => {
    expect(stackOverflow(60, 0, 0, tabs).hidden).toEqual([]);
    expect(stackOverflow(160, 0, 0, tabs).hidden).toEqual(["a"]);
  });
});

describe("revealScroll", () => {
  const VIEW = 400;

  it("leaves a tab already in clear view alone", () => {
    expect(revealScroll(0, VIEW, 160, 100, CHIP)).toBeNull();
  });

  it("scrolls a tab out from under the pinned chip, not merely on screen", () => {
    // Scrolled to 200: tab 'b' at 160 sits left of the pin (200 + 60 = 260),
    // so scrollIntoView would call it visible while the chip covers it.
    expect(revealScroll(200, VIEW, 160, 100, CHIP)).toBe(160 - CHIP - 8);
  });

  it("scrolls a tab off the right edge back into view", () => {
    expect(revealScroll(0, VIEW, 380, 100, CHIP)).toBe(380 + 100 - VIEW + 8);
  });

  it("never asks for a negative scroll", () => {
    expect(revealScroll(10, VIEW, 0, 100, CHIP)).toBe(0);
  });

  it("needs no chip clearance when the group has no chip", () => {
    expect(revealScroll(160, VIEW, 160, 100, 0)).toBeNull();
  });
});

describe("sameOverflow", () => {
  const at = (n: number) => ({ g: stackOverflow(n, 0, CHIP, tabs) });

  it("is true for identical readings, so a scroll that changes nothing is free", () => {
    expect(sameOverflow(at(10), at(20))).toBe(true);
  });

  it("is false when a tab crosses behind the chip", () => {
    expect(sameOverflow(at(10), at(120))).toBe(false);
  });

  it("is false when a group appears or disappears", () => {
    expect(sameOverflow(at(10), { ...at(10), other: at(10).g })).toBe(false);
    expect(sameOverflow({}, at(10))).toBe(false);
  });
});

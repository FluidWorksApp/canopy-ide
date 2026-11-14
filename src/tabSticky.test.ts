import { describe, expect, it } from "vitest";
import { expandedStackScroll, revealScroll, isInPinnedGroup, pinnedWidthOf, revealClearance } from "./tabSticky";

// A chip 60px wide, followed by three 100px tabs — one run of the strip.
const CHIP = 60;

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

describe("expandedStackScroll", () => {
  it("returns the hidden section start when its sticky chip has moved past it", () => {
    expect(expandedStackScroll(240, 80)).toBe(80);
  });

  it("does not move a section that is already at or ahead of the viewport", () => {
    expect(expandedStackScroll(80, 80)).toBeNull();
    expect(expandedStackScroll(40, 80)).toBeNull();
  });
});

describe("pinned tabs held at the left edge", () => {
  const strip = () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-group-key="pinned"><button id="pinned-tab"></button></div>
      <div data-group-key="working"><span data-stack-chip></span><button id="other-tab"></button></div>`;
    return root;
  };
  const width = (el: Element, px: number) =>
    Object.defineProperty(el, "offsetWidth", { configurable: true, value: px });

  it("measures the pinned group and nothing when there is none", () => {
    const root = strip();
    width(root.querySelector('[data-group-key="pinned"]')!, 212);
    expect(pinnedWidthOf(root)).toBe(212);
    const bare = document.createElement("div");
    bare.innerHTML = `<div data-group-key="working"></div>`;
    expect(pinnedWidthOf(bare)).toBe(0);
  });

  it("knows which tabs are pinned", () => {
    const root = strip();
    expect(isInPinnedGroup(root, root.querySelector("#pinned-tab")!)).toBe(true);
    expect(isInPinnedGroup(root, root.querySelector("#other-tab")!)).toBe(false);
    const bare = document.createElement("div");
    bare.innerHTML = `<button id="x"></button>`;
    expect(isInPinnedGroup(bare, bare.querySelector("#x")!)).toBe(false);
  });

  it("clears the pinned tabs and the chip for a tab that scrolls, and nothing for a pinned one", () => {
    expect(revealClearance(90, 212, false)).toBe(302);
    expect(revealClearance(0, 212, false)).toBe(212);
    expect(revealClearance(90, 212, true)).toBe(0);
    // A tab hidden under the pinned tabs is revealed to just past them.
    expect(revealScroll(400, 800, 450, 100, revealClearance(0, 212, false))).toBe(450 - 212 - 8);
  });
});

import { describe, expect, it } from "vitest";
import { placeAboveAnchor } from "./popoverPlacement";

const vp = { width: 1200, height: 800 };
// A chip in the status bar near the bottom-right corner.
const chip = { top: 772, left: 1150, right: 1166 };

describe("placeAboveAnchor", () => {
  it("right-aligns to the anchor and opens upward with a gap", () => {
    const p = placeAboveAnchor(chip, vp, { width: 452, gap: 6, margin: 8 });
    expect(p.width).toBe(452);
    expect(p.left).toBe(1166 - 452);
    expect(p.bottom).toBe(800 - 772 + 6);
  });

  it("caps the height at the room above the anchor, keeping the top on screen", () => {
    const p = placeAboveAnchor(chip, vp, { width: 452, gap: 6, margin: 8 });
    expect(p.maxHeight).toBe(772 - 6 - 8);
    // top edge of the panel = viewport.height - bottom - maxHeight
    expect(vp.height - p.bottom - p.maxHeight).toBe(8);
  });

  it("clamps the left edge inside the margin when the anchor is near the left", () => {
    const p = placeAboveAnchor({ top: 772, left: 10, right: 30 }, vp, {
      width: 452,
      margin: 8,
    });
    expect(p.left).toBe(8);
  });

  it("clamps the right edge inside the margin when the anchor is past it", () => {
    const p = placeAboveAnchor({ top: 772, left: 1196, right: 1300 }, vp, {
      width: 452,
      margin: 8,
    });
    expect(p.left + p.width).toBe(1200 - 8);
  });

  it("shrinks the width to fit a narrow window", () => {
    const p = placeAboveAnchor({ top: 600, left: 280, right: 300 }, { width: 320, height: 640 }, {
      width: 452,
      margin: 8,
    });
    expect(p.width).toBe(304);
    expect(p.left).toBe(8);
  });

  it("keeps a minimum usable height on a very short window without leaving the top", () => {
    const short = { width: 800, height: 200 };
    const p = placeAboveAnchor({ top: 60, left: 700, right: 720 }, short, {
      width: 452,
      margin: 8,
      minHeight: 120,
    });
    expect(p.maxHeight).toBe(120);
    expect(short.height - p.bottom - p.maxHeight).toBeGreaterThanOrEqual(8);
  });

  it("treats an anchor reported below the window as sitting on its bottom edge", () => {
    const p = placeAboveAnchor({ top: 5000, left: 1150, right: 1166 }, vp, {
      width: 452,
      gap: 6,
      margin: 8,
    });
    expect(p.bottom).toBe(6);
    expect(vp.height - p.bottom - p.maxHeight).toBe(8);
  });
});

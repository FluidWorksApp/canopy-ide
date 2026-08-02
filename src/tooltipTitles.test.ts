import { describe, expect, it } from "vitest";
import { parseTitle, placeTip, upgradable, type Box } from "./tooltipTitles";

const box = (p: Partial<Box>): Box => ({
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
  width: 0,
  height: 0,
  ...p,
});

const view = { width: 1000, height: 800 };

describe("parseTitle", () => {
  it("reads a short title as the label", () => {
    expect(parseTitle("Stage file")).toEqual({ label: "Stage file", body: undefined, hint: undefined });
  });

  it("returns null for an empty or whitespace title", () => {
    expect(parseTitle("")).toBeNull();
    expect(parseTitle("   \n  ")).toBeNull();
  });

  it("splits a multi-line title into label and body", () => {
    const tip = parseTitle("Commit\nStages nothing — commits what is already staged");
    expect(tip?.label).toBe("Commit");
    expect(tip?.body).toBe("Stages nothing — commits what is already staged");
  });

  it("lifts a trailing chord into the hint chip", () => {
    expect(parseTitle("Toggle sidebar (⌘B)")).toEqual({
      label: "Toggle sidebar",
      body: undefined,
      hint: "⌘B",
    });
  });

  it("leaves a parenthetical that is not a chord in the label", () => {
    expect(parseTitle("Discard changes (3 files)")?.label).toBe("Discard changes (3 files)");
    expect(parseTitle("Discard changes (3 files)")?.hint).toBeUndefined();
  });

  it("keeps a chord-only title readable as a label", () => {
    expect(parseTitle("(⌘K)")).toEqual({ label: "⌘K" });
  });

  it("renders a long single-line title as body prose, not a semibold label", () => {
    const long =
      "Built the native Cleanup resources task and raised PR #260 — it found 82 GB across 32 checkouts here, 23 GB of it in merged worktrees.";
    expect(parseTitle(long)).toEqual({ body: long });
  });

  it("treats a title that would wrap as prose too", () => {
    const wraps = "Clamped against the right edge of the window so it never runs off";
    expect(parseTitle(wraps)).toEqual({ body: wraps });
  });

  it("still labels a long title that has its own body line", () => {
    const tip = parseTitle(`${"x".repeat(90)}\nsecond line`);
    expect(tip?.label).toHaveLength(90);
    expect(tip?.body).toBe("second line");
  });
});

describe("upgradable", () => {
  const el = (html: string) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild!;
  };

  it("upgrades an ordinary titled element", () => {
    expect(upgradable(el(`<button title="Stage">+</button>`))).toBe(true);
  });

  it("leaves an iframe title alone — it is an accessible name, not a tooltip", () => {
    expect(upgradable(el(`<iframe title="preview"></iframe>`))).toBe(false);
  });

  it("leaves native select popups alone", () => {
    expect(upgradable(el(`<option title="main"></option>`))).toBe(false);
  });

  it("honours the data-native-title opt-out", () => {
    expect(upgradable(el(`<span title="x" data-native-title></span>`))).toBe(false);
  });

  it("never re-enters its own bubble", () => {
    const host = document.createElement("div");
    host.innerHTML = `<span class="cnp-tooltip"><span title="x">y</span></span>`;
    expect(upgradable(host.querySelector("[title]")!)).toBe(false);
  });
});

describe("placeTip", () => {
  it("sits above the trigger when there is room", () => {
    const p = placeTip(box({ top: 400, bottom: 420, left: 500, right: 540, width: 40, height: 20 }), { width: 100, height: 30 }, view);
    expect(p.side).toBe("top");
    expect(p.top).toBe(360);
    expect(p.left).toBe(470);
  });

  it("flips below when the trigger is against the top edge", () => {
    const p = placeTip(box({ top: 4, bottom: 24, left: 500, right: 540, width: 40, height: 20 }), { width: 100, height: 30 }, view);
    expect(p.side).toBe("bottom");
    expect(p.top).toBe(34);
  });

  it("pulls back inside the right edge instead of running off screen", () => {
    const p = placeTip(box({ top: 400, bottom: 420, left: 980, right: 1000, width: 20, height: 20 }), { width: 200, height: 30 }, view);
    expect(p.left).toBe(794);
    expect(p.left + 200).toBeLessThanOrEqual(view.width);
  });

  it("keeps the arrow on the trigger after the bubble is clamped", () => {
    const p = placeTip(box({ top: 400, bottom: 420, left: 980, right: 1000, width: 20, height: 20 }), { width: 200, height: 30 }, view);
    // Trigger centre is 990; the bubble starts at 794, so the arrow is at 196 —
    // clamped off the corner radius.
    expect(p.arrow).toBe(185);
  });

  it("never lets the arrow overrun a rounded corner", () => {
    const p = placeTip(box({ top: 400, bottom: 420, left: 0, right: 8, width: 8, height: 20 }), { width: 200, height: 30 }, view);
    expect(p.arrow).toBe(15);
  });

  it("opens away from the nearer edge, so a top-bar trigger points down", () => {
    // A tab, a stack chip or a toolbar button sits ~100px from the top of the
    // window. A bubble above it fits the viewport and lands squarely on the
    // title bar and the project tabs, which is not "fits".
    const view = { width: 1400, height: 900 };
    const inTopBar = placeTip(box({ top: 96, bottom: 118, left: 300, right: 420 }), { width: 180, height: 44 }, view);
    expect(inTopBar.side).toBe("bottom");
    // Down the window, the same trigger points up.
    const lowDown = placeTip(box({ top: 800, bottom: 822, left: 300, right: 420 }), { width: 180, height: 44 }, view);
    expect(lowDown.side).toBe("top");
  });

  it("takes the roomier side when the bubble fits on neither", () => {
    const short = { width: 1000, height: 200 };
    const low = placeTip(box({ top: 150, bottom: 170, left: 500, right: 540, width: 40, height: 20 }), { width: 100, height: 180 }, short);
    expect(low.side).toBe("top");
    const high = placeTip(box({ top: 20, bottom: 40, left: 500, right: 540, width: 40, height: 20 }), { width: 100, height: 180 }, short);
    expect(high.side).toBe("bottom");
  });

  it("clamps a bubble taller than the window to the top edge, not off it", () => {
    const p = placeTip(box({ top: 10, bottom: 30, left: 500, right: 540, width: 40, height: 20 }), { width: 100, height: 900 }, view);
    expect(p.top).toBe(6);
  });
});

describe("opening beside the trigger", () => {
  // The activity rail is a column of icons: a bubble under one covers the next
  // one down, which is where the pointer is heading.
  const rail = { top: 200, bottom: 232, left: 8, right: 40, width: 32, height: 32 };
  const tip = { width: 160, height: 30 };
  const view = { width: 1400, height: 900 };

  it("puts the bubble to the right of the icon, centred on it", () => {
    const p = placeTip(rail, tip, view, "right");
    expect(p.side).toBe("right");
    expect(p.left).toBeGreaterThan(rail.right);
    // Centred on the icon: the bubble's middle sits on the icon's middle.
    expect(p.top + tip.height / 2).toBe(rail.top + rail.height / 2);
  });

  it("flips to the other side when the preferred one cannot hold it", () => {
    // A rail on the right edge of the window.
    const right = { top: 200, bottom: 232, left: 1360, right: 1392, width: 32, height: 32 };
    expect(placeTip(right, tip, view, "right").side).toBe("left");
    // …and back, for a left-preferring trigger with no room on the left.
    expect(placeTip(rail, tip, view, "left").side).toBe("right");
  });

  it("keeps the bubble inside the window at the ends of the rail", () => {
    const top = { top: 2, bottom: 34, left: 8, right: 40, width: 32, height: 32 };
    const p = placeTip(top, tip, view, "right");
    expect(p.top).toBeGreaterThanOrEqual(0);
    const bottom = { top: 880, bottom: 912, left: 8, right: 40, width: 32, height: 32 };
    const q = placeTip(bottom, tip, view, "right");
    expect(q.top + tip.height).toBeLessThanOrEqual(view.height);
  });

  it("still opens vertically when nothing asks otherwise", () => {
    expect(["top", "bottom"]).toContain(placeTip(rail, tip, view).side);
  });
});

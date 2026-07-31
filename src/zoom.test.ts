import { beforeEach, describe, expect, it } from "vitest";
import { clampZoom, loadZoom, MAX_ZOOM, MIN_ZOOM, STEP } from "./zoom";

const KEY = "canopy.zoom";

describe("clampZoom", () => {
  it("holds the rails", () => {
    expect(clampZoom(5)).toBe(MAX_ZOOM);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(-3)).toBe(MIN_ZOOM);
  });

  it("passes levels inside the range through", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(1.3)).toBe(1.3);
  });

  it("snaps to one decimal so repeated steps can't drift", () => {
    // The whole reason round() exists: 0.1 + 0.2 is 0.30000000000000004, and
    // an un-snapped level would slowly desync from the displayed percentage.
    expect(clampZoom(0.1 + 0.2 + 0.7)).toBe(1);
    let z = 1;
    for (let i = 0; i < 5; i++) z = clampZoom(z + STEP);
    expect(z).toBe(1.5);
    for (let i = 0; i < 10; i++) z = clampZoom(z - STEP);
    expect(z).toBe(MIN_ZOOM);
  });
});

describe("loadZoom", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to 1 when nothing is stored", () => {
    expect(loadZoom()).toBe(1);
  });

  it.each([
    ["", "empty string"],
    ["abc", "garbage"],
    ["0", "zero"],
    ["-1", "negative"],
  ])("defaults to 1 for %s (%s)", (raw) => {
    localStorage.setItem(KEY, raw);
    expect(loadZoom()).toBe(1);
  });

  it("clamps an out-of-range stored level instead of trusting it", () => {
    localStorage.setItem(KEY, "999");
    expect(loadZoom()).toBe(MAX_ZOOM);
  });

  it("round-trips a level the user actually set", () => {
    localStorage.setItem(KEY, "1.4");
    expect(loadZoom()).toBe(1.4);
  });
});

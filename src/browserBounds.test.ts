import { describe, expect, it } from "vitest";
import {
  chooseEngine,
  overlaps,
  sameBounds,
  showable,
  webviewBounds,
} from "./browserBounds";

const viewport = { width: 1440, height: 900 };

describe("webviewBounds", () => {
  it("passes a plain rect through at zoom 1", () => {
    expect(webviewBounds({ x: 200, y: 100, width: 800, height: 600 }, viewport, 1)).toEqual({
      x: 200,
      y: 100,
      width: 800,
      height: 600,
    });
  });

  it("scales by the window zoom, because setZoom magnifies CSS pixels", () => {
    expect(webviewBounds({ x: 100, y: 50, width: 400, height: 300 }, viewport, 1.5)).toEqual({
      x: 150,
      y: 75,
      width: 600,
      height: 450,
    });
  });

  it("rounds rather than passing fractional points to the compositor", () => {
    expect(webviewBounds({ x: 10.4, y: 10.6, width: 100.5, height: 100.5 }, viewport, 1)).toEqual({
      x: 10,
      y: 11,
      width: 101,
      height: 100,
    });
  });

  it("keeps a placeholder's edges where they were, so panes stay adjacent", () => {
    const left = webviewBounds({ x: 0, y: 0, width: 320.5, height: 500 }, viewport, 1);
    const right = webviewBounds({ x: 320.5, y: 0, width: 400, height: 500 }, viewport, 1);
    expect(left.x + left.width).toBe(right.x);
  });

  it("clips to the viewport so the page can't paint over the app's chrome", () => {
    expect(
      webviewBounds({ x: 1200, y: 800, width: 800, height: 600 }, viewport, 1),
    ).toEqual({ x: 1200, y: 800, width: 240, height: 100 });
  });

  it("clips a rect that starts off the top-left edge", () => {
    expect(webviewBounds({ x: -100, y: -50, width: 400, height: 300 }, viewport, 1)).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 250,
    });
  });

  it("returns nothing for a rect entirely off screen", () => {
    const b = webviewBounds({ x: 2000, y: 100, width: 400, height: 300 }, viewport, 1);
    expect(b.width).toBe(0);
    expect(showable(b)).toBe(false);
  });

  it("treats a nonsense zoom as 1 rather than collapsing the view", () => {
    expect(webviewBounds({ x: 0, y: 0, width: 100, height: 100 }, viewport, 0)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });
});

describe("showable", () => {
  it("rejects the sub-pixel slivers a pane drag produces", () => {
    expect(showable({ x: 0, y: 0, width: 1, height: 400 })).toBe(false);
    expect(showable({ x: 0, y: 0, width: 400, height: 300 })).toBe(true);
  });
});

describe("sameBounds", () => {
  it("compares by value and treats null as its own", () => {
    const a = { x: 1, y: 2, width: 3, height: 4 };
    expect(sameBounds(a, { ...a })).toBe(true);
    expect(sameBounds(a, { ...a, x: 2 })).toBe(false);
    expect(sameBounds(null, null)).toBe(true);
    expect(sameBounds(a, null)).toBe(false);
  });
});

describe("overlaps", () => {
  const view = { x: 200, y: 100, width: 800, height: 600 };

  it("sees a full-screen backdrop", () => {
    expect(overlaps(view, { x: 0, y: 0, width: 1440, height: 900 })).toBe(true);
  });

  it("leaves a corner toast alone when it misses the browser", () => {
    expect(overlaps(view, { x: 1100, y: 820, width: 300, height: 60 })).toBe(false);
  });

  it("counts a toast that reaches into the browser", () => {
    expect(overlaps(view, { x: 900, y: 650, width: 300, height: 60 })).toBe(true);
  });

  it("does not count edge-to-edge touching as covering", () => {
    expect(overlaps(view, { x: 1000, y: 100, width: 100, height: 600 })).toBe(false);
  });
});

describe("chooseEngine", () => {
  it("honours the setting where the platform can", () => {
    expect(chooseEngine("webview", true)).toBe("webview");
    expect(chooseEngine("proxy", true)).toBe("proxy");
  });

  it("falls back to the proxy rather than showing an empty pane", () => {
    expect(chooseEngine("webview", false)).toBe("proxy");
    expect(chooseEngine("proxy", false)).toBe("proxy");
  });
});

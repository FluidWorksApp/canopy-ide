import { describe, expect, it } from "vitest";
import {
  firstOccluder,
  isSurface,
  occludes,
  stacksAboveFlow,
  type Candidate,
  type OccluderStyle,
} from "./browserOcclusion";

/** A preview pane roughly where one sits in a 1440x900 window: right of the
 *  54px rail, below the tab bar and the preview toolbar. */
const view = { x: 54, y: 76, width: 1386, height: 800 };

const style = (s: Partial<OccluderStyle> = {}): OccluderStyle => ({
  position: "static",
  zIndex: "auto",
  pointerEvents: "auto",
  ...s,
});

describe("stacksAboveFlow", () => {
  it("counts anything positioned", () => {
    for (const position of ["absolute", "fixed", "relative", "sticky"]) {
      expect(stacksAboveFlow(style({ position }))).toBe(true);
    }
  });

  it("counts an in-flow box that lifts itself with a stacking order", () => {
    expect(stacksAboveFlow(style({ zIndex: "30" }))).toBe(true);
  });

  it("ignores ordinary content", () => {
    expect(stacksAboveFlow(style())).toBe(false);
    expect(stacksAboveFlow(style({ zIndex: "" }))).toBe(false);
  });
});

describe("isSurface", () => {
  it("treats a click-through box as a frame, not a surface", () => {
    expect(isSurface(style({ pointerEvents: "none" }))).toBe(false);
    expect(isSurface(style())).toBe(true);
  });
});

describe("occludes", () => {
  // The bug this mechanism was rewritten for: the COMPONENTS side panel opened
  // over a preview showing a site, and the native webview painted straight over
  // it — the list was clipped mid-item. It carries none of the dialog classes
  // the old detector looked for; it is simply a positioned panel.
  it("catches the COMPONENTS side panel flying out over the page", () => {
    const sidePanel: Candidate = {
      rect: { x: 54, y: 0, width: 260, height: 900 },
      style: style({ position: "absolute" }),
    };
    expect(occludes(view, sidePanel)).toBe(true);
  });

  // ...while the layer it lives in spans the whole content area permanently.
  // Counting that would hide the browser forever, which is why click-through
  // wrappers are descended into instead.
  it("ignores the full-area click-through layer the panel lives in", () => {
    const layer: Candidate = {
      rect: { x: 54, y: 0, width: 1386, height: 900 },
      style: style({ position: "absolute", zIndex: "30", pointerEvents: "none" }),
    };
    expect(occludes(view, layer)).toBe(false);
  });

  // A closed side panel is visibility:hidden, so the walk prunes it before it
  // ever gets here — but an open one that hasn't finished sliding still counts.
  it("catches the panel mid-animation, while it is still travelling", () => {
    const sliding: Candidate = {
      rect: { x: -20, y: 0, width: 260, height: 900 },
      style: style({ position: "absolute" }),
    };
    expect(occludes(view, sliding)).toBe(true);
  });

  it("catches a tooltip, which paints but takes no clicks", () => {
    const tooltip: Candidate = {
      rect: { x: 300, y: 200, width: 280, height: 48 },
      style: style({ position: "absolute", zIndex: "500", pointerEvents: "none" }),
      painted: true,
    };
    expect(occludes(view, tooltip)).toBe(true);
    // ...and would be missed without the backstop, which is what the dev-mode
    // warning in browserHost exists to catch.
    expect(occludes(view, { ...tooltip, painted: false })).toBe(false);
  });

  it("catches a small context menu over the page", () => {
    const menu: Candidate = {
      rect: { x: 400, y: 300, width: 190, height: 220 },
      style: style({ position: "fixed" }),
    };
    expect(occludes(view, menu)).toBe(true);
  });

  it("catches a dropdown that only clips the page by a few rows", () => {
    const dropdown: Candidate = {
      rect: { x: 60, y: 60, width: 240, height: 120 },
      style: style({ position: "absolute" }),
    };
    expect(occludes(view, dropdown)).toBe(true);
  });

  it("catches a full-screen dialog backdrop", () => {
    const backdrop: Candidate = {
      rect: { x: 0, y: 0, width: 1440, height: 900 },
      style: style({ position: "fixed" }),
    };
    expect(occludes(view, backdrop)).toBe(true);
  });

  it("leaves ordinary in-flow chrome alone even where it touches the pane", () => {
    const toolbar: Candidate = {
      rect: { x: 54, y: 40, width: 1386, height: 40 },
      style: style(),
    };
    expect(occludes(view, toolbar)).toBe(false);
  });

  it("leaves a positioned box that misses the pane alone", () => {
    const rail: Candidate = {
      rect: { x: 0, y: 0, width: 54, height: 900 },
      style: style({ position: "absolute" }),
    };
    expect(occludes(view, rail)).toBe(false);
  });

  it("counts a listed toast that reaches the pane, though it takes no clicks", () => {
    const toast: Candidate = {
      rect: { x: 900, y: 700, width: 400, height: 60 },
      style: style({ position: "fixed", pointerEvents: "none" }),
      painted: true,
    };
    expect(occludes(view, toast)).toBe(true);
  });

  it("does not blank the page for a toast that misses it", () => {
    const narrow = { x: 54, y: 76, width: 600, height: 400 };
    const toast: Candidate = {
      rect: { x: 1100, y: 800, width: 300, height: 60 },
      style: style({ position: "fixed", pointerEvents: "none" }),
      painted: true,
    };
    expect(occludes(narrow, toast)).toBe(false);
  });
});

describe("firstOccluder", () => {
  it("names what covered the view, for the dev-mode warning", () => {
    const menu: Candidate = {
      rect: { x: 400, y: 300, width: 190, height: 220 },
      style: style({ position: "fixed" }),
    };
    const chrome: Candidate = { rect: { x: 54, y: 40, width: 1386, height: 40 }, style: style() };
    expect(firstOccluder(view, [chrome, menu])).toBe(menu);
  });

  it("returns null when the pane is clear", () => {
    const chrome: Candidate = { rect: { x: 54, y: 40, width: 1386, height: 40 }, style: style() };
    expect(firstOccluder(view, [chrome])).toBeNull();
  });
});

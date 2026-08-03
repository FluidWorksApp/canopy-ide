import { describe, expect, it } from "vitest";
import { fitWidth, pixelScale, planAgentShot, scaleRect } from "./pageCapture";
import { previewShotContext, type PreviewShot } from "./preview";

const shot = (over: Partial<PreviewShot> = {}): PreviewShot => ({
  n: 1,
  path: "/w/.canopy/shot-1.png",
  thumb: "data:image/png;base64,AA",
  width: 800,
  height: 600,
  region: false,
  pageUrl: "http://localhost:5173/settings",
  note: "",
  ...over,
});

describe("pixelScale", () => {
  it("is the retina backing scale when the snapshot came back at full size", () => {
    expect(pixelScale(2560, 1280)).toBe(2);
  });

  it("is below 1 when the platform downscaled to a max width", () => {
    expect(pixelScale(1200, 1600)).toBe(0.75);
  });

  // A rect scaled by a garbage factor would silently crop the wrong thing;
  // 1 at least yields the region the page actually pointed at, unscaled.
  it("falls back to 1 rather than dividing by a zero or missing width", () => {
    expect(pixelScale(0, 1280)).toBe(1);
    expect(pixelScale(2560, 0)).toBe(1);
  });
});

describe("scaleRect", () => {
  const png = { width: 2000, height: 1000 };

  it("scales a page-space rect into image pixels", () => {
    expect(scaleRect({ x: 10, y: 20, w: 100, h: 50 }, 2, png)).toEqual({
      x: 20,
      y: 40,
      w: 200,
      h: 100,
    });
  });

  // A drag can end past the edge of the view: the page clamps to the viewport,
  // but rounding at 2x can still push the far edge a pixel beyond the bitmap,
  // and drawImage would read outside it.
  it("clamps a rect that runs off the right or bottom edge", () => {
    expect(scaleRect({ x: 900, y: 400, w: 200, h: 200 }, 2, png)).toEqual({
      x: 1800,
      y: 800,
      w: 200,
      h: 200,
    });
  });

  it("refuses a selection that is a stray click rather than a drag", () => {
    expect(scaleRect({ x: 5, y: 5, w: 0.4, h: 0.4 }, 2, png)).toBeNull();
  });
});

describe("fitWidth", () => {
  it("shrinks to the cap, keeping the aspect ratio", () => {
    expect(fitWidth({ width: 3200, height: 1800 }, 1600)).toEqual({
      width: 1600,
      height: 900,
    });
  });

  it("leaves something already narrower alone rather than blowing it up", () => {
    expect(fitWidth({ width: 400, height: 300 }, 1600)).toEqual({
      width: 400,
      height: 300,
    });
  });
});

describe("planAgentShot", () => {
  // The complaint this answers: an agent had to have the preview tab in front
  // to photograph it, on an engine where being in front was never the
  // requirement — WKWebView's snapshot is the page painting itself, not a read
  // of the screen. A background tab is captured where it stands.
  const backgrounded = {
    native: true,
    opened: true,
    painted: false,
    rect: { x: 0, y: 0, width: 0, height: 0 },
  };

  it("captures a webview-engine tab that isn't in front", () => {
    expect(planAgentShot(backgrounded)).toEqual({ take: "view" });
  });

  it("captures the front tab the same way — one path, whatever is on screen", () => {
    expect(
      planAgentShot({
        native: true,
        opened: true,
        painted: true,
        rect: { x: 0, y: 40, width: 900, height: 600 },
      }),
    ).toEqual({ take: "view" });
  });

  // display: none placeholder, so the rect is zeros. The size has to come back
  // from the view, and never from here.
  it("never reads the pane's rect for a native view", () => {
    const plan = planAgentShot({ ...backgrounded, rect: null });
    expect(plan).toEqual({ take: "view" });
  });

  it("says so when the tab has never been shown, so there is no page yet", () => {
    const plan = planAgentShot({ ...backgrounded, opened: false });
    expect(plan.take).toBe("no");
    if (plan.take === "no") {
      expect(plan.reason).toContain("canopy_browser_navigate");
    }
  });

  it("crops this window for a proxy preview that is on screen", () => {
    const rect = { x: 12, y: 40, width: 900, height: 600 };
    expect(
      planAgentShot({ native: false, opened: true, painted: true, rect }),
    ).toEqual({ take: "rect", rect });
  });

  // The one real refusal: the pixels at a backgrounded iframe's rect belong to
  // whichever tab IS in front, and a picture of the wrong tab is worse than
  // none. It must not offer to front the tab itself.
  it("refuses a backgrounded proxy preview rather than photographing another tab", () => {
    const plan = planAgentShot({
      native: false,
      opened: true,
      painted: false,
      rect: { x: 12, y: 40, width: 900, height: 600 },
    });
    expect(plan.take).toBe("no");
    if (plan.take === "no") {
      expect(plan.reason).toContain("canopy_browser_snapshot");
      expect(plan.reason).toContain("webview engine");
    }
  });

  it("refuses a proxy preview with no box to crop to", () => {
    expect(
      planAgentShot({
        native: false,
        opened: true,
        painted: true,
        rect: { x: 0, y: 0, width: 0, height: 0 },
      }).take,
    ).toBe("no");
  });
});

describe("previewShotContext", () => {
  it("hands over paths, not pixels, and says to open them", () => {
    const brief = previewShotContext("http://localhost:5173/settings", [
      shot(),
    ]);
    expect(brief).toContain("/w/.canopy/shot-1.png");
    expect(brief).toContain("open them with your file tools");
    expect(brief).toContain("a screenshot");
  });

  it("carries each note, and says which shots were regions", () => {
    const brief = previewShotContext("http://localhost:5173/", [
      shot({ n: 1, note: "this button is cut off" }),
      shot({ n: 2, path: "/w/.canopy/shot-2.png", region: true }),
    ]);
    expect(brief).toContain("2 screenshots");
    expect(brief).toContain("— this button is cut off");
    expect(brief).toContain("a region of the page");
  });

  // The whole brief is typed into a PTY, where a newline submits early.
  it("stays on one line even when a note has line breaks in it", () => {
    const brief = previewShotContext("http://localhost:5173/", [
      shot({ note: "fix this\nand that\n\nplease" }),
    ]);
    expect(brief).not.toContain("\n");
  });

  it("names the serving component when the page is linked to one", () => {
    const brief = previewShotContext("http://localhost:5173/", [shot()], {
      url: "http://localhost:5173",
      port: 5173,
      ptyId: 1,
      title: "web",
      cwd: "/w/apps/web",
      componentLabel: "web",
      componentPath: "/w/apps/web",
      run: true,
    });
    expect(brief).toContain("/w/apps/web");
    expect(brief).toContain("that is the codebase to change");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PreviewAnnotation, PreviewShot } from "./preview";
import {
  getVibePreviewContext,
  publishVibePreviewContext,
  removeVibePreviewContext,
  subscribeVibePreviewContext,
  vibePreviewBrief,
  type VibePreviewContext,
} from "./vibePreviewContext";

const annotation = (sent = false): PreviewAnnotation => ({
  n: 1,
  selector: "#save",
  tag: "button",
  id: "save",
  classes: "primary",
  text: "Save",
  html: "<button id=\"save\">Save</button>",
  components: ["SaveButton"],
  rect: { x: 1, y: 2, w: 30, h: 12 },
  pageUrl: "http://localhost:3000/settings",
  pageTitle: "Settings",
  comment: "Make this clearer",
  sent,
});

const shot = (sent = false): PreviewShot => ({
  n: 1,
  path: "/project/.canopy/spot/page.png",
  thumb: "data:image/png;base64,AA==",
  width: 800,
  height: 600,
  region: false,
  pageUrl: "http://localhost:3000/settings",
  note: "Align the card",
  sent,
});

const context = (over: Partial<VibePreviewContext> = {}): VibePreviewContext => ({
  projectId: "project",
  tabId: "preview",
  url: "http://localhost:3000/settings",
  server: null,
  annotations: [annotation()],
  shots: [shot()],
  picking: false,
  capturing: false,
  captureMode: "visible",
  go: vi.fn(),
  navigate: vi.fn(),
  togglePicking: vi.fn(),
  capture: vi.fn(),
  setAnnotationComment: vi.fn(),
  removeAnnotation: vi.fn(),
  clearAnnotations: vi.fn(),
  setShotNote: vi.fn(),
  removeShot: vi.fn(),
  clearShots: vi.fn(),
  markSent: vi.fn(),
  ...over,
});

describe("vibe preview context", () => {
  it("publishes one active preview per project and removes only its owner", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVibePreviewContext("project", listener);
    const first = context();
    publishVibePreviewContext(first);

    expect(getVibePreviewContext("project")).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);

    removeVibePreviewContext("project", "other-tab");
    expect(getVibePreviewContext("project")).toBe(first);

    removeVibePreviewContext("project", "preview");
    expect(getVibePreviewContext("project")).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("builds task context from pending annotations and screenshots only", () => {
    const brief = vibePreviewBrief(context());
    expect(brief).toContain("marked an element");
    expect(brief).toContain("Make this clearer");
    expect(brief).toContain("I took a screenshot");
    expect(brief).toContain("Align the card");

    expect(vibePreviewBrief(context({
      annotations: [annotation(true)],
      shots: [shot(true)],
    }))).toBe("");
  });

  it("keeps Build edge-to-edge while Engineer retains the detailed preview panel", () => {
    const source = readFileSync(join(process.cwd(), "src/components/PreviewView.tsx"), "utf8");
    expect(source).toContain('{!buildMode && <div className="preview-toolbar">');
    expect(source).toContain("!buildMode && !feedbackPanelHidden");
    expect(source).toContain("publishVibePreviewContext({");
  });
});

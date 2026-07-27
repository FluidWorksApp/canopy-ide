import { describe, expect, it } from "vitest";
import {
  CAPTURE_INTERVAL_MS,
  frameSrc,
  paneState,
  shouldCapture,
  type CaptureInput,
  type PaneInput,
} from "./browserFrame";

const pane = (o: Partial<PaneInput> = {}): PaneInput => ({
  native: true,
  wanted: true,
  shown: true,
  frame: null,
  ...o,
});

describe("paneState", () => {
  it("shows nothing in the DOM while the native view is painting", () => {
    expect(paneState(pane({ shown: true, frame: "abc" }))).toBe("live");
  });

  // The reported bug: a side panel opened, the view hid, and what was revealed
  // read as a crashed page rather than a covered one.
  it("freezes the last frame when an overlay pushes the view off screen", () => {
    expect(paneState(pane({ shown: false, frame: "abc" }))).toBe("frozen");
  });

  it("falls back to the app's own background before any frame exists", () => {
    expect(paneState(pane({ shown: false, frame: null }))).toBe("empty");
  });

  it("shows nothing for the proxy engine, which paints its own page", () => {
    expect(paneState(pane({ native: false, shown: false, frame: "abc" }))).toBe("empty");
  });

  it("does not freeze a tab that isn't in front — the pane is gone anyway", () => {
    expect(paneState(pane({ wanted: false, shown: false, frame: "abc" }))).toBe("empty");
  });
});

const cap = (o: Partial<CaptureInput> = {}): CaptureInput => ({
  native: true,
  shown: true,
  loading: false,
  lastCaptureAt: 0,
  now: 10_000,
  dirty: false,
  inFlight: false,
  ...o,
});

describe("shouldCapture", () => {
  it("captures a settled, visible page", () => {
    expect(shouldCapture(cap())).toBe(true);
  });

  // A hidden WKWebView snapshots to nothing, so the moment the frame is needed
  // is exactly the moment it can no longer be taken. Hence capturing ahead.
  it("never captures a view that is already hidden", () => {
    expect(shouldCapture(cap({ shown: false }))).toBe(false);
  });

  it("waits for a page that is still arriving", () => {
    expect(shouldCapture(cap({ loading: true }))).toBe(false);
  });

  it("does not stack captures on top of each other", () => {
    expect(shouldCapture(cap({ inFlight: true }))).toBe(false);
  });

  it("does nothing on an engine with no native view", () => {
    expect(shouldCapture(cap({ native: false }))).toBe(false);
  });

  it("holds off until the interval has passed", () => {
    const now = 10_000;
    expect(shouldCapture(cap({ now, lastCaptureAt: now - CAPTURE_INTERVAL_MS + 1 }))).toBe(false);
    expect(shouldCapture(cap({ now, lastCaptureAt: now - CAPTURE_INTERVAL_MS }))).toBe(true);
  });

  it("ignores the interval when the held frame is known to be wrong", () => {
    const now = 10_000;
    expect(shouldCapture(cap({ now, lastCaptureAt: now, dirty: true }))).toBe(true);
  });

  it("still refuses a dirty frame it cannot take", () => {
    expect(shouldCapture(cap({ dirty: true, shown: false }))).toBe(false);
    expect(shouldCapture(cap({ dirty: true, loading: true }))).toBe(false);
  });
});

describe("frameSrc", () => {
  it("wraps the capture as something an img can show", () => {
    expect(frameSrc("QUJD")).toBe("data:image/jpeg;base64,QUJD");
  });
});

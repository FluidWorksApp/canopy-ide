import { describe, expect, it } from "vitest";
import {
  CAPTURE_RETRY_MS,
  frameSrc,
  paneState,
  releaseFrameSrc,
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
  lastCaptureAt: 0,
  now: 10_000,
  dirty: false,
  inFlight: false,
  ...o,
});

describe("shouldCapture", () => {
  it("does not recapture a clean, visible page on every host pass", () => {
    expect(shouldCapture(cap())).toBe(false);
  });

  // A hidden WKWebView snapshots to nothing, so the moment the frame is needed
  // is exactly the moment it can no longer be taken. Hence capturing ahead.
  it("never captures a view that is already hidden", () => {
    expect(shouldCapture(cap({ shown: false }))).toBe(false);
  });

  // Regression: capturing used to be gated on a "page has loaded" flag set by
  // a single navigation event. A listener that missed that event — which a
  // re-subscribing effect does — latched the view as forever-loading, so it
  // never captured again and every overlay showed a blank pane instead of the
  // page. A frame of a half-loaded page is replaced on the next known change or
  // hide transition; a gate that sticks is not.
  it("captures a page that may still be loading, rather than risk never capturing", () => {
    expect(shouldCapture(cap({ dirty: false }))).toBe(false);
    expect(shouldCapture(cap({ dirty: true }))).toBe(true);
  });

  it("does not stack captures on top of each other", () => {
    expect(shouldCapture(cap({ inFlight: true }))).toBe(false);
  });

  it("does nothing on an engine with no native view", () => {
    expect(shouldCapture(cap({ native: false }))).toBe(false);
  });

  it("captures when the held frame is known to be wrong", () => {
    expect(shouldCapture(cap({ dirty: true }))).toBe(true);
  });

  it("bounds retries when a dirty capture fails or comes back empty", () => {
    const now = 10_000;
    expect(
      shouldCapture(cap({ dirty: true, now, lastCaptureAt: now - CAPTURE_RETRY_MS + 1 })),
    ).toBe(false);
    expect(
      shouldCapture(cap({ dirty: true, now, lastCaptureAt: now - CAPTURE_RETRY_MS })),
    ).toBe(true);
  });

  it("still refuses a dirty frame it cannot take", () => {
    expect(shouldCapture(cap({ dirty: true, shown: false }))).toBe(false);
    expect(shouldCapture(cap({ dirty: true, inFlight: true }))).toBe(false);
  });
});

describe("frameSrc", () => {
  it("wraps the capture as a releasable image source", () => {
    const src = frameSrc("QUJD");
    expect(src.startsWith("blob:") || src === "data:image/jpeg;base64,QUJD").toBe(true);
    releaseFrameSrc(src);
  });

  it("does not try to revoke fallback data URLs", () => {
    expect(() => releaseFrameSrc("data:image/jpeg;base64,QUJD")).not.toThrow();
  });
});

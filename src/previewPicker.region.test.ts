// Drives the real injected picker (src-tauri/src/preview_picker.js) in jsdom,
// through the same entry point the webview engine uses: window.__canopyBrowser.
// The region overlay lives in the page, not in this app's DOM, so this is the
// only place its behaviour can be checked without a packaged build — and the
// ordering it guarantees (overlay torn down BEFORE the answer is sent) is the
// difference between a screenshot and a picture of the dimming layer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The real thing, as text — the same bytes preview.rs and browser.rs inject.
import SCRIPT from "../src-tauri/src/preview_picker.js?raw";

interface PickerBridge {
  cmd: (d: Record<string, unknown>) => unknown;
  drain: () => Record<string, unknown>[];
}

const picker = (): PickerBridge =>
  (window as unknown as { __canopyBrowser: PickerBridge }).__canopyBrowser;

/** The dimming layer the picker puts up for a drag: a fixed, full-bleed div
 *  above everything. Identified structurally rather than by a class, because
 *  the script styles inline and has no classes to look for. */
const backdrop = (): HTMLElement | undefined =>
  Array.from(document.documentElement.children).find(
    (el): el is HTMLElement =>
      el instanceof HTMLElement &&
      el.style.position === "fixed" &&
      el.style.inset === "0px" &&
      el.style.cursor === "crosshair",
  );

const mouse = (
  type: string,
  x: number,
  y: number,
  on: EventTarget = document,
) =>
  on.dispatchEvent(
    new MouseEvent(type, {
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }),
  );

describe("preview picker: region select", () => {
  beforeEach(() => {
    // Held, not advanced. The script's doorbell (a cancelled navigation to
    // canopy-drain:) is a real webview mechanism jsdom can only complain
    // about, and nothing here needs it — drain() reads the outbox directly.
    vi.useFakeTimers();
    document.documentElement.innerHTML = "<head></head><body></body>";
    const w = window as unknown as Record<string, unknown>;
    // The native transport: no parent to postMessage to, an outbox to drain.
    w.__canopyNativeBrowser = true;
    delete w.__canopyPicker;
    delete w.__canopyBrowser;
    new Function(SCRIPT)();
    picker().drain(); // discard the "ready" announcement
  });

  afterEach(() => vi.useRealTimers());

  it("puts a backdrop up on request and takes it down again", () => {
    expect(backdrop()).toBeUndefined();
    picker().cmd({ canopy: "region", on: true });
    expect(backdrop()).toBeDefined();
    picker().cmd({ canopy: "region", on: false });
    expect(backdrop()).toBeUndefined();
  });

  it("reports the dragged rect in viewport pixels, normalised", () => {
    picker().cmd({ canopy: "region", on: true });
    const pad = backdrop()!;
    mouse("mousedown", 40, 60, pad);
    mouse("mousemove", 140, 130);
    mouse("mouseup", 140, 130);
    expect(picker().drain()).toContainEqual({
      canopy: "region-done",
      rect: { x: 40, y: 60, w: 100, h: 70 },
    });
  });

  // Dragging up-and-left is a normal way to select; a negative width would
  // crop nothing at all.
  it("handles a drag that runs backwards", () => {
    picker().cmd({ canopy: "region", on: true });
    mouse("mousedown", 200, 200, backdrop()!);
    mouse("mousemove", 50, 80);
    mouse("mouseup", 50, 80);
    expect(picker().drain()).toContainEqual({
      canopy: "region-done",
      rect: { x: 50, y: 80, w: 150, h: 120 },
    });
  });

  // The host snapshots the moment it hears; if the overlay were still up when
  // the message went out, every region capture would come back dimmed.
  it("removes the overlay before it answers, not after", () => {
    picker().cmd({ canopy: "region", on: true });
    mouse("mousedown", 10, 10, backdrop()!);
    mouse("mousemove", 200, 200);
    mouse("mouseup", 200, 200);
    expect(backdrop()).toBeUndefined();
    expect(picker().drain()).toHaveLength(1);
  });

  it("treats a click without a drag as a miss, not a 1px capture", () => {
    picker().cmd({ canopy: "region", on: true });
    mouse("mousedown", 70, 70, backdrop()!);
    mouse("mouseup", 71, 71);
    expect(picker().drain()).toContainEqual({ canopy: "region-cancel" });
  });

  it("cancels on Escape, mid-drag", () => {
    picker().cmd({ canopy: "region", on: true });
    mouse("mousedown", 10, 10, backdrop()!);
    mouse("mousemove", 300, 300);
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(backdrop()).toBeUndefined();
    expect(picker().drain()).toContainEqual({ canopy: "region-cancel" });
  });

  // Two crosshairs at once means a click either tags an element or draws a
  // box, and the user cannot tell which.
  it("turns annotate mode off when region mode comes on", () => {
    picker().cmd({ canopy: "mode", on: true });
    expect(document.documentElement.style.cursor).toBe("crosshair");
    picker().cmd({ canopy: "region", on: true });
    expect(document.documentElement.style.cursor).toBe("");
    // And the page's own click handlers stay unreached: the drag goes to the
    // backdrop, which is above everything the page drew.
    const hit = { count: 0 };
    document.body.addEventListener("click", () => (hit.count += 1));
    mouse("mousedown", 10, 10, backdrop()!);
    mouse("mouseup", 90, 90);
    expect(hit.count).toBe(0);
  });

  it("does not leak a stale answer from an abandoned drag", () => {
    picker().cmd({ canopy: "region", on: true });
    mouse("mousedown", 10, 10, backdrop()!);
    picker().cmd({ canopy: "region", on: false }); // host gave up
    mouse("mouseup", 200, 200);
    expect(picker().drain()).toEqual([]);
  });
});

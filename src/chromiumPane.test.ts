// The pane's one real decision: when a size change is worth restarting the
// stream for. A pane drag emits hundreds of sizes and each restart costs a
// round trip and shows a gap, so this has to reject nearly all of them.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({
  chromiumStartCast: vi.fn(() => Promise.resolve()),
  chromiumStopCast: vi.fn(() => Promise.resolve()),
  chromiumMetrics: vi.fn(() => Promise.resolve(null)),
  onChromiumFrame: vi.fn(() => Promise.resolve(() => {})),
  onChromiumNav: vi.fn(() => Promise.resolve(() => {})),
}));

import * as ipc from "./ipc";
import { paneToPage, useChromiumFrame, worthRecasting } from "./chromiumPane";

describe("worthRecasting", () => {
  it("always casts the first time", () => {
    expect(worthRecasting(null, { width: 800, height: 600 })).toBe(true);
  });

  it("ignores the jitter of a drag", () => {
    const from = { width: 800, height: 600 };
    expect(worthRecasting(from, { width: 803, height: 600 })).toBe(false);
    expect(worthRecasting(from, { width: 800, height: 604 })).toBe(false);
    expect(worthRecasting(from, from)).toBe(false);
  });

  it("recasts once a pane has genuinely changed shape", () => {
    const from = { width: 800, height: 600 };
    expect(worthRecasting(from, { width: 812, height: 600 })).toBe(true);
    expect(worthRecasting(from, { width: 800, height: 588 })).toBe(true);
  });

  // A collapsed pane happens mid-drag and while a tab is transitioning. Casting
  // into a zero-sized box asks Chrome for frames nobody will ever see.
  it("never casts into a collapsed pane", () => {
    expect(worthRecasting({ width: 800, height: 600 }, { width: 0, height: 600 })).toBe(false);
    expect(worthRecasting(null, { width: 800, height: 0 })).toBe(false);
  });
});

// Annotation on this engine lives or dies on this mapping: the page never sees
// a mouse, so "where did the user click" is entirely this function's answer.
describe("paneToPage", () => {
  const page = { width: 1000, height: 500 };

  it("maps a point straight through when the picture fills the pane exactly", () => {
    expect(paneToPage({ x: 100, y: 50 }, { width: 1000, height: 500 }, page)).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("undoes a uniform scale", () => {
    // Half size: a click at 50,25 in the picture is 100,50 in the page.
    expect(paneToPage({ x: 50, y: 25 }, { width: 500, height: 250 }, page)).toEqual({
      x: 100,
      y: 50,
    });
  });

  // The whole reason this is not a two-line division. A tall pane letterboxes
  // top and bottom, and ignoring the offset annotates the wrong element.
  it("accounts for letterboxing when the pane is taller than the page", () => {
    // pane 1000x1000, page 1000x500 -> scale 1, picture 1000x500, top offset 250
    expect(paneToPage({ x: 10, y: 250 }, { width: 1000, height: 1000 }, page)).toEqual({
      x: 10,
      y: 0,
    });
    expect(paneToPage({ x: 10, y: 750 }, { width: 1000, height: 1000 }, page)).toEqual({
      x: 10,
      y: 500,
    });
  });

  it("accounts for pillarboxing when the pane is wider than the page", () => {
    // pane 2000x500, page 1000x500 -> scale 1, picture 1000 wide, left offset 500
    expect(paneToPage({ x: 500, y: 10 }, { width: 2000, height: 500 }, page)).toEqual({
      x: 0,
      y: 10,
    });
  });

  // A click in the letterbox is not a click on the page's nearest edge; it is
  // not a click on the page at all, and reporting an edge would silently
  // annotate whatever happens to sit there.
  it("rejects a point in the letterbox rather than clamping it", () => {
    expect(paneToPage({ x: 10, y: 100 }, { width: 1000, height: 1000 }, page)).toBeNull();
    expect(paneToPage({ x: 10, y: 900 }, { width: 1000, height: 1000 }, page)).toBeNull();
    expect(paneToPage({ x: 100, y: 10 }, { width: 2000, height: 500 }, page)).toBeNull();
  });

  it("has no answer before the page has reported a size", () => {
    expect(paneToPage({ x: 1, y: 1 }, { width: 100, height: 100 }, { width: 0, height: 0 })).toBeNull();
    expect(paneToPage({ x: 1, y: 1 }, { width: 0, height: 0 }, page)).toBeNull();
  });
});

// The stuck-placeholder race: the pane measures itself before the tab has
// opened, so the first start-cast fails. If that failure still counted as "the
// cast is running at this size", no retry would ever happen and the pane would
// show "Starting the browser…" forever.
describe("useChromiumFrame", () => {
  const box = { width: 800, height: 600 };

  it("retries the cast after a start that failed", async () => {
    const start = vi.mocked(ipc.chromiumStartCast);
    start.mockClear();
    start.mockRejectedValueOnce(new Error("no Chromium browser is open for tab t"));
    const { result } = renderHook(() => useChromiumFrame("t", true));
    act(() => result.current.fit(box));
    // Let the rejection land — it is what forgets the recorded size.
    await act(async () => {});
    act(() => result.current.fit(box));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("does not restart a cast that succeeded for an unchanged pane", async () => {
    const start = vi.mocked(ipc.chromiumStartCast);
    start.mockClear();
    const { result } = renderHook(() => useChromiumFrame("t", true));
    act(() => result.current.fit(box));
    await act(async () => {});
    act(() => result.current.fit(box));
    expect(start).toHaveBeenCalledTimes(1);
  });
});

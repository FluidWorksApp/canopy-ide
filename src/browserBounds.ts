// Geometry and engine choice for the embedded browser — the parts that are
// pure arithmetic, kept out of the view so they can be tested.
//
// A child webview is a native view the compositor places over the window, so
// the app can only tell it WHERE to be. The placeholder div in PreviewView
// reports a CSS-pixel rect; the webview wants logical points relative to the
// window's client area. Those differ by exactly the window zoom (Cmd +/-, see
// zoom.ts): Tauri's setZoom is a real webview magnification, so one CSS pixel
// covers `zoom` points.

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The webview's placement for a placeholder rect, clipped to the viewport.
 *
 *  Clipping matters because the webview draws over the window, not inside a
 *  pane: a placeholder scrolled or laid out past an edge would otherwise paint
 *  the page across the app's chrome. An off-screen or collapsed placeholder
 *  comes back zero-sized, which callers read as "nothing to show". */
export function webviewBounds(
  rect: RectLike,
  viewport: { width: number; height: number },
  zoom: number,
): Bounds {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.max(left, Math.min(viewport.width, rect.x + rect.width));
  const bottom = Math.max(top, Math.min(viewport.height, rect.y + rect.height));
  const z = zoom > 0 ? zoom : 1;
  // Edges are rounded, then the size is derived from them. Rounding position
  // and size independently drifts them apart, and a browser view a pixel wider
  // than its placeholder covers the pane divider next to it.
  const x = Math.round(left * z);
  const y = Math.round(top * z);
  return {
    x,
    y,
    width: Math.round(right * z) - x,
    height: Math.round(bottom * z) - y,
  };
}

/** Whether a rect is big enough to be worth showing. Sub-pixel slivers happen
 *  during pane drags and while a tab is mid-transition. */
export function showable(b: Bounds): boolean {
  return b.width >= 2 && b.height >= 2;
}

export function sameBounds(a: Bounds | null, b: Bounds | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Do two rects touch at all? Used to decide whether an open overlay actually
 *  covers the browser — a full-screen dialog always does, a corner toast
 *  usually doesn't, and blanking the page for a toast would be worse than the
 *  toast being clipped. */
export function overlaps(a: RectLike, b: RectLike): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

export type BrowserEngine = "webview" | "proxy";

/** Which engine a preview tab actually runs on. The setting is the user's
 *  preference; `supported` is the platform's veto — only macOS has the child
 *  webview, so everywhere else falls back to the proxy rather than showing an
 *  empty pane. */
export function chooseEngine(setting: BrowserEngine, supported: boolean): BrowserEngine {
  return setting === "webview" && supported ? "webview" : "proxy";
}

// The freeze-frame: what a preview pane shows while its native view is hidden.
//
// A child webview has to get out of the way of anything drawn over it, and side
// panels and menus open constantly — so "hidden" is not a rare state, it is
// most of a normal minute. Hiding it revealed the placeholder underneath, which
// read as the page having crashed rather than the menu having opened.
//
// So the pane keeps the last picture of itself and paints that instead. The
// page appears frozen under the overlay, which is what a still image of a page
// looks like, rather than gone.
//
// The frame is deliberately allowed to be slightly stale. Capturing at the
// moment of hiding would mean waiting on an async snapshot with the overlay
// already painted underneath the webview — trading a blank flash for a torn
// one. Capturing while the view is visible and quiet costs nothing anybody
// sees, and a page that has not changed since is the overwhelming majority of
// them. A page mid-animation freezes a frame or two behind; that is what a
// freeze-frame is.

/** What the placeholder div should be showing. */
export type PaneState =
  /** The native view is on screen and painting; the DOM shows nothing. */
  | "live"
  /** Covered by an overlay, with a picture of the page to stand in for it. */
  | "frozen"
  /** Nothing to show but the app's own background — before the first frame
   *  exists, or on an engine that has no native view. Never white. */
  | "empty";

export interface PaneInput {
  /** Is the webview engine in use at all? */
  native: boolean;
  /** Does the view want to be on screen (right tab, right project, has a URL)? */
  wanted: boolean;
  /** Is it actually shown, or has an occluder pushed it off? */
  shown: boolean;
  frame: string | null;
}

export function paneState({ native, wanted, shown, frame }: PaneInput): PaneState {
  if (!native || !wanted) return "empty";
  if (shown) return "live";
  return frame ? "frozen" : "empty";
}

/** Least time between two captures of the same view. A capture is a real
 *  render plus a JPEG encode plus an IPC hop, and nothing needs it faster than
 *  this — the frame only has to be right at the moment something covers it. */
export const CAPTURE_INTERVAL_MS = 900;

export interface CaptureInput {
  native: boolean;
  /** Only a view that is actually painting can be captured; a hidden WKWebView
   *  snapshots to nothing. */
  shown: boolean;
  /** No point capturing a page that is still arriving. */
  loading: boolean;
  lastCaptureAt: number;
  now: number;
  /** Set when the page navigated or an agent acted on it — the held frame is
   *  known to be wrong, so the interval doesn't apply. */
  dirty: boolean;
  /** A capture already in flight; two at once would just queue renders. */
  inFlight: boolean;
}

export function shouldCapture(c: CaptureInput): boolean {
  if (!c.native || !c.shown || c.loading || c.inFlight) return false;
  if (c.dirty) return true;
  return c.now - c.lastCaptureAt >= CAPTURE_INTERVAL_MS;
}

/** A captured JPEG as something an <img> can show. */
export function frameSrc(base64: string): string {
  return `data:image/jpeg;base64,${base64}`;
}

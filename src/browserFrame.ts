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
// A frame is captured when the view first appears, whenever Canopy knows the
// page changed, and once more as the native view is hidden. Do not photograph a
// quiet page on a timer: every capture crosses the native/renderer boundary as
// a fresh base64 string and used to become a unique decoded data URL. WebKit
// can retain those resources long after JavaScript drops the last reference;
// that cadence is the leading candidate for the observed double-digit-GiB
// footprint.

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

export interface CaptureInput {
  native: boolean;
  /** A view off screen has no frame to prepare. The hide transition itself
   *  takes one final picture directly in browserHost. */
  shown: boolean;
  lastCaptureAt: number;
  now: number;
  /** Set when the page navigated or an agent acted on it — the held frame is
   *  known to be wrong. New views start dirty, so this is also the initial
   *  capture gate. */
  dirty: boolean;
  /** A capture already in flight; two at once would just queue renders. */
  inFlight: boolean;
}

/** A failed/empty capture leaves the view dirty. Bound retries so a broken
 * platform snapshot API cannot become a render/encode/IPC hot loop. */
export const CAPTURE_RETRY_MS = 1_000;

/** Whether to take a picture now.
 *
 *  Deliberately NOT gated on the page having finished loading. It was, and that
 *  was the bug: "loaded" arrived as one navigation event, and a listener that
 *  missed it — which a constantly re-subscribing effect will — latched the view
 *  as forever-loading, so it never captured again for the whole life of the
 *  tab, silently. A blank frame from a page mid-load costs nothing because the
 *  next pass replaces it; a gate that can stick costs the entire feature. */
export function shouldCapture(c: CaptureInput): boolean {
  if (!c.native || !c.shown || c.inFlight) return false;
  if (!c.dirty) return false;
  return c.lastCaptureAt === 0 || c.now - c.lastCaptureAt >= CAPTURE_RETRY_MS;
}

/** A captured JPEG as something an <img> can show.
 *
 * Blob URLs have an explicit lifetime. The old data-URL implementation gave
 * every snapshot a new cache key that WebKit could retain indefinitely. Tests
 * and non-browser callers fall back to a data URL. */
export function frameSrc(base64: string): string {
  if (
    typeof window !== "undefined" &&
    typeof window.atob === "function" &&
    typeof window.Blob === "function" &&
    typeof window.URL?.createObjectURL === "function"
  ) {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return window.URL.createObjectURL(
      new window.Blob([bytes], { type: "image/jpeg" }),
    );
  }
  return `data:image/jpeg;base64,${base64}`;
}

/** Release a frame created by frameSrc. Data URLs need no explicit cleanup. */
export function releaseFrameSrc(src: string | null | undefined): void {
  if (
    src?.startsWith("blob:") &&
    typeof window !== "undefined" &&
    typeof window.URL?.revokeObjectURL === "function"
  ) {
    window.URL.revokeObjectURL(src);
  }
}

/** The frame decoded ahead of the swap. An <img> whose src just changed paints
 *  when the new bytes finish decoding, and a swap mid-decode shows the box's
 *  background for a frame — which, under a freeze-frame, is the blink the
 *  freeze-frame exists to prevent. Best effort: an environment without a real
 *  Image (tests) or a frame that refuses to decode still resolves, because an
 *  undecoded frame beats no frame. */
export function decodedFrame(src: string): Promise<void> {
  if (typeof Image === "undefined") return Promise.resolve();
  const img = new Image();
  img.src = src;
  return typeof img.decode === "function"
    ? img.decode().then(
        () => undefined,
        () => undefined,
      )
    : Promise.resolve();
}

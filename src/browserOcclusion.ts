// Deciding whether anything is painted over the embedded browser's rectangle.
//
// The first version of this asked a class list — ".modal-backdrop, .ctx-menu,
// …". That was a guess about which surfaces count as "an overlay", and it was
// wrong in the most ordinary way available: the side panel, the app's
// most-used floating surface and not a dialog by any reading, floats over the
// content area (`.side-peek-layer`, absolute, z-index 30) carrying none of
// those classes. So the browser sat on top of the COMPONENTS list and clipped
// it mid-item.
//
// The question is asked structurally now. Anything out of normal flow that
// overlaps the view's rectangle paints over it, whatever it is called and
// whoever added it. There is no list to keep up to date and nothing to
// remember, which is the only version of this that stays correct.
//
// Two things the structure alone can't settle, both handled here:
//
//   * A full-area wrapper that paints nothing. `.side-peek-layer` spans the
//     whole content region so it overlaps the browser permanently, but it is a
//     clipping container, not a surface — `pointer-events: none` is what says
//     so. Those are descended into rather than counted, and the painted child
//     inside them is what gets caught.
//   * A surface that paints but takes no clicks: a toast, the zoom chip. Those
//     are genuinely invisible to the structural test, so a small list of known
//     classes survives as a backstop — no longer the mechanism, just the last
//     few percent.

import { overlaps, type RectLike } from "./browserBounds";

/** The computed values the decision needs, read once per candidate. */
export interface OccluderStyle {
  position: string;
  zIndex: string;
  pointerEvents: string;
}

/** Surfaces that paint over content without taking clicks, so the structural
 *  test can't see them. Deliberately short: anything clickable is already
 *  covered, and this is only the backstop. browserHost warns in dev when it
 *  finds a click-through box over a visible browser that isn't listed here,
 *  which is how the next one gets found rather than shipped. */
export const PAINTED_OVERLAY_SELECTOR = [
  // Tooltips are the ordinary case: absolutely positioned, z-index 500, a real
  // background, and pointer-events: none so they never eat a hover.
  ".cnp-tooltip",
  ".notice",
  ".update-toast",
  ".dictation-pill",
  ".zoom-indicator",
  ".coach-layer",
  // The companion unmounts itself while a view is up (see useBrowserShowing),
  // so these should never be found over one. Listed anyway: the dev warning
  // that fires on an unlisted box over a visible browser is how the next
  // overlay gets found, and a mascot that slipped through would otherwise be
  // reported as an unknown occluder rather than a known bug.
  ".companion",
  ".companion-panel",
  ".companion-notice",
].join(",");

/** Is this element out of normal flow, and therefore able to paint over a
 *  sibling that isn't? Position is the real signal — every menu, panel,
 *  popover, flyout and dialog in the app is positioned — with an explicit
 *  stacking order as a second one, for the in-flow elements that lift
 *  themselves with z-index instead. */
export function stacksAboveFlow(s: OccluderStyle): boolean {
  if (s.position && s.position !== "static") return true;
  return s.zIndex !== "" && s.zIndex !== "auto";
}

/** Whether a stacked element is a surface or just a container for one.
 *
 *  `pointer-events: none` is the app's own way of saying "this box is a
 *  positioning frame, click through it" — which is exactly the set of elements
 *  that occupy space without painting in it. Treating them as occluders would
 *  hide the browser permanently; the walk descends into them instead. */
export function isSurface(s: OccluderStyle): boolean {
  return s.pointerEvents !== "none";
}

export interface Candidate {
  rect: RectLike;
  style: OccluderStyle;
  /** Matched PAINTED_OVERLAY_SELECTOR — a surface even if it takes no clicks. */
  painted?: boolean;
  /** Only so a log line or a violation can name what covered the page. Never
   *  read by the decision, which is why this stays testable without a DOM. */
  el?: Element;
}

/** Whether one candidate covers any part of the view. */
export function occludes(view: RectLike, c: Candidate): boolean {
  if (!stacksAboveFlow(c.style)) return false;
  if (!c.painted && !isSurface(c.style)) return false;
  return overlaps(view, c.rect);
}

/** The first thing found covering the view, or null when it is clear. Returns
 *  the candidate rather than a boolean so a dev-mode warning can name it. */
export function firstOccluder(view: RectLike, candidates: Candidate[]): Candidate | null {
  for (const c of candidates) if (occludes(view, c)) return c;
  return null;
}

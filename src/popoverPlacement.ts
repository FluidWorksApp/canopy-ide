// Where a popover that hangs above a status-bar chip goes. Pure, so the clamp
// rules are testable without a DOM: the caller measures the anchor and the
// window, this decides the box.
//
// The panel opens upward from the chip. Its height is never left to content —
// a panel taller than the space above the chip used to grow past the top of
// the window, taking its own header with it. Instead the available space is
// the ceiling (maxHeight) and the panel scrolls inside it.

export interface AnchorRect {
  top: number;
  left: number;
  right: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface PopoverPlacement {
  /** Fixed-position left edge, in viewport px. */
  left: number;
  /** Fixed-position distance from the viewport bottom to the panel's bottom. */
  bottom: number;
  /** The panel's width after shrinking to fit the viewport. */
  width: number;
  /** Tallest the panel may be and still keep its top on screen. */
  maxHeight: number;
}

export interface PlacementOptions {
  /** Preferred panel width. */
  width: number;
  /** Space between the anchor's top and the panel's bottom. */
  gap?: number;
  /** Minimum distance kept from every viewport edge. */
  margin?: number;
  /** Floor for maxHeight on a window too short to honour the margin. */
  minHeight?: number;
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(Math.max(n, lo), Math.max(lo, hi));

/** Right-align the panel to the anchor, then clamp it inside the viewport with
 *  `margin` on each side; open upward with maxHeight = the room above. */
export function placeAboveAnchor(
  anchor: AnchorRect,
  viewport: Viewport,
  { width, gap = 6, margin = 8, minHeight = 120 }: PlacementOptions,
): PopoverPlacement {
  const w = Math.max(0, Math.min(width, viewport.width - margin * 2));
  const left = clamp(anchor.right - w, margin, viewport.width - margin - w);
  // An anchor reported outside the window (scrolled status bar, stale rect)
  // still yields a panel inside it.
  const top = clamp(anchor.top, 0, viewport.height);
  let bottom = viewport.height - top + gap;
  let maxHeight = viewport.height - bottom - margin;
  // Too little room above the anchor (a very short window): keep a usable
  // panel by letting it slide down over the anchor rather than off the top.
  const floor = Math.max(0, Math.min(minHeight, viewport.height - margin * 2));
  if (maxHeight < floor) {
    maxHeight = floor;
    bottom = Math.max(margin, viewport.height - margin - floor);
  }
  return { left, bottom, width: w, maxHeight };
}

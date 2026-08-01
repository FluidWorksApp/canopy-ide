// Sticky stack chips for the horizontally scrolling tab strip.
//
// Scroll a crowded strip and the left of it used to simply leave: the chip
// naming what you were looking at went first, so the further you scrolled the
// less you knew about where you were. Section headers in a vertical list solve
// this by pinning; the same rule works sideways.
//
// One sticky header pushing out the next is the wrong half of that convention
// here, though — a vertical list shows one heading at a time because you read
// one section at a time, while a tab strip is one row you are meant to keep
// your place in. So the chips pile up instead: chip N holds `left: N × nub`, so
// a chip the next one has closed over collapses to a nub and stays on screen,
// and nothing is ever pushed off the left edge. Scroll to the far right of a
// crowded strip and the whole pile is still there, in order, saying what is
// behind you.
//
// CSS does the pinning — each chip's containing block is the strip itself (the
// runs are `display: contents`), which is what stops a chip being evicted when
// its own run ends. This module answers what CSS cannot: which chips the pile
// has closed over.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** Width of a chip collapsed into the pile. Mirrors `--tab-nub-w`; the two are
 *  held together by stickyChipGuard.test.ts, because the pile's arithmetic
 *  happens here and its layout happens there. */
export const NUB_W = 28;

/** Where chip `index` pins: behind it sit that many collapsed chips. */
export function pinOffset(index: number): number {
  return index * NUB_W;
}

/** The last chip the strip has scrolled onto, given each chip's natural
 *  (unpinned) left in strip coordinates, in strip order. That one is shown in
 *  full — it names the run you are actually in — and every chip before it is a
 *  nub. -1 when nothing is pinned.
 *
 *  Monotonic by construction: a chip is wider than a nub, so a chip that has
 *  reached its own pin has necessarily pushed every chip before it past theirs. */
export function pinnedThrough(scrollLeft: number, anchors: number[]): number {
  let last = -1;
  anchors.forEach((left, i) => {
    if (left < scrollLeft + pinOffset(i)) last = i;
  });
  return last;
}

/** Where the strip must scroll to for a tab to be genuinely visible, or null if
 *  it already is.
 *
 *  The pinned pile is the whole reason this isn't `scrollIntoView`: that call
 *  is happy to park a tab flush against the left edge, which is exactly where
 *  the chips are painted, so a tab you jumped to from the agents panel or the
 *  overflow menu could be "revealed" underneath them. Clearing `pinWidth` — the
 *  nubs, plus the tab's own chip pinned after them — is what makes it true. */
export function revealScroll(
  scrollLeft: number,
  viewport: number,
  tabLeft: number,
  tabWidth: number,
  pinWidth: number,
  pad = 8,
): number | null {
  if (tabLeft < scrollLeft + pinWidth) return Math.max(0, tabLeft - pinWidth - pad);
  if (tabLeft + tabWidth > scrollLeft + viewport)
    return Math.max(0, tabLeft + tabWidth - viewport + pad);
  return null;
}

/** Same chips, same verdicts. */
export function samePins(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k]);
}

/** Attribute a run element carries so the strip can be measured by run. */
export const GROUP_ATTR = "data-group-key";
/** The zero-width marker sitting where a chip would be if it weren't pinned.
 *  Measured instead of the chip itself: a pinned chip reports where it is being
 *  held, which is the answer this is trying to compute. */
export const ANCHOR_ATTR = "data-pin-anchor";

/** Which chips the pile has closed over, by run key. Recomputed on scroll, on
 *  resize, and after every render — the strip's contents move under a still
 *  scroll position every time a tab opens, closes or changes run.
 *
 *  Measurement is `offsetLeft`: a layout position, so a tab mid-slide from a
 *  regroup reports where it is going rather than where it momentarily appears,
 *  and the strip's own scrolling never fakes a move. */
export function useChipPins(
  containerRef: RefObject<HTMLElement | null>,
): Record<string, boolean> {
  const [nubs, setNubs] = useState<Record<string, boolean>>({});
  const nubsRef = useRef(nubs);
  nubsRef.current = nubs;

  const measure = useCallback(() => {
    const root = containerRef.current;
    // Hidden project: no layout to read, and nothing on screen to be wrong.
    if (!root || root.offsetParent === null) return;
    const anchors = [...root.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTR}]`)];
    const through = pinnedThrough(
      root.scrollLeft,
      anchors.map((a) => a.offsetLeft),
    );
    const next: Record<string, boolean> = {};
    anchors.forEach((a, i) => {
      const key = a.getAttribute(ANCHOR_ATTR);
      if (key && i < through) next[key] = true;
    });
    if (!samePins(nubsRef.current, next)) setNubs(next);
  }, [containerRef]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    // Scroll is the common case and fires only while scrolling; a resize
    // observer covers the strip growing, the sidebar moving, and the window.
    root.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => {
      root.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [containerRef, measure]);

  // After every render rather than on a content key: a tab renamed mid-run
  // moves every chip after it without changing anything a key would notice.
  useLayoutEffect(measure);

  return nubs;
}

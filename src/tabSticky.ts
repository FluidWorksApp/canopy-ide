// Sticky stack chips for the horizontally scrolling tab strip.
//
// Scroll a crowded strip and the left of it used to simply leave: the chip
// naming what you were looking at went first, so the further you scrolled the
// less you knew about where you were. Section headers in a vertical list solve
// this by pinning; the same rule works sideways. Each chip is `position:
// sticky; left: 0`, so it holds the left edge while its own tabs scroll past
// underneath, and is pushed out by the next chip exactly when its group ends.
//
// CSS does the pinning. This module answers the two questions CSS can't: is a
// chip currently pinned (so it can be shown as floating over the strip), and
// which of its tabs have scrolled behind it (so the chip can offer them as a
// dropdown instead of leaving them unreachable).
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** One tab's horizontal extent, in the strip's own coordinates. */
export interface TabExtent {
  id: string;
  left: number;
  width: number;
}

export interface StackOverflow {
  /** The group has scrolled past the left edge, so its chip is pinned there. */
  stuck: boolean;
  /** Ids hidden behind the pinned chip — off the left edge, or under the chip
   *  itself, which is just as invisible. */
  hidden: string[];
}

/** Pure geometry: where a group sits versus where the strip is scrolled to.
 *  `chipWidth` is the pinned chip's own width — a tab is only reachable once it
 *  clears it, since the chip is painted over the tabs sliding beneath. */
export function stackOverflow(
  scrollLeft: number,
  groupLeft: number,
  chipWidth: number,
  tabs: TabExtent[],
): StackOverflow {
  const edge = scrollLeft + chipWidth;
  return {
    stuck: groupLeft < scrollLeft,
    hidden: tabs.filter((t) => t.left + t.width <= edge).map((t) => t.id),
  };
}

/** Where the strip must scroll to for a tab to be genuinely visible, or null if
 *  it already is.
 *
 *  The pinned chip is the whole reason this isn't `scrollIntoView`: that call
 *  is happy to park a tab flush against the left edge, which is exactly where
 *  the chip is painted, so a tab you jumped to from the agents panel or the
 *  overflow menu could be "revealed" underneath it. Clearing `chipWidth` is
 *  what makes the reveal true. */
export function revealScroll(
  scrollLeft: number,
  viewport: number,
  tabLeft: number,
  tabWidth: number,
  chipWidth: number,
  pad = 8,
): number | null {
  if (tabLeft < scrollLeft + chipWidth) return Math.max(0, tabLeft - chipWidth - pad);
  if (tabLeft + tabWidth > scrollLeft + viewport)
    return Math.max(0, tabLeft + tabWidth - viewport + pad);
  return null;
}

/** Same groups, same verdicts. */
export function sameOverflow(
  a: Record<string, StackOverflow>,
  b: Record<string, StackOverflow>,
): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => {
    const x = a[k];
    const y = b[k];
    return (
      !!y &&
      x.stuck === y.stuck &&
      x.hidden.length === y.hidden.length &&
      x.hidden.every((id, i) => id === y.hidden[i])
    );
  });
}

/** Attribute a group element carries so the strip can be measured by group. */
export const GROUP_ATTR = "data-group-key";
/** Attribute each tab carries. Shared with the FLIP pass — the same elements. */
const TAB_ATTR = "data-flip-id";

/** Live overflow state per group, recomputed on scroll, on resize, and whenever
 *  the caller's `key` says the strip's contents changed.
 *
 *  Measurement is `offsetLeft`/`offsetWidth`: layout positions, so a tab
 *  mid-slide from a regroup reports where it is going rather than where it
 *  momentarily appears, and the strip's own scrolling never fakes a move. */
export function useStripOverflow(
  containerRef: RefObject<HTMLElement | null>,
  key: string,
): Record<string, StackOverflow> {
  const [state, setState] = useState<Record<string, StackOverflow>>({});
  const stateRef = useRef(state);
  stateRef.current = state;

  const measure = useCallback(() => {
    const root = containerRef.current;
    // Hidden project: no layout to read, and nothing on screen to be wrong.
    if (!root || root.offsetParent === null) return;
    const next: Record<string, StackOverflow> = {};
    for (const groupEl of root.querySelectorAll<HTMLElement>(`[${GROUP_ATTR}]`)) {
      const key = groupEl.getAttribute(GROUP_ATTR);
      if (!key) continue;
      const chip = groupEl.querySelector<HTMLElement>("[data-stack-chip]");
      const tabs = [...groupEl.querySelectorAll<HTMLElement>(`[${TAB_ATTR}]`)].map((el) => ({
        id: el.getAttribute(TAB_ATTR) ?? "",
        left: el.offsetLeft,
        width: el.offsetWidth,
      }));
      next[key] = stackOverflow(root.scrollLeft, groupEl.offsetLeft, chip?.offsetWidth ?? 0, tabs);
    }
    if (!sameOverflow(stateRef.current, next)) setState(next);
  }, [containerRef]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    measure();
    // Scroll is the common case and fires only while scrolling; a resize
    // observer covers the strip growing, the sidebar moving, and the window.
    root.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => {
      root.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [containerRef, measure, key]);

  return state;
}

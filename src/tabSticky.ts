// Sticky stack chips for the horizontally scrolling tab strip.
//
// Scroll a crowded strip and the left of it used to simply leave: the chip
// naming what you were looking at went first, so the further you scrolled the
// less you knew about where you were. Section headers in a vertical list solve
// this by pinning; the same rule works sideways.
//
// One full chip owns the edge at a time, like a conventional section header.
// Neither chip changes width or positioning mode during a handoff.
//
// CSS does the pinning. Each run is a real containing block, so its trailing
// edge pushes its header away while the next header arrives. This module only
// supplies reveal geometry and the final section's trailing scroll room.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  type RefObject,
} from "react";

/** Layout position inside a scroll strip, across intermediate positioned group
 *  boxes. `offsetLeft` alone becomes group-relative once runs are real boxes. */
export function contentLeft(root: HTMLElement, element: HTMLElement): number {
  let left = 0;
  let node: HTMLElement | null = element;
  while (node && node !== root) {
    left += node.offsetLeft;
    node = node.offsetParent as HTMLElement | null;
  }
  return left;
}

/** Where the strip must scroll to for a tab to be genuinely visible, or null if
 *  it already is.
 *
 *  The pinned chip is the reason this isn't `scrollIntoView`:
 *  that call is happy to park a tab flush against the left edge, which is
 *  exactly where the chips are painted, so a tab you jumped to from the agents
 *  panel or the overflow menu could be "revealed" underneath them. Clearing
 *  `pinWidth` is what makes it true. */
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

/** Attribute a run element carries so the strip can be measured by run. */
export const GROUP_ATTR = "data-group-key";
/** Zero-width marker at a section's natural start. */
export const ANCHOR_ATTR = "data-pin-anchor";

type StickySection = { group: HTMLElement; chip: HTMLElement };

function stickySections(root: HTMLElement): StickySection[] {
  return [...root.querySelectorAll<HTMLElement>(`[${GROUP_ATTR}]`)]
    .map((group) => ({ group, chip: group.querySelector<HTMLElement>("[data-stack-chip]") }))
    .filter((entry): entry is StickySection => entry.chip != null);
}

/** Maintain the collision snap positions and the trailing room the final sticky
 *  header needs. CSS owns momentum and the complete handoff: every group is an
 *  oversized snap area, so it scrolls freely inside but a fling cannot pass its
 *  next header collision (`scroll-snap-stop: always`).
 *
 *  Measurement is `offsetLeft`: a layout position, so a tab mid-slide from a
 *  regroup reports where it is going rather than where it momentarily appears,
 *  and the strip's own scrolling never fakes a move. */
export function useStickyLayout(
  containerRef: RefObject<HTMLElement | null>,
): void {
  const measure = useCallback(() => {
    const root = containerRef.current;
    // Hidden project: no layout to read, and nothing on screen to be wrong.
    if (!root || root.offsetParent === null) return;
    const anchors = [...root.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTR}]`)];
    const sections = stickySections(root);
    sections.forEach(({ group }, i) => {
      // Align section i where its header first touches section i-1's sticky
      // header, not where both headers would overlap at the scrollport edge.
      group.style.scrollMarginInlineStart = i === 0
        ? "0px"
        : `${sections[i - 1].chip.offsetWidth}px`;
    });
    // Enough room for the final header to reach the edge, and no dead space on
    // a strip already long enough to get it there.
    const last = anchors.length - 1;
    if (last >= 0) {
      const tail = Number.parseFloat(root.style.getPropertyValue("--tab-tail")) || 0;
      // Measured without the tail's own contribution, so this converges in one
      // pass instead of chasing the width it just set.
      const room = root.scrollWidth - tail - root.clientWidth;
      const short = contentLeft(root, anchors[last]) - room;
      const need = short > 0 ? Math.ceil(short) + 1 : 0;
      if (need !== tail) root.style.setProperty("--tab-tail", `${need}px`);
    }
  }, [containerRef]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    // A resize observer covers the strip growing, the sidebar moving, and the
    // window. Scroll and momentum remain entirely browser-owned.
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [containerRef, measure]);

  // After every render rather than on a content key: a tab renamed mid-run
  // moves every chip after it without changing anything a key would notice.
  useLayoutEffect(measure);
}

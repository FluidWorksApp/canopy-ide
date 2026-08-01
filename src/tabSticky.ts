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
// your place in. So the chips queue instead: chip N holds `left: N × compact`,
// so a chip you have scrolled past drops its name and lines up beside the ones
// already there. Nothing is ever pushed off the left edge, and nothing is
// stacked on top of anything — a row of chips overlapping each other by a few
// pixels is a row of half-glyphs you cannot tell apart. Scroll to the far right
// of a crowded strip and the whole queue is still there, in the order the runs
// always appear in, saying what is behind you.
//
// CSS does the pinning — each chip's containing block is the strip itself (the
// runs are `display: contents`), which is what stops a chip being evicted when
// its own run ends. This module answers what CSS cannot: which chips are in the
// queue.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** Width of a chip once it has queued up — icon and count, no name. Mirrors
 *  `--tab-nub-w`; the two are held together by stickyChipGuard.test.ts, because
 *  the queue's arithmetic happens here and its layout happens there. */
export const NUB_W = 50;

/** Where chip `index` pins: behind it sit that many compact chips. */
export function pinOffset(index: number): number {
  return index * NUB_W;
}

/** The last chip the strip has scrolled onto, given each chip's natural
 *  (unpinned) left in strip coordinates, in strip order. That one is shown in
 *  full — it names the run you are actually in — and every chip before it is
 *  compact. -1 when nothing is pinned.
 *
 *  Monotonic by construction: a named chip is wider than a compact one, so a
 *  chip that has reached its own pin has necessarily pushed every chip before
 *  it past theirs. */
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
 *  The queue of pinned chips is the whole reason this isn't `scrollIntoView`:
 *  that call is happy to park a tab flush against the left edge, which is
 *  exactly where the chips are painted, so a tab you jumped to from the agents
 *  panel or the overflow menu could be "revealed" underneath them. Clearing
 *  `pinWidth` — the compact chips, plus the tab's own chip pinned after them —
 *  is what makes it true. */
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

/** What a chip is doing right now. Absent means it is simply in the row,
 *  riding along with its tabs — a chip only takes hold of the strip once it has
 *  arrived at its place in the queue, which is what keeps the handover
 *  continuous: it stops exactly where it already was. Pin it from the start and
 *  it takes hold a chip's width too early, half-under the one still shown in
 *  full, which is the overlap this whole change exists to be rid of. */
export type PinState = "pinned" | "compact";

/** Same chips, same verdicts. */
export function samePins(
  a: Record<string, PinState>,
  b: Record<string, PinState>,
): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** Attribute a run element carries so the strip can be measured by run. */
export const GROUP_ATTR = "data-group-key";
/** The zero-width marker sitting where a chip would be if it weren't pinned.
 *  Measured instead of the chip itself: a pinned chip reports where it is being
 *  held, which is the answer this is trying to compute. */
export const ANCHOR_ATTR = "data-pin-anchor";

/** What each chip is doing, by run key — queued up compact on the left, held
 *  at its place as the run you are in, or absent because it is still riding
 *  along in the row. Recomputed on scroll, on resize, and after every render —
 *  the strip's contents move under a still scroll position every time a tab
 *  opens, closes or changes run.
 *
 *  Measurement is `offsetLeft`: a layout position, so a tab mid-slide from a
 *  regroup reports where it is going rather than where it momentarily appears,
 *  and the strip's own scrolling never fakes a move. */
export function useChipPins(
  containerRef: RefObject<HTMLElement | null>,
): Record<string, PinState> {
  const [pins, setPins] = useState<Record<string, PinState>>({});
  const pinsRef = useRef(pins);
  pinsRef.current = pins;

  const measure = useCallback(() => {
    const root = containerRef.current;
    // Hidden project: no layout to read, and nothing on screen to be wrong.
    if (!root || root.offsetParent === null) return;
    const anchors = [...root.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTR}]`)];
    const chips = [...root.querySelectorAll<HTMLElement>("[data-stack-chip]")];
    const through = pinnedThrough(
      root.scrollLeft,
      anchors.map((a) => a.offsetLeft),
    );
    // How wide this chip is with its name on, remembered while it has one. The
    // reveal has to clear a chip that is about to be shown in full, and asking
    // a compact chip its width gets the compact answer.
    chips.forEach((c, i) => {
      if (i >= through) c.dataset.fullW = String(c.offsetWidth);
    });
    // Enough room past the last tab for the last chip to reach its place. The
    // strip used to simply run out: the final run's chip stopped short of its
    // offset, overlapping the chip in front of it, because there was nothing
    // left to scroll. The tail is exactly the shortfall — plus the one pixel
    // that turns "reaches its pin" into "is past it", since that is the
    // comparison pinnedThrough makes — and 0 on a strip that doesn't need any.
    // Dead space at the end of a short strip is a strip that scrolls past its
    // own last tab.
    const last = anchors.length - 1;
    if (last >= 0) {
      const tail = Number.parseFloat(root.style.getPropertyValue("--tab-tail")) || 0;
      // Measured without the tail's own contribution, so this converges in one
      // pass instead of chasing the width it just set.
      const room = root.scrollWidth - tail - root.clientWidth;
      const short = anchors[last].offsetLeft - pinOffset(last) - room;
      const need = short > 0 ? Math.ceil(short) + 1 : 0;
      if (need !== tail) root.style.setProperty("--tab-tail", `${need}px`);
    }
    const next: Record<string, PinState> = {};
    anchors.forEach((a, i) => {
      const key = a.getAttribute(ANCHOR_ATTR);
      if (key && i <= through) next[key] = i < through ? "compact" : "pinned";
    });
    if (!samePins(pinsRef.current, next)) setPins(next);
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

  return pins;
}

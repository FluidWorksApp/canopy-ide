// Make a tab's move between groups readable: FLIP.
//
// When a tab changes status the strip re-renders with it in a different place,
// which without help is a jump-cut — you look up and the tab you were watching
// is somewhere else, with nothing to say it was the same tab. FLIP fixes that
// with no layout work of its own: remember where each tab was, let React lay
// the strip out wherever it likes, then transform each moved tab back to its
// old position and release it. The browser animates the transform; the layout
// is already final, so nothing reflows during the slide.
//
// Reads and writes are kept in separate passes — measure every tab, then style
// every tab — so the strip forces layout once rather than once per tab.
import { useLayoutEffect, useRef, type RefObject } from "react";

/** Attribute the strip stamps on each animatable element. */
export const FLIP_ATTR = "data-flip-id";

const DURATION = 260;
/** Sub-pixel drift (a scrollbar appearing, a font settling) is not a move. */
const EPSILON = 1;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Animate `[data-flip-id]` children of `containerRef` from wherever they were
 *  on the previous render to wherever they are now.
 *
 *  Runs after every render, but bails before touching the DOM when the strip is
 *  hidden — a background project's ProjectView stays mounted and re-renders
 *  freely, and it must not pay for layout it can't show. */
export function useFlipStrip(containerRef: RefObject<HTMLElement | null>): void {
  const boxes = useRef(new Map<string, { x: number; y: number }>());

  useLayoutEffect(() => {
    const root = containerRef.current;
    // offsetParent is null for a display:none subtree: the cheap "am I even on
    // screen" test, and no measurement happens behind it. Positions are dropped
    // with it, so a project switched back to animates nothing on arrival.
    if (!root || root.offsetParent === null) {
      boxes.current.clear();
      return;
    }
    const els = Array.from(root.querySelectorAll<HTMLElement>(`[${FLIP_ATTR}]`));
    if (els.length === 0) {
      boxes.current.clear();
      return;
    }

    // Pass 1: read. offsetLeft/offsetTop rather than a bounding rect because
    // they report where layout put the tab, ignoring both the strip's scroll
    // position and any transform still in flight from an earlier slide — so a
    // scroll never fakes a move and an interrupted slide can't corrupt the
    // next measurement.
    const next = new Map<string, { x: number; y: number }>();
    const moved: { el: HTMLElement; dx: number; dy: number }[] = [];
    // Reordering by drag already moves tabs under a held pointer; a slide on
    // top of that fights the pointer instead of explaining anything.
    const still = document.body.classList.contains("dragging-tab") || prefersReducedMotion();
    for (const el of els) {
      const id = el.getAttribute(FLIP_ATTR);
      if (!id) continue;
      // Offsets are relative to the nearest positioned ancestor. When that is
      // the strip itself they are already strip-local; otherwise the strip's
      // own offset is the shared origin to subtract.
      const ox = el.offsetParent === root ? 0 : root.offsetLeft;
      const oy = el.offsetParent === root ? 0 : root.offsetTop;
      const x = el.offsetLeft - ox;
      const y = el.offsetTop - oy;
      next.set(id, { x, y });
      const was = boxes.current.get(id);
      if (!was || still) continue;
      const dx = was.x - x;
      const dy = was.y - y;
      if (Math.abs(dx) > EPSILON || Math.abs(dy) > EPSILON) moved.push({ el, dx, dy });
    }
    boxes.current = next;
    if (moved.length === 0) return;

    // Pass 2: write. Snap back to the old position with transitions off…
    for (const { el, dx, dy } of moved) {
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
    }
    // …make the browser commit that as the before-change style…
    void root.offsetWidth;
    // …and release, in the same breath. Deliberately not deferred to a frame:
    // rAF starves in an occluded webview (the same starvation that made agent
    // events miss — see the dispatch timer in App.tsx), which would leave tabs
    // parked at the snap offset until something woke the frame loop, and a
    // render landing in that gap would strand them outright. One forced reflow
    // buys a transition that cannot be starved, cannot be interrupted, and
    // needs no cleanup.
    for (const { el } of moved) {
      el.style.transition = `transform ${DURATION}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
      el.style.transform = "";
    }
  });
}

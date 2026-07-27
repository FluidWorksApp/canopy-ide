// Where the embedded browser's native views are allowed to be — and, more
// often, when they must get out of the way.
//
// A child webview (browser.rs) is a native view the compositor draws OVER the
// whole window. Nothing in the DOM can appear on top of it: not a dialog, not a
// context menu, not the command palette. So every browser view registers here
// with a way to measure its placeholder div, and this module is the single
// place that decides where it goes and whether it is on screen at all.
//
// Two things take it off screen:
//
//   * its own tab isn't in front, its project isn't open, or the placeholder
//     has no size — the view says so itself, through `wanted`;
//   * something is drawn over it. That is tested rather than declared: every
//     fixed overlay in index.css carries one of the classes below, so one
//     observer and one rect intersection cover surfaces nobody remembered to
//     patch, and a new overlay only has to look like the others.
//
// The intersection matters as much as the detection. A full-screen backdrop
// always covers the browser and has to hide it; a corner toast usually misses
// it entirely, and blanking a page for three seconds of "Saved" would be worse
// than the toast being clipped.

import { useEffect, useState } from "react";
import {
  chooseEngine,
  overlaps,
  sameBounds,
  showable,
  webviewBounds,
  type Bounds,
  type BrowserEngine,
  type RectLike,
} from "./browserBounds";
import * as ipc from "./ipc";
import { getSettings } from "./settings";

const OVERLAY_SELECTOR = [
  ".modal-backdrop",
  ".confirm-backdrop",
  ".palette-backdrop",
  ".ctx-menu",
  ".coach-layer",
  ".notice",
  ".update-toast",
  ".dictation-pill",
  ".zoom-indicator",
].join(",");

interface Entry {
  /** Re-measured on every pass rather than pushed in: a pane drag moves the
   *  placeholder without the view re-rendering, and a stale rect would leave
   *  the page painted where the pane used to be. */
  measure: () => RectLike | null;
  wanted: boolean;
  /** Last values pushed to the backend, so an unchanged layout stays quiet. */
  bounds: Bounds | null;
  shown: boolean | null;
}

const views = new Map<string, Entry>();
/** Imperative overrides, for surfaces the observer can't see. */
let suppressed = 0;
let observer: MutationObserver | null = null;
let sizes: ResizeObserver | null = null;
let scheduled = 0;

/** Cmd +/- scales CSS pixels against the window's points (see zoom.ts), and a
 *  webview is positioned in points. applyZoom stamps the level here. */
function currentZoom(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--zoom");
  const z = Number(raw);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

function occluders(): RectLike[] {
  const out: RectLike[] = [];
  for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push(r);
  }
  return out;
}

function apply() {
  scheduled = 0;
  const zoom = currentZoom();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const anyWanted = [...views.values()].some((e) => e.wanted);
  // Only pay for the hit test when something could actually be covered.
  const covers = anyWanted ? occluders() : [];

  for (const [tabId, e] of views) {
    const rect = e.wanted ? e.measure() : null;
    const bounds = rect ? webviewBounds(rect, viewport, zoom) : null;
    if (bounds && !sameBounds(bounds, e.bounds)) {
      e.bounds = bounds;
      void ipc
        .browserSetBounds(tabId, bounds.x, bounds.y, bounds.width, bounds.height)
        .catch(() => {});
    }
    const visible =
      e.wanted &&
      suppressed === 0 &&
      !!rect &&
      !!bounds &&
      showable(bounds) &&
      !covers.some((c) => overlaps(rect, c));
    if (visible !== e.shown) {
      e.shown = visible;
      void ipc.browserSetVisible(tabId, visible).catch(() => {});
    }
  }
  watch(anyWanted);
}

/** A timer rather than requestAnimationFrame: rAF stops while the window is
 *  occluded, and a dialog opened by a shortcut or an agent is exactly when
 *  that happens. */
function schedule() {
  if (scheduled) return;
  scheduled = window.setTimeout(apply, 16);
}

/** The observers run only while a browser view wants to be on screen, which is
 *  the only time an overlay could hide anything or a drag could move it. */
function watch(need: boolean) {
  if (need && !observer) {
    observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    sizes = new ResizeObserver(schedule);
    sizes.observe(document.documentElement);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
  } else if (!need && observer) {
    observer.disconnect();
    observer = null;
    sizes?.disconnect();
    sizes = null;
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule, true);
  }
}

export function registerBrowserView(tabId: string, measure: () => RectLike | null) {
  views.set(tabId, { measure, wanted: false, bounds: null, shown: null });
}

export function forgetBrowserView(tabId: string) {
  views.delete(tabId);
  schedule();
}

/** Whether this view's tab is the one in front of an open project. */
export function setBrowserViewWanted(tabId: string, wanted: boolean) {
  const e = views.get(tabId);
  if (!e || e.wanted === wanted) return;
  e.wanted = wanted;
  // A view coming back has to re-push its bounds: it may have been resized
  // while it was away, and the backend still holds the old rect.
  if (wanted) e.bounds = null;
  schedule();
}

/** Hide every browser view until the returned release is called, for surfaces
 *  the observer can't see — a native menu, a window drag. Idempotent. */
export function suppressBrowserViews(): () => void {
  suppressed++;
  schedule();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    suppressed--;
    schedule();
  };
}

/** Nudge the host after something it can't observe — a tab switch, an engine
 *  change, a page load that resized the pane. */
export const refreshBrowserViews = schedule;

let supported: boolean | null = null;
let probe: Promise<void> | null = null;

/** Which engine preview tabs run on, once the platform has been asked. `null`
 *  until then — a hundred milliseconds at startup, during which a preview
 *  shows nothing rather than briefly showing the wrong engine. */
export function useBrowserEngine(): BrowserEngine | null {
  const [, bump] = useState(0);
  useEffect(() => {
    if (supported !== null) return;
    probe ??= ipc.browserSupported().then((s) => {
      supported = s;
    });
    let live = true;
    void probe.then(() => live && bump((n) => n + 1));
    return () => {
      live = false;
    };
  }, []);
  return supported === null ? null : chooseEngine(getSettings().browserEngine, supported);
}

/** Test seam: drop all state between cases. */
export function resetBrowserHost() {
  views.clear();
  suppressed = 0;
  if (scheduled) window.clearTimeout(scheduled);
  scheduled = 0;
  watch(false);
}

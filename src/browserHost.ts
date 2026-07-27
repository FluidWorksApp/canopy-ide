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
//   * something is drawn over it. That is discovered structurally, by walking
//     the visible DOM for anything out of normal flow whose rectangle overlaps
//     the view — see browserOcclusion.ts for why it is not a class list.
//
// The walk is cheap because of how the app already works: every doc tab that
// isn't in front is `display: none`, and one visibility check prunes each of
// those subtrees whole. With a browser tab in front the visible tree is the
// rail, the tab bar, the toolbar and whatever is floating — a few hundred
// elements, and a computed style is only read where a rectangle actually
// reaches the browser.
//
// The intersection matters as much as the detection. A full-screen backdrop
// always covers the browser and has to hide it; a corner toast usually misses
// it entirely, and blanking a page for three seconds of "Saved" would be worse
// than the toast being clipped. A small dropdown that does reach it hides the
// whole page for as long as it is open — a menu is transient, and punching a
// hole in a native view to avoid the blink is not worth what it would cost.

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
import {
  frameSrc,
  shouldCapture,
  type PaneState,
  paneState,
} from "./browserFrame";
import {
  PAINTED_OVERLAY_SELECTOR,
  isSurface,
  occludes,
  stacksAboveFlow,
  type Candidate,
  type OccluderStyle,
} from "./browserOcclusion";
import * as ipc from "./ipc";
import { getSettings } from "./settings";

/** Told to whoever is rendering the pane, so the DOM can stand in for the
 *  native view while it is out of the way. */
export interface PaneView {
  state: PaneState;
  frame: string | null;
}

interface Entry {
  /** Resolved on every pass rather than pushed in: a pane drag moves the
   *  placeholder without the view re-rendering, and a stale rect would leave
   *  the page painted where the pane used to be. The element itself, not just
   *  its rect, because the occlusion walk has to skip it and its ancestors. */
  host: () => Element | null;
  wanted: boolean;
  /** Last values pushed to the backend, so an unchanged layout stays quiet. */
  bounds: Bounds | null;
  shown: boolean | null;
  /** The last picture of the page, shown while the view is hidden. */
  frame: string | null;
  lastCaptureAt: number;
  capturing: boolean;
  /** The page moved on and the held frame is known to be wrong. */
  dirty: boolean;
  /** Frames taken since this view opened — only used to log the first one. */
  frames: number;
  told: PaneView | null;
}

const views = new Map<string, Entry>();
/** Imperative overrides, for surfaces the observer can't see. */
let suppressed = 0;
let observer: MutationObserver | null = null;
let sizes: ResizeObserver | null = null;
let scheduled = 0;

/** The embedded browser is a native view nobody can inspect from devtools, and
 *  every one of its failures is invisible by construction: a capture that never
 *  runs, a hide that never lands, and a working page all look identical from
 *  the outside. So each hop says what it did, into the app log where a user can
 *  read it back. Kept terse — routine captures are DEV-only, everything that
 *  changes what is on screen is always recorded. */
function log(line: string) {
  void ipc.jsLog("info", `browser: ${line}`);
}

/** Tab ids are uuids; the first chunk is plenty to follow one through a log. */
function short(tabId: string): string {
  return tabId.slice(0, 8);
}

/** Enough of an occluder to recognise it in a log line. */
function describe(c: Candidate): string {
  const el = c.el;
  if (!el) return "?";
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
}

/** Cmd +/- scales CSS pixels against the window's points (see zoom.ts), and a
 *  webview is positioned in points. applyZoom stamps the level here. */
function currentZoom(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--zoom");
  const z = Number(raw);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** display / visibility / opacity in one question. This is what prunes every
 *  backgrounded doc tab — one call at the subtree's root, not once per node. */
function isVisible(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === "function") {
    return check.call(el, { visibilityProperty: true, opacityProperty: true });
  }
  return el.getClientRects().length > 0;
}

function readStyle(el: Element): OccluderStyle {
  const s = getComputedStyle(el);
  return { position: s.position, zIndex: s.zIndex, pointerEvents: s.pointerEvents };
}

/** Elements whose class already warned once, so a permanent blind spot doesn't
 *  print on every layout pass. */
const warned = new Set<string>();

function warnBlindSpot(el: Element) {
  const key = el.className || el.tagName;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    "[browserHost] %o overlaps a visible embedded browser but is click-through " +
      "and unlisted, so it can't be detected structurally. If it paints anything, " +
      "add its class to PAINTED_OVERLAY_SELECTOR in browserOcclusion.ts — otherwise " +
      "the browser will draw over it.",
    el,
  );
}

/** Everything painted over `view`, found by structure rather than by name. */
function occludersOver(host: Element, view: RectLike): Candidate[] {
  const found: Candidate[] = [];
  // An ancestor contains the view; it can never cover it.
  const ancestors = new Set<Node>();
  for (let n: Node | null = host; n; n = n.parentNode) ancestors.add(n);

  const visit = (el: Element) => {
    for (const child of el.children) {
      if (child === host || !isVisible(child)) continue;
      if (ancestors.has(child)) {
        visit(child);
        continue;
      }
      const rect = child.getBoundingClientRect();
      let covered = false;
      // The computed style is the expensive read, so it is only taken for boxes
      // whose rectangle actually reaches the browser — which, with the browser
      // being one pane, is very few of them.
      if (rect.width > 0 && rect.height > 0 && overlaps(view, rect)) {
        const candidate: Candidate = {
          rect,
          style: readStyle(child),
          painted: child.matches(PAINTED_OVERLAY_SELECTOR),
          el: child,
        };
        if (occludes(view, candidate)) {
          found.push(candidate);
          covered = true;
        } else if (
          import.meta.env.DEV &&
          !candidate.painted &&
          stacksAboveFlow(candidate.style) &&
          !isSurface(candidate.style)
        ) {
          // The one thing structure cannot see: a positioned box over the
          // browser that takes no clicks. Usually a layout wrapper (correctly
          // ignored), occasionally a toast (which must be listed). Say so.
          warnBlindSpot(child);
        }
      }
      // A counted occluder's children are inside it and add nothing. Everything
      // else is descended into even when it misses the view, because a fixed or
      // absolute descendant escapes its parent's rectangle.
      if (!covered) visit(child);
    }
  };
  visit(document.body);
  return found;
}

function apply() {
  scheduled = 0;
  const zoom = currentZoom();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const anyWanted = [...views.values()].some((e) => e.wanted);

  for (const [tabId, e] of views) {
    const host = e.wanted ? e.host() : null;
    const rect = host?.getBoundingClientRect() ?? null;
    const bounds = rect ? webviewBounds(rect, viewport, zoom) : null;
    if (bounds && !sameBounds(bounds, e.bounds)) {
      e.bounds = bounds;
      void ipc
        .browserSetBounds(tabId, bounds.x, bounds.y, bounds.width, bounds.height)
        .catch(() => {});
    }
    // Only pay for the walk when this view would otherwise be on screen.
    const over = host && rect && bounds && showable(bounds) ? occludersOver(host, rect) : null;
    const clear = !!over && over.length === 0;
    const cover = over && over.length > 0 ? describe(over[0]) : "offscreen";
    const visible = e.wanted && suppressed === 0 && clear;
    if (visible !== e.shown) {
      e.shown = visible;
      const at = Date.now();
      log(`${visible ? "show" : "hide"} issued tab=${short(tabId)}${visible ? "" : ` by=${cover}`}`);
      void ipc.browserSetVisible(tabId, visible).then(
        () => log(`${visible ? "show" : "hide"} acked tab=${short(tabId)} in=${Date.now() - at}ms`),
        (err) => log(`${visible ? "show" : "hide"} FAILED tab=${short(tabId)} ${err}`),
      );
    }
    // Take the picture while the view is still up. A hidden WKWebView
    // snapshots to nothing, so the instant the frame is needed is the instant
    // it can no longer be taken — it has to already be in hand.
    if (
      shouldCapture({
        native: true,
        shown: e.shown === true,
        lastCaptureAt: e.lastCaptureAt,
        now: Date.now(),
        dirty: e.dirty,
        inFlight: e.capturing,
      })
    ) {
      capture(tabId, e);
    }
    publish(tabId, e);
  }
  watch(anyWanted);
}

function capture(tabId: string, e: Entry) {
  e.capturing = true;
  e.lastCaptureAt = Date.now();
  const at = Date.now();
  void ipc.browserFrame(tabId).then(
    (base64) => {
      e.capturing = false;
      if (!base64) {
        log(`capture EMPTY tab=${short(tabId)}`);
        return;
      }
      e.dirty = false;
      e.frame = frameSrc(base64);
      // Routine refreshes are noise; the first frame is the one that says the
      // whole pipeline works, so it is always reported.
      if (e.frames++ === 0 || import.meta.env.DEV) {
        log(`capture ok tab=${short(tabId)} kb=${Math.round(base64.length / 1024)} in=${Date.now() - at}ms n=${e.frames}`);
      }
      publish(tabId, e);
    },
    (err) => {
      // A view mid-navigation or already gone has no frame to give. Keeping
      // the previous one is right — it is still a better picture of this page
      // than nothing is. But a capture that ALWAYS fails is the difference
      // between a frozen page and a blank one, so it is never silent.
      e.capturing = false;
      log(`capture FAILED tab=${short(tabId)} ${err}`);
    },
  );
}

/** Kept beside `views` rather than inside an Entry: the pane hook subscribes on
 *  the render that creates the placeholder, which is before the effect that
 *  registers the view has run. */
const paneListeners = new Map<string, Set<(v: PaneView) => void>>();

function publish(tabId: string, e: Entry) {
  const next: PaneView = {
    state: paneState({
      native: true,
      wanted: e.wanted,
      shown: e.shown === true,
      frame: e.frame,
    }),
    frame: e.frame,
  };
  if (e.told && e.told.state === next.state && e.told.frame === next.frame) return;
  const was = e.told?.state;
  e.told = next;
  if (was !== next.state) {
    log(`pane tab=${short(tabId)} ${was ?? "-"} -> ${next.state} frame=${next.frame ? "yes" : "no"}`);
  }
  const cbs = paneListeners.get(tabId);
  if (cbs) for (const cb of cbs) cb(next);
}

/** The page navigated: whatever frame is held is of the page being left.
 *
 *  `loading` only decides whether to throw that frame away — it never gates
 *  capturing. An event missed here costs one stale frame, not the feature. */
export function browserViewChanged(tabId: string, loading?: boolean) {
  const e = views.get(tabId);
  if (!e) return;
  e.dirty = true;
  if (loading) {
    e.frame = null;
    log(`nav tab=${short(tabId)} loading, frame dropped`);
  }
  schedule();
}

/** Subscribe to what the pane should be showing. */
export function watchBrowserPane(tabId: string, cb: (v: PaneView) => void): () => void {
  let cbs = paneListeners.get(tabId);
  if (!cbs) {
    cbs = new Set();
    paneListeners.set(tabId, cbs);
  }
  cbs.add(cb);
  const told = views.get(tabId)?.told;
  if (told) cb(told);
  return () => {
    cbs.delete(cb);
    if (cbs.size === 0) paneListeners.delete(tabId);
  };
}

/** React binding for the above. */
export function useBrowserPane(tabId: string, active: boolean): PaneView {
  const [pane, setPane] = useState<PaneView>({ state: "empty", frame: null });
  useEffect(() => {
    if (!active) return;
    return watchBrowserPane(tabId, setPane);
  }, [tabId, active]);
  return active ? pane : { state: "empty", frame: null };
}

/** A timer rather than requestAnimationFrame: rAF stops while the window is
 *  occluded, and a dialog opened by a shortcut or an agent is exactly when
 *  that happens. */
function schedule() {
  sweepUntil = Math.max(sweepUntil, Date.now() + SWEEP_MS);
  startSweep();
  tick();
}

/** One debounced pass, without arming a sweep — what the sweep and the
 *  heartbeat themselves use, so neither can keep the other alive forever. */
function tick() {
  if (scheduled) return;
  scheduled = window.setTimeout(apply, 16);
}

/** How long to keep re-checking after the DOM last changed.
 *
 *  This is the other half of the bug where the app's side panel opened straight
 *  over the page. A panel arrives by adding a class, which fires the observer
 *  once — and then SLIDES in over 340ms under a CSS transition, which fires
 *  nothing at all. Sampling once, 16ms after the class change, catches the
 *  panel while it is still off to the left of the browser and concludes
 *  correctly that nothing overlaps. Nothing ever asks again, and the panel
 *  finishes its slide on top of a page that was never told to move.
 *
 *  Whether that was visible came down to luck: a panel whose contents load
 *  asynchronously (Pull requests) mutates the DOM again mid-slide and gets
 *  re-checked by accident, while one that renders in a single pass (Team)
 *  never does. Hence a sweep rather than a sample — long enough to outlast
 *  --peek-in, which is the slowest transition in the app. */
const SWEEP_MS = 600;
const SWEEP_STEP_MS = 60;
/** A page nobody is touching still has to be captured, and the DOM is silent
 *  while it is being read. Slow, because all it guards against is a frame going
 *  stale — and it only runs while a view is actually on screen. */
const HEARTBEAT_MS = 1000;

let sweepUntil = 0;
let sweeping = 0;
let heartbeat = 0;

function startSweep() {
  if (sweeping) return;
  sweeping = window.setInterval(() => {
    if (Date.now() >= sweepUntil) {
      window.clearInterval(sweeping);
      sweeping = 0;
      return;
    }
    tick();
  }, SWEEP_STEP_MS);
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
    // A transition moves an element every frame while mutating nothing. These
    // bubble, so one listener covers every animated surface in the app.
    for (const ev of MOTION) window.addEventListener(ev, schedule, true);
    heartbeat = window.setInterval(tick, HEARTBEAT_MS);
  } else if (!need && observer) {
    observer.disconnect();
    observer = null;
    sizes?.disconnect();
    sizes = null;
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule, true);
    for (const ev of MOTION) window.removeEventListener(ev, schedule, true);
    window.clearInterval(heartbeat);
    heartbeat = 0;
  }
}

const MOTION = ["transitionrun", "transitionstart", "transitionend", "animationstart", "animationend"];

export function registerBrowserView(tabId: string, host: () => Element | null) {
  views.set(tabId, {
    host,
    wanted: false,
    bounds: null,
    shown: null,
    frame: null,
    lastCaptureAt: 0,
    capturing: false,
    dirty: true,
    frames: 0,
    told: null,
  });
}

export function forgetBrowserView(tabId: string) {
  views.delete(tabId);
  schedule();
}

/** The page navigated, or an agent acted on it, so any frame in hand is of a
 *  page that no longer exists. */
export function browserPageChanged(tabId: string) {
  const e = views.get(tabId);
  if (!e) return;
  e.dirty = true;
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

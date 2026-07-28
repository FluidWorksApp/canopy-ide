// A second opinion on the embedded browser, running the whole time.
//
// Four bugs shipped in a row in this layer, and the full headless suite was
// green for every one of them: tsc, vitest and cargo test cannot see a native
// view that is in the wrong place. The only thing that could see it was a
// person looking at the screen. This is the part that stops needing one.
//
// It watches five invariants (I1..I5 below) and makes any breach loud —
// console.error, a line in the app log under a stable `browser:INVARIANT`
// prefix, and in dev an error notice that stays until it is read.
//
// The one rule that gives it any value: it must not agree with the code it is
// watching. It never runs the occlusion walk, never recomputes bounds through
// browserBounds, never asks shouldCapture anything. It reads what the host
// BELIEVES (browserViewSnapshots), measures the DOM for itself with its own
// arithmetic, and complains when the two disagree. A checker built out of the
// suspect's own code reaches the suspect's own conclusions, bug included.
//
// The decision logic is pure and lives in `createWatchdog` — it takes samples
// and returns violations, which is what browserWatchdog.test.ts exercises with
// synthetic timelines. Everything below that is sampling and shouting.

import { onBrowserSignal, browserViewSnapshots, type BrowserSignal } from "./browserSignals";
import { OVERLAY_SURFACES } from "./overlaySurfaces";
import * as ipc from "./ipc";

export type InvariantCode = "I1" | "I2" | "I3" | "I4" | "I5";

/** What each invariant is, in the words a violation should be read in. */
export const INVARIANTS: Record<InvariantCode, string> = {
  I1: "a surface overlaps a visible browser view",
  I2: "a visibility change was issued and never acknowledged",
  I3: "the view is hidden with no freeze-frame to stand in for it",
  I4: "the view's bounds have drifted from its placeholder",
  I5: "no frame has been captured from a settled, visible page",
};

export interface WatchdogLimits {
  /** How long an overlap may last before it is a bug rather than a frame of
   *  latency. One layout pass is 16ms; a hide plus its ack is well under 100. */
  occlusionMs: number;
  /** A hide that hasn't landed in this long is not going to. */
  ackMs: number;
  /** Grace between hiding and having something to show instead. */
  freezeMs: number;
  driftPx: number;
  driftMs: number;
  /** A visible, settled page that hasn't been photographed in this long has a
   *  broken capture path, and the next overlay will reveal a hole. */
  captureMs: number;
  /** How long after a navigation a page counts as settled. */
  settleMs: number;
}

export const LIMITS: WatchdogLimits = {
  occlusionMs: 150,
  ackMs: 500,
  freezeMs: 150,
  driftPx: 2,
  driftMs: 300,
  captureMs: 10_000,
  settleMs: 1_500,
};

/** One reading of one view: what the host says, beside what the DOM says. */
export interface Sample {
  at: number;
  tabId: string;
  /** The tab is in front and has a page. */
  wanted: boolean;
  /** Visible according to the host — the last thing it pushed to the backend. */
  visible: boolean;
  /** Measured here, not by the occlusion walk: a surface found over the pane,
   *  or null when the pane is clear. */
  occluder: string | null;
  hasFrame: boolean;
  loading: boolean;
  /** No navigation recently, so a capture is both possible and due. */
  settled: boolean;
  /** When a frame last arrived; seeded at registration so a view that has never
   *  captured is judged from when it opened, not from 1970. */
  lastCaptureOkAt: number;
  /** When this view last became both visible and settled — the moment the
   *  capture path could first have taken this picture.
   *
   *  Captures only happen while the view is on screen, so the age of the last
   *  frame is not on its own a fault: a tab in the background for a minute has
   *  correctly not photographed itself for a minute, and would otherwise be in
   *  breach the instant it came back, milliseconds before the capture it just
   *  triggered lands. The budget runs from the opportunity, not from the frame. */
  capturableSince: number;
  /** Punch-through layering: the page is UNDER a see-through app webview, so
   *  overlays are meant to paint over a view that stays on screen and no
   *  freeze-frame is taken at all. Three of the five invariants below describe
   *  the overlay contract and say nothing true about this one. */
  punch: boolean;
  /** Largest edge divergence between the bounds the host pushed and the
   *  placeholder as it is right now, in CSS pixels. Null when the comparison
   *  isn't meaningful (clipped, collapsed, nothing pushed yet). */
  drift: number | null;
  /** Visibility calls issued and still waiting for their ack. */
  unacked: { seq: number; visible: boolean; at: number }[];
}

export interface Violation {
  code: InvariantCode;
  /** Stable per episode, so one breach reports once rather than 20 times/s. */
  key: string;
  tabId: string;
  what: string;
  detail: string;
  /** When the condition started, not when it was reported. */
  since: number;
  at: number;
}

export interface WatchdogTick {
  opened: Violation[];
  closed: Violation[];
}

interface Condition {
  code: InvariantCode;
  key: string;
  dwell: number;
  detail: string;
}

/** Conditions this sample is currently in breach of, before dwell times are
 *  applied. Pure, and the whole of the judgement — everything else is timing. */
export function conditionsFor(s: Sample, limits: WatchdogLimits): Condition[] {
  const out: Condition[] = [];
  const t = s.tabId;

  // I1 — the original bug, and the one the DOM can prove on its own: something
  // is drawn over a view the host still believes is on screen. Under
  // punch-through that is the intended arrangement rather than a fault — the
  // overlay paints over the page, and what has to be checked instead (the
  // click pass-through region excluding the overlay) is the selftest's job.
  if (!s.punch && s.visible && s.occluder) {
    out.push({
      code: "I1",
      key: `I1:${t}:${s.occluder}`,
      dwell: limits.occlusionMs,
      detail: `${s.occluder} overlaps the page while the view is shown`,
    });
  }

  // I2 — issued and unanswered. A hide that never lands leaves the page on top
  // of the app, and nothing else in the system would ever say so.
  for (const u of s.unacked) {
    const waited = s.at - u.at;
    if (waited > limits.ackMs) {
      out.push({
        code: "I2",
        key: `I2:${t}:${u.seq}`,
        dwell: 0,
        detail: `${u.visible ? "show" : "hide"} #${u.seq} unacknowledged after ${waited}ms`,
      });
    }
  }

  // I3 — hidden for an overlay with nothing to put in its place. This is what
  // the whole freeze-frame exists to prevent, and what a stuck capture gate
  // silently undoes.
  if (!s.punch && s.wanted && !s.visible && s.occluder && !s.hasFrame && !s.loading) {
    out.push({
      code: "I3",
      key: `I3:${t}`,
      dwell: limits.freezeMs,
      detail: `hidden by ${s.occluder} with no frame held, and the page is not loading`,
    });
  }

  // I4 — the page is painting somewhere other than where its placeholder is.
  // No bug here yet; the class of bug is one CSS change away.
  if (s.visible && s.drift !== null && s.drift > limits.driftPx) {
    out.push({
      code: "I4",
      key: `I4:${t}`,
      dwell: limits.driftMs,
      detail: `bounds are ${Math.round(s.drift)}px off the placeholder`,
    });
  }

  // I5 — the capture path is dead. Costs nothing while it works, and would
  // have named the fault within ten seconds of the build that broke it.
  // Punch-through takes no pictures by design, so there is nothing here to be
  // dead. The clock starts at whichever came last: the frame in hand, or the
  // moment this view could first have been photographed.
  if (!s.punch && s.visible && s.settled) {
    const since = s.at - Math.max(s.lastCaptureOkAt, s.capturableSince);
    if (since > limits.captureMs) {
      out.push({
        code: "I5",
        key: `I5:${t}`,
        dwell: 0,
        detail: `no frame captured for ${Math.round(since / 1000)}s on a settled page`,
      });
    }
  }
  return out;
}

interface Episode {
  tabId: string;
  since: number;
  firing: Violation | null;
  detail: string;
  code: InvariantCode;
}

export interface Watchdog {
  /** Feed one reading; get back what started and what stopped. */
  observe(s: Sample): WatchdogTick;
  /** A view went away: end anything it was in breach of. */
  forget(tabId: string, at: number): WatchdogTick;
  /** Everything currently in breach. */
  open(): Violation[];
}

export function createWatchdog(limits: WatchdogLimits = LIMITS): Watchdog {
  const episodes = new Map<string, Episode>();

  const close = (keys: string[], at: number): Violation[] => {
    const closed: Violation[] = [];
    for (const key of keys) {
      const ep = episodes.get(key);
      if (!ep) continue;
      episodes.delete(key);
      if (ep.firing) closed.push({ ...ep.firing, at });
    }
    return closed;
  };

  return {
    observe(s) {
      const conds = conditionsFor(s, limits);
      const seen = new Set(conds.map((c) => c.key));
      const opened: Violation[] = [];

      for (const c of conds) {
        let ep = episodes.get(c.key);
        if (!ep) {
          ep = { tabId: s.tabId, since: s.at, firing: null, detail: c.detail, code: c.code };
          episodes.set(c.key, ep);
        }
        ep.detail = c.detail;
        if (!ep.firing && s.at - ep.since >= c.dwell) {
          ep.firing = {
            code: c.code,
            key: c.key,
            tabId: s.tabId,
            what: INVARIANTS[c.code],
            detail: c.detail,
            since: ep.since,
            at: s.at,
          };
          opened.push(ep.firing);
        }
      }

      // Only this tab's episodes can be cleared by this tab's reading.
      const gone = [...episodes.entries()]
        .filter(([key, ep]) => ep.tabId === s.tabId && !seen.has(key))
        .map(([key]) => key);
      return { opened, closed: close(gone, s.at) };
    },

    forget(tabId, at) {
      const keys = [...episodes.entries()]
        .filter(([, ep]) => ep.tabId === tabId)
        .map(([key]) => key);
      return { opened: [], closed: close(keys, at) };
    },

    open() {
      return [...episodes.values()].flatMap((ep) => (ep.firing ? [ep.firing] : []));
    },
  };
}

// ---------- the runtime: sampling the real DOM, and shouting ----------

/** How often to look. Three readings inside the 150ms overlap budget, which is
 *  enough to be sure and cheap enough to leave on: a dozen selector queries and
 *  a rect comparison, and only while a browser view is on screen. */
const SAMPLE_MS = 50;

/** Do two rectangles share more than a hairline? A one-pixel touch at an edge
 *  is a rounding artefact, not something painted over the page.
 *
 *  Deliberately not browserBounds.overlaps — the point of this module is that
 *  it does not share code with what it is checking. */
function intersectionArea(a: DOMRect, b: DOMRect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function paints(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === "function") {
    return check.call(el, { visibilityProperty: true, opacityProperty: true });
  }
  return el.getClientRects().length > 0;
}

function name(el: Element): string {
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
}

/** Anything over the pane, found the registry's way and the browser's way.
 *
 *  Two independent probes because they miss different things: the registry
 *  walk sees surfaces that paint without taking clicks (a toast), and the hit
 *  test sees surfaces nobody registered. Between them, an overlay has to be
 *  both unlisted and click-through to escape — and browserHost's dev warning
 *  covers exactly that case. */
function occluderOver(host: Element, rect: DOMRect): string | null {
  for (const surface of OVERLAY_SURFACES) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(surface.selector);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (el === host || el.contains(host) || host.contains(el)) continue;
      if (!paints(el)) continue;
      if (intersectionArea(rect, el.getBoundingClientRect()) > 4) {
        return `${surface.id} (${name(el)})`;
      }
    }
  }
  // What is actually on top in the middle of the pane. Cheap, and it catches
  // surfaces the registry has never heard of.
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  const top = document.elementFromPoint(x, y);
  if (top && top !== host && !host.contains(top) && !top.contains(host)) {
    return `unregistered:${name(top)}`;
  }
  return null;
}

/** How far the pushed bounds are from where the placeholder is now.
 *
 *  Null when the placeholder is clipped by the viewport — the host clamps in
 *  that case, and a clamp is not drift. The arithmetic is written out here
 *  rather than borrowed from browserBounds on purpose. */
function driftOf(
  bounds: { x: number; y: number; width: number; height: number },
  rect: DOMRect,
  zoom: number,
): number | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (rect.left < 0 || rect.top < 0 || rect.right > vw || rect.bottom > vh) return null;
  if (rect.width < 2 || rect.height < 2) return null;
  const z = zoom > 0 ? zoom : 1;
  return Math.max(
    Math.abs(bounds.x / z - rect.left),
    Math.abs(bounds.y / z - rect.top),
    Math.abs(bounds.width / z - rect.width),
    Math.abs(bounds.height / z - rect.height),
  );
}

/** Where a violation goes. The console for whoever has devtools open, the app
 *  log for whoever doesn't (and for the selftest's report), and an error notice
 *  in dev — errors are the one notice kind that waits to be dismissed. */
function report(v: Violation, kind: "opened" | "cleared") {
  const line =
    `browser:INVARIANT ${v.code} ${kind} tab=${v.tabId.slice(0, 8)} ` +
    `${v.what} — ${v.detail} (${Math.max(0, v.at - v.since)}ms)`;
  if (kind === "opened") console.error(`[watchdog] ${line}`);
  else console.warn(`[watchdog] ${line}`);
  void ipc.jsLog(kind === "opened" ? "error" : "info", line);
  window.dispatchEvent(
    new CustomEvent("canopy:browser-invariant", { detail: { violation: v, kind } }),
  );
}

let running = false;
let violations: Violation[] = [];

/** Everything the watchdog has caught this session, for the selftest report. */
export function watchdogViolations(): Violation[] {
  return violations;
}

export function clearWatchdogViolations() {
  violations = [];
}

/** Start watching. Idempotent, and returns a stop function.
 *
 *  Dev builds run it always. Release builds do not, unless somebody asks:
 *  `localStorage["canopy.browserWatchdog"] = "on"` in the app's console, or the
 *  selftest turning it on for its own run. Nothing about a normal release
 *  build changes — the sampler never starts, and the host's announcements go
 *  to an empty listener set. */
export function startBrowserWatchdog(force = false): () => void {
  if (running) return () => {};
  const wanted =
    force ||
    import.meta.env.DEV ||
    (() => {
      try {
        return localStorage.getItem("canopy.browserWatchdog") === "on";
      } catch {
        return false;
      }
    })();
  if (!wanted) return () => {};
  running = true;

  const dog = createWatchdog();
  const unacked = new Map<string, { seq: number; visible: boolean; at: number }[]>();
  const captured = new Map<string, number>();
  const navAt = new Map<string, number>();
  /** When each view last became photographable, kept by watching the samples
   *  go past rather than by asking the host — the host has no such notion, and
   *  a value it computed would be a value it could get wrong in the same way
   *  twice. Dropped the moment the view stops being visible or settled, so the
   *  span is always a continuous one. */
  const capturable = new Map<string, number>();

  const take = (tick: WatchdogTick) => {
    for (const v of tick.opened) {
      violations = [...violations, v];
      report(v, "opened");
    }
    for (const v of tick.closed) report(v, "cleared");
  };

  const un = onBrowserSignal((s: BrowserSignal) => {
    switch (s.t) {
      case "register":
        captured.set(s.tabId, s.at);
        navAt.set(s.tabId, s.at);
        break;
      case "forget":
        take(dog.forget(s.tabId, s.at));
        unacked.delete(s.tabId);
        captured.delete(s.tabId);
        navAt.delete(s.tabId);
        capturable.delete(s.tabId);
        break;
      case "visibility": {
        const list = unacked.get(s.tabId) ?? [];
        list.push({ seq: s.seq, visible: s.visible, at: s.at });
        unacked.set(s.tabId, list);
        break;
      }
      case "visibility-ack":
        unacked.set(s.tabId, (unacked.get(s.tabId) ?? []).filter((u) => u.seq !== s.seq));
        break;
      case "capture":
        if (s.result === "ok") captured.set(s.tabId, s.at);
        break;
      case "nav":
        navAt.set(s.tabId, s.at);
        break;
      default:
        break;
    }
  });

  const timer = window.setInterval(() => {
    const at = Date.now();
    // Which layering is in force, read off the DOM the host stamped rather than
    // out of settings — the class is what the CSS and the native side are
    // actually behaving as, which is the thing the invariants describe.
    const punch = document.documentElement.classList.contains("punch-through");
    for (const v of browserViewSnapshots()) {
      const rect = v.hostRect;
      const host = v.host;
      const visible = v.shown === true;
      const settled = !v.loading && at - (navAt.get(v.tabId) ?? at) > LIMITS.settleMs;
      // Punch-through counts as no opportunity at all, not just as an excused
      // one: it takes no pictures for as long as it is engaged, and switching
      // back to overlay must not arrive already a minute overdue.
      if (!visible || !settled || punch) capturable.delete(v.tabId);
      else if (!capturable.has(v.tabId)) capturable.set(v.tabId, at);
      take(
        dog.observe({
          at,
          tabId: v.tabId,
          wanted: v.wanted,
          visible,
          occluder: host && rect && visible ? occluderOver(host, rect) : null,
          hasFrame: v.hasFrame,
          loading: v.loading,
          settled,
          lastCaptureOkAt: Math.max(v.lastCaptureOkAt, captured.get(v.tabId) ?? 0),
          capturableSince: capturable.get(v.tabId) ?? at,
          punch,
          drift: v.bounds && rect ? driftOf(v.bounds, rect, v.zoom) : null,
          unacked: unacked.get(v.tabId) ?? [],
        }),
      );
    }
  }, SAMPLE_MS);

  return () => {
    running = false;
    un();
    window.clearInterval(timer);
  };
}

// What the browser layer just did, said out loud.
//
// The embedded browser is a native view nobody can inspect from devtools, and
// every one of its failures is invisible by construction: a capture that never
// runs, a hide that was issued and never landed, and a page working perfectly
// all look identical from outside. Four bugs shipped in a row for exactly that
// reason, each one found by the owner's eyes rather than by anything automatic.
//
// So the host announces each hop it takes. This module is only the wire: no
// decisions, no state beyond the subscriber set, nothing that can fail. The
// watchdog reads these to judge invariants, the selftest reads them to time its
// assertions, and neither has to reach into browserHost's internals — which
// matters, because a checker that shares the code under suspicion agrees with
// it about everything, including the bug.

import type { Bounds } from "./browserBounds";
import type { PaneState } from "./browserFrame";

export type BrowserSignal =
  | { t: "register"; at: number; tabId: string }
  | { t: "forget"; at: number; tabId: string }
  /** A hide or show was sent to the backend. `seq` pairs it with its ack. */
  | {
      t: "visibility";
      at: number;
      tabId: string;
      seq: number;
      visible: boolean;
      /** What the host thinks is covering it, when hiding. */
      by: string | null;
    }
  | {
      t: "visibility-ack";
      at: number;
      tabId: string;
      seq: number;
      visible: boolean;
      ok: boolean;
      error?: string;
    }
  | { t: "bounds"; at: number; tabId: string; bounds: Bounds }
  | {
      t: "capture";
      at: number;
      tabId: string;
      result: "ok" | "empty" | "failed";
      ms: number;
      error?: string;
    }
  | { t: "pane"; at: number; tabId: string; state: PaneState; frame: boolean }
  | { t: "nav"; at: number; tabId: string; loading: boolean };

/** One signal as a log line. Lives here rather than in either consumer: the
 *  host writes these to the app log as they happen and the selftest writes the
 *  same lines into its own timeline, and two spellings of the same event would
 *  make the two records impossible to line up. */
export function describeBrowserSignal(s: BrowserSignal): string {
  const tab = s.tabId.slice(0, 8);
  switch (s.t) {
    case "visibility":
      return `${s.visible ? "show" : "hide"} issued tab=${tab} seq=${s.seq}${
        s.visible ? "" : ` by=${s.by}`
      }`;
    case "visibility-ack":
      return `${s.visible ? "show" : "hide"} ${s.ok ? "acked" : `FAILED ${s.error}`} tab=${tab} seq=${s.seq}`;
    case "capture":
      return `capture ${s.result} tab=${tab} in=${s.ms}ms`;
    case "pane":
      return `pane tab=${tab} -> ${s.state} frame=${s.frame ? "yes" : "no"}`;
    case "nav":
      return `nav tab=${tab} loading=${s.loading}`;
    case "bounds":
      return `bounds tab=${tab} ${s.bounds.width}x${s.bounds.height}@${s.bounds.x},${s.bounds.y}`;
    default:
      return `${s.t} tab=${tab}`;
  }
}

type Listener = (s: BrowserSignal) => void;

const listeners = new Set<Listener>();

/** Publish. Never throws into the caller: the host must not change what it does
 *  because something watching it went wrong. */
export function emitBrowserSignal(s: BrowserSignal) {
  for (const l of listeners) {
    try {
      l(s);
    } catch {
      // An observer's bug is the observer's problem.
    }
  }
}

export function onBrowserSignal(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Nobody is listening — the host can skip the work of describing itself. */
export function browserSignalsIdle(): boolean {
  return listeners.size === 0;
}

/** One view's state as the host holds it, read rather than recomputed.
 *
 *  The watchdog is not allowed to re-derive any of this: if it ran the same
 *  occlusion walk the host runs, it would reach the same wrong answer. It reads
 *  what the host BELIEVES, and compares that against the DOM it measures for
 *  itself. */
export interface ViewSnapshot {
  tabId: string;
  /** The tab is in front of an open project and has a URL. */
  wanted: boolean;
  /** Last visibility the host pushed; null before the first push. */
  shown: boolean | null;
  /** Last bounds pushed to the backend, in window points. */
  bounds: Bounds | null;
  /** The placeholder element and its rect right now, in CSS pixels — resolved
   *  fresh, because a pane drag moves it without anything re-rendering. */
  host: Element | null;
  hostRect: DOMRect | null;
  /** CSS pixels per window point (Cmd +/-). */
  zoom: number;
  hasFrame: boolean;
  /** When a capture last came back with an image. 0 = never. */
  lastCaptureOkAt: number;
  /** The page is still arriving, so it has nothing worth photographing. */
  loading: boolean;
  /** Last navigation event, for deciding whether a page has settled. */
  lastNavAt: number;
}

/** Set by browserHost at import time. A function rather than an import so this
 *  module stays dependency-free and safe to import from anywhere. */
let snapshots: () => ViewSnapshot[] = () => [];

export function provideViewSnapshots(fn: () => ViewSnapshot[]) {
  snapshots = fn;
}

export function browserViewSnapshots(): ViewSnapshot[] {
  return snapshots();
}

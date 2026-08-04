// @vitest-environment jsdom
//
// The two moments the pane changes hands between the freeze-frame and the
// native view, pinned from the pane's side of the contract (watchBrowserPane):
//
//   * showing: the pane must NOT go live on the host's belief alone. The show
//     is a round trip and the page may never have painted this document
//     (loaded off screen); going live early unmounts the freeze-frame over
//     bare background. The pane holds frozen until browser_painted says the
//     page has a frame of its own — bounded, so a mute page can't hold it
//     forever.
//
//   * hiding: the frame in hand is up to CAPTURE_INTERVAL_MS old, and a page
//     that moved in that window jumps backwards when the still replaces it. A
//     hidden WKWebView still answers a snapshot (snapshot.rs), so the hide
//     itself takes one more picture and the still catches up under the
//     overlay.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerBrowserView,
  resetBrowserHost,
  setBrowserViewWanted,
  watchBrowserPane,
  type PaneView,
} from "./browserHost";
import { mockCommands } from "./test/setup";

const TAB = "tab-1";
const PANE = { x: 0, y: 40, w: 1200, h: 760 };

function place(el: Element, r: { x: number; y: number; w: number; h: number }) {
  el.getBoundingClientRect = () =>
    ({
      x: r.x,
      y: r.y,
      left: r.x,
      top: r.y,
      right: r.x + r.w,
      bottom: r.y + r.h,
      width: r.w,
      height: r.h,
      toJSON: () => "",
    }) as DOMRect;
}

let host: HTMLElement;
/** Flipped by each test: what browser_painted answers. */
let painted: boolean;
let frames: number;

beforeEach(() => {
  vi.useFakeTimers();
  window.innerWidth = 1200;
  window.innerHeight = 800;
  // Same jsdom shims as companionBrowserHide.test.ts: no cascade, no layout.
  (Element.prototype as Element & { checkVisibility: () => boolean }).checkVisibility =
    () => true;
  const styleOf = ((el: Element) => {
    const own = (el as HTMLElement).style;
    return {
      position: own.position || "static",
      zIndex: own.zIndex || "auto",
      pointerEvents: own.pointerEvents || "auto",
      display: own.display || "block",
      getPropertyValue: () => "",
    } as unknown as CSSStyleDeclaration;
  }) as typeof window.getComputedStyle;
  window.getComputedStyle = styleOf;
  globalThis.getComputedStyle = styleOf;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  painted = false;
  frames = 0;
  mockCommands({
    browser_set_bounds: () => null,
    browser_set_visible: () => null,
    browser_frame: () => {
      frames++;
      return "aGk=";
    },
    browser_painted: () => painted,
    js_log: () => null,
  });

  document.body.innerHTML = "";
  host = document.createElement("div");
  host.className = "preview-webview-host";
  place(host, PANE);
  document.body.appendChild(host);

  resetBrowserHost();
  registerBrowserView(TAB, () => host);
});

afterEach(() => {
  resetBrowserHost();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function settle(steps = 6) {
  for (let i = 0; i < steps; i++) {
    await vi.advanceTimersByTimeAsync(70);
  }
}

/** The pane as the component would see it. */
function watchPane() {
  const seen: PaneView[] = [];
  watchBrowserPane(TAB, (v) => seen.push(v));
  return {
    seen,
    state: () => seen[seen.length - 1]?.state,
  };
}

function cover() {
  const el = document.createElement("div");
  // A registered surface (overlaySurfaces.ts), so the DEV-mode unregistered
  // warning doesn't try to pretty-print a jsdom element mid-walk.
  el.className = "ctx-menu";
  el.style.position = "fixed";
  el.style.zIndex = "60";
  place(el, { x: 100, y: 100, w: 300, h: 200 });
  document.body.appendChild(el);
  return el;
}

describe("showing: the pane holds its freeze-frame until the page has painted", () => {
  it("stays frozen while browser_painted says no, and goes live when it says yes", async () => {
    const pane = watchPane();
    setBrowserViewWanted(TAB, true);
    // Well past the show, its ack and the first capture — but the page has
    // never painted, so the pane must still be standing in for it.
    await settle(4);
    expect(pane.state()).toBe("frozen");

    painted = true;
    await settle(3);
    expect(pane.state()).toBe("live");
  });

  it("gives up waiting on a page that never answers yes", async () => {
    const pane = watchPane();
    setBrowserViewWanted(TAB, true);
    // Past SETTLE_MAX_MS: the rescue in browser.rs owns the blank from here,
    // and a pane frozen forever would mask the page it eventually paints.
    await settle(14);
    expect(pane.state()).toBe("live");
  });
});

describe("hiding: the still catches up under the overlay", () => {
  it("takes a fresh frame on the hide itself, off screen", async () => {
    painted = true;
    const pane = watchPane();
    setBrowserViewWanted(TAB, true);
    await settle();
    expect(pane.state()).toBe("live");
    const before = frames;

    cover();
    // Short of CAPTURE_INTERVAL_MS since the last periodic capture, so a new
    // frame here can only be the hide-transition one.
    await settle(3);
    expect(pane.state()).toBe("frozen");
    expect(frames).toBeGreaterThan(before);
  });
});

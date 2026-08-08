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
//   * hiding: the frame in hand may predate the page's latest self-directed
//     change. A hidden WKWebView still answers a snapshot (snapshot.rs), so the
//     hide itself takes one more picture and the still catches up under the
//     overlay.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserPageChanged,
  forgetBrowserView,
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
    // Clean pages are not recaptured periodically, so a new frame here can
    // only be the hide-transition one.
    await settle(3);
    expect(pane.state()).toBe("frozen");
    expect(frames).toBeGreaterThan(before);
  });
});

describe("capture retention", () => {
  it("does not keep photographing a clean visible page on the heartbeat", async () => {
    painted = true;
    setBrowserViewWanted(TAB, true);
    await settle();
    const settledFrames = frames;

    await vi.advanceTimersByTimeAsync(30_000);

    expect(settledFrames).toBeGreaterThan(0);
    expect(frames).toBe(settledFrames);
  });
});

describe("frame resource lifetime", () => {
  const created: string[] = [];
  const revoked: string[] = [];
  let createDescriptor: PropertyDescriptor | undefined;
  let revokeDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    created.length = 0;
    revoked.length = 0;
    createDescriptor = Object.getOwnPropertyDescriptor(window.URL, "createObjectURL");
    revokeDescriptor = Object.getOwnPropertyDescriptor(window.URL, "revokeObjectURL");
    Object.defineProperty(window.URL, "createObjectURL", {
      configurable: true,
      value: () => {
        const url = `blob:canopy-frame-${created.length + 1}`;
        created.push(url);
        return url;
      },
    });
    Object.defineProperty(window.URL, "revokeObjectURL", {
      configurable: true,
      value: (url: string) => revoked.push(url),
    });
  });

  afterEach(() => {
    if (createDescriptor) {
      Object.defineProperty(window.URL, "createObjectURL", createDescriptor);
    } else {
      Reflect.deleteProperty(window.URL, "createObjectURL");
    }
    if (revokeDescriptor) {
      Object.defineProperty(window.URL, "revokeObjectURL", revokeDescriptor);
    } else {
      Reflect.deleteProperty(window.URL, "revokeObjectURL");
    }
  });

  it("releases the previous frame after adopting a replacement", async () => {
    painted = true;
    setBrowserViewWanted(TAB, true);
    await settle();
    expect(created).toHaveLength(1);

    browserPageChanged(TAB);
    await vi.advanceTimersByTimeAsync(1_100);

    expect(created).toHaveLength(2);
    expect(revoked).toContain(created[0]);
    expect(revoked).not.toContain(created[1]);
  });

  it("releases the retained frame when the view is forgotten", async () => {
    painted = true;
    setBrowserViewWanted(TAB, true);
    await settle();
    const current = created[0];

    forgetBrowserView(TAB);

    expect(revoked).toContain(current);
  });

  it("releases a decode that completes after the view was forgotten", async () => {
    let finishDecode: (() => void) | undefined;
    const OriginalImage = globalThis.Image;
    class DeferredImage {
      src = "";
      decode() {
        return new Promise<void>((resolve) => {
          finishDecode = resolve;
        });
      }
    }
    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      value: DeferredImage,
    });

    try {
      painted = true;
      setBrowserViewWanted(TAB, true);
      await vi.advanceTimersByTimeAsync(100);
      expect(created).toHaveLength(1);
      expect(finishDecode).toBeTypeOf("function");

      forgetBrowserView(TAB);
      finishDecode?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(revoked).toContain(created[0]);
    } finally {
      Object.defineProperty(globalThis, "Image", {
        configurable: true,
        value: OriginalImage,
      });
    }
  });

  it("rejects a pre-change decode and retries for the current page", async () => {
    const pending: Array<() => void> = [];
    const OriginalImage = globalThis.Image;
    class DeferredImage {
      src = "";
      decode() {
        return new Promise<void>((resolve) => pending.push(resolve));
      }
    }
    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      value: DeferredImage,
    });

    try {
      painted = true;
      setBrowserViewWanted(TAB, true);
      await vi.advanceTimersByTimeAsync(100);
      expect(created).toHaveLength(1);

      browserPageChanged(TAB);
      pending.shift()?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(revoked).toContain(created[0]);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(created).toHaveLength(2);
    } finally {
      Object.defineProperty(globalThis, "Image", {
        configurable: true,
        value: OriginalImage,
      });
    }
  });
});

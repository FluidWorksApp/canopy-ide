// @vitest-environment jsdom
//
// The companion gets out of a browser tab's way — and the rule it uses to
// decide that must not be a rule the getting-out-of-the-way changes.
//
// It was. The companion hid itself while a native view was SHOWN, and the host
// hides a view while anything is painted over it. Those two rules point at each
// other, and together they have a stable wrong answer:
//
//   companion mounted -> walk finds it over the pane -> view hidden
//                     -> "no view is shown" -> companion stays mounted
//
// Nothing moves after that. Every input is settled, no timer fires that would
// change anything, and the app sits there with a mascot in the corner and a page
// that never appears — which is exactly what a browser tab looked like with the
// companion enabled: permanently blank, from the first pass, forever.
//
// The fix is to decide on something the walk cannot move: whether a browser tab
// is in front with a URL and a placeholder to draw in (`claiming`). That is set
// by the tab being active — an input, not an output — so the loop is cut.
//
// This file closes the loop for real rather than asserting on one side of it:
// the harness below applies the companion's rule to the host's own snapshots
// and mounts/unmounts a `.companion` box accordingly, exactly like the
// component does. If the two rules ever point at each other again, it stops
// converging and this goes red.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  forgetBrowserView,
  registerBrowserView,
  resetBrowserHost,
  setBrowserViewWanted,
  refreshBrowserViews,
} from "./browserHost";
import { browserViewSnapshots } from "./browserSignals";
import { activeView, resetActiveView, subscribeActiveView } from "./activeView";
import { mockCommands } from "./test/setup";

const TAB = "tab-1";
/** The browser pane: everything under the tab bar of a 1200x800 window. */
const PANE = { x: 0, y: 40, w: 1200, h: 760 };
/** Where the companion parks by default — bottom right, inside the pane. */
const MASCOT = { x: 1120, y: 720, w: 54, h: 54 };

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

beforeEach(() => {
  vi.useFakeTimers();
  window.innerWidth = 1200;
  window.innerHeight = 800;
  // jsdom's checkVisibility consults a cascade that throws under this setup;
  // everything here is on screen. Same shim as browserOcclusionWalk.test.ts.
  (Element.prototype as Element & { checkVisibility: () => boolean }).checkVisibility =
    () => true;
  const styleOf = ((el: Element) => {
    const own = (el as HTMLElement).style;
    return {
      position: own.position || "static",
      zIndex: own.zIndex || "auto",
      pointerEvents: own.pointerEvents || "auto",
      display: own.display || "block",
      // The host reads --zoom and --bg off the root through this. Unset is the
      // honest answer here: currentZoom falls back to 1, which is what an
      // un-zoomed window reports anyway.
      getPropertyValue: () => "",
    } as unknown as CSSStyleDeclaration;
  }) as typeof window.getComputedStyle;
  window.getComputedStyle = styleOf;
  globalThis.getComputedStyle = styleOf;
  // jsdom lays nothing out, so it ships no ResizeObserver. The host observes
  // the document with one; nothing here resizes, so a stub that never fires is
  // the whole of what it needs.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  mockCommands({
    browser_set_bounds: () => null,
    browser_set_visible: () => null,
    // A page that photographs fine — so a blank pane in this test can only ever
    // be the visibility decision, never a missing frame.
    browser_frame: () => "aGk=",
    js_log: () => null,
  });

  document.body.innerHTML = "";
  host = document.createElement("div");
  host.className = "preview-webview-host";
  place(host, PANE);
  document.body.appendChild(host);

  resetActiveView();
  resetBrowserHost();
  registerBrowserView(TAB, () => host);
});

afterEach(() => {
  resetBrowserHost();
  resetActiveView();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** Put the mascot on screen, where the component puts it. */
function mountCompanion() {
  if (document.querySelector(".companion")) return;
  const el = document.createElement("div");
  el.className = "companion";
  el.style.position = "fixed";
  el.style.zIndex = "60";
  place(el, MASCOT);
  document.body.appendChild(el);
}

function unmountCompanion() {
  document.querySelector(".companion")?.remove();
}

const view = () => browserViewSnapshots()[0];
const companionOnScreen = () => !!document.querySelector(".companion");

/** Let the host's debounce, sweep and heartbeat run. MutationObserver callbacks
 *  are microtasks in jsdom, so each step drains those too. */
async function settle(steps = 20) {
  for (let i = 0; i < steps; i++) {
    await vi.advanceTimersByTimeAsync(70);
  }
}

/** The two rules running against each other, the way the app runs them.
 *
 *  `hideWhen` stands in for the companion's render: the component subscribes to
 *  the activeView channel and returns null, and browserHost pushes into that
 *  channel from the same layout pass that decides visibility — so a rule
 *  expressed over the channel here is the same input by the same route. */
async function runBoth(hideWhen: () => boolean) {
  mountCompanion();
  setBrowserViewWanted(TAB, true);
  refreshBrowserViews();
  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(70);
    if (hideWhen()) unmountCompanion();
    else mountCompanion();
  }
}

describe("a browser tab in front, with the companion enabled", () => {
  it("hides the companion and shows the page", async () => {
    // The rule the app actually ships: one channel, one field.
    await runBoth(() => activeView().nativeTabId !== null);
    expect(companionOnScreen()).toBe(false);
    expect(view().shown).toBe(true);
  });

  it("deadlocks if the companion decides on whether the view is SHOWN", async () => {
    // The bug, pinned as a bug. Not a fix to keep — a demonstration that
    // `shown` is an output of the walk and therefore unusable as the walk's
    // input, so that a future "simplification" back to it fails here loudly
    // instead of blanking every preview tab in the app.
    await runBoth(() => view()?.shown === true);
    expect(companionOnScreen()).toBe(true);
    expect(view().shown).toBe(false);
  });
});

describe("the channel anything can subscribe to", () => {
  it("names the browser tab claiming the pane, even while it is covered", async () => {
    mountCompanion();
    setBrowserViewWanted(TAB, true);
    await settle();
    expect(activeView().nativeTabId).toBe(TAB);
    expect(view().shown).toBe(false);
  });

  it("clears when the tab goes to the back", async () => {
    setBrowserViewWanted(TAB, true);
    await settle();
    expect(activeView().nativeTabId).toBe(TAB);
    setBrowserViewWanted(TAB, false);
    await settle();
    expect(activeView().nativeTabId).toBeNull();
  });

  it("clears when the last browser view is forgotten", async () => {
    setBrowserViewWanted(TAB, true);
    await settle();
    forgetBrowserView(TAB);
    await settle();
    // The pass that publishes this has no views left to loop over, which is
    // exactly why the value is collected in the loop and published outside it.
    expect(activeView().nativeTabId).toBeNull();
  });

  it("tells subscribers once per change, not once per pass", async () => {
    const seen: (string | null)[] = [];
    const off = subscribeActiveView(() => seen.push(activeView().nativeTabId));
    setBrowserViewWanted(TAB, true);
    await settle();
    setBrowserViewWanted(TAB, false);
    await settle();
    off();
    // The host's heartbeat runs several passes across that span and pushes on
    // every one; a channel that forwarded each would re-render every
    // subscriber four times a second for a value that never moved.
    expect(seen).toEqual([TAB, null]);
  });
});

describe("what the host reports about a view a surface is covering", () => {
  beforeEach(async () => {
    mountCompanion();
    setBrowserViewWanted(TAB, true);
    await settle();
  });

  it("is hidden, because something really is painted over it", () => {
    expect(view().shown).toBe(false);
  });

  it("still says the tab is claiming its rectangle", () => {
    // The distinction the fix rests on: "a browser tab is in front here" is
    // true whether or not the view is currently allowed on screen.
    expect(view().claiming).toBe(true);
  });

  it("stops claiming when the tab goes to the back", async () => {
    setBrowserViewWanted(TAB, false);
    await settle();
    expect(view().claiming).toBe(false);
  });

  it("stops claiming when the placeholder has no room to draw", async () => {
    place(host, { x: 0, y: 40, w: 0, h: 0 });
    refreshBrowserViews();
    await settle();
    // A pane collapsed to nothing is not a browser tab the companion has to
    // make way for — there is no page on screen to be in front of.
    expect(view().claiming).toBe(false);
  });
});

describe("one channel, and nothing reaching around it", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("has the companion subscribe rather than measure", () => {
    const src = read("src/components/Companion.tsx");
    expect(src).toContain("useNativeSurface");
    // No private timer and no reach into the browser layer. Both were how the
    // question got asked four different ways in four different files.
    expect(src).not.toContain("browserViewSnapshots");
    expect(src).not.toContain("onBrowserSignal");
  });

  it("still unmounts rather than hiding with CSS", () => {
    // A `display: none` companion is not painted, but a visibility-hidden or
    // opacity-0 one still has a box the walk would count — and the whole point
    // is to leave the pane clear.
    expect(read("src/components/Companion.tsx")).toContain("return null");
  });

  it("fills the channel from the layout pass, not from a poll", () => {
    const host = read("src/browserHost.ts");
    expect(host).toContain("setNativeSurface(claimedBy)");
    // Outside the per-view loop. Inside it, closing the last preview tab would
    // leave the channel naming a tab that no longer exists.
    const apply = host.slice(host.indexOf("function apply()"), host.indexOf("function capture("));
    expect(apply.indexOf("setNativeSurface(claimedBy)")).toBeGreaterThan(
      apply.indexOf("publish(tabId, e);"),
    );
  });

  it("leaves browserViewSnapshots to the layer that owns it", () => {
    // The snapshots are the browser layer's internal reading, and the watchdog
    // deliberately reads them raw — its independence from the host is the whole
    // point of it. Everything ELSE asks the channel. A new consumer added here
    // is a fifth spelling of "what is in front", which is what this replaced.
    const allowed = new Set([
      "src/browserSignals.ts", // defines them
      "src/browserWatchdog.ts", // deliberately independent
      "src/selftest/browserSelftest.ts", // asserts on the raw contract
      "src/companionBrowserHide.test.ts", // this file
    ]);
    // `--untracked` is the whole of this guard's reach, and it is not a
    // nicety. A new consumer is a NEW FILE, and a new file is untracked until
    // somebody commits it — so the tracked-only search passes on exactly the
    // change this exists to catch, and goes red one commit later, against
    // whoever pulls next. This test made that mistake about itself: the file
    // holding the channel mentioned the snapshots in its header comment, and
    // the guard called the tree clean right up until the commit landed.
    const hits = execSync(
      "git grep -l --untracked 'browserViewSnapshots' -- 'src/*' || true",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((f) => !allowed.has(f));
    expect(hits).toEqual([]);
  });

  it("catches a consumer that has not been committed yet", () => {
    // The guard above, held to its own claim. Without --untracked this passes
    // while a brand-new reacher-around sits in the working tree.
    const probe = join(process.cwd(), "src/zzGuardProbe.ts");
    writeFileSync(probe, "export const x = browserViewSnapshots;\n");
    try {
      const hits = execSync(
        "git grep -l --untracked 'browserViewSnapshots' -- 'src/*' || true",
        { encoding: "utf8" },
      );
      expect(hits).toContain("src/zzGuardProbe.ts");
    } finally {
      rmSync(probe, { force: true });
    }
  });
});

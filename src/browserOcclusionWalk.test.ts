// The walk, not the predicates.
//
// browserOcclusion.test.ts covers the decision — given a candidate, does it
// occlude — with synthetic candidates. Nothing covered the part that FINDS
// candidates in a real tree, so a walk that skips a subtree, or never reaches a
// position:fixed surface nested three levels down, passed the whole suite. A
// context menu over a browser tab is exactly that shape.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { occludersOver } from "./browserHost";

// The walk reads computed styles; jsdom's cascade is both slow here and prone
// to throwing from its own stylesheet plumbing. What this file exercises is the
// traversal — which subtrees get visited and what gets counted — so styles are
// read straight off the inline attribute, with pointer-events inherited the way
// the real property is. The predicates themselves have their own tests.
beforeEach(() => {
  // jsdom implements checkVisibility by consulting the cascade, which throws
  // from its own stylesheet plumbing under this suite's setup. Everything here
  // is visible unless a test says otherwise; the skip path has its own case.
  (Element.prototype as Element & { checkVisibility: () => boolean }).checkVisibility =
    () => true;
  const styleOf = ((el: Element) => {
    const own = (el as HTMLElement).style;
    let pe = own.pointerEvents;
    for (let n = el.parentElement; n && !pe; n = n.parentElement) {
      pe = n.style.pointerEvents;
    }
    return {
      position: own.position || "static",
      zIndex: own.zIndex || "auto",
      pointerEvents: pe || "auto",
    } as CSSStyleDeclaration;
  }) as typeof window.getComputedStyle;
  // Both bindings: readStyle() resolves the global, which is not guaranteed to
  // be the same object as `window` under every environment shim.
  window.getComputedStyle = styleOf;
  globalThis.getComputedStyle = styleOf;
});

/** jsdom lays nothing out, so every rectangle is stated. */
function rect(el: Element, r: { x: number; y: number; w: number; h: number }) {
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

/** The browser pane: the right-hand half of a 1200x800 window. RectLike is
 *  x/y/width/height — the shape browserBounds works in. */
const VIEW = { x: 600, y: 40, width: 600, height: 720 };

beforeEach(() => {
  document.body.innerHTML = "";
  // The walk warns about its own blind spot — a positioned, click-through box
  // over the browser — by passing the ELEMENT to console.warn. The test runner
  // then serialises it for the terminal and trips over jsdom's stylesheet
  // plumbing. The warning is diagnostics, not the behaviour under test; it is
  // asserted where it matters and swallowed everywhere else.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the occlusion walk", () => {
  it("finds a fixed surface nested inside an ordinary subtree", () => {
    // The shape that broke live: the menu is rendered by a footer component, so
    // it sits several levels down a subtree whose own boxes are nowhere near
    // the browser pane. Only the menu's own fixed rectangle reaches it.
    document.body.innerHTML = `
      <div class="app">
        <div class="panes">
          <div class="pane" id="pane"><div class="browser-host" id="host"></div></div>
        </div>
        <div class="status-bar" id="bar">
          <span class="split-btn">
            <div class="ctx-menu" id="menu"></div>
          </span>
        </div>
      </div>`;
    const host = document.getElementById("host")!;
    rect(document.querySelector(".app")!, { x: 0, y: 0, w: 1200, h: 800 });
    rect(document.querySelector(".panes")!, { x: 0, y: 40, w: 1200, h: 720 });
    rect(document.getElementById("pane")!, { x: 600, y: 40, w: 600, h: 720 });
    rect(host, { x: 600, y: 40, w: 600, h: 720 });
    // The footer's own box is at the bottom, clear of the pane.
    rect(document.getElementById("bar")!, { x: 0, y: 760, w: 1200, h: 40 });
    rect(document.querySelector(".split-btn")!, { x: 900, y: 760, w: 200, h: 40 });
    // The menu escapes it and lands over the browser.
    const menu = document.getElementById("menu")!;
    rect(menu, { x: 900, y: 300, w: 260, h: 400 });
    menu.setAttribute("style", "position:fixed;z-index:500");

    const found = occludersOver(host, VIEW);
    expect(found.map((c) => (c.el as HTMLElement).id)).toContain("menu");
  });

  it("does not count the host's own ancestors", () => {
    document.body.innerHTML = `<div id="pane"><div id="host"></div></div>`;
    const host = document.getElementById("host")!;
    rect(document.getElementById("pane")!, { x: 600, y: 40, w: 600, h: 720 });
    rect(host, { x: 600, y: 40, w: 600, h: 720 });
    expect(occludersOver(host, VIEW)).toEqual([]);
  });

  it("descends through a click-through wrapper to the surface inside it", () => {
    // The .side-peek-layer shape: a frame spanning the content area permanently,
    // click-through because it paints nothing, with the real surface inside it.
    // Classes are left off deliberately — an element matching a real rule sends
    // jsdom into its own stylesheet plumbing, which throws. What decides this
    // case is pointer-events, not the class.
    document.body.innerHTML = `
      <div id="host"></div>
      <div id="layer"><div id="panel"></div></div>`;
    const host = document.getElementById("host")!;
    rect(host, { x: 600, y: 40, w: 600, h: 720 });
    const layer = document.getElementById("layer")!;
    rect(layer, { x: 0, y: 40, w: 1200, h: 720 });
    layer.setAttribute("style", "position:absolute;pointer-events:none");
    const panel = document.getElementById("panel")!;
    rect(panel, { x: 700, y: 40, w: 400, h: 720 });
    // pointer-events is inherited, so the painted child inside a click-through
    // frame has to turn it back on — which is exactly what the real .side-peek
    // does, and what makes it visible to the structural test.
    panel.setAttribute("style", "position:absolute;pointer-events:auto");

    const found = occludersOver(host, VIEW);
    const ids = found.map((c) => (c.el as HTMLElement).id);
    expect(ids).toContain("panel");
    expect(ids).not.toContain("layer");
    // ...and the frame itself is reported as the walk's known blind spot, which
    // is how the next toast that needs listing gets found.
    expect(console.warn).toHaveBeenCalled();
  });

  it("ignores a surface that misses the pane entirely", () => {
    document.body.innerHTML = `
      <div id="host"></div>
      <div class="ctx-menu" id="menu"></div>`;
    const host = document.getElementById("host")!;
    rect(host, { x: 600, y: 40, w: 600, h: 720 });
    const menu = document.getElementById("menu")!;
    // A menu opened on the left-hand pane: nowhere near the browser.
    rect(menu, { x: 20, y: 300, w: 260, h: 400 });
    menu.setAttribute("style", "position:fixed;z-index:500");
    expect(occludersOver(host, VIEW)).toEqual([]);
  });

  it("catches a click-through painted surface via the backstop list", () => {
    // A toast takes no clicks, so structure cannot see it; .notice is listed.
    document.body.innerHTML = `
      <div id="host"></div>
      <div class="notice" id="toast"></div>`;
    const host = document.getElementById("host")!;
    rect(host, { x: 600, y: 40, w: 600, h: 720 });
    const toast = document.getElementById("toast")!;
    rect(toast, { x: 700, y: 700, w: 400, h: 60 });
    toast.setAttribute("style", "position:fixed;pointer-events:none");
    expect(occludersOver(host, VIEW).map((c) => (c.el as HTMLElement).id)).toContain("toast");
  });

  it("skips a subtree the engine reports as not visible", () => {
    // display:none on a wrapper takes its children with it — the walk must not
    // pay for them, and must not count a menu inside a closed panel.
    document.body.innerHTML = `
      <div id="host"></div>
      <div id="closed"><div class="ctx-menu" id="menu"></div></div>`;
    const host = document.getElementById("host")!;
    rect(host, { x: 600, y: 40, w: 600, h: 720 });
    const closed = document.getElementById("closed")!;
    rect(closed, { x: 600, y: 40, w: 600, h: 720 });
    (closed as Element & { checkVisibility: () => boolean }).checkVisibility = () => false;
    const menu = document.getElementById("menu")!;
    rect(menu, { x: 900, y: 300, w: 260, h: 400 });
    menu.setAttribute("style", "position:fixed;z-index:500");

    expect(occludersOver(host, VIEW)).toEqual([]);
  });
});

// Drives the real injected picker (src-tauri/src/preview_picker.js) in jsdom,
// through the same entry point the webview engine uses: window.__canopyBrowser.
//
// What is pinned here is the traversal. A flat document.querySelectorAll misses
// everything inside an open shadow root and everything inside a same-origin
// iframe, and the failure is silent: the snapshot comes back well-formed, just
// without the control the agent was sent to find. That reads as "the button
// does not exist" rather than "I cannot see it", which is the difference
// between an agent retrying and an agent confidently reporting the wrong thing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import SCRIPT from "../src-tauri/src/preview_picker.js?raw";

interface PickerBridge {
  run: (d: Record<string, unknown>) => { done: boolean; ok?: boolean; data?: unknown };
  drain: () => { canopy: string; id: number; ok: boolean; data: unknown }[];
}

interface SnapshotElement {
  ref: number;
  tag: string;
  text: string;
  selector: string;
  frame?: string;
  role?: string;
}

interface Snapshot {
  elements: SnapshotElement[];
  blockedFrames?: string[];
  domTruncated?: boolean;
}

const picker = (): PickerBridge =>
  (window as unknown as { __canopyBrowser: PickerBridge }).__canopyBrowser;

/** Anything with DOM constructors on it: the test realm, or a frame's window. */
interface RealmLike {
  Element: typeof Element;
  HTMLElement: typeof HTMLElement;
  [key: string]: unknown;
}

/** Run an op and return its reply payload.
 *
 *  Read-only ops (snapshot) finish inside run() and come straight back. Anything
 *  cursor-led (click, type) animates a pointer to the target first and answers
 *  through the outbox, so the clock has to be run forward before draining. */
let nextId = 1;
const op = async <T,>(d: Record<string, unknown>): Promise<T> => {
  const id = nextId++;
  const inline = picker().run({ id, ...d });
  if (inline.done) {
    if (!inline.ok) throw new Error(String(inline.data));
    return inline.data as T;
  }
  await vi.advanceTimersByTimeAsync(5000);
  const answer = picker()
    .drain()
    .find((m) => m.canopy === "agent-result" && m.id === id);
  if (!answer) throw new Error(`op ${String(d.op)} never answered`);
  if (!answer.ok) throw new Error(String(answer.data));
  return answer.data as T;
};

const snapshot = () => op<Snapshot>({ op: "snapshot" });
const labels = (s: Snapshot) => s.elements.map((e) => e.text);

/** Attach an open shadow root to `host` with the given markup. */
const shadow = (host: Element, html: string) => {
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = html;
  return root;
};

/** A same-origin iframe with the given body markup, appended to the page.
 *  jsdom gives srcdoc-less frames a real about:blank document synchronously. */
const frame = (html: string, attrs = ""): HTMLIFrameElement => {
  document.body.insertAdjacentHTML("beforeend", `<iframe ${attrs}></iframe>`);
  const el = document.body.lastElementChild as HTMLIFrameElement;
  el.contentDocument!.body.innerHTML = html;
  // A frame is its own realm with its own Element.prototype, so the stubs
  // installed on the test realm do not reach inside it. Without this every
  // framed element measures 0×0 and the picker correctly discards it — which
  // would look exactly like traversal failing to descend.
  if (el.contentWindow) layOut(el.contentWindow as unknown as RealmLike);
  return el;
};

/** vitest hands the test realm a `window` that is not the one `document`
 *  belongs to — `document.defaultView === window` is false in here — and jsdom's
 *  MouseEvent brand-checks its `view` member against its own Window class. So
 *  the picker's own event construction throws in this environment for a reason
 *  that cannot happen in a browser, where a document and its window always
 *  agree. Strip `view` on the way through rather than weaken the picker. */
const allowSyntheticEvents = () => {
  const realms = [globalThis, document.defaultView].filter(Boolean) as Record<
    string,
    unknown
  >[];
  for (const realm of realms) {
    for (const name of ["MouseEvent", "KeyboardEvent"]) {
      const Real = realm[name] as
        | (new (t: string, i?: Record<string, unknown>) => Event)
        | undefined;
      if (!Real || (Real as { __stripped?: boolean }).__stripped) continue;
      const Patched = function (type: string, init: Record<string, unknown> = {}) {
        const { view: _view, ...rest } = init;
        return new Real(type, rest);
      } as unknown as { __stripped?: boolean };
      Patched.__stripped = true;
      Object.defineProperty(realm, name, {
        configurable: true,
        writable: true,
        value: Patched,
      });
    }
  }
};

/** jsdom implements no layout, and innerText is a layout-dependent property it
 *  therefore leaves undefined. The picker reads both — rects to decide what is
 *  visible, innerText to label a control — so both are stood up here. Without
 *  this every element is invisible and every label is the empty string, which
 *  looks exactly like a traversal that found nothing. */
const layOut = (realm: RealmLike = globalThis as unknown as RealmLike) => {
  allowSyntheticEvents();
  const elementProto = realm.Element.prototype;
  const htmlProto = realm.HTMLElement.prototype;
  Object.defineProperty(htmlProto, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? "";
    },
  });
  const rect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: 40, bottom: 20, width: 40, height: 20 }) as DOMRect;
  Object.defineProperty(elementProto, "getClientRects", {
    configurable: true,
    writable: true,
    value: () => [rect()] as unknown as DOMRectList,
  });
  Object.defineProperty(elementProto, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: rect,
  });
  // jsdom implements no scrolling either. The repo's setup stubs this on the
  // test realm; a frame's realm is fresh and needs its own.
  if (!elementProto.scrollIntoView) {
    Object.defineProperty(elementProto, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }
};

describe("preview picker: deep traversal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    nextId = 1;
    document.documentElement.innerHTML = "<head></head><body></body>";
    const w = window as unknown as Record<string, unknown>;
    w.__canopyNativeBrowser = true;
    delete w.__canopyPicker;
    delete w.__canopyBrowser;
    new Function(SCRIPT)();
    picker().drain(); // discard the "ready" announcement
    layOut();
  });

  it("finds controls inside an open shadow root", async () => {
    document.body.innerHTML = `<button>top</button><my-widget></my-widget>`;
    shadow(document.querySelector("my-widget")!, `<button>inside</button>`);
    expect(labels(await snapshot())).toEqual(["top", "inside"]);
  });

  it("descends nested shadow roots", async () => {
    document.body.innerHTML = `<outer-el></outer-el>`;
    const outer = shadow(document.querySelector("outer-el")!, `<inner-el></inner-el>`);
    shadow(outer.querySelector("inner-el")!, `<button>deep</button>`);
    expect(labels(await snapshot())).toEqual(["deep"]);
  });

  it("finds controls inside a same-origin iframe", async () => {
    document.body.innerHTML = `<button>top</button>`;
    frame(`<button>framed</button>`);
    expect(labels(await snapshot())).toEqual(["top", "framed"]);
  });

  it("attributes a framed element to its frame, and leaves top-level ones bare", async () => {
    document.body.innerHTML = `<button>top</button>`;
    frame(`<button>framed</button>`, `id="checkout"`);
    const els = (await snapshot()).elements;
    expect(els.find((e) => e.text === "top")!.frame).toBeUndefined();
    expect(els.find((e) => e.text === "framed")!.frame).toBe("#checkout");
  });

  // The whole point of a ref: hand it back and it acts on the right element,
  // wherever it lives. A ref that only works at the top level is a trap.
  it("clicks a ref that lives inside a shadow root", async () => {
    document.body.innerHTML = `<my-widget></my-widget>`;
    const root = shadow(document.querySelector("my-widget")!, `<button>go</button>`);
    const btn = root.querySelector("button")!;
    const hits: string[] = [];
    btn.addEventListener("click", () => hits.push("clicked"));
    const ref = (await snapshot()).elements.find((e) => e.text === "go")!.ref;
    await op({ op: "click", ref });
    expect(hits).toEqual(["clicked"]);
  });

  it("types into a ref that lives inside an iframe", async () => {
    const f = frame(`<input placeholder="email">`);
    const input = f.contentDocument!.querySelector("input")!;
    const ref = (await snapshot()).elements.find((e) => e.text === "email")!.ref;
    await op({ op: "type", ref, text: "sam@fluidwords.app" });
    expect(input.value).toBe("sam@fluidwords.app");
  });

  // A reported selector has to be usable as an argument, or the snapshot is
  // describing a page the caller cannot act on.
  it("round-trips a reported deep selector back through click", async () => {
    document.body.innerHTML = `<my-widget></my-widget>`;
    const root = shadow(document.querySelector("my-widget")!, `<button>go</button>`);
    const hits: string[] = [];
    root.querySelector("button")!.addEventListener("click", () => hits.push("clicked"));
    const selector = (await snapshot()).elements.find((e) => e.text === "go")!.selector;
    expect(selector).toContain(">>>");
    await op({ op: "click", selector });
    expect(hits).toEqual(["clicked"]);
  });

  // Agents write plain CSS far more often than they copy a reported path.
  it("resolves a plain selector that only matches inside a shadow root", async () => {
    document.body.innerHTML = `<my-widget></my-widget>`;
    const root = shadow(
      document.querySelector("my-widget")!,
      `<button class="submit">go</button>`,
    );
    const hits: string[] = [];
    root.querySelector("button")!.addEventListener("click", () => hits.push("clicked"));
    await op({ op: "click", selector: "button.submit" });
    expect(hits).toEqual(["clicked"]);
  });

  it("reports a cross-origin frame as blocked rather than omitting it", async () => {
    document.body.innerHTML = `<button>top</button>`;
    const f = frame("", `id="paywall"`);
    // What a real cross-origin frame does: the getter throws on access.
    Object.defineProperty(f, "contentDocument", {
      get() {
        throw new DOMException("cross-origin", "SecurityError");
      },
    });
    const snap = await snapshot();
    expect(labels(snap)).toEqual(["top"]);
    expect(snap.blockedFrames).toEqual(["#paywall"]);
  });

  it("survives a frame whose document is not there yet", async () => {
    document.body.innerHTML = `<button>top</button>`;
    const f = frame("", `id="pending"`);
    Object.defineProperty(f, "contentDocument", { get: () => null });
    const snap = await snapshot();
    expect(labels(snap)).toEqual(["top"]);
    expect(snap.blockedFrames).toEqual(["#pending"]);
  });

  it("still reports a bare page exactly as before", async () => {
    document.body.innerHTML = `<button>one</button><a href="/x">two</a>`;
    const snap = await snapshot();
    expect(labels(snap)).toEqual(["one", "two"]);
    expect(snap.blockedFrames).toBeUndefined();
    expect(snap.domTruncated).toBeUndefined();
    expect(snap.elements.every((e) => e.frame === undefined)).toBe(true);
  });

  it("gives a missing deep selector a real error, not a silent miss", async () => {
    document.body.innerHTML = `<my-widget></my-widget>`;
    shadow(document.querySelector("my-widget")!, `<button>go</button>`);
    await expect(op({ op: "click", selector: "my-widget >>> input" })).rejects.toThrow(
      /no element matches selector/,
    );
  });
});

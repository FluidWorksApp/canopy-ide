import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLinkHint, opensLink, LINK_CHORD } from "./terminalLinks";
import { IS_MAC } from "./platform";

/** A MouseEvent stand-in — only the button and modifier flags are read. */
const click = (mods: Partial<MouseEvent> = {}) =>
  ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    clientX: 0,
    clientY: 0,
    ...mods,
  }) as MouseEvent;

/** The follow-link modifier on this platform, and the one it must never be
 *  confused with (on macOS that other one is a right-click). */
const linkMod = IS_MAC ? { metaKey: true } : { ctrlKey: true };
const otherMod = IS_MAC ? { ctrlKey: true } : { metaKey: true };

describe("opensLink in modifier mode", () => {
  it("follows a link on the platform's modifier", () => {
    expect(opensLink(click(linkMod), "modifier")).toBe(true);
  });

  it("ignores a bare click — the whole point of #178", () => {
    expect(opensLink(click(), "modifier")).toBe(false);
  });

  it("ignores the other platform's modifier", () => {
    expect(opensLink(click(otherMod), "modifier")).toBe(false);
    expect(opensLink(click({ ...linkMod, ...otherMod }), "modifier")).toBe(false);
  });

  it("ignores every button but the left one", () => {
    // xterm activates on any mouseup over a link, so right-click used to open
    // the URL *and* the context menu.
    expect(opensLink(click({ ...linkMod, button: 2 }), "modifier")).toBe(false);
    expect(opensLink(click({ ...linkMod, button: 1 }), "modifier")).toBe(false);
    expect(opensLink(click({ button: 2 }), "modifier")).toBe(false);
  });

  it("tolerates Shift and Alt riding along", () => {
    expect(opensLink(click({ ...linkMod, shiftKey: true }), "modifier")).toBe(true);
    expect(opensLink(click({ ...linkMod, altKey: true }), "modifier")).toBe(true);
  });

  it("is what a caller that names no mode gets", () => {
    expect(opensLink(click())).toBe(false);
    expect(opensLink(click(linkMod))).toBe(true);
  });
});

describe("opensLink in click mode", () => {
  it("follows a link on a bare click", () => {
    expect(opensLink(click(), "click")).toBe(true);
  });

  it("still follows one when the modifier rides along", () => {
    // Muscle memory from the chord must not stop working under the default.
    expect(opensLink(click(linkMod), "click")).toBe(true);
  });

  it("leaves a click that ended a selection alone", () => {
    // Same button, same gesture: a drag across a link ends over the link.
    expect(opensLink(click(), "click", true)).toBe(false);
    expect(opensLink(click(linkMod), "click", true)).toBe(false);
  });

  it("ignores the other platform's modifier and every other button", () => {
    expect(opensLink(click(otherMod), "click")).toBe(false);
    expect(opensLink(click({ button: 2 }), "click")).toBe(false);
    expect(opensLink(click({ button: 1 }), "click")).toBe(false);
  });
});

describe("createLinkHint", () => {
  let host: HTMLDivElement;
  const bubble = () => host.querySelector(".term-link-hint");

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    host.remove();
  });

  it("waits before showing, then names the chord", () => {
    const hint = createLinkHint(host, () => "modifier");
    hint.show(click());
    expect(bubble()).toBeNull();
    vi.advanceTimersByTime(300);
    expect(bubble()?.textContent).toContain(LINK_CHORD);
    hint.dispose();
  });

  it("names no chord when a plain click is enough", () => {
    const hint = createLinkHint(host, () => "click");
    hint.show(click());
    vi.advanceTimersByTime(300);
    expect(bubble()?.textContent).toBe("Open link");
    hint.dispose();
  });

  it("follows a mode that changes under an open terminal", () => {
    let mode: "click" | "modifier" = "modifier";
    const hint = createLinkHint(host, () => mode);
    hint.show(click());
    vi.advanceTimersByTime(300);
    expect(bubble()?.textContent).toContain(LINK_CHORD);
    hint.hide();
    mode = "click";
    hint.show(click());
    vi.advanceTimersByTime(300);
    expect(bubble()?.textContent).toBe("Open link");
    hint.dispose();
  });

  it("a pointer passing over a link never shows one", () => {
    const hint = createLinkHint(host);
    hint.show(click());
    vi.advanceTimersByTime(100);
    hint.hide();
    vi.advanceTimersByTime(1000);
    expect(bubble()).toBeNull();
    hint.dispose();
  });

  it("leaves nothing behind when the terminal goes away", () => {
    const hint = createLinkHint(host);
    hint.show(click());
    vi.advanceTimersByTime(300);
    expect(bubble()).not.toBeNull();
    hint.dispose();
    expect(bubble()).toBeNull();
  });

  it("shows one bubble however many links the pointer crosses", () => {
    const hint = createLinkHint(host);
    hint.show(click({ clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(300);
    hint.show(click({ clientX: 80, clientY: 40 }));
    vi.advanceTimersByTime(300);
    expect(host.querySelectorAll(".term-link-hint")).toHaveLength(1);
    hint.dispose();
  });
});

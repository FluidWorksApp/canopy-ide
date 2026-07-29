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

describe("opensLink", () => {
  it("follows a link on the platform's modifier", () => {
    expect(opensLink(click(linkMod))).toBe(true);
  });

  it("ignores a bare click — the whole point of #178", () => {
    expect(opensLink(click())).toBe(false);
  });

  it("ignores the other platform's modifier", () => {
    expect(opensLink(click(otherMod))).toBe(false);
    expect(opensLink(click({ ...linkMod, ...otherMod }))).toBe(false);
  });

  it("ignores every button but the left one", () => {
    // xterm activates on any mouseup over a link, so right-click used to open
    // the URL *and* the context menu.
    expect(opensLink(click({ ...linkMod, button: 2 }))).toBe(false);
    expect(opensLink(click({ ...linkMod, button: 1 }))).toBe(false);
    expect(opensLink(click({ button: 2 }))).toBe(false);
  });

  it("tolerates Shift and Alt riding along", () => {
    expect(opensLink(click({ ...linkMod, shiftKey: true }))).toBe(true);
    expect(opensLink(click({ ...linkMod, altKey: true }))).toBe(true);
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
    const hint = createLinkHint(host);
    hint.show(click());
    expect(bubble()).toBeNull();
    vi.advanceTimersByTime(300);
    expect(bubble()?.textContent).toContain(LINK_CHORD);
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

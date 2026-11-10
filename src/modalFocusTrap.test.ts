import { afterEach, describe, expect, it } from "vitest";
import { trapTab } from "./modalFocusTrap";

const key = (shiftKey = false) => new KeyboardEvent("keydown", { key: "Tab", shiftKey, cancelable: true, bubbles: true });
const mount = (html: string) => {
  document.body.innerHTML = html;
  // jsdom has no layout: report every element as rendered.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) el.getClientRects = () => [{}] as unknown as DOMRectList;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("modal focus trap", () => {
  it("wraps Tab from the last control to the first, and Shift+Tab back", () => {
    mount('<button id="out">x</button><div class="palette-backdrop"><input id="a"/><button id="b">b</button></div>');
    (document.getElementById("b") as HTMLElement).focus();
    const forward = key();
    trapTab(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("a");
    const back = key(true);
    trapTab(back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("b");
  });

  it("pulls focus in when it was outside", () => {
    mount('<button id="out">x</button><div aria-modal="true"><button id="in">i</button></div>');
    (document.getElementById("out") as HTMLElement).focus();
    trapTab(key());
    expect(document.activeElement?.id).toBe("in");
  });

  it("leaves Tab alone with no modal open, and ignores a plain role=dialog card", () => {
    mount('<button id="a">a</button><div role="dialog"><button id="b">b</button></div>');
    (document.getElementById("b") as HTMLElement).focus();
    const e = key();
    trapTab(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it("skips roving-tabindex controls that are not the current stop", () => {
    mount('<div class="palette-backdrop"><button id="a">a</button><button id="r1" tabindex="-1">r</button><button id="b">b</button></div>');
    (document.getElementById("b") as HTMLElement).focus();
    trapTab(key());
    expect(document.activeElement?.id).toBe("a");
  });
});

import { describe, expect, it, vi } from "vitest";
import { forgetTabThumb, overlayOpen, setTabThumb, subscribeTabThumbs, tabThumb } from "./tabThumbs";

describe("tabThumbs", () => {
  it("keeps the last picture per tab and forgets it", () => {
    expect(tabThumb("a")).toBeNull();
    setTabThumb("a", "AAAA");
    expect(tabThumb("a")).toBe("data:image/png;base64,AAAA");
    forgetTabThumb("a");
    expect(tabThumb("a")).toBeNull();
  });
  it("ignores an empty capture and notifies listeners", () => {
    const cb = vi.fn();
    const off = subscribeTabThumbs(cb);
    setTabThumb("b", "");
    expect(cb).not.toHaveBeenCalled();
    setTabThumb("b", "BB");
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    forgetTabThumb("b");
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it("sees a hover card or menu floating over the window", () => {
    expect(overlayOpen()).toBe(false);
    const card = document.createElement("div");
    card.className = "tab-hover-preview";
    document.body.append(card);
    expect(overlayOpen()).toBe(true);
    card.remove();
  });
});

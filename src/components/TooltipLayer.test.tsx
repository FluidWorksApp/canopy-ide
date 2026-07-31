import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { TooltipLayer } from "./TooltipLayer";

// The layer opens after a hover delay and listens for real pointer events on
// the document, so every test drives it the way the webview does: dispatch,
// then run the clock.
const hover = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  });

const settle = () =>
  act(() => {
    vi.advanceTimersByTime(400);
  });

const trigger = (attrs: Record<string, string>, tag = "button") => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
};

describe("TooltipLayer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    render(<TooltipLayer />);
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("shows the themed bubble for a native title", () => {
    hover(trigger({ title: "Stage file" }));
    settle();
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveClass("cnp-tooltip");
    expect(tip).toHaveTextContent("Stage file");
  });

  it("takes the title off the element so the platform draws nothing", () => {
    const el = trigger({ title: "Stage file" });
    hover(el);
    expect(el.hasAttribute("title")).toBe(false);
    settle();
    expect(el.hasAttribute("title")).toBe(false);
  });

  it("gives the title back when the pointer leaves", () => {
    const el = trigger({ title: "Stage file" });
    hover(el);
    settle();
    hover(document.body);
    expect(el.getAttribute("title")).toBe("Stage file");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows nothing before the hover delay is up", () => {
    hover(trigger({ title: "Stage file" }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("stays open when the pointer moves onto a child of the trigger", () => {
    const el = trigger({ title: "Stage file" });
    const icon = document.createElement("span");
    el.appendChild(icon);
    hover(el);
    settle();
    hover(icon);
    settle();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Stage file");
  });

  it("splits a chord into the mono hint chip", () => {
    hover(trigger({ title: "Toggle sidebar (⌘B)" }));
    settle();
    expect(screen.getByRole("tooltip").querySelector(".cnp-tooltip-label")).toHaveTextContent(
      "Toggle sidebar",
    );
    expect(screen.getByRole("tooltip").querySelector(".cnp-tooltip-hint")).toHaveTextContent("⌘B");
  });

  it("closes on a press and restores the title", () => {
    const el = trigger({ title: "Stage file" });
    hover(el);
    settle();
    act(() => {
      document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(el.getAttribute("title")).toBe("Stage file");
  });

  it("closes when something scrolls — the anchor has moved", () => {
    hover(trigger({ title: "Stage file" }));
    settle();
    act(() => {
      document.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("leaves an iframe title alone", () => {
    const el = trigger({ title: "preview" }, "iframe");
    hover(el);
    settle();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(el.getAttribute("title")).toBe("preview");
  });

  it("does not open for the focus that follows a click", () => {
    const el = trigger({ title: "Stage file" });
    act(() => {
      document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    settle();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens on keyboard focus", () => {
    const el = trigger({ title: "Stage file" });
    act(() => {
      el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    settle();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Stage file");
  });

  it("takes back a title React re-writes onto a live row, and follows it", async () => {
    const el = trigger({ title: "3 files changed" });
    hover(el);
    settle();
    el.setAttribute("title", "4 files changed");
    // MutationObserver callbacks are microtasks; fake timers don't run them.
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.hasAttribute("title")).toBe(false);
    expect(screen.getByRole("tooltip")).toHaveTextContent("4 files changed");
    hover(document.body);
    expect(el.getAttribute("title")).toBe("4 files changed");
  });

  it("gives the title back when the trigger is unmounted mid-hover", () => {
    const el = trigger({ title: "Stage file" });
    hover(el);
    el.remove();
    settle();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(el.getAttribute("title")).toBe("Stage file");
  });
});

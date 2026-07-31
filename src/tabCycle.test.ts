import { describe, expect, it } from "vitest";
import { tabCycleDirection } from "./tabCycle";

const ev = (over: Partial<KeyboardEvent>) =>
  ({
    code: "Tab",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  }) as KeyboardEvent;

describe("tabCycleDirection", () => {
  it("cycles forward on Ctrl+Tab and back on Ctrl+Shift+Tab", () => {
    expect(tabCycleDirection(ev({ ctrlKey: true }))).toBe(1);
    expect(tabCycleDirection(ev({ ctrlKey: true, shiftKey: true }))).toBe(-1);
  });

  it("leaves plain Tab alone — it still indents and moves focus", () => {
    expect(tabCycleDirection(ev({}))).toBe(0);
    expect(tabCycleDirection(ev({ shiftKey: true }))).toBe(0);
  });

  it("ignores Tab with Cmd or Option held", () => {
    // ⌘⇥ is the macOS app switcher; ⌃⌥⇥ is nobody's tab chord.
    expect(tabCycleDirection(ev({ ctrlKey: true, metaKey: true }))).toBe(0);
    expect(tabCycleDirection(ev({ ctrlKey: true, altKey: true }))).toBe(0);
    expect(tabCycleDirection(ev({ metaKey: true }))).toBe(0);
  });

  it("still answers the Ctrl+Cmd+Arrow menu accelerator", () => {
    const arrow = (code: string, over: Partial<KeyboardEvent> = {}) =>
      tabCycleDirection(ev({ code, ctrlKey: true, metaKey: true, ...over }));
    expect(arrow("ArrowRight")).toBe(1);
    expect(arrow("ArrowLeft")).toBe(-1);
    // Off macOS the same chord reaches the webview as Ctrl+Alt.
    expect(arrow("ArrowRight", { metaKey: false, altKey: true })).toBe(1);
    expect(arrow("ArrowLeft", { metaKey: false, altKey: true })).toBe(-1);
  });

  it("leaves a bare Ctrl+Arrow to the terminal", () => {
    // Ctrl+Arrow is word-jump in every readline; only the paired modifier
    // chord is ours.
    expect(tabCycleDirection(ev({ code: "ArrowRight", ctrlKey: true }))).toBe(
      0,
    );
    expect(tabCycleDirection(ev({ code: "ArrowLeft", ctrlKey: true }))).toBe(0);
  });

  it("ignores keys that are not the tab chords", () => {
    expect(tabCycleDirection(ev({ code: "KeyT", ctrlKey: true }))).toBe(0);
    expect(
      tabCycleDirection(ev({ code: "ArrowUp", ctrlKey: true, metaKey: true })),
    ).toBe(0);
  });
});

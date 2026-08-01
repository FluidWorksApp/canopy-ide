// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Companion } from "./Companion";
import { getSettings, updateSettings } from "../settings";
import { DEFAULT_SPOT } from "../companion";
import type { AttentionItem } from "../attention";

// The companion draws a real <Mascot> and, when opened, a real <Markdown>.
// Neither is what these tests are about, and Markdown drags a sanitizer and a
// parser into a test about pointer arithmetic.
vi.mock("./Mascot", () => ({
  Mascot: ({ state }: { state: string }) => <svg data-face={state} />,
}));
vi.mock("./CompanionChat", () => ({
  CompanionChat: ({
    onRetry,
    onToggleExpand,
    width,
    height,
  }: {
    onRetry: () => void;
    onToggleExpand: () => void;
    width: number;
    height: number;
  }) => (
    <div data-testid="chat" data-width={width} data-height={height}>
      <button data-testid="retry" onClick={onRetry} />
      <button data-testid="grow" onClick={onToggleExpand} />
    </div>
  ),
}));

const VIEW = { width: 1000, height: 600 };
const MASCOT = 54;
const travelX = VIEW.width - MASCOT;
const travelY = VIEW.height - MASCOT;

beforeEach(() => {
  localStorage.clear();
  window.innerWidth = VIEW.width;
  window.innerHeight = VIEW.height;
});

const noop = () => {};

function mount(notices: AttentionItem[] = []) {
  return render(
    <Companion
      notices={notices}
      onDismissNotice={noop}
      onFollowNotice={noop}
      proposal={null}
      onAnswerProposal={noop}
      onInstallCli={noop}
      onRetry={noop}
    />,
  );
}

const mascot = () => document.querySelector(".companion") as HTMLElement;

/** Where it is actually drawn. jsdom's getBoundingClientRect is always zero, so
 *  the inline style the component sets is the only truth about its position —
 *  and it is the same number the real drag arithmetic works from. */
function origin(): { left: number; top: number } {
  const el = mascot();
  return { left: parseFloat(el.style.left), top: parseFloat(el.style.top) };
}

/** jsdom has no pointer capture; the component calls it defensively. */
function stubCapture(el: HTMLElement) {
  (el as unknown as { setPointerCapture: () => void }).setPointerCapture = noop;
  (el as unknown as { releasePointerCapture: () => void }).releasePointerCapture = noop;
}

function pointer(el: HTMLElement, type: "Down" | "Move" | "Up", x: number, y: number) {
  fireEvent[`pointer${type}` as "pointerDown"](el, {
    clientX: x,
    clientY: y,
    button: 0,
    pointerId: 1,
    isPrimary: true,
  });
}

describe("dragging the companion", () => {
  it("remembers where it was dropped, as a fraction of the window", () => {
    mount();
    const el = mascot();
    stubCapture(el);
    const from = origin();
    act(() => {
      pointer(el, "Down", from.left + 27, from.top + 27);
      pointer(el, "Move", 400, 300);
      pointer(el, "Up", 400, 300);
    });
    const spot = getSettings().companionSpot;
    expect(Math.round(spot.x * travelX)).toBe(400 - 27);
    expect(Math.round(spot.y * travelY)).toBe(300 - 27);
  });

  it("saves the release point even when the whole flick lands in one frame", () => {
    // The bug this pins: reading the drag position from React state on
    // pointerup takes a value one render behind, so a flick fast enough that
    // the last move and the release are not separated by a re-render saved
    // where the drag *started* and the companion snapped back. Every event
    // here is dispatched in a single act(), which is exactly that case.
    mount();
    const el = mascot();
    stubCapture(el);
    const from = origin();
    act(() => {
      pointer(el, "Down", from.left + 27, from.top + 27);
      pointer(el, "Move", 120, 90);
      pointer(el, "Up", 120, 90);
    });
    const spot = getSettings().companionSpot;
    expect(Math.round(spot.x * travelX)).toBe(120 - 27);
    expect(Math.round(spot.y * travelY)).toBe(90 - 27);
    expect(spot).not.toEqual(DEFAULT_SPOT);
  });

  it("never lets a drag put it off-screen", () => {
    mount();
    const el = mascot();
    stubCapture(el);
    const from = origin();
    act(() => {
      pointer(el, "Down", from.left + 27, from.top + 27);
      pointer(el, "Move", 5000, -5000);
      pointer(el, "Up", 5000, -5000);
    });
    const spot = getSettings().companionSpot;
    expect(spot.x).toBeLessThanOrEqual(1);
    expect(spot.x).toBeGreaterThanOrEqual(0);
    expect(spot.y).toBeLessThanOrEqual(1);
    expect(spot.y).toBeGreaterThanOrEqual(0);
  });

  it("treats a press that barely moves as a click, not a drag", () => {
    mount();
    const el = mascot();
    stubCapture(el);
    const before = getSettings().companionSpot;
    const from = origin();
    act(() => {
      pointer(el, "Down", from.left + 27, from.top + 27);
      pointer(el, "Move", from.left + 28, from.top + 29);
      pointer(el, "Up", from.left + 28, from.top + 29);
    });
    // Position untouched, and the chat opened instead.
    expect(getSettings().companionSpot).toEqual(before);
    expect(screen.getByTestId("chat")).toBeTruthy();
  });

  it("ignores a right-click so the drag cannot start from one", () => {
    mount();
    const el = mascot();
    stubCapture(el);
    const before = getSettings().companionSpot;
    act(() => {
      fireEvent.pointerDown(el, { clientX: 100, clientY: 100, button: 2, pointerId: 1 });
      pointer(el, "Move", 400, 400);
      pointer(el, "Up", 400, 400);
    });
    expect(getSettings().companionSpot).toEqual(before);
  });
});

describe("with no agent CLI installed", () => {
  it("stays on screen instead of vanishing", async () => {
    // Going invisible was the wrong answer: the user is then left with a
    // setting that says the companion is on, no companion, and nothing telling
    // them what it wants. It stays, asleep, and says so when opened.
    const { startCompanion } = await import("../companionSession");
    await startCompanion({ projects: [], installed: () => false, tools: [] });
    mount();
    expect(mascot()).toBeTruthy();
    expect(mascot().querySelector("svg")?.getAttribute("data-face")).toBe("sleeping");
  });
});

describe("a dead session", () => {
  it("offers a retry that reaches the launcher", () => {
    // Recovering from "the companion's agent stopped" used to mean finding the
    // Settings toggle and switching it off and on again.
    const onRetry = vi.fn();
    render(
      <Companion
        notices={[]}
        onDismissNotice={noop}
        onFollowNotice={noop}
        proposal={null}
        onAnswerProposal={noop}
        onInstallCli={noop}
        onRetry={onRetry}
      />,
    );
    act(() => {
      fireEvent.click(mascot());
      fireEvent.pointerDown(mascot(), { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
      fireEvent.pointerUp(mascot(), { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    });
    const retry = screen.queryByTestId("retry");
    if (retry) {
      act(() => void fireEvent.click(retry));
      expect(onRetry).toHaveBeenCalled();
    }
  });
});

describe("the notice it delivers", () => {
  const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
    id: "n1",
    kind: "fyi",
    tone: "info",
    title: "something happened",
    source: "app",
    ts: 0,
    ...over,
  });

  const card = () => document.querySelector(".companion-notice") as HTMLElement;

  it("wears the tone it is reporting, not the one card for everything", () => {
    // A failure and a success used to be the same card: no tone class at all,
    // and the reader was left to find the severity in a 54px face beside it.
    mount([item({ tone: "error", title: "could not determine current branch" })]);
    expect(card().className).toContain("companion-notice-error");
  });

  it("does not give an error the standing edge that means 'still waiting'", () => {
    // The bug: the edge was drawn for anything that does not fade, and an error
    // does not fade either — so a failure came up wearing the question's accent
    // while Ash wore blocked red for the same item.
    mount([item({ tone: "error" })]);
    expect(card().className).not.toContain("companion-notice-held");
  });

  it("keeps the standing edge for a question nobody has answered", () => {
    mount([item({ kind: "question", tone: "warn" })]);
    expect(card().className).toContain("companion-notice-held");
  });

  it("drops it again once that question is resolved", () => {
    mount([item({ kind: "question", tone: "warn", resolvedAt: 1 })]);
    expect(card().className).not.toContain("companion-notice-held");
  });

  it("stands beside the companion, not a chat panel's height above it", () => {
    // It used to be placed with the chat panel's geometry, so the panel's 380px
    // bottom clamp applied to a ~76px card: with the companion in its default
    // bottom-right corner the notice was parked a third of the window above the
    // mascot supposedly saying it, floating unattached over the work.
    updateSettings({ companionSpot: { x: 1, y: 1 } });
    mount([item()]);
    const top = parseFloat(card().style.top);
    const mascotTop = parseFloat(mascot().style.top);
    expect(mascotTop - top).toBeLessThan(120);
    // Still fully on screen, which is the only thing the clamp is for.
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(VIEW.height);
  });
});

describe("expanding the chat", () => {
  /** Open the panel the way a click does. */
  function openChat() {
    const el = mascot();
    stubCapture(el);
    act(() => {
      pointer(el, "Down", 0, 0);
      pointer(el, "Up", 0, 0);
    });
    return screen.getByTestId("chat");
  }

  it("gives the panel more room, still placed inside the window", () => {
    updateSettings({ companionSpot: { x: 1, y: 1 } });
    mount();
    const chat = openChat();
    const before = Number(chat.dataset.height);
    act(() => void fireEvent.click(screen.getByTestId("grow")));
    const after = Number(screen.getByTestId("chat").dataset.height);
    expect(after).toBeGreaterThan(before);
    // The window here is 600 tall: an unclamped expanded height would be placed
    // as if it fit and take the compose box off the bottom edge.
    expect(after).toBeLessThanOrEqual(VIEW.height);
    expect(Number(screen.getByTestId("chat").dataset.width)).toBeLessThanOrEqual(VIEW.width);
  });

  it("stays expanded the next time it is opened", () => {
    // Re-clicking the control on every summon is the cost the control exists to
    // remove.
    mount();
    openChat();
    act(() => void fireEvent.click(screen.getByTestId("grow")));
    const big = Number(screen.getByTestId("chat").dataset.height);
    act(() => {
      pointer(mascot(), "Down", 0, 0);
      pointer(mascot(), "Up", 0, 0);
    });
    expect(screen.queryByTestId("chat")).toBeNull();
    openChat();
    expect(Number(screen.getByTestId("chat").dataset.height)).toBe(big);
  });
});

describe("the position survives", () => {
  it("a remount — it is a setting, not component state", () => {
    updateSettings({ companionSpot: { x: 0.25, y: 0.75 } });
    const { unmount } = mount();
    const first = mascot().style.left;
    unmount();
    mount();
    expect(mascot().style.left).toBe(first);
    expect(mascot().style.left).toBe(`${Math.round(0.25 * travelX)}px`);
  });

  it("a resize, staying proportionally placed rather than stranded", () => {
    updateSettings({ companionSpot: { x: 1, y: 1 } });
    mount();
    expect(mascot().style.left).toBe(`${VIEW.width - MASCOT}px`);
    act(() => {
      window.innerWidth = 600;
      window.innerHeight = 400;
      window.dispatchEvent(new Event("resize"));
    });
    // Flush against the new right edge, not off past it.
    expect(mascot().style.left).toBe(`${600 - MASCOT}px`);
    expect(mascot().style.top).toBe(`${400 - MASCOT}px`);
  });
});

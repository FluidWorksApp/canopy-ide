import { beforeEach, describe, expect, it, vi } from "vitest";

const { onDragDropEvent, unlisten, drag } = vi.hoisted(() => ({
  onDragDropEvent: vi.fn(),
  unlisten: vi.fn(),
  drag: {
    handler: undefined as
      | ((event: {
          payload:
            | { type: "drop"; paths: string[]; position: { x: number; y: number } }
            | { type: "leave" };
        }) => void)
      | undefined,
  },
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onDragDropEvent }),
}));

import {
  registerTerminalWindowEvents,
  terminalWindowEventMetrics,
  type TerminalWindowEventTarget,
} from "./terminalWindowEvents";
import { INSERT_TEXT_EVENT } from "./insertText";
import { THEME_CHANGE_EVENT } from "./settings";

const target = (active: () => boolean): TerminalWindowEventTarget => ({
  active,
  focus: vi.fn(),
  insertText: vi.fn(),
  dropPaths: vi.fn(),
  themeChanged: vi.fn(),
});
describe("terminal window event router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drag.handler = undefined;
    onDragDropEvent.mockImplementation((handler) => {
      drag.handler = handler;
      return Promise.resolve(unlisten);
    });
  });

  it("installs one listener set and routes active-only input", async () => {
    const hidden = target(() => false);
    const active = target(() => true);
    const offHidden = registerTerminalWindowEvents(hidden);
    const offActive = registerTerminalWindowEvents(active);
    await Promise.resolve();
    await Promise.resolve();

    expect(onDragDropEvent).toHaveBeenCalledTimes(1);
    expect(terminalWindowEventMetrics()).toMatchObject({
      targets: 2,
      domListenerSets: 1,
      tauriDropListeners: 1,
    });
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new CustomEvent(INSERT_TEXT_EVENT, { detail: "hello" }));
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
    expect(active.focus).toHaveBeenCalledTimes(1);
    expect(active.insertText).toHaveBeenCalledWith("hello");
    expect(hidden.insertText).not.toHaveBeenCalled();
    expect(active.themeChanged).toHaveBeenCalledTimes(1);
    expect(hidden.themeChanged).toHaveBeenCalledTimes(1);

    offHidden();
    offActive();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(terminalWindowEventMetrics()).toMatchObject({
      targets: 0,
      domListenerSets: 0,
      tauriDropListeners: 0,
    });
  });

  it("contains a native-listener failure and retries on a later owner", async () => {
    vi.useFakeTimers();
    onDragDropEvent.mockRejectedValueOnce(new Error("webview unavailable"));
    const firstOff = registerTerminalWindowEvents(target(() => true));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalWindowEventMetrics()).toMatchObject({
      targets: 1,
      tauriDropListeners: 0,
      tauriDropListenerPending: 0,
      tauriDropRetryPending: 1,
    });
    onDragDropEvent.mockResolvedValueOnce(unlisten);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(onDragDropEvent).toHaveBeenCalledTimes(2);
    expect(terminalWindowEventMetrics()).toMatchObject({
      targets: 1,
      tauriDropListeners: 1,
      tauriDropRetryPending: 0,
    });
    firstOff();
    vi.useRealTimers();
  });

  it("routes a drop to the visible split pane under the pointer", async () => {
    const active = target(() => true);
    active.containsPoint = (x) => x < 100;
    const hovered = target(() => false);
    hovered.containsPoint = (x) => x >= 100 && x < 200;
    const offActive = registerTerminalWindowEvents(active);
    const offHovered = registerTerminalWindowEvents(hovered);
    await Promise.resolve();
    await Promise.resolve();

    drag.handler?.({
      payload: {
        type: "drop",
        paths: ["/tmp/reference image.png"],
        position: { x: 150, y: 20 },
      },
    });
    expect(hovered.dropPaths).toHaveBeenCalledWith(["/tmp/reference image.png"]);
    expect(active.dropPaths).not.toHaveBeenCalled();

    // Another drop surface can sit over a terminal. If the release is outside
    // every visible terminal, do not paste into the previously focused shell.
    drag.handler?.({
      payload: {
        type: "drop",
        paths: ["/tmp/not-for-the-shell.png"],
        position: { x: 250, y: 20 },
      },
    });
    expect(active.dropPaths).not.toHaveBeenCalled();
    expect(hovered.dropPaths).toHaveBeenCalledTimes(1);

    offActive();
    offHovered();
  });
});

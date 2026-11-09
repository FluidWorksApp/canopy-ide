// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StreamedBrowser } from "./StreamedBrowser";
import type { RemoteExecutionClient } from "./client";

vi.mock("../terminalClipboard", () => ({ writeClipboardText: vi.fn(async () => true) }));

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 1;
  binaryType = "";
  readonly sent: unknown[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: typeof data === "object" && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data }));
  }
}
const latest = () => FakeSocket.all.at(-1)!;
const control = (controller: string, dialog: unknown = null, generation = 0) => ({ type: "control", canOperate: true, controller, generation, dialog });

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", class { private readonly callback: () => void; constructor(callback: () => void) { this.callback = callback; } observe() { this.callback(); } disconnect() {} });
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 640, height: 400, close() {} })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, x: 0, y: 0, toJSON() {} } as DOMRect);
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = () => {
  const streamUrl = vi.fn(async (_id: string, path: string) => `wss://host.test/v1/stream?ticket=${streamUrl.mock.calls.length}&path=${encodeURIComponent(path)}`);
  const client = { streamUrl } as unknown as RemoteExecutionClient;
  const view = render(<StreamedBrowser client={client} workspaceId="alice" workspaceName="Alice" />);
  return { view, streamUrl };
};

it("watches the agent, takes control, maps a click into page pixels and releases", async () => {
  const { view, streamUrl } = mount();
  await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  // The cap is the pane at the device pixel ratio.
  expect(streamUrl).toHaveBeenCalledWith("alice", "/browser/stream?maxWidth=1600&maxHeight=1000");
  act(() => {
    latest().message(control("agent"));
    latest().message({ type: "viewport", width: 1280, height: 800 });
    latest().message(new ArrayBuffer(4));
  });
  expect(view.getByRole("status").textContent).toBe("Agent has control");
  expect(latest().sent).toEqual([{ type: "ack" }]);
  // Input while the agent controls the page is never sent.
  const canvas = view.container.querySelector("canvas")!;
  fireEvent.pointerDown(canvas, { button: 0, buttons: 1, clientX: 400, clientY: 250, pointerId: 1 });
  expect(latest().sent).toEqual([{ type: "ack" }]);
  fireEvent.click(view.getByRole("button", { name: "Take control" }));
  expect(latest().sent.at(-1)).toEqual({ type: "takeControl" });
  act(() => latest().message(control("you", null, 1)));
  expect(view.getByRole("status").textContent).toBe("You have control");
  // Taking control sends the pane size for the page to follow.
  expect(latest().sent.at(-1)).toEqual({ type: "resize", width: 800, height: 500 });
  await waitFor(() => expect((createImageBitmap as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
  await act(async () => {});
  canvas.setPointerCapture = vi.fn();
  fireEvent.pointerDown(canvas, { button: 0, buttons: 1, clientX: 400, clientY: 250, pointerId: 1 });
  fireEvent.pointerUp(canvas, { button: 0, buttons: 0, clientX: 400, clientY: 250, pointerId: 1 });
  expect(latest().sent.slice(-2)).toEqual([
    { type: "mouse", action: "down", x: 640, y: 400, modifiers: 0, button: "left", buttons: 1, clickCount: 1 },
    { type: "mouse", action: "up", x: 640, y: 400, modifiers: 0, button: "left", buttons: 0, clickCount: 1 },
  ]);
  fireEvent.click(view.getByRole("button", { name: "Release control" }));
  expect(latest().sent.at(-1)).toEqual({ type: "releaseControl" });
});

it("shows the page's dialog and answers it only while in control", async () => {
  const { view } = mount();
  await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  const dialog = { type: "prompt", message: "Name?", defaultValue: "initial" };
  act(() => latest().message(control("agent", dialog)));
  expect(view.getByRole("dialog", { name: "Browser dialog" }).textContent).toContain("Take control to respond.");
  act(() => latest().message(control("you", dialog, 1)));
  const answer = view.getByRole("textbox", { name: "Dialog response" }) as HTMLInputElement;
  expect(answer.value).toBe("initial");
  fireEvent.change(answer, { target: { value: "Ada" } });
  fireEvent.click(view.getByRole("button", { name: "Accept" }));
  expect(latest().sent.at(-1)).toEqual({ type: "dialog", accept: true, promptText: "Ada" });
});

it("streams only while the window is visible, and stops for good when the page closes", async () => {
  const { view } = mount();
  await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(latest().readyState).toBe(3);
  expect(view.getByRole("status").textContent).toBe("Paused while hidden");
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await waitFor(() => expect(FakeSocket.all).toHaveLength(2));
  act(() => latest().dispatchEvent(Object.assign(new Event("close"), { code: 4404 })));
  expect(view.getByRole("status").textContent).toBe("The agent browser closed");
  fireEvent.click(view.getByRole("button", { name: "Reopen the agent browser" }));
  await waitFor(() => expect(FakeSocket.all).toHaveLength(3));
});

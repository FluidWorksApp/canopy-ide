// @vitest-environment jsdom
// The desktop preview's surface (autoControl): input goes to the page without
// "Take control" unless another viewer holds it, and pointer positions map to
// page CSS pixels even when frames arrive at 2x (the host renders at 2x, the
// page's viewport is in CSS pixels). The August Chromium engine sent frame
// pixels as page coordinates and every click landed in the wrong place.
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StreamSurface } from "./StreamSurface";

vi.mock("../terminalClipboard", () => ({ writeClipboardText: vi.fn(async () => true) }));

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 1;
  binaryType = "";
  readonly sent: Record<string, unknown>[] = [];
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
const control = (controller: string) => ({ type: "control", canOperate: true, controller, generation: 0, dialog: null });

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", class { private readonly callback: () => void; constructor(callback: () => void) { this.callback = callback; } observe() { this.callback(); } disconnect() {} });
  // Frames at 2x: 1600x1000 device pixels for an 800x500 CSS viewport.
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1600, height: 1000, close() {} })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D);
  // The pane is 400x250 on screen: half the page's CSS size.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 250, right: 400, bottom: 250, x: 0, y: 0, toJSON() {} } as DOMRect);
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = (events: Partial<Parameters<typeof StreamSurface>[0]> = {}) => {
  const streamUrl = vi.fn(async (path: string) => `ws://127.0.0.1:1/tabs/t/stream?ticket=x&${path.split("?")[1] ?? ""}`);
  const view = render(<StreamSurface streamUrl={streamUrl} connectKey="t" visible autoControl dialogHint="Click the page to respond." {...events} />);
  return { view, streamUrl };
};

const paintFrame = async () => {
  act(() => {
    latest().message({ type: "viewport", width: 800, height: 500 });
    latest().message(new ArrayBuffer(4));
  });
  await waitFor(() => expect((createImageBitmap as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
  await act(async () => {});
};

it("clicks while the agent owns the page, in page CSS pixels from a 2x frame", async () => {
  const { view } = mount();
  await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  act(() => latest().message(control("agent")));
  await paintFrame();
  const canvas = view.container.querySelector("canvas")!;
  canvas.setPointerCapture = vi.fn();
  // The canvas holds the 2x frame; the page is 800x500 CSS.
  expect(canvas.width).toBe(1600);
  fireEvent.pointerDown(canvas, { button: 0, buttons: 1, clientX: 200, clientY: 125, pointerId: 1 });
  fireEvent.pointerUp(canvas, { button: 0, buttons: 0, clientX: 200, clientY: 125, pointerId: 1 });
  const mice = latest().sent.filter((message) => message.type === "mouse");
  // The centre of the pane is the centre of the page, not of the frame.
  expect(mice[0]).toMatchObject({ type: "mouse", action: "down", x: 400, y: 250, button: "left" });
  expect(mice[1]).toMatchObject({ type: "mouse", action: "up", x: 400, y: 250 });
  // No "Take control" round trip was needed.
  expect(latest().sent.some((message) => message.type === "takeControl")).toBe(false);
});

it("sends nothing while another viewer holds the page", async () => {
  const { view } = mount();
  await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  act(() => latest().message(control("another-viewer")));
  await paintFrame();
  const canvas = view.container.querySelector("canvas")!;
  canvas.setPointerCapture = vi.fn();
  fireEvent.pointerDown(canvas, { button: 0, buttons: 1, clientX: 200, clientY: 125, pointerId: 1 });
  expect(latest().sent.filter((message) => message.type === "mouse")).toEqual([]);
});

it("hands the preview its navigation, picker messages, popups and file choosers", async () => {
  const onNavigated = vi.fn();
  const onPicker = vi.fn();
  const onPopup = vi.fn();
  const onFileChooser = vi.fn();
  mount({ onNavigated, onPicker, onPopup, onFileChooser });
  await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  act(() => {
    latest().message({ type: "navigated", url: "http://localhost:3000/a", title: "A" });
    latest().message({ type: "picker", message: { canopy: "annotation", payload: { selector: "#x" } } });
    latest().message({ type: "popup", tabId: "popup-1", openerId: "t", url: "https://accounts.example/signin" });
    latest().message({ type: "fileChooser", id: "c1", multiple: false, accept: ".png" });
  });
  expect(onNavigated).toHaveBeenCalledWith({ url: "http://localhost:3000/a", title: "A" });
  expect(onPicker).toHaveBeenCalledWith({ canopy: "annotation", payload: { selector: "#x" } });
  expect(onPopup).toHaveBeenCalledWith({ tabId: "popup-1", openerId: "t", url: "https://accounts.example/signin" });
  expect(onFileChooser).toHaveBeenCalledWith({ id: "c1", multiple: false, accept: ".png" });
});

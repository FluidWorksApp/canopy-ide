import { afterEach, expect, it, vi } from "vitest";
import SCRIPT from "../src-tauri/src/preview_picker.js?raw";

afterEach(() => vi.useRealTimers());

it("answers through the Chrome binding without a native navigation doorbell", async () => {
  vi.useFakeTimers();
  const w = window as unknown as Record<string, unknown>;
  w.__canopyNativeBrowser = false;
  w.__canopyStreamBrowser = true;
  delete w.__canopyPicker;
  const send = vi.fn().mockResolvedValue(undefined);
  w.__canopyStreamSend = send;
  const originalUrl = location.href;
  new Function(SCRIPT)();
  const bridge = w.__canopyBrowser as { cmd: (message: unknown) => void; drain: () => unknown[] };
  bridge.cmd({ canopy: "agent", id: 71, op: "eval", code: "2 + 3", bg: true });
  await vi.advanceTimersByTimeAsync(100);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ canopy: "agent-result", id: 71, ok: true, data: { result: 5 } }));
  expect(bridge.drain()).toEqual([]);
  expect(location.href).toBe(originalUrl);
});

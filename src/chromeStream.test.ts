import { afterEach, expect, it, vi } from "vitest";
import { captureChromeFrame } from "./chromeStream";

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

it("accepts a screenshot only from the owning iframe, origin and request", async () => {
  const frame = document.createElement("iframe");
  frame.src = "http://127.0.0.1:1234/capability/";
  document.body.append(frame);
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  const pending = captureChromeFrame(frame);
  const id = post.mock.calls[0][0].id;
  let resolved = false;
  void pending.then(() => { resolved = true; });
  const data = { canopy: "capture-result", id, image: "png", width: 900, height: 650 };
  window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: "https://wrong.example", data }));
  window.dispatchEvent(new MessageEvent("message", { source: window, origin: "http://127.0.0.1:1234", data }));
  await Promise.resolve();
  expect(resolved).toBe(false);
  window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: "http://127.0.0.1:1234", data }));
  expect(await pending).toEqual(data);
});

it("times out a disconnected screenshot instead of leaving capture pending", async () => {
  vi.useFakeTimers();
  const frame = document.createElement("iframe");
  frame.src = "http://127.0.0.1:1234/capability/";
  document.body.append(frame);
  const pending = expect(captureChromeFrame(frame)).rejects.toThrow("did not answer");
  await vi.advanceTimersByTimeAsync(12_000);
  await pending;
});

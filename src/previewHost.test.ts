// previewHost.ts: the host's first line is kept by the app for the whole
// session, so "no browser" there may be stale; and a window that sits on the
// offer must notice a download another window started.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invokeDesktop: vi.fn() }));
vi.mock("./host", () => ({ invokeDesktop: mocks.invokeDesktop }));

const respond = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.invokeDesktop.mockResolvedValue({ port: 4312, token: "t", executable: "" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("asks the host before saying ready when the start line had no browser", async () => {
  const fetch = vi.fn(() => respond({ executable: "/browsers/chromium_headless_shell-1243/chrome-headless-shell", installer: null }));
  vi.stubGlobal("fetch", fetch);
  const host = await import("./previewHost");
  await host.startPreviewHost();
  // Ready already knows Chromium is there: no offer flashes.
  expect(host.previewHostState().status).toBe("ready");
  expect(host.previewBrowserState()?.executable).toMatch(/chrome-headless-shell$/);
  expect(host.usesDownloadedChromium(host.previewBrowserState())).toBe(true);
});

it("keeps following a computer with no browser, so another window's download shows up", async () => {
  const states = [
    { executable: "", installer: { state: "missing", received: 0, total: 100, version: "153" } },
    { executable: "", installer: { state: "downloading", received: 40, total: 100, version: "153" } },
    { executable: "/chromium", installer: { state: "installed", received: 100, total: 100, version: "153" } },
  ];
  let next = 0;
  vi.stubGlobal("fetch", vi.fn(() => respond(states[Math.min(next++, states.length - 1)])));
  const host = await import("./previewHost");
  await host.startPreviewHost();
  expect(host.previewBrowserState()?.installer?.state).toBe("missing");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(host.previewBrowserState()?.installer?.state).toBe("downloading");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(host.previewBrowserState()?.executable).toBe("/chromium");
  // Done: no more polling.
  const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock?.calls?.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect((fetch as unknown as ReturnType<typeof vi.fn>).mock?.calls?.length).toBe(calls);
});

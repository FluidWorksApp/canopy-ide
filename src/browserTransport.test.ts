// The engine seam. What is pinned here is routing and the one real behavioural
// difference between the engines: whether page events arrive by themselves.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({
  browserNavigate: vi.fn(async () => {}),
  browserRunOp: vi.fn(async () => ({ done: true, ok: true })),
  browserCommand: vi.fn(async () => {}),
  browserHere: vi.fn(async () => ({ url: "u", title: "t" })),
  browserClose: vi.fn(async () => {}),
  chromiumNavigate: vi.fn(async () => {}),
  chromiumRunOp: vi.fn(async () => ({ done: true, ok: true })),
  chromiumCommand: vi.fn(async () => {}),
  chromiumHere: vi.fn(async () => ({ url: "u", title: "t" })),
  chromiumClose: vi.fn(async () => {}),
  chromiumDrain: vi.fn(async () => [{ canopy: "ready" }]),
  chromiumOpen: vi.fn(async () => {}),
}));

import * as ipc from "./ipc";
import { openOn, resolveChromiumExe, transportFor } from "./browserTransport";

beforeEach(() => vi.clearAllMocks());

describe("transportFor", () => {
  // The proxy engine's frame lives in this window, so its ops never take the
  // IPC path at all. Reporting null is the honest answer, not an oversight.
  it("has no transport for the proxy engine", () => {
    expect(transportFor("proxy", "/chrome")).toBeNull();
  });

  it("routes webview ops to the webview commands", async () => {
    const t = transportFor("webview", "")!;
    await t.runOp("tab1", { op: "snapshot" });
    expect(ipc.browserRunOp).toHaveBeenCalledWith("tab1", { op: "snapshot" });
    expect(ipc.chromiumRunOp).not.toHaveBeenCalled();
  });

  it("routes chromium ops to the chromium commands", async () => {
    const t = transportFor("chromium", "/chrome")!;
    await t.runOp("tab1", { op: "snapshot" });
    expect(ipc.chromiumRunOp).toHaveBeenCalledWith("tab1", { op: "snapshot" });
    expect(ipc.browserRunOp).not.toHaveBeenCalled();
  });

  // chooseEngine should have vetoed this already; if it somehow gets here, a
  // null is recoverable and a call to a browser that isn't there is not.
  it("refuses the chromium engine with no browser to drive", () => {
    expect(transportFor("chromium", "")).toBeNull();
  });

  it("knows only the webview engine announces its own results", () => {
    expect(transportFor("webview", "")!.pushesEvents).toBe(true);
    expect(transportFor("chromium", "/chrome")!.pushesEvents).toBe(false);
  });

  it("pulls queued events on the chromium engine", async () => {
    const t = transportFor("chromium", "/chrome")!;
    expect(await t.drain("tab1")).toEqual([{ canopy: "ready" }]);
  });

  // CDP has no history-delta command; the page knows how to move itself, and
  // the picker is already there to be asked.
  it("turns a chromium history move into a page command, not a navigation", async () => {
    const t = transportFor("chromium", "/chrome")!;
    await t.navigate("tab1", null, "back");
    expect(ipc.chromiumNavigate).not.toHaveBeenCalled();
    expect(ipc.chromiumCommand).toHaveBeenCalledWith("tab1", {
      canopy: "navigate",
      delta: -1,
    });
  });

  it("sends a real chromium URL as a navigation", async () => {
    const t = transportFor("chromium", "/chrome")!;
    await t.navigate("tab1", "https://example.com", null);
    expect(ipc.chromiumNavigate).toHaveBeenCalledWith("tab1", "https://example.com");
  });
});

describe("resolveChromiumExe", () => {
  const detected = [
    { name: "Google Chrome", path: "/chrome" },
    { name: "Brave Browser", path: "/brave" },
  ];

  it("prefers what the user chose over what was detected", () => {
    expect(resolveChromiumExe("/my/build", detected)).toBe("/my/build");
  });

  it("falls back to the highest-ranked detection", () => {
    expect(resolveChromiumExe("", detected)).toBe("/chrome");
  });

  it("is empty when there is nothing to drive", () => {
    expect(resolveChromiumExe("", [])).toBe("");
    expect(resolveChromiumExe("   ", [])).toBe("");
  });
});

describe("openOn", () => {
  it("only opens on the chromium engine", () => {
    expect(openOn("webview", "/chrome", "t", "u")).toBeNull();
    expect(openOn("proxy", "/chrome", "t", "u")).toBeNull();
  });

  it("opens a chromium tab with the resolved binary", async () => {
    await openOn("chromium", "/chrome", "tab1", "https://example.com");
    expect(ipc.chromiumOpen).toHaveBeenCalledWith("/chrome", "tab1", "https://example.com");
  });

  it("does not try to launch nothing", () => {
    expect(openOn("chromium", "", "t", "u")).toBeNull();
  });
});

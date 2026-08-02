// The engine seam: which wire a browser op goes down, per engine.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({
  browserNavigate: vi.fn(async () => {}),
  browserRunOp: vi.fn(async () => ({ done: true, ok: true })),
  browserCommand: vi.fn(async () => {}),
  browserHere: vi.fn(async () => ({ url: "u", title: "t" })),
  browserClose: vi.fn(async () => {}),
}));

import * as ipc from "./ipc";
import { transportFor } from "./browserTransport";

beforeEach(() => vi.clearAllMocks());

describe("transportFor", () => {
  // The proxy engine's frame lives in this window, so its ops never take the
  // IPC path at all. Reporting null is the honest answer, not an oversight.
  it("has no transport for the proxy engine", () => {
    expect(transportFor("proxy")).toBeNull();
  });

  it("routes webview ops to the webview commands", async () => {
    const t = transportFor("webview")!;
    await t.runOp("tab1", { op: "snapshot" });
    expect(ipc.browserRunOp).toHaveBeenCalledWith("tab1", { op: "snapshot" });
  });

  it("routes a webview navigation with its action", async () => {
    const t = transportFor("webview")!;
    await t.navigate("tab1", "https://example.com", null);
    expect(ipc.browserNavigate).toHaveBeenCalledWith("tab1", "https://example.com", null);
  });
});

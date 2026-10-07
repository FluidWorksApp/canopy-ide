// @vitest-environment jsdom
//
// The browser selftest exercises the native webview engine by name. Settings no
// longer offer that engine and migrate it away on every read, so a selftest
// that asked through updateSettings() silently ran the proxy engine instead and
// waited 90s for a native view that never registers. The override is the one
// way to ask for it; these pin both halves of that contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  browserSupported: vi.fn(async () => true),
}));

import { overrideBrowserEngine, preferredEngine, resetBrowserHost, useBrowserEngine } from "./browserHost";
import { updateSettings } from "./settings";

describe("browser engine override", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBrowserHost();
  });
  afterEach(() => {
    resetBrowserHost();
    localStorage.clear();
  });

  it("cannot be reached through settings, which migrate the native engine away", () => {
    updateSettings({ browserEngine: "webview" });
    expect(preferredEngine()).toBe("proxy");
  });

  it("selects the native engine without persisting it, and releases it again", async () => {
    const { result } = renderHook(() => useBrowserEngine());
    expect(result.current).toBe("proxy");

    act(() => overrideBrowserEngine("webview"));
    await waitFor(() => expect(result.current).toBe("webview"));
    expect(localStorage.getItem("canopy.settings") ?? "").not.toContain("webview");

    act(() => overrideBrowserEngine(null));
    expect(result.current).toBe("proxy");
  });

  it("re-renders on a settings change without a parent render", () => {
    const { result } = renderHook(() => useBrowserEngine());
    act(() => {
      updateSettings({ browserEngine: "chrome" });
    });
    expect(result.current).toBe("chrome");
  });
});

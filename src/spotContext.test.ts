import { beforeEach, describe, expect, it, vi } from "vitest";

// The routing is the contract: a preview tab's pixels live in a native child
// webview, and a rect capture of the main webview there is a picture of the
// empty placeholder underneath — the blank-screenshot bug.
const browserSnapshot = vi.fn(async (_tabId: string, _max?: number) => "child-png");
const webviewSnapshot = vi.fn(
  async (_x: number, _y: number, _w: number, _h: number, _max?: number) => "rect-png",
);

vi.mock("./ipc", () => ({
  browserSnapshot: (tabId: string, max?: number) => browserSnapshot(tabId, max),
  webviewSnapshot: (x: number, y: number, w: number, h: number, max?: number) =>
    webviewSnapshot(x, y, w, h, max),
  spotSaveContextImage: async () => "/dev/null",
}));

import { capturePixels } from "./spotContext";
import type { SubTab } from "./components/ProjectView/helpers";

const rect = { x: 10, y: 20, width: 300, height: 200 };
const previewTab: SubTab = { id: "tab-1", type: "preview", url: "http://localhost:4321/", annotations: [] };
const fileTab = { id: "tab-2", type: "file", file: { path: "/p/a.ts" } } as unknown as SubTab;

beforeEach(() => {
  browserSnapshot.mockClear();
  webviewSnapshot.mockClear();
  browserSnapshot.mockResolvedValue("child-png");
});

describe("capturePixels", () => {
  it("asks the browser view itself for a preview tab", async () => {
    const png = await capturePixels({ activeTab: previewTab, dir: "/p", rect });
    expect(png).toBe("child-png");
    expect(browserSnapshot).toHaveBeenCalledWith("tab-1", 1400);
    expect(webviewSnapshot).not.toHaveBeenCalled();
  });

  it("falls back to the rect capture when the tab has no native view", async () => {
    browserSnapshot.mockRejectedValue(new Error("no browser view for tab tab-1"));
    const png = await capturePixels({ activeTab: previewTab, dir: "/p", rect });
    expect(png).toBe("rect-png");
    expect(webviewSnapshot).toHaveBeenCalledWith(10, 20, 300, 200, 1400);
  });

  it("captures the pane rect for every other kind of tab", async () => {
    const png = await capturePixels({ activeTab: fileTab, dir: "/p", rect });
    expect(png).toBe("rect-png");
    expect(browserSnapshot).not.toHaveBeenCalled();
  });
});

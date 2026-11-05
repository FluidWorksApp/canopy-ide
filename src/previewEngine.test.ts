import { describe, expect, it } from "vitest";
import { isWorkspaceLocalPage, previewEngine } from "./previewEngine";

describe("previewEngine", () => {
  it("embeds every page on a remote workspace", () => {
    for (const chosen of ["webview", "proxy", null] as const)
      for (const buildMode of [true, false])
        expect(previewEngine({ remote: true, buildMode, chosen })).toBe("proxy");
  });

  it("keeps the desktop's choice locally, with the proxy standing in for the webview in build mode", () => {
    expect(previewEngine({ remote: false, buildMode: true, chosen: "webview" })).toBe("proxy");
    expect(previewEngine({ remote: false, buildMode: false, chosen: "webview" })).toBe("webview");
    expect(previewEngine({ remote: false, buildMode: false, chosen: null })).toBeNull();
  });
});

describe("isWorkspaceLocalPage", () => {
  it("is true only for loopback web pages", () => {
    expect(isWorkspaceLocalPage("http://localhost:5173/")).toBe(true);
    expect(isWorkspaceLocalPage("http://127.0.0.1:8080/x")).toBe(true);
    expect(isWorkspaceLocalPage("https://preview.localhost/")).toBe(true);
    expect(isWorkspaceLocalPage("https://studio.coraa.ai/")).toBe(false);
    expect(isWorkspaceLocalPage("file:///etc/hosts")).toBe(false);
  });
});

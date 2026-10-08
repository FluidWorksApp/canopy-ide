import { describe, expect, it } from "vitest";
import { isWorkspaceLocalPage, previewEngine } from "./previewEngine";

describe("previewEngine", () => {
  it("streams every web page through Chrome on a remote workspace", () => {
    // The incident: a public site in build mode picked the proxy, which the
    // workspace does not run ("does not support preview_start").
    for (const url of ["https://studio.coraa.ai/", "http://localhost:3000/", "http://app.localhost/"])
      for (const chosen of ["webview", "proxy", "chrome", null] as const)
        expect(previewEngine({ remote: true, url, buildMode: true, chosen })).toBe("chrome");
  });

  it("keeps the desktop's choice locally, with the proxy standing in for the webview in build mode", () => {
    expect(previewEngine({ remote: false, url: "https://studio.coraa.ai/", buildMode: true, chosen: "webview" })).toBe("proxy");
    expect(previewEngine({ remote: false, url: "https://studio.coraa.ai/", buildMode: false, chosen: "webview" })).toBe("webview");
    expect(previewEngine({ remote: false, url: "https://studio.coraa.ai/", buildMode: false, chosen: null })).toBeNull();
  });

  it("leaves non-web URLs to the desktop's choice", () => {
    expect(previewEngine({ remote: true, url: "about:blank", buildMode: false, chosen: "webview" })).toBe("webview");
    expect(previewEngine({ remote: true, url: "not a url", buildMode: true, chosen: "webview" })).toBe("proxy");
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

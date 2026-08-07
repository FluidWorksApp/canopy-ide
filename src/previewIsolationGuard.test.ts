/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Build previews a live page rather than a black rectangle", () => {
  const preview = read("src/components/PreviewView.tsx");

  it("uses the DOM-composited engine in Build, whatever the setting says", () => {
    // A native webview is composited above the window, so nothing in the DOM can
    // be painted over it. browserHost's only answer is to hide the whole view
    // when anything overlaps — so Build's floating island blanked the entire
    // preview, and the person saw black where their app should be.
    expect(preview).toContain('buildMode && chosenEngine !== null ? "proxy" : chosenEngine');
  });
});

describe("a project's preview cookies stay its own", () => {
  const preview = read("src/components/PreviewView.tsx");
  const ipc = read("src/ipc.ts");

  it("scopes the proxy to a project rather than sharing one loopback host", () => {
    // Cookies are keyed by host and ignore the port, so every project on
    // 127.0.0.1 shared one jar and a session cookie from one app was sent to
    // another. The isolation is the hostname; passing no project would undo it.
    expect(ipc).toContain("previewStart = (projectId: string, target: string)");
    expect(preview).toContain("previewStart(projectId, origin)");
  });

  it("points the iframe at the project host, not at the loopback literal", () => {
    // Loading the same proxy through 127.0.0.1 reaches the same server but puts
    // the page back on the shared host, which is the whole defect.
    expect(preview).not.toContain("http://127.0.0.1:${p.port}");
    expect(preview).toContain("http://${p.host}:${p.port}");
  });

  it("recognises its own page by the project host", () => {
    // The same rewrite has to reach the guard that decides whether a URL belongs
    // to this proxy, or a project-hosted page reads as somebody else's.
    expect(preview).toContain("u.host !== `${p.host}:${p.port}`");
  });
});

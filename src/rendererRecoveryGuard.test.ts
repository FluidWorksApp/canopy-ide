import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("renderer recovery wiring", () => {
  it("registers and answers liveness before Monaco can delay React", () => {
    const main = read("src/main.tsx");
    const registration = main.indexOf("ptyRendererRegister()");
    const heartbeat = main.indexOf("installEarlyWatchdogHeartbeat()");
    const monacoBarrier = main.indexOf("Promise.all([");
    expect(registration).toBeGreaterThan(-1);
    expect(heartbeat).toBeGreaterThan(registration);
    expect(heartbeat).toBeLessThan(monacoBarrier);
    expect(main).not.toContain('invoke("pty_kill_all")');
  });

  it("restores only tab-backed sessions and preserves ownership on close", () => {
    const app = read("src/App.tsx");
    const project = read("src/components/ProjectView/index.tsx");
    expect(app).toContain('session.kind !== "detached"');
    expect(app).toContain('e.kind === "desktop"');
    expect(project).toContain("d.killOnClose === true");
  });

  it("uses one generation-scoped viewer path for owned and remote PTYs", () => {
    const term = read("src/components/Term.tsx");
    expect(term).toContain("ipc.ptyAttachDesktop");
    expect(term).toContain("ipc.ptyDetachDesktop");
    expect(term).not.toContain("ipc.ptyAttach(");
    expect(term).toContain("streamVisibilityRef.current?.(streaming)");
    expect(term).toContain("new TerminalStreamLedger()");
    expect(term).toContain("streamLedger.replayAfter()");
  });

  it("streams every visible split pane while only the focused pane owns input", () => {
    const project = read("src/components/ProjectView/index.tsx");
    expect(project).toContain("streaming={shown}");
    expect(project).toContain("tab.id === activeTabId && visible");
    expect(project).toContain("pane != null || (!grouped && tab.id === activeTabId)");
  });
});

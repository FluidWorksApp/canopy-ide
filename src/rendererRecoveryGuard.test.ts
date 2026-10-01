import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("renderer recovery wiring", () => {
  it("registers and answers liveness before Monaco can delay React", () => {
    const main = read("src/main.tsx");
    const selftest = read("src-tauri/src/selftest.rs");
    const registration = main.indexOf("ptyRendererRegister()");
    const exitListener = main.indexOf("await onPtyExit");
    const heartbeat = main.indexOf("installEarlyWatchdogHeartbeat()");
    const monacoBarrier = main.indexOf("Promise.all([");
    expect(registration).toBeGreaterThan(-1);
    expect(exitListener).toBeGreaterThan(registration);
    expect(heartbeat).toBeGreaterThan(exitListener);
    expect(heartbeat).toBeLessThan(monacoBarrier);
    expect(main).not.toContain('invoke("pty_kill_all")');
    expect(main).toContain("renderer registration failed; retrying");
    expect(main).toContain('new Error("renderer registration timed out")');
    expect(main).toContain("Promise.race([");
    expect(main).toContain("retryMs = Math.min(retryMs * 2, 2_000)");
    const ipc = read("src/ipc.ts");
    expect(ipc).toContain("renderer registration was superseded");
    const reload = ipc.indexOf('await invoke<void>("selftest_reload_renderer")');
    const cleanup = ipc.indexOf("window.setTimeout(releaseRendererListeners, 100);", reload);
    expect(reload).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(reload);
    expect(ipc).toContain("void release();");
    expect(ipc).not.toContain("prepareRendererReplacement");
    expect(ipc).toContain('invoke<StoreChangeBatch>("store_changes"');
    expect(selftest).toContain("replacement_registered(");
    expect(selftest).toContain("current_renderer_generation()");
    expect(selftest).toContain("candidate_attempts.fetch_add(1");
    expect(main).toContain("configureSelftestPtyListenerFailures");
  });

  it("restores only tab-backed sessions and preserves ownership on close", () => {
    const app = read("src/App.tsx");
    const project = read("src/components/ProjectView/index.tsx");
    expect(app).toContain('session.kind !== "detached"');
    expect(app).toContain('e.kind === "desktop"');
    expect(project).toContain("d.killOnClose === true");
  });

  it("does not consume surviving PTYs before workspace hydration", () => {
    const app = read("src/App.tsx");
    const recovery = app.slice(
      app.indexOf("// A PTY opened from the phone"),
      app.indexOf("// A clicked notification"),
    );
    const hydrationGuard = recovery.indexOf("if (!loaded) return;");
    const listener = recovery.indexOf(".onPtySpawned");
    expect(hydrationGuard).toBeGreaterThan(-1);
    expect(listener).toBeGreaterThan(hydrationGuard);
    expect(recovery).toContain("terminalProjectSignature");
  });

  it("reconciles live native sessions and queues them until ProjectView mounts", () => {
    const app = read("src/App.tsx");
    const project = read("src/components/ProjectView/index.tsx");
    const recovery = app.slice(
      app.indexOf("// A PTY opened from the phone"),
      app.indexOf("// A clicked notification"),
    );
    expect(recovery).toContain(".onPtySpawned");
    expect(recovery).toContain(".rendererPtySessionsLive()");
    expect(recovery).toContain("Promise.allSettled([");
    expect(recovery).toContain("ipc.onPtyExit(terminalEnded)");
    expect(recovery).toContain("terminalAttachmentQueue.discard");
    expect(recovery).toContain("ipc.rendererPtySessions()");
    const install = recovery.slice(recovery.indexOf("const install"));
    expect(install.indexOf(".onPtySpawned")).toBeLessThan(
      install.indexOf("reconcile();"),
    );
    expect(recovery).toContain("terminalAttachmentQueue.enqueue");
    expect(recovery).toContain("e.project_id");
    expect(recovery).toContain("run: Boolean(e.run)");
    expect(recovery).toContain("runCommandId: e.run_command_id");
    expect(project).toContain("run: presentation?.run || undefined");
    expect(project).toContain("d.recovered && !activatedRecoveredTerminalRef.current");
    expect(recovery).not.toContain('new CustomEvent("canopy:attach-terminal"');
    expect(project).toContain("terminalAttachmentQueue.subscribe(project.id");
    const start = recovery.lastIndexOf(
      "for (const session of ipc.rendererPtySessions())",
    );
    expect(start).toBeGreaterThan(-1);
    expect(recovery.indexOf("reconcile();\n    install();", start)).toBeGreaterThan(
      start,
    );
  });

  it("uses one generation-scoped viewer path for owned and remote PTYs", () => {
    const term = read("src/components/Term.tsx");
    const ipc = read("src/ipc.ts");
    expect(term).toContain("ipc.ptyAttachDesktop");
    expect(term).toContain("ipc.ptyDetachDesktop");
    expect(term).not.toContain("ipc.ptyAttach(");
    expect(term).toContain("streamVisibilityRef.current?.(streaming)");
    expect(term).toContain("new TerminalStreamLedger()");
    expect(term).toContain("streamLedger.replayAfter()");
    expect(term).toContain("terminal stream interrupted; reconnecting");
    expect(term).toContain('new Error("terminal attach timed out")');
    expect(term).toContain("late.generation");
    expect(term).toContain("Math.min(100 * 2 ** (attachFailureCount - 1), 2_000)");
    expect(ipc).toContain('await invoke<PtyGeometry & {');
    expect(ipc).toContain('invoke<DesktopRead | null>("pty_read_desktop"');
    expect(ipc).toContain("One in-flight renderer-owned read per attachment");
  });

  it("streams every visible split pane while only the focused pane owns input", () => {
    const project = read("src/components/ProjectView/index.tsx");
    expect(project).toContain("streaming={shown}");
    expect(project).toContain("tab.id === activeTabId && visible");
    expect(project).toContain("pane != null || (!grouped && tab.id === activeTabId)");
  });
});

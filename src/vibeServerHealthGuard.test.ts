/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("vibe server health wiring", () => {
  it("starts every configured preview dependency itself, once, as a run tab", () => {
    const view = read("src/components/ProjectView/index.tsx");
    const start = view.indexOf("const autoStartedVibeRun");
    const effect = view.indexOf("useEffect(", start);
    const autoStart = view.slice(start, view.indexOf("useEffect(", effect + 1));
    // Commands come from the validated setup graph, not from anything the user
    // typed. Every run carries stable ids and an argv-native command may use a
    // component-owned cwd without changing its identity.
    expect(autoStart).toContain("for (const { component, command, identity } of vibeRequiredRuns)");
    expect(autoStart).toContain("identity.dependsOn");
    expect(autoStart).toContain("vibeRunReady(");
    expect(autoStart).toContain("dependencyTab,");
    expect(autoStart).toContain("dependencyCommand,");
    expect(autoStart).toContain("projectStats,");
    expect(autoStart).toContain("command.cwd ?? component.path");
    expect(autoStart).toContain(
      "{ componentId: component.id, runCommandId: command.id }",
    );
    expect(autoStart).toContain("matchesVibeRun(tab, component, command)");
    expect(autoStart).toContain("autoStartedVibeRuns.current.has(key)");
  });

  it("distinguishes explicit shutdown from a process crash", () => {
    const rust = read("src-tauri/src/pty.rs");
    expect(rust).toContain("requested: session.shutdown.load(Ordering::SeqCst)");
    const term = read("src/components/Term.tsx");
    expect(term).toContain("onExitedRef.current(event)");
  });

  it("watches every required long-lived process, not only the preview", () => {
    const view = read("src/components/ProjectView/index.tsx");
    const start = view.indexOf("vibeServerWatch.current =");
    const watcherSetup = view.slice(start, view.indexOf("vibeServerExit.current =", start));
    expect(watcherSetup).toContain("vibeRequiredRuns");
    expect(watcherSetup).toContain(".map(({ component, command })");
    expect(watcherSetup).not.toContain("vibeServerTargetKey");
  });

  it("drops the incident when the person stops the server themselves", () => {
    // The incident only cleared when the server came back on a port, so
    // someone who stopped it deliberately kept being told "The app server
    // keeps stopping" — Canopy insisting on a fault they had just chosen.
    const view = read("src/components/ProjectView/index.tsx");
    const start = view.indexOf("vibeServerExit.current =");
    const watcher = view.slice(start, view.indexOf("const autoStartedVibeRun", start));
    const stop = watcher.indexOf("event.requested");
    expect(stop).toBeGreaterThan(-1);
    // Before the crash-loop branch, or it never runs for a requested stop.
    expect(stop).toBeLessThan(watcher.indexOf('decision.action !== "crash-loop"'));
    expect(watcher.slice(stop)).toContain("resolveServerIncident(watched.targetKey)");
  });

  it("repairs the first failed exit and retains durable crash-loop escalation", () => {
    const view = read("src/components/ProjectView/index.tsx");
    const start = view.indexOf("vibeServerExit.current =");
    const end = view.indexOf("const autoStartedVibeRun", start);
    const watcher = view.slice(start, end);
    expect(watcher).toContain('classification.exit !== "repair"');
    expect(watcher).toContain("reportManagedProcessFailure(input)");
    expect(watcher).not.toContain('restartRun(tabId, undefined, "watchdog")');
    expect(watcher).not.toContain("addTerminal(");
    expect(watcher).toContain("captureTextSettled");
    expect(watcher).toContain("reportServerIncident");
    expect(watcher).toContain("postAttention");
  });

  it("routes setup-command failure through the same classifier and repair entry", () => {
    const view = read("src/components/ProjectView/index.tsx");
    const start = view.indexOf("for (const setup of gate.failed)");
    const failure = view.slice(start, view.indexOf("if (!gate.ready)", start));
    expect(failure).toContain("classifyManagedProcess({");
    expect(failure).toContain('classification.exit !== "repair"');
    expect(failure).toContain('kind: "setup"');
    expect(failure).toContain("reportManagedProcessFailure({");
    expect(failure).not.toContain("postAttention({");
  });

  it("keeps ordinary run reaping separate from the crash watcher", () => {
    expect(read("src/runReap.ts")).not.toContain("vibeServer");
  });

  it("keeps the server incident latched across chat turns", () => {
    const session = read("src/vibeBuilderSession.ts");
    expect(session).toContain("this.incidentOpen = this.serverIncidentOpen");
    expect(session).toContain('kind: "vibe-server-log-tail"');
    expect(session).toContain('kind: "watchdog-incident"');
  });

  it("routes managed run states through one classifier and startup repair exit", () => {
    const view = read("src/components/ProjectView/index.tsx");
    const supervisor = read("src/managedProcessSupervisor.ts");
    expect(view).toContain("classifyManagedProcess({");
    expect(view).toContain("reportServerStartupStall({");
    expect(view).not.toContain("detectManagedProcessPrompt(");
    for (const state of [
      "spawning",
      "working",
      "waiting-on-input",
      "ready",
      "exited-ok",
      "failed",
      "hung",
    ]) {
      expect(supervisor).toContain(`| "${state}"`);
    }
  });
});

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("vibe server health wiring", () => {
  it("starts the configured dev command itself, once, as a run tab", () => {
    const view = read("src/components/ProjectView/index.tsx");
    const start = view.indexOf("const autoStartedVibeRun");
    const effect = view.indexOf("useEffect(", start);
    const autoStart = view.slice(start, view.indexOf("useEffect(", effect + 1));
    // The command comes from the vibe target the config resolved, not from
    // anything the user typed, and the run tab carries the stable ids so the
    // watcher below can recognise its exit.
    expect(autoStart).toContain("vibeRun.command");
    expect(autoStart).toContain(
      "{ componentId: vibeComponent.id, runCommandId: vibeRun.id }",
    );
    expect(autoStart).toContain("matchesVibeRun(tab, vibeComponent, vibeRun)");
    expect(autoStart).toContain("autoStartedVibeRun.current !== key");
  });

  it("distinguishes explicit shutdown from a process crash", () => {
    const rust = read("src-tauri/src/pty.rs");
    expect(rust).toContain("requested: session.shutdown.load(Ordering::SeqCst)");
    const term = read("src/components/Term.tsx");
    expect(term).toContain("onExitedRef.current(event)");
  });

  it("restarts the same run tab and records a durable crash-loop incident", () => {
    const view = read("src/components/ProjectView/index.tsx");
    const start = view.indexOf("vibeServerExit.current =");
    const end = view.indexOf("const autoStartedVibeRun", start);
    const watcher = view.slice(start, end);
    expect(watcher).toContain('restartRun(tabId, undefined, "watchdog")');
    expect(watcher).not.toContain("addTerminal(");
    expect(watcher).toContain("captureTextSettled");
    expect(watcher).toContain("reportServerIncident");
    expect(watcher).toContain("postAttention");
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
});

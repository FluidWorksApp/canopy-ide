/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("the vibe MVP wiring boundaries", () => {
  it("reserves the A2 attempt before starting the keyed project runner", () => {
    const session = read("src/vibeBuilderSession.ts");
    const reserve = session.indexOf("this.deps.reserve({");
    const startAttempt = session.indexOf("this.deps.startAttempt(", reserve);
    const spawn = session.indexOf("this.deps.runner.start(", startAttempt);
    expect(reserve).toBeGreaterThan(-1);
    expect(startAttempt).toBeGreaterThan(reserve);
    expect(spawn).toBeGreaterThan(startAttempt);
    expect(session).not.toContain("companionSpawn");
    expect(session).not.toContain("companionSession");
  });

  it("keeps the native task process map attempt-keyed and Companion-free", () => {
    const rust = read("src-tauri/src/structured_runner.rs");
    expect(rust).toContain("HashMap<String, Running>");
    expect(rust).toContain("attempt_id: String");
    expect(rust).toContain("kill_on_drop(true)");
    expect(rust).not.toContain("CompanionManager");
    expect(rust).not.toContain("pty_id");

    const ipc = read("src/ipc.ts");
    const structured = ipc.slice(
      ipc.indexOf("// ------------------------------------------------------ structured task runner"),
      ipc.indexOf("// ---------------------------------------------------------------- companion"),
    );
    expect(structured).toContain("structured_runner_spawn");
    expect(structured).not.toContain("companion_");
  });

  it("mounts Build chat without replacing the stable PanelGroup runtime", () => {
    const projectView = read("src/components/ProjectView/index.tsx");
    const chat = projectView.indexOf('<aside className="vibe-chat-placeholder"');
    const panels = projectView.indexOf('<PanelGroup direction="horizontal">', chat);
    expect(chat).toBeGreaterThan(-1);
    expect(projectView.slice(chat, panels)).toContain("<VibeBuilderPane");
    expect(panels).toBeGreaterThan(chat);
    expect(projectView).toContain("{mainArea}");
  });

  it("keeps raw run output mounted for Engineer but presents only the preview in Build", () => {
    const projectView = read("src/components/ProjectView/index.tsx");
    const autoStartAt = projectView.indexOf("const autoStartedVibeRuns");
    const firstEffect = projectView.indexOf("useEffect(", autoStartAt);
    const autoStart = projectView.slice(
      autoStartAt,
      projectView.indexOf("useEffect(", firstEffect + 1),
    );
    const launch = autoStart.slice(
      autoStart.indexOf("addTerminal("),
      autoStart.indexOf("{ componentId:"),
    );
    expect(launch).toContain("run mounted for Engineer");
    expect(launch.indexOf("false,")).toBeGreaterThan(
      launch.indexOf("run mounted for Engineer"),
    );

    const main = projectView.slice(
      projectView.indexOf("const surfaceTabId"),
      projectView.indexOf("// ---------- side panels ----------"),
    );
    expect(main).toContain(
      "const surfaceTabId = vibe ? vibePreview?.id ?? null : activeTabId;",
    );
    expect(main).toContain("const shown =\n              !vibe &&");
    expect(main).toContain(
      "!vibe && !softClosed && tab.id === activeTabId && visible",
    );
    expect(main).toContain("tab.id === surfaceTabId && visible");
    expect(main).toContain("{!vibe && activeTerminalGroup &&");
    expect(main).toContain("{!vibe && agentTermWs &&");
    expect(projectView).not.toContain("Open the failed run to inspect its output");
  });

  it("never sends Build mode to the target setup modal", () => {
    const projectView = read("src/components/ProjectView/index.tsx");
    const chat = projectView.indexOf('<aside className="vibe-chat-placeholder"');
    const panels = projectView.indexOf('<PanelGroup direction="horizontal">', chat);
    const buildChat = projectView.slice(chat, panels);
    expect(buildChat).not.toContain("Build needs setup");
    expect(buildChat).not.toContain("Set up Build mode");
    expect(buildChat).not.toContain("onEdit");
  });

  it("creates automatic setup inside the lifecycle effect, not during render", () => {
    const projectView = read("src/components/ProjectView/index.tsx");
    const setup = projectView.slice(
      projectView.indexOf("const [vibeProjectSetupSession"),
      projectView.indexOf("const vibeWaitingSession"),
    );
    expect(setup).toContain("useEffect(() => {");
    expect(setup).toContain("const session = createVibeProjectSetupSession(");
    expect(setup).toContain("setVibeProjectSetupSession(session)");
    expect(setup).toContain("void session.stop()");
    expect(setup).not.toContain("useMemo(");
  });

  it("never asks a Build user to configure or start a server", () => {
    const preview = read("src/components/PreviewView.tsx");
    const buildPreview = preview.slice(
      preview.indexOf("if (buildMode)"),
      preview.indexOf('<div className="preview-empty">', preview.indexOf("if (buildMode)")),
    );
    const projectView = read("src/components/ProjectView/index.tsx");
    expect(projectView).toContain("buildMode={vibe}");
    expect(buildPreview).toContain("Your idea is taking shape");
    expect(buildPreview).toContain("will appear here automatically");
    expect(buildPreview).not.toContain("server");
    expect(buildPreview).not.toContain("component");
    expect(buildPreview).not.toContain("localhost");
    expect(preview).not.toContain("Add a run command to a component");
    expect(preview).not.toContain("project settings");
    expect(preview).not.toContain("Once it's listening");
  });

  it("persists inferred target data before publishing it to ProjectView", () => {
    const app = read("src/App.tsx");
    const start = app.indexOf("onPersistVibeTarget: async");
    const end = app.indexOf("onSaveCustomTasks:", start + 1);
    const handler = app.slice(start, end);
    expect(handler.indexOf("await saveWorkspaceStrict(candidate)")).toBeGreaterThan(-1);
    expect(handler.indexOf("await saveWorkspaceStrict(candidate)")).toBeLessThan(
      handler.indexOf("update({ projects })"),
    );
  });

  it("hides only Companion's renderer in Build while attention keeps rendering", () => {
    const app = read("src/App.tsx");
    expect(app).toContain("personaBinding(");
    expect(app).toContain("toasts.length > 0 && attentionFallbackVisible");
    expect(app).toContain("companionVisible && (");
    const binding = read("src/personaBinding.ts");
    expect(binding).toContain("attentionFallbackVisible: !companionVisible");
  });

  // Textual, and knowingly weak — ProjectView is 12k lines with no render
  // harness, so this is what is available at this seam. The parts that can be
  // exercised for real are: `parseVibePackageFact` -> `inferVibeCheck` in
  // vibePackageScripts.test.ts, and the caveat reaching the ledger and the user
  // in vibeBuilderSession.test.ts. This covers only the wire between them.
  it("derives the Build check from inference, and passes the gap along with it", () => {
    const projectView = read("src/components/ProjectView/index.tsx");
    expect(projectView).toContain("inferVibeCheck(");
    // Name-matching the component's configured commands finds nothing in a
    // project Canopy set up from nothing, which is what made `verified`
    // unreachable for the users who did the least setup.
    expect(projectView).not.toMatch(
      /const vibeCheck = vibeComponent\?\.commands\?\.find/,
    );
    expect(projectView).toContain("checkCommand: vibeCheckCommand");
    // A gap with no way to say why leaves a permanently incomplete turn looking
    // like a Canopy fault instead of a missing script.
    expect(projectView).toContain("checkCaveat: vibeCheckCaveat");
  });

  it("judges independent observations and fails unknown checkpoint inputs closed", () => {
    const session = read("src/vibeBuilderSession.ts");
    expect(session).toContain("judgeVerification(contract, observations)");
    // The review is awaited, so an incident opened while it ran must still
    // close the checkpoint: the decision reads the rechecked context, never
    // the one the reviewer captured before it went away.
    expect(session).toContain("checkpointDecision(safeReview.context)");
    expect(session).toContain(
      "noOpenIncident: review.context.noOpenIncident && !this.incidentOpen",
    );
    expect(session).toContain('verdict: "unknown"');
    // Was `secretScanClean: false` — a hardcoded literal that made
    // auto-checkpoint dead code. The scan is real now, so the invariant worth
    // holding is that the boolean comes FROM the scan of the diff about to be
    // committed and from nothing else; a literal either way would be a claim
    // rather than a result. The behavioural half of this lives in
    // vibeBuilderSession.test.ts ("blocks a checkpoint when the diff about to
    // be committed carries a credential"), which is the test that can actually
    // fail if the wiring is wrong.
    expect(session).toContain("const secrets = scanDiffForSecrets(diff)");
    expect(session).toContain("secretScanClean: secrets.clean");
    expect(session).not.toMatch(/secretScanClean:\s*(true|false)/);
    expect(session).toContain('kind: "turn-diff"');
    expect(session).toContain('response: SAVE_CHECKPOINT');
  });
});

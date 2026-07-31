// Stagehand is default-on, which makes "when is it NOT on" the thing worth
// pinning: a feature advertised as enabled that silently never fires is worse
// than one that says why it can't.
import { describe, expect, it } from "vitest";
import { oneShotArgv, stagehandState } from "./stagehand";

const ok = { node: true, cli: true };

describe("stagehandState", () => {
  it("is on by default once everything it needs is there", () => {
    expect(stagehandState("chromium", true, ok)).toEqual({ active: true });
  });

  // The other two engines are WebKit. There is no CDP to attach to, so this is
  // not a policy choice — there is nothing for Stagehand to drive.
  it("is off on the engines that have no debugging protocol", () => {
    for (const engine of ["webview", "proxy"] as const) {
      const s = stagehandState(engine, true, ok);
      expect(s.active).toBe(false);
      expect(s.active === false && s.reason).toMatch(/Chrome engine/);
    }
  });

  it("says which prerequisite is missing rather than just refusing", () => {
    const noNode = stagehandState("chromium", true, { node: false, cli: true });
    expect(noNode.active === false && noNode.reason).toMatch(/Node/);
    const noCli = stagehandState("chromium", true, { node: true, cli: false });
    expect(noCli.active === false && noCli.reason).toMatch(/one-shot/);
  });

  it("honours being turned off even where it would work", () => {
    expect(stagehandState("chromium", false, ok)).toEqual({
      active: false,
      reason: "Turned off for this engine.",
    });
  });

  // Order matters: an engine that cannot run it at all should say so before
  // complaining about a missing Node the user would then go and install.
  it("reports the engine before the prerequisites", () => {
    const s = stagehandState("proxy", true, { node: false, cli: false });
    expect(s.active === false && s.reason).toMatch(/Chrome engine/);
  });
});

describe("oneShotArgv", () => {
  it("builds the verified headless form for each known CLI", () => {
    expect(oneShotArgv("claude", "claude", "hi")).toEqual(["claude", "-p", "hi"]);
    expect(oneShotArgv("codex", "codex", "hi")).toEqual(["codex", "exec", "hi"]);
  });

  // A rebound or enterprise CLI names a path, and the argv has to use it rather
  // than the vendor's bare name — the same drift the CLI registry guards.
  it("uses the binary it was given, not the vendor's name", () => {
    expect(oneShotArgv("claude", "/opt/acme/bin/claude", "hi")).toEqual([
      "/opt/acme/bin/claude",
      "-p",
      "hi",
    ]);
  });

  // Guessing a headless flag doesn't error — it starts a session that ignores
  // the prompt and hangs. Refusing is the only safe answer.
  it("refuses a CLI with no verified headless form", () => {
    expect(oneShotArgv("amp", "amp", "hi")).toBeNull();
    expect(oneShotArgv("nonesuch", "x", "hi")).toBeNull();
  });

  // The prompt is model output heading for a command line; it stays one argv
  // element so there is no shell to inject into.
  it("keeps a hostile prompt as a single argument", () => {
    const argv = oneShotArgv("claude", "claude", "'; rm -rf / #")!;
    expect(argv).toHaveLength(3);
    expect(argv[2]).toBe("'; rm -rf / #");
  });
});

import { describe, expect, it } from "vitest";
import { companionRunnerLaunch } from "./companion";
import { CLAUDE_RUNNER, CODEX_RUNNER } from "./structuredRunners";
import { companionLaunch, launchArgs } from "../packages/remote-host/slack-companion-runner.mjs";

// The workspace VM answers Slack with the desktop companion's own launch. Its
// argv is a hand port (the host bundle cannot import TypeScript), so this pins
// it to the builders it was ported from.
describe("VM companion launch", () => {
  const desktop = (bin: string, sessionId: string, model = "") =>
    companionRunnerLaunch(
      { bin, sessionId, systemPrompt: "BRIEF", roots: ["/workspace"], model, authority: "read" },
      { cwd: "/workspace" },
    );
  const vm = (bin: string, sessionId: string, model = "") =>
    companionLaunch({ bin, sessionId, systemPrompt: "BRIEF", model });

  it("matches the desktop policy", () => {
    expect(vm("claude", "s1")).toEqual({ ...desktop("claude", "s1"), env: undefined });
  });

  it.each(["", "opus"])("matches claude's argv (model %j)", (model) => {
    expect(launchArgs("claude", vm("claude", "s1", model))).toEqual(CLAUDE_RUNNER.args(desktop("claude", "s1", model)));
    expect(launchArgs("claude", vm("claude", "s1", model), { resume: true })).toEqual(
      CLAUDE_RUNNER.resumeArgs(desktop("claude", "s1", model)),
    );
  });

  it("matches codex's argv", () => {
    expect(launchArgs("codex", vm("codex", ""))).toEqual(CODEX_RUNNER.args(desktop("codex", "")));
    expect(launchArgs("codex", vm("codex", "th-1"), { resume: true })).toEqual(
      CODEX_RUNNER.resumeArgs(desktop("codex", "th-1")),
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  HARNESS_CAPABILITIES,
  HARNESS_COMPACT_COMMAND,
  HARNESS_FEATURES,
  HARNESS_MIN_VERSION,
  harnessCapabilities,
  harnessSupport,
  harnessVersionWarning,
} from "./harness";
import { BUILTIN_AGENT_CLIS } from "./projects";
import { CLAUDE_RUNNER } from "./structuredRunners";

describe("harness capabilities", () => {
  it("gives every entry a verdict for every feature", () => {
    for (const caps of Object.values(HARNESS_CAPABILITIES)) {
      expect(Object.keys(caps).sort()).toEqual([...HARNESS_FEATURES].sort());
    }
  });

  it("cites a source for every claim Claude Code's entry makes", () => {
    // An uncited "native" is a remembered flag dressed up as a finding.
    const claude = harnessCapabilities("claude");
    for (const feature of HARNESS_FEATURES) {
      const cap = claude[feature];
      if (cap.support !== "unknown") expect(cap.source, feature).toBeTruthy();
    }
  });

  it("claims for Claude Code only what the runner stamp verifies", () => {
    expect(CLAUDE_RUNNER.verification.flags.structuredJson).toBe(true);
    expect(CLAUDE_RUNNER.verification.flags.planMode).toBe(true);
    expect(harnessSupport("claude", "headlessStructuredRun")).toBe("native");
    expect(harnessSupport("claude", "planMode")).toBe("native");
    expect(harnessSupport("claude", "selfUpdate")).toBe("native");
    expect(harnessSupport("claude", "hooks")).toBe("native");
    expect(harnessSupport("claude", "usageReporting")).toBe("native");
    // Resume is verified; fork is not.
    expect(harnessSupport("claude", "sessionsResumeFork")).toBe("partial");
    // The IDE protocol, from the 2.1.310 wire capture.
    expect(harnessSupport("claude", "ideProtocol")).toBe("native");
    expect(harnessCapabilities("claude").ideProtocol.source).toMatch(/claude_ide_protocol_capture\.md/);
  });

  it("records subagents and compaction from the transcript and live-run evidence", () => {
    for (const feature of ["subagents", "compaction"] as const) {
      expect(harnessSupport("claude", feature)).toBe("native");
      expect(harnessCapabilities("claude")[feature].source).toMatch(/session_activity\.rs/);
    }
    expect(HARNESS_COMPACT_COMMAND.claude).toBe("/compact");
    // A CLI nobody has checked promises neither.
    expect(harnessSupport("codex", "subagents")).toBe("unknown");
    expect(HARNESS_COMPACT_COMMAND.codex).toBeUndefined();
  });

  it("records Claude's file rewind as partial, with the Canopy layer beside it", () => {
    const cap = harnessCapabilities("claude").checkpointsRewind;
    expect(cap.support).toBe("partial");
    expect(cap.note).toMatch(/--rewind-files/);
    expect(cap.canopyLayer).toMatch(/refs\/canopy\/turns/);
    expect(CLAUDE_RUNNER.sessionEnv).toContainEqual([
      "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
      "true",
    ]);
  });

  it("warns about a Claude older than the 2.1.302 floor, and only then", () => {
    expect(HARNESS_MIN_VERSION.claude.version).toBe("2.1.302");
    expect(harnessVersionWarning("claude", "2.1.301 (Claude Code)")).toMatch(/older than 2\.1\.302/);
    expect(harnessVersionWarning("claude", "2.0.999")).toMatch(/older/);
    expect(harnessVersionWarning("claude", "2.1.302")).toBeNull();
    expect(harnessVersionWarning("claude", "2.1.310 (Claude Code)")).toBeNull();
    expect(harnessVersionWarning("claude", "3.0.0")).toBeNull();
    // Unknown is not old.
    expect(harnessVersionWarning("claude", undefined)).toBeNull();
    expect(harnessVersionWarning("claude", "nightly")).toBeNull();
    // No floor, no warning.
    expect(harnessVersionWarning("codex", "0.0.1")).toBeNull();
  });

  it("claims nothing for any other CLI beyond rule enforcement while research is in progress", () => {
    for (const cli of BUILTIN_AGENT_CLIS.filter((c) => c.id !== "claude")) {
      for (const feature of HARNESS_FEATURES.filter((f) => f !== "ruleEnforcement")) {
        expect(harnessSupport(cli.id, feature), `${cli.id}.${feature}`).toBe("unknown");
      }
    }
  });

  it("says how rules are enforced for every built-in agent CLI, with a source", () => {
    for (const cli of BUILTIN_AGENT_CLIS) {
      const cap = harnessCapabilities(cli.id).ruleEnforcement;
      expect(cap.support, cli.id).not.toBe("unknown");
      expect(cap.source, cli.id).toBeTruthy();
      expect(cap.note, cli.id).toBeTruthy();
    }
    expect(harnessSupport("aider", "ruleEnforcement")).toBe("none");
    for (const id of ["claude", "codex", "cursor", "grok", "agy", "opencode", "omp", "amp"]) {
      expect(harnessSupport(id, "ruleEnforcement"), id).toBe("native");
    }
  });

  it("answers unknown, not undefined, for a CLI it has never heard of", () => {
    const caps = harnessCapabilities("in-house-agent");
    expect(HARNESS_FEATURES.every((f) => caps[f].support === "unknown")).toBe(true);
  });
});

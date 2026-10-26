import { describe, expect, it } from "vitest";
import {
  HARNESS_CAPABILITIES,
  HARNESS_FEATURES,
  harnessCapabilities,
  harnessSupport,
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
  });

  it("leaves Claude Code's unchecked features unknown", () => {
    for (const feature of ["checkpointsRewind", "ideProtocol", "subagents", "compaction"] as const) {
      expect(harnessSupport("claude", feature)).toBe("unknown");
    }
  });

  it("claims nothing for any other CLI while research is in progress", () => {
    for (const cli of BUILTIN_AGENT_CLIS.filter((c) => c.id !== "claude")) {
      for (const feature of HARNESS_FEATURES) {
        expect(harnessSupport(cli.id, feature), `${cli.id}.${feature}`).toBe("unknown");
      }
    }
  });

  it("answers unknown, not undefined, for a CLI it has never heard of", () => {
    const caps = harnessCapabilities("in-house-agent");
    expect(HARNESS_FEATURES.every((f) => caps[f].support === "unknown")).toBe(true);
  });
});

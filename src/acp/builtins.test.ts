import { afterEach, describe, expect, it } from "vitest";
import { startStructured, type ProjectRunnerProcess } from "../projectRunner";
import { agentCliFor, legacyRunnerFor, structuredRunnerFor, acpEnabledFor } from "../projects";
import { sanitizeAcpAgents, updateSettings } from "../settings";
import { canResumeSession, sessionOriginOf } from "../sessionOrigin";
import {
  CLAUDE_ACP_SPEC,
  CLAUDE_RUNNER,
  CODEX_ACP_SPEC,
  CODEX_RUNNER,
  CURSOR_ACP_SPEC,
  CURSOR_RUNNER,
  OPENCODE_ACP_SPEC,
  type StructuredRunnerLaunch,
} from "../structuredRunners";
import { isShellCommand } from "./providers";

afterEach(() => {
  localStorage.clear();
  updateSettings({ acpAgents: {} });
});

const launch = (bin: string, model = "opus"): StructuredRunnerLaunch => ({
  bin,
  policy: {
    systemPromptAppend: "",
    permissionMode: "",
    disallowedTools: [],
    model,
    sessionId: "s",
    cwd: "/work",
    authority: "workspace-write",
  },
});

describe("built-in ACP specs", () => {
  it("pins the registry npx package and passes no model or agent flags", () => {
    for (const [spec, pkg] of [
      [CLAUDE_ACP_SPEC, "@agentclientprotocol/claude-agent-acp@0.102.0"],
      [CODEX_ACP_SPEC, "@agentclientprotocol/codex-acp@2.6.0"],
    ] as const) {
      expect(spec.command).toBe("npx");
      expect(isShellCommand(spec.command)).toBe(false);
      expect(spec.args).toEqual(["-y", pkg]);
      expect(spec.adapter).toBe(true);
      expect(spec.modelArg).toBeUndefined();
      expect(spec.agentArg).toBeUndefined();
      expect(spec.trustAllArg).toBeUndefined();
    }
  });

  it("launches cursor-agent acp and opencode acp on the agent's own binary", () => {
    expect(CURSOR_ACP_SPEC.args).toEqual(["acp"]);
    expect(CURSOR_ACP_SPEC.adapter).toBeFalsy();
    expect(OPENCODE_ACP_SPEC.args).toEqual(["acp"]);
  });

  it("stamps every row as registry-sourced and not live-tested", () => {
    for (const spec of [CLAUDE_ACP_SPEC, CODEX_ACP_SPEC, CURSOR_ACP_SPEC, OPENCODE_ACP_SPEC]) {
      expect(spec.verification.source).toMatch(/NOT live-tested/);
      expect(spec.verification.cliVersion).toBeTruthy();
      expect(spec.verification.checkedOn).toBe("2026-11-09");
    }
  });
});

describe("runner resolver", () => {
  it("resolves claude, codex and cursor to ACP by default", () => {
    for (const id of ["claude", "codex", "cursor"]) {
      expect(structuredRunnerFor(id)?.tier, id).toBe("acp");
      expect(acpEnabledFor(id)).toBe(true);
    }
  });

  it("returns the vendor runner when the setting is off", () => {
    updateSettings({ acpAgents: { claude: false, codex: false, cursor: false } });
    expect(structuredRunnerFor("claude")).toBe(CLAUDE_RUNNER);
    expect(structuredRunnerFor("codex")).toBe(CODEX_RUNNER);
    expect(structuredRunnerFor("cursor")).toBe(CURSOR_RUNNER);
  });

  it("legacyRunnerFor is always the vendor runner", () => {
    expect(legacyRunnerFor("claude")).toBe(CLAUDE_RUNNER);
    expect(legacyRunnerFor("codex")).toBe(CODEX_RUNNER);
    updateSettings({ acpAgents: { claude: false } });
    expect(legacyRunnerFor("claude")).toBe(CLAUDE_RUNNER);
  });

  it("one-shot consumers keep vendor oneshot argv for claude and codex", () => {
    expect(legacyRunnerFor("claude")?.oneshotArgs).toBeTypeOf("function");
    expect(legacyRunnerFor("codex")?.tier).toBe("oneshot");
    expect(structuredRunnerFor("claude")?.oneshotArgs).toBeUndefined();
  });

  it("keeps Kiro on ACP and leaves unmigrated agents alone", () => {
    expect(structuredRunnerFor("kiro")?.tier).toBe("acp");
    expect(legacyRunnerFor("kiro")?.tier).toBe("acp");
    expect(structuredRunnerFor("aider")).toBeUndefined();
  });

  it("opencode runs over ACP and has no vendor fallback", () => {
    expect(structuredRunnerFor("opencode")?.tier).toBe("acp");
    expect(legacyRunnerFor("opencode")).toBeUndefined();
    updateSettings({ acpAgents: { opencode: false } });
    expect(structuredRunnerFor("opencode")).toBeUndefined();
  });

  it("sanitizes the stored map to booleans", () => {
    expect(sanitizeAcpAgents({ claude: false, codex: "no", [`x`.repeat(80)]: false, ok: true })).toEqual({
      claude: false,
      ok: true,
    });
    expect(sanitizeAcpAgents("junk")).toEqual({});
  });

  it("builds ACP argv without the vendor flags", () => {
    expect(agentCliFor("claude")?.acpRunner?.args(launch("claude"))).toEqual([
      "-y",
      "@agentclientprotocol/claude-agent-acp@0.102.0",
    ]);
    expect(agentCliFor("cursor")?.acpRunner?.args(launch("cursor-agent"))).toEqual(["acp"]);
  });
});

describe("session origin", () => {
  it("only resumes an id minted by the same kind of transport", () => {
    expect(sessionOriginOf("claude")).toBe("acp");
    updateSettings({ acpAgents: { claude: false } });
    expect(sessionOriginOf("claude")).toBe("vendor");
    expect(canResumeSession("acp", "claude")).toBe(false);
    expect(canResumeSession("vendor", "claude")).toBe(true);
    expect(canResumeSession(null, "claude")).toBe(false);
  });
});

describe("launching", () => {
  function harness(failSpawnFor?: (command: string) => boolean) {
    const spawned: { command: string; args: string[] }[] = [];
    const process: ProjectRunnerProcess = {
      spawn: async (_id, o) => {
        spawned.push(o);
        if (failSpawnFor?.(o.command)) throw new Error("spawn npx ENOENT");
      },
      write: async () => {},
      kill: async () => {},
    };
    return { process, spawned };
  }

  it("runs an npx adapter through npx, not the agent's own binary", async () => {
    const h = harness();
    await startStructured("a1", "claude", launch("claude"), { emit: () => {} }, { resume: false, process: h.process });
    expect(h.spawned[0]).toMatchObject({
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@0.102.0"],
    });
  });

  it("falls back to the vendor runner when the ACP process cannot spawn", async () => {
    const h = harness((c) => c === "npx");
    await startStructured("a1", "claude", launch("claude"), { emit: () => {} }, { resume: false, process: h.process });
    expect(h.spawned.map((s) => s.command)).toEqual(["npx", "claude"]);
    expect(h.spawned[1].args).toContain("stream-json");
  });

  it("names the setting when there is no vendor runner to fall back to", async () => {
    const h = harness(() => true);
    await expect(
      startStructured("a1", "opencode", launch("opencode"), { emit: () => {} }, { resume: false, process: h.process }),
    ).rejects.toThrow(/Use ACP/);
  });
});

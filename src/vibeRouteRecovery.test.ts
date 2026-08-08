import { describe, expect, it, vi } from "vitest";
import type { AgentCli } from "./projects";
import {
  buildRouteRecoveryActions,
  executeVibeRouteRecovery,
  parseRouteRecoveryResponse,
  type VibeRouteRecoveryDeps,
} from "./vibeRouteRecovery";

const claude = {
  id: "claude",
  name: "Claude Code",
  bin: "claude",
  icon: "claude",
  install: "npm install -g @anthropic-ai/claude-code",
  rebound: false,
} as AgentCli;

const codex = {
  id: "codex",
  name: "Codex",
  bin: "codex",
  icon: "codex",
  install: "npm install -g @openai/codex",
  rebound: false,
} as AgentCli;

function deps(over: Partial<VibeRouteRecoveryDeps> = {}): VibeRouteRecoveryDeps {
  return {
    clis: [claude, codex],
    profiles: [
      { id: "default", label: "Personal", root: "/home/me", removable: false },
      { id: "work", label: "Work", root: "/profiles/work", removable: true },
    ],
    activeProfileId: "default",
    runTerminal: vi.fn(),
    profileAccounts: vi.fn(async () => []),
    profileEnv: vi.fn(async () => []),
    setActiveProfile: vi.fn(),
    primeLaunchEnv: vi.fn(async () => {}),
    setupAgentHooks: vi.fn(async (agent) => ({
      agent,
      ok: true,
      steps: [],
      summary: `${agent} ready`,
    })),
    openAgentSettings: vi.fn(),
    ...over,
  };
}

describe("vibe route recovery", () => {
  it("offers only honest Build-capable installs and keeps responses opaque", () => {
    const actions = buildRouteRecoveryActions(
      [
        {
          cli: "claude",
          state: {
            agent: "claude",
            profile: "default",
            kind: "unusable",
            reasons: ["not-installed"],
          },
        },
        {
          cli: "aider",
          state: {
            agent: "aider",
            profile: "default",
            kind: "unusable",
            reasons: ["not-installed"],
          },
        },
      ],
      [
        claude,
        {
          ...claude,
          id: "aider",
          name: "Aider",
          bin: "aider",
          install: "pipx install aider-chat",
        },
      ],
    );

    expect(actions.map((action) => action.label)).toEqual([
      "Install Claude Code",
      "Agent settings & binary path",
    ]);
    expect(parseRouteRecoveryResponse(actions[0].response)).toEqual({
      kind: "install",
      cli: "claude",
    });
    expect(actions[0].response).not.toContain("Claude Code");
  });

  it("offers sign-in, account switch and integration repair from fleet reasons", () => {
    const actions = buildRouteRecoveryActions(
      [
        {
          cli: "codex",
          state: {
            agent: "codex",
            profile: "default",
            kind: "unusable",
            reasons: ["signed-out", "integration-unhealthy"],
          },
        },
      ],
      [codex],
    );

    expect(actions.map((action) => action.label)).toEqual([
      "Sign in to Codex",
      "Use another Codex account",
      "Repair Codex connection",
      "Agent settings & binary path",
    ]);
  });

  it("runs an installer as a chore so its existing exit path re-probes", async () => {
    const h = deps();
    await expect(
      executeVibeRouteRecovery({ kind: "install", cli: "claude" }, h),
    ).resolves.toMatchObject({ ok: true, prompt: "Installing Claude Code." });
    expect(h.runTerminal).toHaveBeenCalledWith({
      command: claude.install,
      title: "install Claude Code",
      icon: "⬇",
      run: "chore",
    });
  });

  it("opens sign-in in the active profile's environment", async () => {
    const h = deps({
      activeProfileId: "work",
      profileEnv: vi.fn(async () => [
        ["CLAUDE_CONFIG_DIR", "/profiles/work/.claude"] as [string, string],
      ]),
    });
    await executeVibeRouteRecovery({ kind: "sign-in", cli: "claude" }, h);
    expect(h.profileEnv).toHaveBeenCalledWith("claude", "work");
    expect(h.runTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "claude",
        title: "Claude Code — Work",
        run: false,
        profile: "work",
      }),
    );
  });

  it("switches only to another account already signed in to that CLI", async () => {
    const h = deps({
      profileAccounts: vi.fn(async (id) =>
        id === "work"
          ? [{ agent: "codex", state: "in" as const, account: "dev@example.com" }]
          : [],
      ),
    });
    await expect(
      executeVibeRouteRecovery({ kind: "switch-account", cli: "codex" }, h),
    ).resolves.toMatchObject({ ok: true, prompt: "Switched to Work." });
    expect(h.setActiveProfile).toHaveBeenCalledWith("work");
    expect(h.primeLaunchEnv).toHaveBeenCalledOnce();
  });

  it("uses the existing hook setup and surfaces a partial failure", async () => {
    const h = deps({
      setupAgentHooks: vi.fn(async (agent) => ({
        agent,
        ok: false,
        steps: [{ step: "mcp", ok: false, message: "registry is unreadable" }],
        summary: "Codex MCP registry is unreadable",
      })),
    });
    await expect(
      executeVibeRouteRecovery(
        { kind: "repair-integration", cli: "codex" },
        h,
      ),
    ).resolves.toEqual({
      ok: false,
      prompt: "I couldn't finish repairing Codex.",
      detail: "Codex MCP registry is unreadable",
    });
    expect(h.setupAgentHooks).toHaveBeenCalledWith("codex");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({
  agentIntegrationHealth: vi.fn(),
  setupAgentHooks: vi.fn(),
  gatesPolicyWrite: vi.fn(),
}));
vi.mock("../ipc", async (orig) => ({ ...(await orig<typeof import("../ipc")>()), ...ipcMock }));
const ledger = vi.hoisted(() => ({ queryLedger: vi.fn() }));
vi.mock("../ledger", async (orig) => ({ ...(await orig<typeof import("../ledger")>()), ...ledger }));

import {
  checkWorkspaceHooks,
  dismissWorkspaceHooks,
  pushWorkspacePolicies,
  resetWorkspaceHooksForTests,
  updateWorkspaceHooks,
  workspaceHooksState,
} from "./workspaceRules";

const gate = { kind: "path", paths: ["migrations/**"], actions: ["write"] };

beforeEach(() => {
  resetWorkspaceHooksForTests();
  Object.values(ipcMock).forEach((m) => m.mockReset());
  ledger.queryLedger.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("pushWorkspacePolicies", () => {
  it("writes each open project's policy into the workspace, and one bad project doesn't stop the rest", async () => {
    ledger.queryLedger.mockImplementation(async (root: string) => {
      if (root === "/workspace/bad") throw Error("unreadable");
      return [{ id: "r1", ts: 1, kind: "rule", scope: "project", status: "active", author: { kind: "human", name: "you" }, data: { type: "rule", text: "Never touch migrations", tag: "enforced", approved: true, gate } }];
    });
    ipcMock.gatesPolicyWrite.mockResolvedValue("/workspace/a/.canopy/gates.json");
    await pushWorkspacePolicies(["/workspace/bad", "/workspace/a", "/workspace/a"]);
    expect(ipcMock.gatesPolicyWrite).toHaveBeenCalledTimes(1);
    const [cwd, policy] = ipcMock.gatesPolicyWrite.mock.calls[0];
    expect(cwd).toBe("/workspace/a");
    expect(policy.trifecta).toBe("warn");
    expect(policy.gates.length + policy.guidance.length).toBe(1);
  });
});

describe("workspace hooks", () => {
  it("offers an update only for installed CLIs whose hooks are not current, then updates them", async () => {
    ipcMock.agentIntegrationHealth.mockResolvedValue([
      { agent: "a1", cli_installed: true, hooks: "missing", mcp: "ours" },
      { agent: "a2", cli_installed: false, hooks: "missing", mcp: "missing" },
    ]);
    expect(await checkWorkspaceHooks()).toEqual({ state: "outdated", agents: ["a1"] });
    ipcMock.setupAgentHooks.mockResolvedValue({ agent: "a1", ok: true, steps: [], summary: "Hooks installed." });
    await updateWorkspaceHooks();
    expect(ipcMock.setupAgentHooks).toHaveBeenCalledWith("a1");
    expect(workspaceHooksState()).toEqual({ state: "updated", summary: "Hooks installed." });
  });

  it("reports a failed update with the host's words, and can be dismissed", async () => {
    ipcMock.agentIntegrationHealth.mockResolvedValue([{ agent: "a1", cli_installed: true, hooks: "missing", mcp: "ours" }]);
    await checkWorkspaceHooks();
    ipcMock.setupAgentHooks.mockResolvedValue({ agent: "a1", ok: false, steps: [], summary: "default: Configuration is invalid" });
    await updateWorkspaceHooks();
    expect(workspaceHooksState()).toMatchObject({ state: "failed", agents: ["a1"], summary: "default: Configuration is invalid" });
    dismissWorkspaceHooks();
    expect(workspaceHooksState()).toEqual({ state: "unknown" });
    // useSyncExternalStore needs the same snapshot on every read, or it loops.
    expect(workspaceHooksState()).toBe(workspaceHooksState());
  });

  it("says nothing when every hook is current", async () => {
    ipcMock.agentIntegrationHealth.mockResolvedValue([{ agent: "a1", cli_installed: true, hooks: "ours", mcp: "ours" }]);
    expect(await checkWorkspaceHooks()).toEqual({ state: "current" });
  });
});

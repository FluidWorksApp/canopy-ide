import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  peek: vi.fn(),
}));

vi.mock("../remoteExecution/workspaceListCache", () => ({
  refreshWorkspaceList: mocks.refresh,
  peekWorkspaceList: mocks.peek,
}));
vi.mock("../host", () => ({ isRemoteHost: () => false }));
vi.mock("../remoteExecution/workspace", () => ({ activeWorkspace: () => null }));
vi.mock("../projects", () => ({
  loadWorkspace: async () => ({ projects: [{ id: "p1", name: "Canopy", components: [] }] }),
}));
vi.mock("../ipc", () => ({
  ptyStats: async () => [],
  memoryInfo: async () => ({ total_bytes: 100, available_bytes: 50 }),
}));
vi.mock("../meshJobs", () => ({ localRemoteJobs: () => ({ load: () => [] }) }));

import { gatherTargetInventory, gatherUnified } from "./gather";

const workspace = { id: "w1", name: "Studio", state: "ready", provider: "lightsail" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.peek.mockReturnValue(undefined);
  mocks.refresh.mockResolvedValue({ workspaces: [workspace] });
});

describe("machine inventory boundaries", () => {
  it("lists This Mac and the account's workspaces as picker targets", async () => {
    const inventory = await gatherTargetInventory();

    expect(inventory.targets.map((target) => target.name)).toEqual(["This Mac", "Studio"]);
    expect(inventory.discoveryFailures).toEqual([]);
  });

  it("preserves a workspace discovery failure instead of returning a clean empty inventory", async () => {
    mocks.refresh.mockRejectedValue(new Error("workspace service unavailable"));

    const inventory = await gatherTargetInventory();

    expect(inventory.targets).toEqual([{ target: { kind: "local" }, name: "This Mac", online: true }]);
    expect(inventory.discoveryFailures.join(" ")).toContain("workspace service unavailable");
  });

  it("reads the workspace list once during the pre-launch gather", async () => {
    const gathered = await gatherUnified();

    expect(gathered.discoveryFailures).toEqual([]);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});

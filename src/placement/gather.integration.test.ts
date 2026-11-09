import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  peek: vi.fn(),
  listMachines: vi.fn(),
  connect: vi.fn(),
  listShell: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../remoteExecution/workspaceListCache", () => ({
  refreshWorkspaceList: mocks.refresh,
  peekWorkspaceList: mocks.peek,
}));
vi.mock("../t3connect/api", () => ({
  listT3Machines: mocks.listMachines,
  connectT3Machine: mocks.connect,
}));
vi.mock("../t3connect/methods", () => ({ listShell: mocks.listShell }));
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
const machine = { id: "m1", label: "Build Mini" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.peek.mockReturnValue(undefined);
  mocks.refresh.mockResolvedValue({ workspaces: [workspace] });
  mocks.listMachines.mockResolvedValue([machine]);
  mocks.connect.mockResolvedValue({ close: mocks.close });
  mocks.listShell.mockResolvedValue({ projects: [], threads: [] });
});

describe("machine inventory boundaries", () => {
  it("renders picker targets without opening every T3 shell", async () => {
    const inventory = await gatherTargetInventory();

    expect(inventory.targets.map((target) => target.name)).toEqual(["This Mac", "Studio", "Build Mini"]);
    expect(inventory.discoveryFailures).toEqual([]);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.listShell).not.toHaveBeenCalled();
  });

  it("preserves workspace and machine discovery failures instead of returning a clean empty inventory", async () => {
    mocks.refresh.mockRejectedValue(new Error("workspace service unavailable"));
    mocks.listMachines.mockRejectedValue(new Error("machine registry unavailable"));

    const inventory = await gatherTargetInventory();

    expect(inventory.targets).toEqual([{ target: { kind: "local" }, name: "This Mac", online: true }]);
    expect(inventory.discoveryFailures.join(" ")).toContain("workspace service unavailable");
    expect(inventory.discoveryFailures.join(" ")).toContain("machine registry unavailable");
  });

  it("opens each T3 shell once during the one fresh pre-launch gather", async () => {
    const gathered = await gatherUnified();

    expect(gathered.discoveryFailures).toEqual([]);
    expect(mocks.listMachines).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledWith("m1");
    expect(mocks.listShell).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});

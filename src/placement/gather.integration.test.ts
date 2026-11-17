import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  peek: vi.fn(),
  saved: vi.fn(),
  remote: { value: false },
}));

vi.mock("../remoteExecution/workspaceListCache", () => ({
  refreshWorkspaceList: mocks.refresh,
  peekWorkspaceList: mocks.peek,
  restoreWorkspaceList: async () => undefined,
  subscribeWorkspaceList: () => () => {},
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => (command === "execution_remote_list" ? mocks.saved() : Promise.reject(new Error(`unexpected ${command}`))),
}));
vi.mock("../host", () => ({ isRemoteHost: () => mocks.remote.value }));
vi.mock("../remoteExecution/workspace", () => ({
  activeWorkspace: () => (mocks.remote.value ? { connection: { workspaceId: "own", workspaceName: "Build Box" } } : null),
}));
vi.mock("../projects", () => ({
  loadWorkspace: async () => ({ projects: [{ id: "p1", name: "Canopy", components: [] }] }),
}));
vi.mock("../ipc", () => ({
  ptyStats: async () => [],
  memoryInfo: async () => ({ total_bytes: 100, available_bytes: 50 }),
}));
vi.mock("../meshJobs", () => ({ localRemoteJobs: () => ({ load: () => [] }) }));

import { gatherTargetInventory, gatherUnified } from "./gather";
import { invalidateSavedMachines } from "../machines/inventory";

const workspace = { id: "w1", name: "Studio", state: "ready", provider: "lightsail" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.remote.value = false;
  mocks.peek.mockReturnValue(undefined);
  mocks.refresh.mockResolvedValue({ workspaces: [workspace] });
  mocks.saved.mockResolvedValue([]);
  invalidateSavedMachines();
});

describe("machine inventory boundaries", () => {
  it("lists This Mac and the account's workspaces as picker targets", async () => {
    const inventory = await gatherTargetInventory();

    expect(inventory.targets.map((target) => target.name)).toEqual(["This Mac", "Studio"]);
    expect(inventory.discoveryFailures).toEqual([]);
  });

  it("lists the machine a remote window runs on when the account's list omits it", async () => {
    mocks.remote.value = true;

    const inventory = await gatherTargetInventory();

    expect(inventory.targets.map((target) => [target.name, target.online])).toEqual([
      ["This Mac", true],
      ["Studio", true],
      ["Build Box", true],
    ]);
  });

  it("does not list the active machine twice when the account already names it", async () => {
    mocks.remote.value = true;
    mocks.refresh.mockResolvedValue({ workspaces: [{ ...workspace, id: "own", name: "Build Box" }] });

    const inventory = await gatherTargetInventory();

    expect(inventory.targets.map((target) => target.name)).toEqual(["This Mac", "Build Box"]);
  });

  it("lists the person's own machines beside the account's workspaces", async () => {
    mocks.saved.mockResolvedValue([
      { id: "http://box.tail1.ts.net:8787/work-0a1b2c3d", endpoint: "http://box.tail1.ts.net:8787", workspaceId: "work-0a1b2c3d", workspaceName: "box", own: true },
    ]);

    const inventory = await gatherTargetInventory();

    expect(inventory.targets.map((target) => [target.name, target.online])).toEqual([
      ["This Mac", true],
      ["Studio", true],
      ["box", true],
    ]);
  });

  it("keeps own machines in the picker when the account cannot be read", async () => {
    mocks.refresh.mockRejectedValue(new Error("workspace service unavailable"));
    mocks.saved.mockResolvedValue([
      { id: "http://127.0.0.1:8787/work-0a1b2c3d", endpoint: "http://127.0.0.1:8787", workspaceId: "work-0a1b2c3d", workspaceName: "box", own: true },
    ]);

    const inventory = await gatherTargetInventory();

    expect(inventory.targets.map((target) => target.name)).toEqual(["This Mac", "box"]);
    expect(inventory.discoveryFailures.join(" ")).toContain("workspace service unavailable");
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

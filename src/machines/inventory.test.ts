import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  peek: vi.fn(),
  restore: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}));

vi.mock("../remoteExecution/workspaceListCache", () => ({
  refreshWorkspaceList: mocks.refresh,
  peekWorkspaceList: mocks.peek,
  restoreWorkspaceList: mocks.restore,
  subscribeWorkspaceList: mocks.subscribe,
}));

import {
  invalidateSavedMachines,
  mergeMachines,
  ownMachineSavedId,
  peekMachines,
  reachableMachines,
  refreshMachines,
  type InventoryDeps,
  type SavedMachine,
} from "./inventory";

const cloud = { id: "w1", name: "Studio", state: "ready" };
const box: SavedMachine = { id: "http://box.tail1.ts.net:8787/work-0a1b2c3d", endpoint: "http://box.tail1.ts.net:8787", workspaceId: "work-0a1b2c3d", workspaceName: "box", own: true };
const cloudSaved: SavedMachine = { id: "https://w1.workspaces.canopyide.dev/w1", endpoint: "https://w1.workspaces.canopyide.dev", workspaceId: "w1", workspaceName: "Studio", own: false };

const deps = (list: SavedMachine[] | Error, now = 1000): InventoryDeps => ({
  savedList: vi.fn(async () => {
    if (list instanceof Error) throw list;
    return list;
  }),
  now: () => now,
});

beforeEach(() => {
  vi.clearAllMocks();
  invalidateSavedMachines();
  mocks.peek.mockReturnValue(undefined);
  mocks.refresh.mockResolvedValue({ workspaces: [cloud] });
  mocks.restore.mockResolvedValue(undefined);
});

describe("mergeMachines", () => {
  it("lists cloud workspaces and own machines together", () => {
    const machines = mergeMachines([cloud], [box, cloudSaved]);
    expect(machines.map((m) => [m.id, m.name, m.kind])).toEqual([
      ["w1", "Studio", "cloud"],
      ["work-0a1b2c3d", "box", "own"],
    ]);
    expect(machines[1]).toMatchObject({ state: "ready", savedId: box.id, endpoint: box.endpoint });
  });

  it("never treats a saved cloud connection as an own machine, even when the account list is unread", () => {
    expect(mergeMachines([], [cloudSaved])).toEqual([]);
    // An expired cloud credential the native side could not classify still has the cloud address.
    expect(mergeMachines([], [{ ...cloudSaved, own: true }])).toEqual([]);
  });

  it("keeps the first of two own machines that share a workspace id", () => {
    const other: SavedMachine = { ...box, id: "http://127.0.0.1:8787/work-0a1b2c3d", endpoint: "http://127.0.0.1:8787", workspaceName: "tunnel" };
    expect(mergeMachines([], [box, other]).map((m) => m.name)).toEqual(["box"]);
  });

  it("adds the machine this window is on when neither source names it", () => {
    const machines = mergeMachines([cloud], [], { workspaceId: "work-9", workspaceName: "ip-172-26-8-57", endpoint: "http://127.0.0.1:8787" });
    expect(machines.map((m) => [m.id, m.name, m.kind, m.state])).toEqual([
      ["w1", "Studio", "cloud", "ready"],
      ["work-9", "ip-172-26-8-57", "own", "ready"],
    ]);
    expect(mergeMachines([cloud], [], { workspaceId: "w1" })).toHaveLength(1);
  });

  it("takes a saved id from the connection id when the workspace id is missing", () => {
    const { workspaceId: _dropped, ...legacy } = box;
    expect(mergeMachines([], [legacy])[0].id).toBe("work-0a1b2c3d");
  });
});

describe("reachableMachines", () => {
  it("keeps ready machines this account may connect to", () => {
    const machines = mergeMachines(
      [cloud, { id: "w2", name: "Asleep", state: "stopped" }, { id: "w3", name: "Theirs", state: "ready", access: { canConnect: false } }],
      [box],
    );
    expect(reachableMachines(machines).map((m) => m.id)).toEqual(["w1", "work-0a1b2c3d"]);
  });
});

describe("refreshMachines", () => {
  it("reads both sources", async () => {
    const result = await refreshMachines(null, deps([box]));
    expect(result.failure).toBeUndefined();
    expect(result.machines.map((m) => m.id)).toEqual(["w1", "work-0a1b2c3d"]);
    expect(peekMachines().map((m) => m.id)).toEqual(["work-0a1b2c3d"]);
  });

  it("still lists own machines when the account cannot be read, and says so", async () => {
    mocks.refresh.mockRejectedValue(new Error("not signed in"));
    const result = await refreshMachines(null, deps([box]));
    expect(result.machines.map((m) => m.id)).toEqual(["work-0a1b2c3d"]);
    expect(result.failure).toContain("not signed in");
  });

  it("still lists cloud workspaces when this Mac's saved list cannot be read", async () => {
    const result = await refreshMachines(null, deps(new Error("keyring locked")));
    expect(result.machines.map((m) => m.id)).toEqual(["w1"]);
  });
});

describe("ownMachineSavedId", () => {
  it("names the saved connection of an own machine", async () => {
    expect(await ownMachineSavedId("work-0a1b2c3d", deps([box]))).toBe(box.id);
  });

  it("is null for a cloud workspace, without reading the credential store", async () => {
    mocks.peek.mockReturnValue({ workspaces: [cloud] });
    const d = deps([box]);
    expect(await ownMachineSavedId("w1", d)).toBeNull();
    expect(d.savedList).not.toHaveBeenCalled();
  });

  it("is null for an id nothing knows", async () => {
    expect(await ownMachineSavedId("nope", deps([box]))).toBeNull();
  });

  it("reads the store once for several questions in a row", async () => {
    const d = deps([box]);
    await ownMachineSavedId("work-0a1b2c3d", d);
    await ownMachineSavedId("work-0a1b2c3d", d);
    expect(d.savedList).toHaveBeenCalledOnce();
  });
});

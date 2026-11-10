import { describe, expect, it } from "vitest";
import { capacityFromMemory, collectResources, type ResourceSources } from "./resources";

const base: ResourceSources = {
  now: () => 42,
  localActiveAgents: async () => 1,
  localMemory: async () => ({ total_bytes: 100, available_bytes: 25 }),
  localCapacity: 4,
  remoteWorkspaces: async () => [
    { id: "w1", state: "ready", memory_max_mib: 6144 },
    { id: "w2", state: "stopped" },
  ],
  remoteActiveAgents: async () => 2,
  t3Machines: async () => [{ id: "m1" }],
  t3ActiveAgents: async () => 0,
};

describe("collectResources", () => {
  it("snapshots local, remote and t3 targets", async () => {
    const rs = await collectResources(base);
    expect(rs).toHaveLength(4);
    expect(rs[0]).toMatchObject({ target: { kind: "local" }, online: true, activeAgents: 1, memFree: 0.25, lastSeen: 42 });
    expect(rs[1]).toMatchObject({ target: { kind: "remote", workspaceId: "w1" }, online: true, activeAgents: 2, capacity: 4 });
    expect(rs[2]).toMatchObject({ online: false });
    expect(rs[3]).toMatchObject({ target: { kind: "t3", machineId: "m1" }, online: true });
  });
  it("marks a workspace read from outside as counting sessions, not agents", async () => {
    const rs = await collectResources({ ...base, remoteActiveAgents: async () => ({ sessions: 3 }) });
    expect(rs[1]).toMatchObject({ online: true, activeAgents: 3, loadBasis: "sessions", capacity: 4 });
    expect(rs[1].loadUnknown).toBeUndefined();
  });
  it("keeps an inactive local machine eligible without pretending its load is known", async () => {
    const [local] = await collectResources({
      ...base,
      localActiveAgents: async () => "unknown",
      remoteWorkspaces: async () => [],
      t3Machines: async () => [],
    });
    expect(local).toMatchObject({ online: true, activeAgents: 0, loadUnknown: true, capacity: 4 });
  });
  it("marks failing sources offline instead of throwing", async () => {
    const boom = async () => { throw new Error("x"); };
    const rs = await collectResources({ ...base, localActiveAgents: boom, remoteActiveAgents: boom, t3ActiveAgents: boom });
    expect(rs.map((r) => r.online)).toEqual([false, false, false, false]);
  });
  it("tolerates a failed workspace list", async () => {
    const rs = await collectResources({ ...base, remoteWorkspaces: async () => { throw new Error("x"); }, t3Machines: async () => { throw new Error("y"); } });
    expect(rs).toHaveLength(1);
  });
});

describe("capacityFromMemory", () => {
  it("scales with memory and falls back", () => {
    expect(capacityFromMemory(8192, 4)).toBe(5);
    expect(capacityFromMemory(512, 4)).toBe(2);
    expect(capacityFromMemory(undefined, 4)).toBe(4);
  });
});

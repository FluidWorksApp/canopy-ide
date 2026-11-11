import { describe, expect, it, vi } from "vitest";
import { localTabReconnect } from "./remoteReconnect";
import { EnvironmentRegistry } from "./registry";
import { joinThisMac, leaveThisMac } from "./live";

describe("localTabReconnect", () => {
  it("attaches a terminal still running on this Mac under the local environment", async () => {
    const adopt = vi.fn(() => 2 ** 40 + 7);
    const result = await localTabReconnect(4, { invoke: async () => [{ id: 4 }, { id: 5 }] as never, adopt });
    expect(result).toEqual({ kind: "attached", alias: 2 ** 40 + 7, machineName: "This Mac" });
    expect(adopt).toHaveBeenCalledWith(expect.objectContaining({ id: "local", readOnly: false }), 4);
  });
  it("says gone, without attaching, when that terminal has ended", async () => {
    const adopt = vi.fn();
    const result = await localTabReconnect(9, { invoke: async () => [{ id: 4 }] as never, adopt });
    expect(result).toEqual({ kind: "gone", machineName: "This Mac" });
    expect(adopt).not.toHaveBeenCalled();
  });
  it("fails, without attaching, when the terminal list cannot be read", async () => {
    const adopt = vi.fn();
    const result = await localTabReconnect(4, { invoke: async () => { throw new Error("boom"); }, adopt });
    expect(result.kind).toBe("failed");
    expect(adopt).not.toHaveBeenCalled();
  });
});

describe("joinThisMac", () => {
  it("registers this Mac as one of the other machines, never the primary, and lets go again", () => {
    const registry = new EnvironmentRegistry();
    joinThisMac(registry);
    joinThisMac(registry);
    expect(registry.list().map((e) => e.id)).toEqual(["local"]);
    expect(registry.get("local")?.host.kind).toBe("native");
    expect(registry.primary).toBeUndefined();
    leaveThisMac(registry);
    expect(registry.get("local")).toBeUndefined();
  });
});

describe("leaveThisMac", () => {
  it("keeps the routes of this Mac's terminals so tabs unmounting after it can still let go", async () => {
    const { aliasPty, routeOf, resetPtyRoutes } = await import("./ptyRoute");
    resetPtyRoutes();
    const registry = new EnvironmentRegistry();
    joinThisMac(registry);
    const alias = aliasPty("local", 4, registry.get("local")!.host, false);
    leaveThisMac(registry);
    expect(routeOf(alias)?.env).toBe("local");
    resetPtyRoutes();
  });
});

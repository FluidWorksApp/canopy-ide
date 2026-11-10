import { describe, expect, it, vi } from "vitest";
import { guardedDesktop, openTemporaryWorkspace, type TemporaryDeps } from "./temporaryWorkspace";
import type { Host } from "../host/contract";

const connection = { endpoint: "https://w9.workspaces.canopyide.dev", token: "t", workspaceId: "w9", workspaceName: "Coraa Workstation" };

function deps(over: Partial<TemporaryDeps> = {}) {
  const hostInvoke = vi.fn(async (command: string) => `ran ${command}`);
  const dispose = vi.fn();
  const made: { desktop?: Host } = {};
  const d: TemporaryDeps = {
    connect: vi.fn(async () => connection),
    clientId: () => "client-1",
    makeHost: vi.fn((_c, desktop) => {
      made.desktop = desktop;
      return { invoke: hostInvoke as never, dispose };
    }),
    ...over,
  };
  return { d, hostInvoke, dispose, made };
}

describe("openTemporaryWorkspace", () => {
  it("connects with a stable client id and runs commands on that workspace", async () => {
    const { d, hostInvoke } = deps();
    const ws = await openTemporaryWorkspace("w9", d);
    expect(d.connect).toHaveBeenCalledWith("w9", "client-1");
    expect(ws.workspaceName).toBe("Coraa Workstation");
    expect(await ws.invoke("store_load")).toBe("ran store_load");
    expect(hostInvoke).toHaveBeenCalledWith("store_load", {});
  });

  it("refuses commands once disposed, and disposes the host once", async () => {
    const { d, dispose } = deps();
    const ws = await openTemporaryWorkspace("w9", d);
    ws.dispose();
    ws.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(ws.invoke("store_load")).rejects.toThrow(/closed/);
  });

  it("passes the host a desktop that cannot overwrite the saved active workspace", async () => {
    const { d, made } = deps();
    await openTemporaryWorkspace("w9", d);
    const base = vi.fn(async () => "native");
    const desktop = guardedDesktop({ kind: "native", invoke: base as never, listen: vi.fn() as never, channel: vi.fn() as never } as Host);
    expect(made.desktop).toBeDefined();
    await desktop.invoke("execution_remote_set", { connection });
    expect(base).not.toHaveBeenCalled();
    await desktop.invoke("canopy_account_cache_key");
    expect(base).toHaveBeenCalledWith("canopy_account_cache_key", undefined);
  });

  it("does not hold a host when the credential cannot be issued", async () => {
    const { d } = deps({ connect: vi.fn(async () => { throw new Error("stopped"); }) });
    await expect(openTemporaryWorkspace("w9", d)).rejects.toThrow("stopped");
    expect(d.makeHost).not.toHaveBeenCalled();
  });
});

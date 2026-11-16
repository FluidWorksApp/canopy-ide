import { describe, expect, it, vi } from "vitest";
import { guardedDesktop, openSavedMachine, openTemporaryWorkspace, type SavedMachineDeps, type TemporaryDeps } from "./temporaryWorkspace";
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

describe("openSavedMachine", () => {
  const box = { endpoint: "http://box.tail1234.ts.net:8787", token: "synthetic-token-0123456789abcdef", workspaceId: "work-0a1b2c3d", workspaceName: "box" };
  const make = (over: Partial<SavedMachineDeps> = {}): SavedMachineDeps => ({
    saved: vi.fn(async () => box),
    open: vi.fn(async () => ({ root: "/home/me/work" })),
    makeHost: vi.fn(() => ({ invoke: vi.fn(async () => "ok") as never, dispose: vi.fn() })),
    ...over,
  });

  it("opens a saved machine with its own credential and folder, leaving the window where it is", async () => {
    const d = make();
    const ws = await openSavedMachine("http://box.tail1234.ts.net:8787/work-0a1b2c3d", d);
    expect(d.saved).toHaveBeenCalledWith("http://box.tail1234.ts.net:8787/work-0a1b2c3d");
    expect(d.open).toHaveBeenCalledWith(box);
    expect(ws.root).toBe("/home/me/work");
    expect(ws.connection?.()).toEqual(box);
    expect(ws.workspaceName).toBe("box");
  });

  it("falls back to the default folder when the host reports none, and says when the machine is gone", async () => {
    expect((await openSavedMachine("id", make({ open: vi.fn(async () => ({})) }))).root).toBe("/workspace");
    await expect(openSavedMachine("id", make({ saved: vi.fn(async () => null) }))).rejects.toThrow("no longer saved");
  });
});

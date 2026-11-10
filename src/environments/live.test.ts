import { afterEach, expect, it, vi } from "vitest";
import type { Host } from "../host/contract";
import { EnvironmentRegistry } from "./registry";
import { connectMachine, disconnectMachine } from "./live";
import type { TemporaryDeps } from "../remoteExecution/temporaryWorkspace";

const fakeDeps = () => {
  const dispose = vi.fn();
  const host = { kind: "socket", readOnly: false, invoke: vi.fn(), listen: vi.fn(), channel: vi.fn(), dispose } as unknown as Host & { dispose: () => void };
  const deps: TemporaryDeps = {
    connect: vi.fn(async (workspaceId: string) => ({ workspaceId, workspaceName: "Workstation", endpoint: "e", token: "t" }) as never),
    clientId: () => "c",
    makeHost: () => host as never,
  };
  return { deps, dispose };
};

afterEach(async () => {
  await disconnectMachine("ws1", new EnvironmentRegistry());
});

it("connects once, reuses the connection and does not become the primary", async () => {
  const registry = new EnvironmentRegistry();
  const { deps } = fakeDeps();
  const a = await connectMachine("ws1", deps, registry);
  const b = await connectMachine("ws1", deps, registry);
  expect(a.env).toBe("remote:ws1");
  expect(b.name).toBe("Workstation");
  expect(deps.connect).toHaveBeenCalledTimes(1);
  expect(registry.get("remote:ws1")?.status).toBe("connected");
  expect(registry.primary).toBeUndefined();
});

it("lets go of a machine: closes it and removes it", async () => {
  const registry = new EnvironmentRegistry();
  const { deps, dispose } = fakeDeps();
  await connectMachine("ws1", deps, registry);
  await disconnectMachine("ws1", registry);
  expect(dispose).toHaveBeenCalled();
  expect(registry.get("remote:ws1")).toBeUndefined();
});

it("a failed connection is not remembered, so the next try connects again", async () => {
  const registry = new EnvironmentRegistry();
  const { deps } = fakeDeps();
  (deps.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("offline"));
  await expect(connectMachine("ws1", deps, registry)).rejects.toThrow("offline");
  await expect(connectMachine("ws1", deps, registry)).resolves.toMatchObject({ env: "remote:ws1" });
});

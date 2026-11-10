// The machines this window is connected to besides its own (docs/multi-host-design.md, P3).
//
// A machine is connected ONLY because the person chose to run something there
// (starting an agent on it); connecting wakes and bills a workspace, so nothing
// calls this on its own. The connection is the same one the project mirror uses
// (remoteExecution/temporaryWorkspace.ts): it is never installed as the window's
// host and never rewrites the saved active workspace.
import type { Host } from "../host/contract";
import { openTemporaryWorkspace, type TemporaryDeps, type TemporaryWorkspace } from "../remoteExecution/temporaryWorkspace";
import { EnvironmentRegistry } from "./registry";
import { forgetEnvironment } from "./ptyRoute";
import { stopListeningToMachine } from "../ipc";
import { targetKey } from "../placement/types";

/** Every machine connected for work besides the window's own. */
export const liveEnvironments = new EnvironmentRegistry();

const open = new Map<string, Promise<TemporaryWorkspace>>();

export interface ConnectedMachine {
  /** "remote:<workspaceId>" */
  env: string;
  name: string;
  host: Host;
  readOnly: boolean;
  invoke: TemporaryWorkspace["invoke"];
}

/** Connect to a workspace for work on it, reusing a connection already open.
 *  Rejects when it cannot be reached; the caller falls back to the old flow. */
export async function connectMachine(
  workspaceId: string,
  deps?: TemporaryDeps,
  registry: EnvironmentRegistry = liveEnvironments,
): Promise<ConnectedMachine> {
  const env = targetKey({ kind: "remote", workspaceId });
  let pending = open.get(env);
  if (!pending) {
    pending = openTemporaryWorkspace(workspaceId, deps);
    open.set(env, pending);
    pending.catch(() => open.delete(env));
  }
  const ws = await pending;
  if (!ws.host) throw new Error("This connection cannot run terminals.");
  if (!registry.get(env)) {
    registry.register(
      { id: env, name: ws.workspaceName, host: ws.host, status: "connected", readOnly: ws.readOnly },
      { secondary: true },
    );
  }
  return { env, name: ws.workspaceName, host: ws.host, readOnly: ws.readOnly, invoke: ws.invoke };
}

/** Let go of a machine: close the connection and forget its terminals. */
export async function disconnectMachine(workspaceId: string, registry: EnvironmentRegistry = liveEnvironments): Promise<void> {
  const env = targetKey({ kind: "remote", workspaceId });
  const pending = open.get(env);
  open.delete(env);
  registry.unregister(env);
  stopListeningToMachine(env);
  forgetEnvironment(env);
  (await pending?.catch(() => undefined))?.dispose();
}

/** The machines connected right now (never connects one). */
export async function connectedMachines(): Promise<ConnectedMachine[]> {
  const out: ConnectedMachine[] = [];
  for (const [env, pending] of open) {
    const ws = await pending.catch(() => undefined);
    if (!ws?.host) continue;
    out.push({ env, name: ws.workspaceName, host: ws.host, readOnly: ws.readOnly, invoke: ws.invoke });
  }
  return out;
}

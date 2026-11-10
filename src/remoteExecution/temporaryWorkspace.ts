// A short-lived connection to a workspace the window is NOT connected to, so
// work can be sent to it (the project mirror, and teleport after it) without
// switching the whole window over. It is a NativeWorkspaceHost like the live one,
// with two differences that matter:
//
//   * It is never installed as the window's host (src/host stays as it is).
//   * Its token renewal must not write the saved "active workspace". The live
//     host persists a renewed credential with `execution_remote_set`; a
//     temporary one doing that would silently replace which workspace the app
//     opens next time. That one command is swallowed here.
//
// Always `dispose()` it: it holds a heartbeat and listeners until then.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { nativeHost } from "../host/native";
import type { Host } from "../host/contract";
import { NativeWorkspaceHost, type WorkspaceConnection } from "./NativeWorkspaceHost";

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface TemporaryWorkspace {
  workspaceId: string;
  workspaceName: string;
  invoke: Invoke;
  /** The connection itself, for callers that need more than `invoke` (events,
   *  channels, a terminal). Absent when a test host offers only `invoke`. */
  host?: Host;
  /** Whether the credential is view-only. */
  readOnly: boolean;
  dispose: () => void;
}

export interface TemporaryDeps {
  connect: (workspaceId: string, clientId: string) => Promise<WorkspaceConnection>;
  clientId: (workspaceId: string) => string;
  makeHost: (connection: WorkspaceConnection, desktop: Host) => Pick<NativeWorkspaceHost, "invoke" | "dispose"> & Partial<Host>;
}

/** The desktop side of a temporary host: everything native as usual, except the
 *  write of the active-workspace record. */
export function guardedDesktop(base: Host = nativeHost): Host {
  return {
    ...base,
    invoke: ((command: string, args?: Record<string, unknown>) =>
      command === "execution_remote_set" ? Promise.resolve(undefined) : base.invoke(command, args)) as Host["invoke"],
  };
}

const stableClientId = (workspaceId: string): string => {
  const key = `canopy:probe-client:${workspaceId}`;
  try {
    const saved = localStorage.getItem(key);
    if (saved) return saved;
    const made = crypto.randomUUID();
    localStorage.setItem(key, made);
    return made;
  } catch {
    return crypto.randomUUID();
  }
};

const defaultDeps: TemporaryDeps = {
  connect: async (workspaceId, clientId) => {
    const result = await tauriInvoke<{ connection?: WorkspaceConnection }>("canopy_account_request", {
      route: "/api/operations",
      body: { action: "connect", workspaceId, clientId },
    });
    const c = result?.connection;
    if (!c || c.workspaceId !== workspaceId || typeof c.endpoint !== "string" || typeof c.token !== "string" || !c.token) {
      throw new Error("The workspace did not issue a usable credential.");
    }
    return { ...c, clientId: c.clientId ?? clientId };
  },
  clientId: stableClientId,
  makeHost: (connection, desktop) => new NativeWorkspaceHost(connection, desktop),
};

export async function openTemporaryWorkspace(workspaceId: string, deps: TemporaryDeps = defaultDeps): Promise<TemporaryWorkspace> {
  const connection = await deps.connect(workspaceId, deps.clientId(workspaceId));
  const host = deps.makeHost(connection, guardedDesktop());
  let closed = false;
  return {
    workspaceId,
    workspaceName: connection.workspaceName || workspaceId,
    ...(typeof host.listen === "function" && typeof host.channel === "function" ? { host: host as unknown as Host } : {}),
    readOnly: host.readOnly === true,
    invoke: ((command: string, args?: Record<string, unknown>) => {
      if (closed) return Promise.reject(new Error("The connection to the workspace was closed."));
      return host.invoke(command, args ?? {});
    }) as Invoke,
    dispose: () => {
      if (closed) return;
      closed = true;
      host.dispose();
    },
  };
}

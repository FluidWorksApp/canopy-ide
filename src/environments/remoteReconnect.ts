// Taking back a terminal that is still running on another machine after the
// project that started it slept. Connects only because the person pressed
// Reconnect (never on wake), checks the session is still alive through that
// machine's own process list, and re-registers it under an alias exactly as a
// fresh spawn would.
import { adoptMachineTerminal, type PtyMachine } from "../ipc";
import { nativeHost } from "../host/native";
import { connectMachine, type ConnectedMachine } from "./live";
import { THIS_MAC_ENV } from "./allWorkspaceTabs";
import { peekWorkspaceList } from "../remoteExecution/workspaceListCache";

export type ReconnectResult =
  | { kind: "attached"; alias: number; machineName: string }
  | { kind: "gone"; machineName: string }
  | { kind: "failed"; reason: string };

const workspaceIdOf = (env: string): string | null => (env.startsWith("remote:") ? env.slice("remote:".length) : null);

/** The machine's name for messages, from what is already known; never fetched. */
export function machineLabel(env: string): string {
  const id = workspaceIdOf(env);
  const known = id ? peekWorkspaceList()?.workspaces.find((w) => w.id === id)?.name : undefined;
  return known ?? "its workspace";
}

export interface ReconnectDeps {
  connect: (workspaceId: string) => Promise<Pick<ConnectedMachine, "env" | "name" | "host" | "readOnly" | "invoke">>;
  adopt: (machine: PtyMachine, realId: number) => number;
}

export async function remoteTabReconnect(
  env: string,
  sessionId: number,
  deps: ReconnectDeps = { connect: (id) => connectMachine(id), adopt: adoptMachineTerminal },
): Promise<ReconnectResult> {
  const workspaceId = workspaceIdOf(env);
  if (!workspaceId) return { kind: "failed", reason: "This terminal's machine is not a workspace." };
  let machine: Awaited<ReturnType<ReconnectDeps["connect"]>>;
  try {
    machine = await deps.connect(workspaceId);
  } catch (error) {
    return { kind: "failed", reason: `Could not connect: ${String((error as Error)?.message ?? error)}` };
  }
  try {
    const live = await machine.invoke<{ id: number }[]>("pty_stats");
    if (!live.some((s) => s.id === sessionId)) return { kind: "gone", machineName: machine.name };
  } catch (error) {
    return { kind: "failed", reason: `Could not read ${machine.name}'s terminals: ${String((error as Error)?.message ?? error)}` };
  }
  const alias = deps.adopt({ id: machine.env, host: machine.host, readOnly: machine.readOnly }, sessionId);
  return { kind: "attached", alias, machineName: machine.name };
}

export interface LocalReconnectDeps {
  invoke: <T>(command: string) => Promise<T>;
  adopt: (machine: PtyMachine, realId: number) => number;
}

/** The same for a terminal running on this Mac while a workspace is the
 *  window's own machine ("All workspaces"): this Mac is then one of the other
 *  machines, reached through the desktop host. */
export async function localTabReconnect(
  sessionId: number,
  deps: LocalReconnectDeps = { invoke: (command) => nativeHost.invoke(command), adopt: adoptMachineTerminal },
): Promise<ReconnectResult> {
  try {
    const live = await deps.invoke<{ id: number }[]>("pty_stats");
    if (!live.some((s) => s.id === sessionId)) return { kind: "gone", machineName: "This Mac" };
  } catch (error) {
    return { kind: "failed", reason: `Could not read this Mac's terminals: ${String((error as Error)?.message ?? error)}` };
  }
  const alias = deps.adopt({ id: THIS_MAC_ENV, host: nativeHost, readOnly: false }, sessionId);
  return { kind: "attached", alias, machineName: "This Mac" };
}

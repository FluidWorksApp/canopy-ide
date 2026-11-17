// The window's own view of the machines, for the machine channel.
//
// ops.ts carries out what an agent asks; this is where its machines come
// from in the running app: this computer, the workspace the window is on, and
// any other machine of the person's that can be opened beside it (cloud
// workspaces and their own canopy-host machines alike, machines/inventory.ts).
//
// It also keeps the one decision that is the person's: whether agents on one
// machine may drive another for a repository. Asked the first time, in the
// same dialog an agent's question uses, and remembered on this computer.
import { invoke as hostInvoke, isReadOnlyHost, isRemoteHost } from "../host";
import { nativeHost } from "../host/native";
import { activeWorkspace } from "../remoteExecution/workspace";
import { connectMachine, connectedMachines } from "../environments/live";
import type { RelaySource } from "./agentRelay";
import type { ChannelMachine } from "./channel";
import { reachableMachines, refreshMachines } from "./inventory";
import { runMachineOp, THIS_MAC, type ConsentRequest, type KnownMachine, type MachineDirectory } from "./ops";

export const THIS_MAC_NAME = "This Mac";

function activeMachine() {
  const connection = isRemoteHost() ? activeWorkspace()?.connection : undefined;
  return connection ? { workspaceId: connection.workspaceId, workspaceName: connection.workspaceName, endpoint: connection.endpoint } : null;
}

/** Every machine this window can reach, this computer first. */
export const windowDirectory: MachineDirectory = {
  async list(): Promise<KnownMachine[]> {
    const { machines } = await refreshMachines(activeMachine());
    const reachable = new Set(reachableMachines(machines).map((m) => m.id));
    return [
      { id: THIS_MAC, name: THIS_MAC_NAME, kind: "this-mac", reachable: true },
      ...machines.map((m): KnownMachine => ({ id: m.id, name: m.name, kind: m.kind, reachable: reachable.has(m.id) })),
    ];
  },
  async open(id: string): Promise<ChannelMachine> {
    if (id === THIS_MAC) {
      return { id, name: THIS_MAC_NAME, desktop: true, invoke: ((command, args) => nativeHost.invoke(command, args)) as ChannelMachine["invoke"] };
    }
    const active = activeMachine();
    if (active?.workspaceId === id) {
      // The window's own workspace: its connection is already open.
      return { id, name: active.workspaceName || "This workspace", desktop: false, readOnly: isReadOnlyHost(), invoke: hostInvoke as ChannelMachine["invoke"] };
    }
    const machine = await connectMachine(id);
    return { id, name: machine.name, desktop: false, readOnly: machine.readOnly, invoke: machine.invoke as ChannelMachine["invoke"] };
  },
};

// ---- consent ---------------------------------------------------------------

const CONSENT_KEY = "canopy.machineChannel.consent.v1";
export const ALLOW = "Allow";
export const DECLINE = "Not now";

const consentId = (request: ConsentRequest): string => `${request.repository.toLowerCase()}|${request.from.id}>${request.to.id}`;

function readConsent(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONSENT_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function hasConsent(request: ConsentRequest): boolean {
  return typeof readConsent()[consentId(request)] === "number";
}

export function grantConsent(request: ConsentRequest, now = Date.now()): void {
  const store = readConsent();
  store[consentId(request)] = now;
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify(store));
  } catch {
    /* Not remembered: the person is asked again next time. */
  }
}

/** Forget every answer: agents ask again before driving another machine. */
export function forgetConsent(): void {
  try {
    localStorage.removeItem(CONSENT_KEY);
  } catch {
    /* nothing to forget */
  }
}

export const consentQuestion = (request: ConsentRequest): string =>
  `Let agents on ${request.from.name} run commands and move files on ${request.to.name} for ${request.repository}?`;

/** One question at a time per pair: a workflow and a run arriving together
 *  must not put the same dialog up twice. */
const asking = new Map<string, Promise<boolean>>();

/** A remembered yes, or the person's answer now. Only a yes is remembered. */
export function consentThrough(ask: (question: string, options: string[]) => Promise<string>) {
  return (request: ConsentRequest): Promise<boolean> => {
    if (hasConsent(request)) return Promise.resolve(true);
    const id = consentId(request);
    let pending = asking.get(id);
    if (!pending) {
      pending = ask(consentQuestion(request), [ALLOW, DECLINE])
        .then((answer) => {
          const yes = answer.trim() === ALLOW;
          if (yes) grantConsent(request);
          return yes;
        })
        .catch(() => false)
        .finally(() => asking.delete(id));
      asking.set(id, pending);
    }
    return pending;
  };
}

/** An agent's machine op, from the machine it runs on and the folder it is in. */
export function handleMachineOp(
  request: { kind: string; args: Record<string, unknown> | null | undefined; originId: string; cwd: string },
  ask: (question: string, options: string[]) => Promise<string>,
  directory: MachineDirectory = windowDirectory,
): Promise<unknown> {
  return runMachineOp(request.kind, request.args ?? {}, {
    originId: request.originId,
    cwd: request.cwd,
    directory,
    consent: consentThrough(ask),
  });
}

/** The machines whose agents this window answers for: the workspace it is on
 *  and every machine connected beside it. A machine the person may only look
 *  at is left out; so is this computer, whose agents reach the window through
 *  the app itself. */
export async function relaySources(): Promise<RelaySource[]> {
  const out: RelaySource[] = [];
  const active = activeMachine();
  if (active && !isReadOnlyHost()) {
    out.push({ id: active.workspaceId, name: active.workspaceName || "This workspace", invoke: hostInvoke as RelaySource["invoke"] });
  }
  for (const machine of await connectedMachines()) {
    const id = machine.env.replace(/^remote:/, "");
    if (machine.readOnly || out.some((source) => source.id === id)) continue;
    out.push({ id, name: machine.name, invoke: machine.invoke as RelaySource["invoke"] });
  }
  return out;
}

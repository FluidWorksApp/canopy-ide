// Every machine this window can run work on besides this Mac, in one list.
//
// Two sources, and before this module every "other machine" feature read only
// the first:
//
//  - Cloud workspaces: the account's list (remoteExecution/workspaceListCache).
//    Their credential is issued by the account each time one is opened.
//  - Own machines: a `canopy-host` link the person pasted. The account has
//    never heard of them; the link's credential is saved on this Mac
//    (execution_remote_list marks them `own`).
//
// Teleport, Send to workspace, placement, the "All workspaces" tab strip and
// the machine tools all ask this module, and all open a machine through
// remoteExecution/temporaryWorkspace.ts, which asks `ownMachineSavedId` to
// decide whose credential to use. A person with no Canopy account but a
// machine of their own gets a list too: a failed account read is reported
// beside the machines that could be read, never instead of them.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  peekWorkspaceList,
  refreshWorkspaceList,
  restoreWorkspaceList,
  subscribeWorkspaceList,
} from "../remoteExecution/workspaceListCache";

/** A connection saved on this Mac, as `execution_remote_list` reports it. */
export interface SavedMachine {
  /** `<endpoint>/<workspaceId>`: what its credential is stored under. */
  id: string;
  endpoint: string;
  workspaceId?: string;
  workspaceName: string;
  /** Connected from a canopy-host link, so the account does not list it. */
  own?: boolean;
}

/** What this module needs of an account workspace. */
export interface CloudWorkspace {
  id: string;
  name: string;
  state: string;
  access?: { canConnect?: boolean };
  cpu_max?: number;
  memory_max_mib?: number;
}

export interface Machine {
  /** The workspace id: what placement targets, "remote:<id>" environments and
   *  probes key a machine by. */
  id: string;
  name: string;
  kind: "cloud" | "own";
  /** A cloud workspace's lifecycle state. An own machine is "ready": whether it
   *  answers is learned by connecting, and nothing here wakes or bills it. */
  state: string;
  access?: { canConnect?: boolean };
  cpu_max?: number;
  memory_max_mib?: number;
  /** Own machines: the saved connection holding the credential. */
  savedId?: string;
  /** Own machines: the address, for telling two apart. */
  endpoint?: string;
}

/** The machine this window is attached to, when it is not this Mac. */
export interface ActiveMachine {
  workspaceId: string;
  workspaceName?: string;
  endpoint?: string;
}

const savedWorkspaceId = (saved: SavedMachine): string =>
  saved.workspaceId || saved.id.slice(saved.id.lastIndexOf("/") + 1);

const isCloudEndpoint = (endpoint: string | undefined, workspaceId: string): boolean =>
  endpoint === `https://${workspaceId}.workspaces.canopyide.dev`;

/** One list from both sources. A cloud workspace wins an id it shares with a
 *  saved connection (that connection is the same workspace, opened before); two
 *  own machines with one id keep the first, because everything downstream keys
 *  by that id and could not tell them apart. `active` is added when neither
 *  source names it, so the machine a window is on is always in its own list. */
export function mergeMachines(
  cloud: readonly CloudWorkspace[],
  saved: readonly SavedMachine[],
  active?: ActiveMachine | null,
): Machine[] {
  const out = new Map<string, Machine>();
  for (const w of cloud) {
    out.set(w.id, {
      id: w.id,
      name: w.name,
      kind: "cloud",
      state: w.state,
      ...(w.access ? { access: w.access } : {}),
      ...(w.cpu_max != null ? { cpu_max: w.cpu_max } : {}),
      ...(w.memory_max_mib != null ? { memory_max_mib: w.memory_max_mib } : {}),
    });
  }
  for (const s of saved) {
    if (s.own !== true) continue;
    const id = savedWorkspaceId(s);
    if (!id || out.has(id) || isCloudEndpoint(s.endpoint, id)) continue;
    out.set(id, { id, name: s.workspaceName || id, kind: "own", state: "ready", savedId: s.id, endpoint: s.endpoint });
  }
  if (active?.workspaceId && !out.has(active.workspaceId)) {
    out.set(active.workspaceId, {
      id: active.workspaceId,
      name: active.workspaceName || "This workspace",
      kind: isCloudEndpoint(active.endpoint, active.workspaceId) ? "cloud" : "own",
      state: "ready",
      ...(active.endpoint ? { endpoint: active.endpoint } : {}),
    });
  }
  return [...out.values()];
}

/** Machines work can be sent to or started on: ready, and connectable. */
export const reachableMachines = <W extends { state: string; access?: { canConnect?: boolean } }>(
  machines: readonly W[],
): W[] => machines.filter((m) => m.state === "ready" && m.access?.canConnect !== false);

// ---- the saved list, read from this Mac's credential store ----------------

/** Reading the store can wait on a keyring; do not ask more often than this. */
const SAVED_TTL_MS = 15_000;
let saved: { at: number; machines: SavedMachine[] } | null = null;
let savedPending: Promise<SavedMachine[]> | undefined;
let savedEpoch = 0;
const listeners = new Set<(machines: Machine[]) => void>();

export interface InventoryDeps {
  savedList: () => Promise<SavedMachine[]>;
  now: () => number;
}

const defaultDeps: InventoryDeps = {
  savedList: () => tauriInvoke<SavedMachine[]>("execution_remote_list"),
  now: () => Date.now(),
};

/** The saved connections, cached briefly. A failed read keeps the last answer. */
export function savedMachines(force = false, deps: InventoryDeps = defaultDeps): Promise<SavedMachine[]> {
  if (!force && saved && deps.now() - saved.at < SAVED_TTL_MS) return Promise.resolve(saved.machines);
  if (savedPending) return savedPending;
  const epoch = savedEpoch;
  const run = deps
    .savedList()
    .then((list) => {
      const machines = Array.isArray(list) ? list.filter((s) => s && typeof s.id === "string" && typeof s.endpoint === "string") : [];
      if (epoch === savedEpoch) {
        saved = { at: deps.now(), machines };
        notify();
      }
      return machines;
    })
    .catch(() => saved?.machines ?? [])
    .finally(() => {
      if (savedPending === run) savedPending = undefined;
    });
  savedPending = run;
  return run;
}

/** Forget what was read: a machine was added or removed. */
export function invalidateSavedMachines(): void {
  savedEpoch++;
  saved = null;
  savedPending = undefined;
}

function notify(): void {
  if (!listeners.size) return;
  const machines = peekMachines();
  for (const listener of listeners) {
    try {
      listener(machines);
    } catch {
      /* One subscriber never blocks the list. */
    }
  }
}

/** What is known now, without asking anything. */
export function peekMachines(active?: ActiveMachine | null): Machine[] {
  return mergeMachines(peekWorkspaceList()?.workspaces ?? [], saved?.machines ?? [], active);
}

export interface MachineList {
  machines: Machine[];
  /** Why the account's cloud workspaces could not be read, when they could
   *  not; `machines` still holds what could (the last known list, own machines). */
  failure?: string;
}

/** Read both sources again. Never rejects: the account being unreachable, or
 *  nobody being signed in, still leaves the person's own machines. */
export async function refreshMachines(active?: ActiveMachine | null, deps: InventoryDeps = defaultDeps): Promise<MachineList> {
  const [cloud, own] = await Promise.allSettled([refreshWorkspaceList(), savedMachines(true, deps)]);
  const workspaces = cloud.status === "fulfilled" ? cloud.value.workspaces : (peekWorkspaceList()?.workspaces ?? []);
  const machines = mergeMachines(workspaces, own.status === "fulfilled" ? own.value : (saved?.machines ?? []), active);
  if (cloud.status === "fulfilled") return { machines };
  return { machines, failure: String((cloud.reason as { message?: string })?.message ?? cloud.reason) };
}

/** The cached lists, restored from the last session where there is one. */
export async function restoreMachines(active?: ActiveMachine | null, deps: InventoryDeps = defaultDeps): Promise<Machine[]> {
  await Promise.allSettled([restoreWorkspaceList(), savedMachines(false, deps)]);
  return peekMachines(active);
}

/** Called with the merged list whenever either source changes. */
export function subscribeMachines(listener: (machines: Machine[]) => void): () => void {
  listeners.add(listener);
  const off = subscribeWorkspaceList(() => listener(peekMachines()));
  return () => {
    listeners.delete(listener);
    off();
  };
}

/** The saved connection to open `workspaceId` with, when it is the person's own
 *  machine; null for a cloud workspace (the account issues its credential). */
export async function ownMachineSavedId(workspaceId: string, deps: InventoryDeps = defaultDeps): Promise<string | null> {
  if (peekWorkspaceList()?.workspaces.some((w) => w.id === workspaceId)) return null;
  const find = (list: readonly SavedMachine[]) =>
    mergeMachines([], list).find((m) => m.id === workspaceId && m.kind === "own")?.savedId ?? null;
  return find(await savedMachines(false, deps));
}

/** The machine's name for a message, from what is already known. */
export function machineName(workspaceId: string): string | undefined {
  return peekMachines().find((m) => m.id === workspaceId)?.name;
}

if (typeof window !== "undefined") {
  window.addEventListener("canopy:machines-changed", () => {
    invalidateSavedMachines();
    void savedMachines(true);
  });
}

// Reads the real world into the pure placement types. Everything goes through
// the app's existing seams; the host is a global singleton (src/host), so
// only the ACTIVE host's projects and terminals are readable. Other remotes
// contribute their lifecycle state and size from the workspace list.
import * as ipc from "../ipc";
import { isRemoteHost } from "../host";
import { loadWorkspace } from "../projects";
import { activeWorkspace } from "../remoteExecution/workspace";
import { probeSessions, runningSessions } from "../remoteExecution/workspaceProbe";
import { refreshMachines } from "../machines/inventory";
import { localRemoteJobs } from "../meshJobs";
import { collectResources, type ResourceSources } from "./resources";
import { canonicalProjects, type ProjectLike } from "./identity";
import { buildUnifiedRows, type UnifiedInput, type UnifiedRow } from "./unified";
import { sameTarget, type DisplayTarget, type ResourceSnapshot, type Target } from "./types";

const LOCAL_CAPACITY = 6;

const failureMessage = (source: string, error: unknown) =>
  `Could not read ${source}: ${String((error as { message?: string })?.message ?? error)}`;

/** The machine this window is attached to, when it is not this Mac. */
function activeMachine() {
  const connection = isRemoteHost() ? activeWorkspace()?.connection : undefined;
  return connection
    ? { workspaceId: connection.workspaceId, workspaceName: connection.workspaceName, endpoint: connection.endpoint }
    : null;
}

/** Cloud workspaces and the person's own machines (machines/inventory.ts). The
 *  machine a window is on is always in the list: it is connected, so it is a
 *  place to launch even when no source names it. A failed account read keeps
 *  whatever could be read and is reported beside it. */
async function discoverWorkspaces() {
  const { machines, failure } = await refreshMachines(activeMachine());
  return {
    remoteWorkspaces: machines,
    failure: failure ? failureMessage("connected workspaces", failure) : null,
  };
}

async function discoverInventory() {
  const result = await discoverWorkspaces();
  return { remoteWorkspaces: result.remoteWorkspaces, failures: result.failure ? [result.failure] : [] };
}

async function workspaces() {
  return (await discoverWorkspaces()).remoteWorkspaces;
}

const agentStats = async () => (await ipc.ptyStats()).filter((s) => s.agent_hint);

export function realSources(): ResourceSources {
  return {
    now: () => Date.now(),
    localActiveAgents: async () => isRemoteHost() ? "unknown" : (await agentStats()).length,
    localMemory: async () => {
      if (isRemoteHost()) return null;
      const m = await ipc.memoryInfo();
      return m ? { total_bytes: m.total_bytes, available_bytes: m.available_bytes } : null;
    },
    localCapacity: LOCAL_CAPACITY,
    remoteWorkspaces: workspaces,
    // The active host's terminals are counted directly; any other ready workspace
    // is read through the account (workspaceProbe.ts).
    remoteActiveAgents: async (id) => {
      if (isRemoteHost() && activeWorkspace()?.connection.workspaceId === id) return (await agentStats()).length;
      // Any other ready workspace is asked directly. Failure is "unknown", never
      // "idle": an unreachable workspace must not look free to the balancer.
      try {
        return { sessions: runningSessions(await probeSessions(id)) };
      } catch {
        return "unknown";
      }
    },
  };
}

export interface Gathered {
  rows: UnifiedRow[];
  resources: ResourceSnapshot[];
  /** Concrete choices shown anywhere a person selects a machine. */
  targets: DisplayTarget[];
  /** Inventory reads that failed. Launches fail closed while these are present. */
  discoveryFailures: string[];
  /** Plain-language notes on what could not be read. */
  notes: string[];
}

export interface TargetInventory {
  /** Lightweight picker choices. No machine shell is opened to build these. */
  targets: DisplayTarget[];
  /** Inventory reads that failed. Callers must not treat these as an empty list. */
  discoveryFailures: string[];
}

export function displayTargets(
  resources: ResourceSnapshot[],
  remoteWorkspaces: { id: string; name: string }[],
): DisplayTarget[] {
  const online = (target: Target) =>
    resources.find((resource) => sameTarget(resource.target, target))?.online ?? false;
  const local: Target = { kind: "local" };
  return [
    { target: local, name: "This Mac", online: online(local) },
    ...remoteWorkspaces.map(({ id, name }) => {
      const target: Target = { kind: "remote", workspaceId: id };
      return { target, name, online: online(target) };
    }),
  ];
}

export async function gatherTargetInventory(): Promise<TargetInventory> {
  const { remoteWorkspaces, failures } = await discoverInventory();
  return {
    targets: [
      { target: { kind: "local" }, name: "This Mac", online: true },
      ...remoteWorkspaces.map((workspace) => ({
        target: { kind: "remote" as const, workspaceId: workspace.id },
        name: workspace.name,
        online: workspace.state === "ready",
      })),
    ],
    discoveryFailures: failures,
  };
}

export function projectAvailability(
  rows: UnifiedRow[],
  project: { id: string; name: string },
): Target[] {
  return rows
    .filter((row) =>
      row.kind === "project" &&
      !row.needsSetup &&
      row.projectId === project.id,
    )
    .map((row) => row.target);
}

export async function gatherUnified(): Promise<Gathered> {
  const inventory = await discoverInventory();
  const notes: string[] = [...inventory.failures];
  const list = inventory.remoteWorkspaces;
  const sources = realSources();
  sources.remoteWorkspaces = async () => list;
  const [resources, ws, stats] = await Promise.all([
    collectResources(sources),
    loadWorkspace().catch(() => null),
    agentStats().catch(() => []),
  ]);
  // The workspace's projects go by the Mac's ids where the mirror made them
  // (placement/identity.ts), so a mirrored project counts as set up there. This
  // Mac's own store has no such links and is unchanged.
  const projects = canonicalProjects((ws?.projects ?? []) as ProjectLike[]);
  const agents = stats.map((s) => ({
    id: String(s.id),
    name: s.name ?? s.title,
    project: (ws?.projects ?? []).find((p) => p.components.some((c) => c.path && s.cwd.startsWith(c.path)))?.name,
  }));

  const onRemote = isRemoteHost() ? activeWorkspace()?.connection.workspaceId : undefined;
  // Other ready workspaces: their running sessions, read through the account.
  // The listing is cached by the load probe just above, so this is not a second
  // round trip. An unreachable one is named rather than shown as empty.
  const sessionsByWorkspace = new Map<string, { id: string; title: string }[]>();
  await Promise.all(
    list
      .filter((w) => w.id !== onRemote && w.state === "ready")
      .map(async (w) => {
        try {
          const running = (await probeSessions(w.id)).filter((x) => x.exitCode == null);
          sessionsByWorkspace.set(w.id, running.map((x) => ({ id: String(x.id), title: x.title || `Session ${x.id}` })));
        } catch {
          notes.push(`Could not read ${w.name}'s sessions.`);
        }
      }),
  );
  const input: UnifiedInput = {
    local: onRemote ? { projects: [], agents: [] } : { projects, agents },
    remotes: list.map((w) => ({
      workspaceId: w.id,
      name: w.name,
      state: w.state,
      ...(w.id === onRemote ? { projects, agents } : {}),
      ...(sessionsByWorkspace.has(w.id) ? { sessions: sessionsByWorkspace.get(w.id) } : {}),
    })),
    jobs: localRemoteJobs()
      .load()
      .map((j) => ({ jobId: j.jobId, title: j.title, workspace: j.workspace, target: j.target, workspaceId: list.find((w) => w.name === j.workspace)?.id })),
  };
  if (list.some((w) => w.id !== onRemote)) notes.push("Projects on workspaces other than the active one are not listed until you switch to them.");
  if (onRemote) notes.push("This Mac's projects are not readable while a remote workspace is active.");

  return {
    rows: buildUnifiedRows(input),
    resources,
    targets: displayTargets(resources, list),
    discoveryFailures: inventory.failures,
    notes,
  };
}

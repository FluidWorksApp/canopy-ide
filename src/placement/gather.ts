// Reads the real world into the pure placement types. Everything goes through
// the app's existing seams; the host is a global singleton (src/host), so
// only the ACTIVE host's projects and terminals are readable. Other remotes
// contribute their lifecycle state and size from the workspace list, and T3
// machines are read through their own short-lived RPC clients.
import * as ipc from "../ipc";
import { isRemoteHost } from "../host";
import { loadWorkspace } from "../projects";
import { listT3Machines, connectT3Machine } from "../t3connect/api";
import { listShell } from "../t3connect/methods";
import { activeWorkspace } from "../remoteExecution/workspace";
import { peekWorkspaceList, refreshWorkspaceList } from "../remoteExecution/workspaceListCache";
import { localRemoteJobs } from "../meshJobs";
import { collectResources, type ResourceSources } from "./resources";
import { buildUnifiedRows, type UnifiedInput, type UnifiedRow } from "./unified";
import { sameTarget, type DisplayTarget, type ResourceSnapshot, type Target } from "./types";

const LOCAL_CAPACITY = 6;

async function workspaces() {
  const cached = peekWorkspaceList();
  try {
    return (await refreshWorkspaceList()).workspaces;
  } catch {
    return cached?.workspaces ?? [];
  }
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
    // Only the active host's terminals can be counted; others are reported as
    // unknown so balance does not mistake them for idle.
    remoteActiveAgents: async (id) =>
      isRemoteHost() && activeWorkspace()?.connection.workspaceId === id ? (await agentStats()).length : "unknown",
    t3Machines: listT3Machines,
    t3ActiveAgents: async (id) => {
      const rpc = await connectT3Machine(id);
      try {
        const shell = await listShell(rpc);
        return shell.threads.filter((thread) => thread.status === "running").length;
      } finally {
        rpc.close();
      }
    },
  };
}

export interface Gathered {
  rows: UnifiedRow[];
  resources: ResourceSnapshot[];
  /** Concrete choices shown anywhere a person selects a machine. */
  targets: DisplayTarget[];
  /** Plain-language notes on what could not be read. */
  notes: string[];
}

export function displayTargets(
  resources: ResourceSnapshot[],
  remoteWorkspaces: { id: string; name: string }[],
  t3Machines: { id: string; label: string }[],
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
    ...t3Machines.map(({ id, label }) => {
      const target: Target = { kind: "t3", machineId: id };
      return { target, name: label, online: online(target) };
    }),
  ];
}

export async function gatherUnified(): Promise<Gathered> {
  const notes: string[] = [];
  const [resources, list, machines, ws, stats] = await Promise.all([
    collectResources(realSources()),
    workspaces().catch(() => []),
    listT3Machines().catch(() => []),
    loadWorkspace().catch(() => null),
    agentStats().catch(() => []),
  ]);
  const projects = (ws?.projects ?? []).map((p) => ({ id: p.id, name: p.name }));
  const agents = stats.map((s) => ({
    id: String(s.id),
    name: s.name ?? s.title,
    project: (ws?.projects ?? []).find((p) => p.components.some((c) => c.path && s.cwd.startsWith(c.path)))?.name,
  }));

  const onRemote = isRemoteHost() ? activeWorkspace()?.connection.workspaceId : undefined;
  const input: UnifiedInput = {
    local: onRemote ? { projects: [], agents: [] } : { projects, agents },
    remotes: list.map((w) => ({
      workspaceId: w.id,
      name: w.name,
      state: w.state,
      ...(w.id === onRemote ? { projects, agents } : {}),
    })),
    t3: [],
    jobs: localRemoteJobs()
      .load()
      .map((j) => ({ jobId: j.jobId, title: j.title, workspace: j.workspace, target: j.target, workspaceId: list.find((w) => w.name === j.workspace)?.id })),
  };
  if (list.some((w) => w.id !== onRemote)) notes.push("Projects on workspaces other than the active one are not listed until you switch to them.");
  if (onRemote) notes.push("This Mac's projects are not readable while a remote workspace is active.");

  await Promise.all(
    machines.map(async (m) => {
      try {
        const rpc = await connectT3Machine(m.id);
        try {
          const shell = await listShell(rpc);
          input.t3.push({
            machineId: m.id,
            label: m.label,
            projects: shell.projects.map((p) => ({ id: p.id, title: p.title })),
            threads: shell.threads.map((t) => ({ id: t.id, name: t.title ?? t.id, project: t.projectId, status: t.status, branch: t.branch ?? undefined })),
          });
        } finally {
          rpc.close();
        }
      } catch {
        notes.push(`Could not read ${m.label}.`);
      }
    }),
  );
  return {
    rows: buildUnifiedRows(input),
    resources,
    targets: displayTargets(resources, list, machines),
    notes,
  };
}

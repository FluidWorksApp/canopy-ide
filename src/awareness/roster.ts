// What each live agent is called and says it is doing, across every open
// project — the same roster ProjectView already publishes to the context
// bridge for canopy_agents (name, canopy_name_task title/description), kept
// here too so the awareness engine, which runs once for the whole window, can
// name the agents it writes to and about. Plus, for the team board, a way to
// ask who is running in this account's cloud workspaces (meshJobs.targets).

export interface RosterEntry {
  ptyId: number;
  name: string;
  /** Agent registry id. */
  agent: string | null;
  title: string | null;
  description: string | null;
}

const byProject = new Map<string, RosterEntry[]>();
const listeners = new Set<() => void>();

/** ProjectView calls this whenever it publishes its context snapshot. */
export function publishAwarenessRoster(projectId: string, agents: RosterEntry[]): void {
  byProject.set(projectId, agents);
  for (const cb of listeners) cb();
}

export function forgetAwarenessRoster(projectId: string): void {
  if (byProject.delete(projectId)) for (const cb of listeners) cb();
}

export function rosterEntry(ptyId: number): RosterEntry | null {
  for (const list of byProject.values()) {
    const hit = list.find((a) => a.ptyId === ptyId);
    if (hit) return hit;
  }
  return null;
}

export function subscribeAwarenessRoster(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** A cloud workspace's live agents, as meshJobs.targets reports them. A
 *  current workspace service also says which repository each agent works in
 *  (its origin URL), its checkout, and the files it edited lately (from the
 *  host's view of its hook events), so awareness can tell it about changes. */
export interface CloudRoster {
  /** Control-plane workspace id. */
  id?: string;
  name: string;
  online: boolean;
  agents:
    | {
        ptyId: number;
        name: string | null;
        agent: string | null;
        task: string | null;
        repo?: string | null;
        root?: string | null;
        /** Repo-relative, newest first; `ts` in ms. */
        files?: { path: string; ts: number }[];
      }[]
    | null;
  note?: string;
}

let cloudProvider: (() => Promise<CloudRoster[]>) | null = null;
let cloudSender: ((workspace: string, ptyId: number, text: string) => Promise<string>) | null = null;

/** App wires this to the mesh-jobs coordinator: a message to one agent in a
 *  cloud workspace, through that workspace's service. Resolves with its id. */
export function setCloudNoteSender(fn: ((workspace: string, ptyId: number, text: string) => Promise<string>) | null): void {
  cloudSender = fn;
}

export async function sendCloudNote(workspace: string, ptyId: number, text: string): Promise<string> {
  if (!cloudSender) throw new Error("Not signed in to a Canopy team, so cloud workspaces can't be reached.");
  return cloudSender(workspace, ptyId, text);
}

/** App wires this to the mesh-jobs coordinator once. */
export function setCloudRosterProvider(fn: (() => Promise<CloudRoster[]>) | null): void {
  cloudProvider = fn;
}

export async function cloudRosters(): Promise<CloudRoster[] | null> {
  if (!cloudProvider) return null;
  try {
    return await cloudProvider();
  } catch {
    return null;
  }
}

/** Tests only. */
export function resetAwarenessRosterForTests(): void {
  byProject.clear();
  listeners.clear();
  cloudProvider = null;
  cloudSender = null;
}

// Collects a ResourceSnapshot per target. Every source is injected and every
// failure marks that target offline rather than failing the whole sweep.
import type { ResourceSnapshot, Target } from "./types";

export interface RemoteWorkspaceInfo {
  id: string;
  state: string;
  cpu_max?: number;
  memory_max_mib?: number;
}

export interface ResourceSources {
  now: () => number;
  /** Running local agents/ptys. */
  localActiveAgents: () => Promise<number | "unknown">;
  localMemory: () => Promise<{ total_bytes: number; available_bytes: number } | null>;
  localCapacity: number;
  remoteWorkspaces: () => Promise<RemoteWorkspaceInfo[]>;
  /** "unknown" when this client cannot observe that workspace's load. A
   *  `{sessions}` answer counts every running session, agents and shells. */
  remoteActiveAgents: (workspaceId: string) => Promise<number | "unknown" | { sessions: number }>;
  t3Machines: () => Promise<{ id: string }[]>;
  t3ActiveAgents: (machineId: string) => Promise<number | "unknown">;
}

/** One agent per ~1.5 GiB of memory, at least 2. */
export const capacityFromMemory = (mib: number | undefined, fallback: number) =>
  mib && mib > 0 ? Math.max(2, Math.floor(mib / 1536)) : fallback;

const offline = (target: Target, now: number): ResourceSnapshot => ({
  target, online: false, activeAgents: 0, capacity: 0, lastSeen: now,
});

async function safe<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch {
    return null;
  }
}

export async function collectResources(src: ResourceSources, defaultRemoteCapacity = 4): Promise<ResourceSnapshot[]> {
  const now = src.now();
  const out: ResourceSnapshot[] = [];

  const local: Target = { kind: "local" };
  const [agents, mem] = await Promise.all([safe(src.localActiveAgents), safe(src.localMemory)]);
  out.push(
    agents === null
      ? offline(local, now)
      : {
          target: local,
          online: true,
          activeAgents: agents === "unknown" ? 0 : agents,
          ...(agents === "unknown" ? { loadUnknown: true } : {}),
          capacity: src.localCapacity,
          memFree: mem && mem.total_bytes > 0 ? mem.available_bytes / mem.total_bytes : undefined,
          lastSeen: now,
        },
  );

  const workspaces = (await safe(src.remoteWorkspaces)) ?? [];
  out.push(
    ...(await Promise.all(
      workspaces.map(async (w): Promise<ResourceSnapshot> => {
        const target: Target = { kind: "remote", workspaceId: w.id };
        if (w.state !== "ready") return offline(target, now);
        const n = await safe(() => src.remoteActiveAgents(w.id));
        if (n === null) return offline(target, now);
        const capacity = capacityFromMemory(w.memory_max_mib, defaultRemoteCapacity);
        if (typeof n === "object" && n !== null) return { target, online: true, activeAgents: n.sessions, loadBasis: "sessions", capacity, lastSeen: now };
        return { target, online: true, activeAgents: n === "unknown" ? 0 : n, ...(n === "unknown" ? { loadUnknown: true } : {}), capacity, lastSeen: now };
      }),
    )),
  );

  const machines = (await safe(src.t3Machines)) ?? [];
  out.push(
    ...(await Promise.all(
      machines.map(async (m): Promise<ResourceSnapshot> => {
        const target: Target = { kind: "t3", machineId: m.id };
        const n = await safe(() => src.t3ActiveAgents(m.id));
        if (n === null) return offline(target, now);
        return { target, online: true, activeAgents: n === "unknown" ? 0 : n, ...(n === "unknown" ? { loadUnknown: true } : {}), capacity: defaultRemoteCapacity, lastSeen: now };
      }),
    )),
  );
  return out;
}

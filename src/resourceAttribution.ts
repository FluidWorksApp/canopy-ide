// Who is using a shared cloud workspace's memory and CPU, and how much is left.
//
// Everyone's terminals in a workspace run as the same Linux user, so the
// container's own counters can't say whose they are. Each desktop records who
// started a terminal (`owner` in its terminal metadata) and the workspace
// reports every live terminal's working set and cores with that owner
// (workspace-metrics.mjs `sessions`). Here they are grouped by person: you,
// each teammate by name, and the workspace's own services (the desktop and
// VNC, browsers, the Canopy host) as whatever the terminals don't explain.
//
// "Free" is always the limit less the working set, never less memory.current:
// the page cache the kernel drops on demand is shown apart, as reclaimable.

import { peekTeamIdentity, teamIdentity } from "./teamIdentity";

export interface ResourceOwner {
  id: string;
  name: string;
}

export interface SessionUsage {
  id: number;
  memoryBytes: number;
  cpusUsed: number;
  kind?: "terminal" | "build";
  owner: ResourceOwner | null;
}

export interface PersonUsage {
  key: string;
  kind: "you" | "teammate" | "unknown" | "services";
  label: string;
  memoryBytes: number;
  cpusUsed: number | null;
  terminals: number;
}

const DEVICE_KEY = "canopy.resourceOwnerId";

/** This desktop's stable id when nobody is signed in, so "You" still holds
 *  across restarts without being anyone's account. */
function deviceOwnerId(): string {
  try {
    const known = localStorage.getItem(DEVICE_KEY);
    if (known) return known;
    const id = `device:${crypto.randomUUID()}`;
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return "device:unknown";
  }
}

/** Who "You" are for attribution: the signed-in Canopy account, else this
 *  desktop. */
export function selfOwnerId(): string {
  return peekTeamIdentity()?.id ?? deviceOwnerId();
}

/** The owner a new terminal records. Waits briefly for the signed-in identity
 *  on a cold start; a spawn never waits longer than `waitMs` for it. */
export async function terminalOwner(waitMs = 1000): Promise<ResourceOwner> {
  const me =
    peekTeamIdentity() ??
    (await Promise.race([
      teamIdentity(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs)),
    ]));
  return me ? { id: me.id, name: me.name } : { id: deviceOwnerId(), name: "Teammate" };
}

/** Group the workspace's terminals by person. Services are the workspace's
 *  working set less every terminal's (never below zero: terminal memory is
 *  measured per process tree and can double-count shared pages). */
export function attributeUsage(
  sessions: SessionUsage[],
  totals: { workingSetBytes: number; cpusUsed: number | null },
  selfId: string,
): PersonUsage[] {
  const people = new Map<string, PersonUsage>();
  for (const s of sessions) {
    const mine = s.owner?.id === selfId;
    const key = mine ? "you" : s.owner ? `person:${s.owner.id}` : "unknown";
    const row =
      people.get(key) ??
      ({
        key,
        kind: mine ? "you" : s.owner ? "teammate" : "unknown",
        label: mine ? "You" : s.owner ? s.owner.name : "Terminals from older versions",
        memoryBytes: 0,
        cpusUsed: 0,
        terminals: 0,
      } satisfies PersonUsage);
    row.memoryBytes += Math.max(0, s.memoryBytes || 0);
    row.cpusUsed = (row.cpusUsed ?? 0) + Math.max(0, s.cpusUsed || 0);
    row.terminals += 1;
    people.set(key, row);
  }
  const you = people.get("you") ?? {
    key: "you",
    kind: "you" as const,
    label: "You",
    memoryBytes: 0,
    cpusUsed: 0,
    terminals: 0,
  };
  people.delete("you");
  const unknown = people.get("unknown");
  people.delete("unknown");
  const teammates = [...people.values()].sort(
    (a, b) => b.memoryBytes - a.memoryBytes || a.label.localeCompare(b.label),
  );
  const rows = [you, ...teammates, ...(unknown ? [unknown] : [])];
  const termMem = rows.reduce((n, r) => n + r.memoryBytes, 0);
  const termCpu = rows.reduce((n, r) => n + (r.cpusUsed ?? 0), 0);
  rows.push({
    key: "services",
    kind: "services",
    label: "Workspace services",
    memoryBytes: Math.max(0, totals.workingSetBytes - termMem),
    cpusUsed: totals.cpusUsed == null ? null : Math.max(0, totals.cpusUsed - termCpu),
    terminals: 0,
  });
  return rows;
}

export type Availability = "ok" | "low" | "critical";

/** Memory is low under 15% of the limit free, critical under 7%. Without a
 *  limit there is nothing to run out of here. */
export function memoryAvailability(availableBytes: number | null | undefined, limitBytes: number | null | undefined): Availability {
  if (availableBytes == null || !limitBytes || !Number.isFinite(availableBytes)) return "ok";
  const free = availableBytes / limitBytes;
  return free < 0.07 ? "critical" : free < 0.15 ? "low" : "ok";
}

/** CPU free is short when under one core (a quarter of the allocation on a
 *  workspace smaller than four cores). One busy sample is a build step, not
 *  a shortage, so the chip only says so after CPU_LOW_SAMPLES in a row. */
export const CPU_LOW_SAMPLES = 5;
export function cpuShort(cpusAvailable: number | null | undefined, cpus: number | null | undefined): boolean {
  if (cpusAvailable == null || !cpus || !Number.isFinite(cpusAvailable)) return false;
  return cpusAvailable < Math.min(1, cpus / 4);
}
export function nextCpuStreak(streak: number, cpusAvailable: number | null | undefined, cpus: number | null | undefined): number {
  return cpuShort(cpusAvailable, cpus) ? Math.min(streak + 1, CPU_LOW_SAMPLES) : 0;
}

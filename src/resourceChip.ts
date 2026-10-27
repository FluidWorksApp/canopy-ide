// Wording and numbers for the status bar's resource chip: a shared cloud
// workspace's free memory and cores and your share, and the "free" framing
// on a local desktop. The popover is WorkspaceResources.tsx.
import type { AppStats } from "./ipc";
import { fixedNumber } from "./format";
import {
  attributeUsage,
  CPU_LOW_SAMPLES,
  memoryAvailability,
  type Availability,
  type PersonUsage,
} from "./resourceAttribution";

export const fmtBytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;

export const fmtCores = (cores: number) =>
  `${cores > 0 && cores < 0.05 ? "<0.1" : fixedNumber(cores, 1)} ${cores === 1 ? "core" : "cores"}`;

export const fmtAllocated = (cores: number) =>
  `${Number.isInteger(cores) ? cores : fixedNumber(cores, 1)} ${cores === 1 ? "core" : "cores"}`;

/** Class for a chip or popover number at this availability. */
export const availabilityClass = (level: Availability) =>
  level === "critical" ? "res-critical" : level === "low" ? "res-low" : undefined;

export interface ResourceChip {
  /** Pieces of the chip text, each with its own warning colour. */
  parts: { text: string; className?: string }[];
  title: string;
}

export type Workspace = NonNullable<AppStats["workspace"]>;

/** Whether this workspace reports availability (a host from this release). */
export const reportsAvailability = (ws: Workspace | undefined): ws is Workspace & { workingSetBytes: number } =>
  typeof ws?.workingSetBytes === "number";

export function peopleRows(ws: Workspace & { workingSetBytes: number }, selfId: string): PersonUsage[] | null {
  return ws.sessions
    ? attributeUsage(ws.sessions, { workingSetBytes: ws.workingSetBytes, cpusUsed: ws.cpusUsed ?? null }, selfId)
    : null;
}

/** Chip for a workspace that reports availability: your share and what's
 *  free, e.g. "You 2.4 GB · 20.3 GB free · 6.1 cores free". */
export function workspaceChip(ws: Workspace & { workingSetBytes: number }, selfId: string, cpuLowStreak: number): ResourceChip {
  const you = peopleRows(ws, selfId)?.find((r) => r.kind === "you");
  const memLevel = memoryAvailability(ws.availableBytes, ws.memoryLimitBytes);
  const cpuLow = cpuLowStreak >= CPU_LOW_SAMPLES;
  const parts: ResourceChip["parts"] = [];
  parts.push({ text: you ? `You ${fmtBytes(you.memoryBytes)}` : `${fmtBytes(ws.workingSetBytes)} in use` });
  if (ws.availableBytes != null) parts.push({ text: `${fmtBytes(ws.availableBytes)} free`, className: availabilityClass(memLevel) });
  if (ws.cpusAvailable != null) parts.push({ text: `${fmtCores(ws.cpusAvailable)} free`, className: cpuLow ? "res-low" : undefined });
  else if (ws.cpusUsed != null) parts.push({ text: `${fmtCores(ws.cpusUsed)} in use` });
  const mem =
    ws.availableBytes != null && ws.memoryLimitBytes
      ? `${fmtBytes(ws.availableBytes)} of ${fmtBytes(ws.memoryLimitBytes)} memory free`
      : `${fmtBytes(ws.workingSetBytes)} memory in use`;
  const cpu =
    ws.cpusAvailable != null && ws.cpus
      ? `${fmtCores(ws.cpusAvailable)} of ${fmtAllocated(ws.cpus)} free`
      : ws.cpusUsed != null
        ? `${fmtCores(ws.cpusUsed)} in use`
        : null;
  const title = [
    `Cloud workspace: ${mem}${cpu ? `; CPU ${cpu}` : ""}.`,
    you ? `Your terminals use ${fmtBytes(you.memoryBytes)} and ${fmtCores(you.cpusUsed ?? 0)}.` : "",
    ws.reclaimableBytes ? `${fmtBytes(ws.reclaimableBytes)} of cached files isn't counted as in use: it's freed automatically when needed.` : "",
    memLevel === "critical"
      ? "Memory is nearly full: agents and builds may be stopped."
      : memLevel === "low"
        ? "Memory is getting low."
        : "",
    cpuLow ? "CPU has been nearly fully used for a while, so things may run slowly." : "",
    "Click for who is using what.",
  ]
    .filter(Boolean)
    .join(" ");
  return { parts, title };
}

/** Local desktop chip: Canopy's own footprint, with this computer's free
 *  memory beside it. */
export function desktopFree(app: AppStats): { text: string; className?: string; title: string } | null {
  if (!app.system || !(app.system.totalBytes > 0)) return null;
  const level = memoryAvailability(app.system.availableBytes, app.system.totalBytes);
  return {
    text: `${fmtBytes(app.system.availableBytes)} free`,
    className: availabilityClass(level),
    title:
      `This computer has ${fmtBytes(app.system.availableBytes)} of ${fmtBytes(app.system.totalBytes)} memory free.` +
      (level === "critical" ? " Memory is nearly full." : level === "low" ? " Memory is getting low." : ""),
  };
}

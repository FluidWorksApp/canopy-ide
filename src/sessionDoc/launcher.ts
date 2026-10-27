// "Continue in a new agent": start a fresh agent, on any installed CLI, whose
// brief is a handoff packet.
//
// Starting an agent belongs to a ProjectView (tabs, worktrees, task history),
// and App already has the one function that routes a brief to the right
// project and waits for the launch to be confirmed — the companion's
// `startSession`. App registers it here once, so a session document or a chat
// card can use it without either knowing about App.

import * as ipc from "../ipc";
import { installedBrain } from "../brain";
import { AGENT_CLIS } from "../projects";

export interface LaunchRequest {
  /** Project name; optional when `dir` is given. */
  project?: string | null;
  dir?: string | null;
  prompt: string;
  label?: string | null;
  /** Agent registry id; empty = the project's default. */
  agent?: string | null;
}

export interface LaunchResult {
  started: boolean;
  note: string;
}

export interface LaunchProject {
  name: string;
  dirs: string[];
}

interface Launcher {
  start(req: LaunchRequest): Promise<{ started: boolean; note: string }>;
  projects(): LaunchProject[];
}

let launcher: Launcher | null = null;

/** App calls this once; returns the unregister. */
export function registerSessionLauncher(next: Launcher): () => void {
  launcher = next;
  return () => {
    if (launcher === next) launcher = null;
  };
}

export function launchProjects(): LaunchProject[] {
  try {
    return launcher?.projects() ?? [];
  } catch {
    return [];
  }
}

/** Start the agent and say plainly whether it started. Never throws. */
export async function launchAgent(req: LaunchRequest): Promise<LaunchResult> {
  if (!launcher) return { started: false, note: "Canopy isn't ready to start agents yet — try again in a moment." };
  try {
    const r = await launcher.start(req);
    return { started: r.started, note: r.note };
  } catch (e) {
    return { started: false, note: e instanceof Error ? e.message : String(e) };
  }
}

export interface InstalledAgent {
  id: string;
  name: string;
  brain: boolean;
}

/** The agent CLIs installed here, the brain first — the default successor,
 *  because it is the CLI the person already chose to trust with judgment. */
export async function installedAgents(): Promise<InstalledAgent[]> {
  const found = await ipc.whichCheck(AGENT_CLIS.map((c) => c.bin)).catch(() => ({}) as Record<string, boolean>);
  const has = (bin: string) => !!(found as Record<string, boolean>)[bin];
  const brain = installedBrain(has);
  return AGENT_CLIS.filter((c) => has(c.bin))
    .map((c) => ({ id: c.id, name: c.name, brain: c.id === brain?.id }))
    .sort((a, b) => Number(b.brain) - Number(a.brain));
}

/** Tests only. */
export function resetLauncherForTests(): void {
  launcher = null;
}

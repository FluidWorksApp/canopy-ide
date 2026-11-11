// "All workspaces": the strip shows this window's own tabs plus the live
// terminals of the connected workspaces, in one row. This is the decision of
// which of a machine's terminals still need a tab here; connecting and
// attaching are done by the caller through the same alias path as a launch.
import { aliasOf } from "./ptyRoute";

export interface MachineSession {
  /** The terminal's id on its own machine. */
  id: number;
  /** Where it was started, when the machine says. */
  cwd?: string;
  /** What it runs, when the machine says. */
  command?: string;
  /** Its title (the program or agent name), when the machine says. */
  title?: string;
}

/** Terminals of a machine as it lists them. Anything unreadable is dropped; a
 *  machine that answers nonsense contributes nothing. */
export function parseMachineSessions(rows: unknown): MachineSession[] {
  if (!Array.isArray(rows)) return [];
  const out: MachineSession[] = [];
  for (const row of rows) {
    const id = (row as { id?: unknown })?.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0) continue;
    const cwd = (row as { cwd?: unknown }).cwd;
    const command = (row as { command?: unknown }).command;
    const title = (row as { title?: unknown }).title;
    out.push({
      id,
      ...(typeof cwd === "string" && cwd ? { cwd } : {}),
      ...(typeof command === "string" && command ? { command } : {}),
      ...(typeof title === "string" && title ? { title } : {}),
    });
  }
  return out;
}

/** The sessions on `env` that have no tab here yet: neither a placeholder
 *  holding the id nor a live tab attached to it through an alias. */
export function sessionsNeedingTabs(
  env: string,
  sessions: readonly MachineSession[],
  tabs: readonly { type: string; machine?: string; ptyId?: number | null; reconnect?: { sessionId: number } }[],
): MachineSession[] {
  const held = new Set<number>();
  for (const tab of tabs) {
    if (tab.type !== "terminal" || tab.machine !== env) continue;
    if (tab.reconnect) held.add(tab.reconnect.sessionId);
  }
  return sessions.filter((session) => {
    if (held.has(session.id)) return false;
    const alias = aliasOf(env, session.id);
    return !(alias !== undefined && tabs.some((t) => t.type === "terminal" && t.ptyId === alias));
  });
}

/** The machine's short label for a tab: the workspace's own name. */
export const machineBadge = (name: string): string => name.trim().slice(0, 14) || "workspace";

/** The environment id of the desktop this window runs on, while a workspace is
 *  the window's own machine and the desktop therefore joins as one of the others. */
export const THIS_MAC_ENV = "local";

/** The running workspaces "All workspaces" should read terminals from: ready,
 *  connectable, and never the one that already is this window's own machine.
 *  That one's terminals are the window's primary tabs (no `machine`, plain ids),
 *  so reading it as a second machine would add every one of them again. */
export function workspacesToJoin<W extends { id: string; state?: string; access?: { canConnect?: boolean } }>(
  workspaces: readonly W[],
  activeWorkspaceId?: string,
): W[] {
  return workspaces.filter((w) => w.state === "ready" && w.access?.canConnect !== false && w.id !== activeWorkspaceId);
}

/** Whether a tab belongs in the project's remembered terminals (the Resume
 *  list). A remembered row carries only a folder and a command, so it can only
 *  be reopened on this window's own machine: a terminal shown from another
 *  machine, or only because "All workspaces" is on, would come back as a shell
 *  in a folder that exists somewhere else. */
export const rememberableTab = (tab: { viaAll?: boolean; machine?: string }): boolean => !tab.viaAll && !tab.machine;

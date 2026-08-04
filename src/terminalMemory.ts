// What was open in a project's terminals last time, so closing the app (or a
// project) doesn't erase the shape of the work.
//
// Agent *sessions* restore with their conversation (see restorable.ts); this
// is the other half — the plain shells, the dev servers, the run commands —
// which have no transcript to resume, only a directory and a command line.
// Kept in localStorage rather than the workspace file: it is a convenience
// record, not part of the project's definition, and a corrupt one should cost
// nothing.
import type { TerminalGroup } from "./terminalGroups";
import type { Restorable } from "./restorable";
import { resumeSessionId } from "./projects";
import { agentIdForCommand } from "./agentIdentity";

export interface RememberedTerminal {
  cwd: string;
  command?: string;
  title: string;
  icon?: string;
  /** It lived in the RUNS rail rather than the terminal strip. */
  run?: boolean;
  /** Runtime identity used to reconnect this terminal to a remembered split. */
  tabId?: string;
  paneGroup?: string;
  /** Exact conversation identity. Optional so pre-session memory remains valid. */
  sessionId?: string;
  /** Account that owns the session store. */
  profile?: string;
}

export interface TerminalResumeLeaf {
  key: string;
  remembered?: RememberedTerminal;
  restorable?: Restorable;
}

export interface TerminalResumeCard {
  key: string;
  group?: TerminalGroup;
  leaves: TerminalResumeLeaf[];
}

export interface RememberedTerminalState {
  terminals: RememberedTerminal[];
  terminalGroups: Record<string, TerminalGroup>;
}

const KEY = "canopy.terminals";

type StoredProject = RememberedTerminal[] | RememberedTerminalState;
type Store = Record<string, StoredProject>;

function read(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Store;
  } catch {
    return {};
  }
}

export function rememberTerminals(
  projectId: string,
  terminals: RememberedTerminal[],
  terminalGroups: Record<string, TerminalGroup> = {},
) {
  // Never record an empty set. Closing the last tab is exactly when this
  // memory becomes valuable — overwriting it at that moment would erase the
  // thing the user wants back.
  if (terminals.length === 0) return;
  const store = read();
  store[projectId] = {
    terminals: terminals.slice(0, 12),
    terminalGroups,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Storage full or unavailable — a lost convenience record is not worth
    // interrupting anyone over.
  }
}

export function rememberedTerminals(projectId: string): RememberedTerminal[] {
  return rememberedTerminalState(projectId).terminals;
}

export function rememberedTerminalState(projectId: string): RememberedTerminalState {
  const stored = read()[projectId];
  if (Array.isArray(stored)) return { terminals: stored, terminalGroups: {} };
  return stored ?? { terminals: [], terminalGroups: {} };
}

export function forgetTerminals(projectId: string) {
  const store = read();
  delete store[projectId];
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // ignore
  }
}

/** One empty-state choice per multiplex, with exact session-to-pane matching.
 * Old memory remains readable: resume commands already carry their session id;
 * bare legacy agent commands reopen fresh rather than guessing by cwd + agent. */
export function terminalResumeCards(
  terminals: RememberedTerminal[],
  groups: Record<string, TerminalGroup>,
  restorables: Restorable[],
): TerminalResumeCard[] {
  const available = new Map(restorables.map((r) => [r.digest.session_id, r]));
  const leaves: TerminalResumeLeaf[] = [];

  for (const terminal of terminals) {
    const agentId = agentIdForCommand(terminal.command);
    const sessionId = terminal.sessionId ?? resumeSessionId(terminal.command) ?? undefined;
    const restorable = sessionId ? available.get(sessionId) : undefined;
    if (restorable) available.delete(sessionId!);

    // A remembered, identified conversation that is absent from Restorable may
    // be live, user-closed, or unresumable. Never replay it as a fresh agent.
    if (agentId && sessionId && !restorable) continue;
    leaves.push({
      key: terminal.tabId ? `terminal:${terminal.tabId}` : `terminal:${leaves.length}`,
      remembered: terminal,
      restorable,
    });
  }

  for (const restorable of available.values()) {
    leaves.push({
      key: `session:${restorable.digest.session_id}`,
      restorable,
    });
  }

  const byOldId = new Map(
    leaves
      .filter((leaf) => leaf.remembered?.tabId)
      .map((leaf) => [leaf.remembered!.tabId!, leaf]),
  );
  const claimed = new Set<TerminalResumeLeaf>();
  const cards: TerminalResumeCard[] = [];
  for (const group of Object.values(groups)) {
    const members = leafIdsSafe(group.root)
      .map((id) => byOldId.get(id))
      .filter((leaf): leaf is TerminalResumeLeaf => Boolean(leaf))
      .filter((leaf) => leaf.remembered?.paneGroup === group.id);
    if (members.length < 2) continue;
    members.forEach((leaf) => claimed.add(leaf));
    cards.push({ key: `group:${group.id}`, group, leaves: members });
  }
  for (const leaf of leaves) {
    if (!claimed.has(leaf)) cards.push({ key: leaf.key, leaves: [leaf] });
  }
  return cards;
}

function leafIdsSafe(node: TerminalGroup["root"]): string[] {
  return node.type === "leaf"
    ? [node.tabId]
    : [...leafIdsSafe(node.first), ...leafIdsSafe(node.second)];
}

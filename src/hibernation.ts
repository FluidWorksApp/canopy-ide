// Putting a project to sleep, and waking it back up exactly as it was.
//
// Not to be confused with the agent-level hibernation Settings → Agents offers
// (`autoHibernate`), which reclaims one stale agent's terminal and leaves the
// rest of the project running. This is the whole project: every tab at once,
// explicitly, on a right-click.
//
// Hibernating is the space-saving middle ground between "leave it open" and
// "close it": everything the project had on screen — its tabs, its open files,
// its terminals and the agent conversations running in them — is written down,
// and everything it was holding is given back (PTYs, language servers, Monaco
// models, file watchers). Its tab stays where it was, so the project is still
// one click away, and that click offers the whole arrangement back.
//
// The snapshot lives in localStorage rather than the workspace file for the
// same reason terminalMemory does: it is a record of a session's shape, not
// part of the project's definition, and a corrupt one must cost nothing more
// than a project that opens empty. It is also the single source of truth for
// "is this project hibernating" — a marker held anywhere else would drift from
// the snapshot it describes, and a project claiming to be asleep with nothing
// to wake is the one state this feature cannot afford.
import type { SubTab, SideTab } from "./components/ProjectView/helpers";
import type * as ipc from "./ipc";
import type { ReviewPayload } from "./components/ReviewView";
import { AGENT_CLIS, restoreCommand, resumeSessionId } from "./projects";
import { agentIdForCommand } from "./agentIdentity";

/** A terminal as it will be brought back: a directory, a command line, and —
 *  when it was hosting an agent — the conversation to resume rather than a
 *  fresh start of the same CLI. */
export interface TerminalSnapshot {
  kind: "terminal";
  cwd: string;
  command?: string;
  title: string;
  icon?: string;
  run?: boolean;
  /** Registry id of the CLI running in it, when it was an agent. */
  agentId?: string;
  /** The conversation that was live in it, for `<cli> --resume <id>`. */
  sessionId?: string;
  /** The account it ran under: the resume command's session id only exists in
   *  that account's store. */
  profile?: string;
  /** A headless PTY from the remote portal. It outlives hibernation (we never
   *  spawned it, so we never kill it) — reattached on wake if still alive. */
  attachId?: number;
}

export type SnapshotTab =
  | TerminalSnapshot
  | { kind: "file"; path: string; view: "preview" | "source" | "diff" }
  | { kind: "preview"; url: string }
  | { kind: "pr"; repo: string; pr: ipc.PrInfo }
  | { kind: "ticket"; ticket: ipc.TicketInfo; source: string }
  | { kind: "commit"; repo: string; hash: string; short: string; subject: string }
  | { kind: "branch"; repo: string; branch: ipc.BranchWork }
  | { kind: "review"; review: ReviewPayload }
  | {
      kind: "agent";
      repo: string | null;
      agent: string;
      cwd: string;
      sessionId?: string;
      digest?: ipc.SessionDigest;
    }
  | { kind: "agents" }
  | { kind: "task-history" }
  | { kind: "instructions"; focus?: string }
  | { kind: "mcp"; server: ipc.McpServer }
  | { kind: "chat"; peer: string | null; name: string };

export interface ProjectSnapshot {
  version: 1;
  /** When the project was put to sleep. */
  at: number;
  tabs: SnapshotTab[];
  /** Index into `tabs` of the tab that was in front; null when none was. */
  activeIndex: number | null;
  sideTab: SideTab;
  /** The side panel was pinned out (the Cmd+B latch), rather than merely being
   *  hovered when the project went to sleep. */
  sidePinned: boolean;
  /** The worktree the project's file surface was pointed at, if any. */
  worktree: { repo: string; path: string; branch: string } | null;
}

const VERSION = 1;

// ---------- building one ----------

/**
 * Freeze a project's tabs.
 *
 * `sessionFor` maps a live PTY to the agent conversation running in it (see
 * liveSessionByPty in ProjectView) — the whole reason an agent comes back
 * mid-thought rather than at a fresh prompt.
 *
 * Three kinds of tab are deliberately left behind:
 *   - micro-task terminals, which are one-shot; "restoring" one would re-run a
 *     task that already finished (the same rule terminalMemory follows);
 *   - run tabs whose command has already exited, which are output to read, not
 *     work to resume — waking would re-run the build;
 *   - collab and shared-project tabs, which are someone else's live session.
 *     There is nothing on this machine to restore them from.
 */
export function snapshotTabs(
  tabs: SubTab[],
  sessionFor: (ptyId: number) => string | undefined = () => undefined,
): SnapshotTab[] {
  const out: SnapshotTab[] = [];
  for (const t of tabs) {
    switch (t.type) {
      case "terminal": {
        if (t.micro) break;
        if (t.run && t.exited) break;
        const command = t.command;
        const agentId = agentIdForCommand(command) ?? undefined;
        // The live conversation if the hook reported one, else the id the
        // command itself names (a terminal started as a resume knows its own
        // session even before the agent has said anything).
        const sessionId =
          (t.ptyId != null ? sessionFor(t.ptyId) : undefined) ??
          resumeSessionId(command) ??
          undefined;
        out.push({
          kind: "terminal",
          cwd: t.cwd,
          command,
          title: t.customTitle ?? t.title,
          icon: t.icon,
          run: t.run,
          agentId,
          sessionId: agentId ? sessionId : undefined,
          profile: t.profile,
          attachId: t.attachId,
        });
        break;
      }
      case "file":
        out.push({ kind: "file", path: t.file.path, view: t.file.view });
        break;
      case "preview":
        out.push({ kind: "preview", url: t.url });
        break;
      case "pr":
        out.push({ kind: "pr", repo: t.repo, pr: t.pr });
        break;
      case "ticket":
        out.push({ kind: "ticket", ticket: t.ticket, source: t.source });
        break;
      case "commit":
        out.push({
          kind: "commit",
          repo: t.repo,
          hash: t.hash,
          short: t.short,
          subject: t.subject,
        });
        break;
      case "branch":
        out.push({ kind: "branch", repo: t.repo, branch: t.branch });
        break;
      case "review":
        out.push({ kind: "review", review: t.review });
        break;
      case "agent":
        out.push({
          kind: "agent",
          repo: t.repo,
          agent: t.agent,
          cwd: t.cwd,
          sessionId: t.sessionId,
          digest: t.digest,
        });
        break;
      case "agents":
        out.push({ kind: "agents" });
        break;
      case "task-history":
        out.push({ kind: "task-history" });
        break;
      case "instructions":
        out.push({ kind: "instructions", focus: t.focus });
        break;
      // The row is config, not a live connection: safe to store, and it lets
      // the tab draw its header on wake before the server has restarted.
      case "mcp":
        out.push({ kind: "mcp", server: t.server });
        break;
      case "chat":
        out.push({ kind: "chat", peer: t.peer, name: t.name });
        break;
      // collab / shared-project: live sessions owned by someone else.
      default:
        break;
    }
  }
  return out;
}

/** Build the whole snapshot. `activeTabId` is resolved against the tabs that
 *  actually made it in, so a dropped tab can never leave the wake pointing at
 *  the wrong one. */
export function buildSnapshot(opts: {
  tabs: SubTab[];
  activeTabId: string | null;
  sideTab: SideTab;
  sidePinned: boolean;
  worktree: { repo: string; path: string; branch: string } | null;
  sessionFor?: (ptyId: number) => string | undefined;
  now?: number;
}): ProjectSnapshot {
  const kept = opts.tabs.filter((t) => snapshotTabs([t], opts.sessionFor).length > 0);
  const activeIndex = kept.findIndex((t) => t.id === opts.activeTabId);
  return {
    version: VERSION,
    at: opts.now ?? Date.now(),
    tabs: snapshotTabs(kept, opts.sessionFor),
    activeIndex: activeIndex < 0 ? null : activeIndex,
    sideTab: opts.sideTab,
    sidePinned: opts.sidePinned,
    worktree: opts.worktree,
  };
}

// ---------- describing one ----------

export interface SnapshotSummary {
  /** Agent conversations that will be resumed. */
  agents: number;
  /** Plain shells and run commands. */
  terminals: number;
  files: number;
  /** Everything else with a tab: PRs, issues, diffs, previews, chats. */
  views: number;
  total: number;
}

export function snapshotSummary(snap: ProjectSnapshot | null): SnapshotSummary {
  const empty = { agents: 0, terminals: 0, files: 0, views: 0, total: 0 };
  if (!snap) return empty;
  const s = { ...empty, total: snap.tabs.length };
  for (const t of snap.tabs) {
    if (t.kind === "terminal") {
      if (t.agentId) s.agents++;
      else s.terminals++;
    } else if (t.kind === "file") {
      s.files++;
    } else {
      s.views++;
    }
  }
  return s;
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** A human line for one restore step — what the wake screen ticks off. */
export function stepLabel(t: SnapshotTab): string {
  switch (t.kind) {
    case "terminal": {
      const where = baseName(t.cwd);
      if (t.agentId) {
        const name = AGENT_CLIS.find((c) => c.id === t.agentId)?.name ?? t.agentId;
        return t.sessionId
          ? `Resuming ${name} in ${where}`
          : `Starting ${name} in ${where}`;
      }
      if (t.run) return `Restarting ${t.title}`;
      return `Opening terminal in ${where}`;
    }
    case "file":
      return `Reopening ${baseName(t.path)}`;
    case "preview":
      return t.url ? `Reloading preview of ${t.url}` : "Reopening preview";
    case "pr":
      return `Reopening PR #${t.pr.number}`;
    case "ticket":
      return `Reopening issue ${t.ticket.id}`;
    case "commit":
      return `Reopening commit ${t.short}`;
    case "branch":
      return `Reopening branch ${t.branch.branch}`;
    case "review":
      return `Reopening review ${t.review.title}`;
    case "agent":
      return `Reopening ${t.agent}'s workspace`;
    case "agents":
      return "Reopening the agents page";
    case "task-history":
      return "Reopening completed tasks";
    case "instructions":
      return "Reopening agent instructions";
    case "mcp":
      return `Reopening ${t.server.name}`;
    case "chat":
      return `Reopening chat with ${t.name}`;
  }
}

export interface WakeStep {
  tab: SnapshotTab;
  label: string;
}

/** The ordered plan a wake executes. Order is the tab order, so the strip comes
 *  back left-to-right exactly as it was — a "cheap things first" pass would
 *  reshuffle the user's tabs to save a few hundred milliseconds. */
export function wakeSteps(snap: ProjectSnapshot | null): WakeStep[] {
  return (snap?.tabs ?? []).map((tab) => ({ tab, label: stepLabel(tab) }));
}

/** The command a hibernated terminal comes back with: the agent's own resume
 *  line when there is a conversation to reopen, else whatever it was launched
 *  with. Returns `resumed` so the caller can say which of the two happened. */
export function terminalLaunch(t: TerminalSnapshot): {
  command: string | undefined;
  resumed: boolean;
} {
  if (t.agentId && t.sessionId) {
    const resume = restoreCommand(t.agentId, t.sessionId);
    if (resume) return { command: resume, resumed: true };
  }
  return { command: t.command, resumed: false };
}

// ---------- the store ----------

const KEY = "canopy.hibernation.v1";

/** Fired after any write, so the tabs, the welcome list and the project
 *  manager re-render without polling localStorage. */
export const HIBERNATION_CHANGE_EVENT = "canopy:hibernation";

/** App -> the project's view: "snapshot yourself". Only the view knows what is
 *  open, and only App knows a project was asked to sleep, so the two meet over
 *  a window event — the same shape the app already uses to route a spawned PTY
 *  or an agent action to the ProjectView that owns it.
 *  detail: { projectId } */
export const HIBERNATE_EVENT = "canopy:hibernate";

/** The view answering: the snapshot is written (or could not be), so App may
 *  close the project. detail: { projectId, ok } */
export const HIBERNATED_EVENT = "canopy:hibernated";

type Store = Record<string, ProjectSnapshot>;

function read(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Store;
    if (!raw || typeof raw !== "object") return {};
    // Drop anything written by a future (or corrupt) version rather than
    // handing a half-understood snapshot to the restorer.
    const out: Store = {};
    for (const [id, snap] of Object.entries(raw)) {
      if (snap && snap.version === VERSION && Array.isArray(snap.tabs)) out[id] = snap;
    }
    return out;
  } catch {
    return {};
  }
}

function write(store: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Storage full or blocked. The project stays awake rather than being
    // closed with nothing to come back to — see writeHibernation's return.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(HIBERNATION_CHANGE_EVENT));
  }
}

/** Every hibernating project, by id. */
export const hibernatedProjects = (): Store => read();

export const hibernationOf = (projectId: string): ProjectSnapshot | null =>
  read()[projectId] ?? null;

export const isHibernating = (projectId: string): boolean => projectId in read();

/** Persist a snapshot. Returns false when it could not be stored — the caller
 *  must then leave the project open, because closing it would throw the work
 *  away instead of putting it away. */
export function writeHibernation(projectId: string, snap: ProjectSnapshot): boolean {
  const store = read();
  store[projectId] = snap;
  write(store);
  return isHibernating(projectId);
}

export function clearHibernation(projectId: string) {
  const store = read();
  if (!(projectId in store)) return;
  delete store[projectId];
  write(store);
}

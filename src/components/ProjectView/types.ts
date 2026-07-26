import type * as ipc from "../../ipc";
import type { AgentEventEntry, OpenFile, Notify, RelayHandle } from "../../types";
import type { ReviewPayload } from "../ReviewView";
import type { PreviewAnnotation } from "../../preview";
import type { Project } from "../../projects";

export type SideTab = "files" | "changes" | "git" | "trackers" | "tasks" | "agents" | "team";

export interface TermSubTab {
  id: string;
  type: "terminal";
  cwd: string;
  /** Auto title, tracked from the shell/OSC. Shown unless the user renamed. */
  title: string;
  /** User-set name (double-click the tab). Wins over `title` for display and
   *  survives the shell repainting its own title; cleared by renaming to empty. */
  customTitle?: string;
  ptyId: number | null;
  /** When set, this tab attaches to an already-running headless PTY (spawned
   *  from the remote portal) instead of spawning its own. Closing it detaches;
   *  the agent keeps running for the phone. */
  attachId?: number;
  command?: string;
  icon?: string;
  /** Launched from a component run command — lives in the run rail, not the
   *  terminal strip. */
  run?: boolean;
  /** Run tabs outlive their process: a one-shot command (build, install) ends
   *  on its own, and the tab stays so the output and exit status remain
   *  readable. Undefined while still running. */
  exitCode?: number | null;
  exited?: boolean;
  /** Bumped to force a fresh Term (and a fresh PTY) on re-run. */
  epoch?: number;
  /** The last thing this terminal asked attention for (OSC 9/99/777), and
   *  whether it is still unread. Cleared when the tab is looked at. */
  notice?: string;
  unread?: boolean;
  /** An ephemeral micro-task tab: closed and its session forgotten once the
   *  agent calls canopy_job_done (or the user closes it). Never restored.
   *  `runId` keys this run's entry in the task history — the record outlives
   *  the tab, which is the point. */
  micro?: { taskId: string; runId?: string };
}

export interface FileSubTab {
  id: string;
  type: "file";
  file: OpenFile;
}

export interface TicketSubTab {
  id: string;
  type: "ticket";
  ticket: ipc.TicketInfo;
  source: string;
}

export interface BranchSubTab {
  id: string;
  type: "branch";
  repo: string;
  branch: ipc.BranchWork;
}

export interface CommitSubTab {
  id: string;
  type: "commit";
  repo: string;
  hash: string;
  short: string;
  subject: string;
}

export interface PrSubTab {
  id: string;
  type: "pr";
  repo: string;
  pr: ipc.PrInfo;
}

export interface ReviewSubTab {
  id: string;
  type: "review";
  review: ReviewPayload;
}

/** An agent session's workspace: its branch, diffs, commits and PR. */
export interface AgentSubTab {
  id: string;
  type: "agent";
  /** Repo the agent's cwd matched; null renders the digest-only view. */
  repo: string | null;
  /** Authoritative agent id, from the live process tree. */
  agent: string;
  /** The agent's working directory — the git join is keyed off this. */
  cwd: string;
  /** Hook session id + digest when a hook CLI wrote one; enrichment only. */
  sessionId?: string;
  digest?: ipc.SessionDigest;
  /** Live terminal hosting the session, for the jump-back button. */
  ptyId?: number;
}

/** Every micro-task that has finished, with what it reported and the tail of
 *  its terminal. One per project — opening it twice just focuses the first. */
export interface TaskHistorySubTab {
  id: string;
  type: "task-history";
}

/** The instruction files every agent reads before it sees any code — the
 *  project's, the user's own, and the skill and subagent packs. One per
 *  project; `focus` is the file a panel row asked it to open on. */
export interface InstructionsSubTab {
  id: string;
  type: "instructions";
  focus?: string;
}

export interface ChatSubTab {
  id: string;
  type: "chat";
  /** Relay member id for a DM; null for the everyone channel. */
  peer: string | null;
  name: string;
  /** A message arrived while the tab wasn't in front. */
  unread?: boolean;
}

/** A file someone else owns, live. Distinct from FileSubTab because it has no
 *  path — that is the point, see docs/collab-editing.md §5. */
export interface CollabSubTab {
  id: string;
  type: "collab";
  doc: string;
  name: string;
  ownerName: string;
}

/** A whole project someone else shared, live: a browsable tree of their files,
 *  each opened on demand into a CollabSubTab. */
export interface SharedProjectSubTab {
  id: string;
  type: "shared-project";
  doc: string;
  name: string;
  ownerName: string;
}

/** An embedded browser onto a locally running server, with annotate mode.
 *  Navigation and collected annotations live on the tab so they survive
 *  switching away (the view, like every doc tab, unmounts when inactive). */
export interface PreviewSubTab {
  id: string;
  type: "preview";
  /** The previewed page's real URL ("" until the user picks a server). */
  url: string;
  annotations: PreviewAnnotation[];
}

export type SubTab =
  | CollabSubTab
  | SharedProjectSubTab
  | PreviewSubTab
  | TermSubTab
  | FileSubTab
  | PrSubTab
  | TicketSubTab
  | CommitSubTab
  | BranchSubTab
  | ReviewSubTab
  | AgentSubTab
  | TaskHistorySubTab
  | InstructionsSubTab
  | ChatSubTab;

/** Every tab that isn't a terminal — the "document" tabs, rendered together
 *  below the terminals and display-toggled the same way. */
export type DocSubTab = Exclude<SubTab, TermSubTab>;

/** One entry in a right-hand rail (a shell or a running command). */
export interface RailChip {
  id: string;
  active: boolean;
  /** Extra state class for the chip (e.g. run-chip-live / -done / -failed). */
  className?: string;
  dot: React.ReactNode;
  title: string;
  tooltip: string;
  /** Trailing control, e.g. a run's "re-run" button. */
  action?: React.ReactNode;
  onSelect: () => void;
  onClose: () => void;
}

export interface ProjectViewProps {
  project: Project;
  visible: boolean;
  zen: boolean;
  events: AgentEventEntry[];
  hookPath: string | null;
  /** Every open project (name + roots) — the resource breakdown groups the
   *  machine-wide session stats by project, which one project can't know. */
  allProjects: { name: string; roots: string[] }[];
  /** Pending-card keys the user dismissed (held app-wide so badges agree). */
  dismissedPending: Set<string>;
  onDismissPending: (key: string) => void;
  onEdit: () => void;
  onNotice: Notify;
  onShareContext: (on: boolean) => void;
  /** App-wide team relay — same handle in every project. */
  relay: RelayHandle;
}

/** One tab as canopy_editor_state describes it. */
export function describeTab(tab: SubTab | undefined) {
  if (!tab) return null;
  switch (tab.type) {
    case "file":
      return { kind: "file", path: tab.file.path, view: tab.file.view, dirty: tab.file.dirty };
    case "terminal":
      return {
        kind: tab.run ? "run" : "terminal",
        label: tab.customTitle ?? tab.title,
        cwd: tab.cwd,
        ptyId: tab.ptyId,
      };
    case "preview":
      return { kind: "preview", url: tab.url || null };
    case "ticket":
      return { kind: "ticket", label: tab.ticket.title };
    case "pr":
      return { kind: "pr", label: `#${tab.pr.number} ${tab.pr.title}` };
    case "commit":
      return { kind: "commit", label: `${tab.short} ${tab.subject}` };
    case "branch":
      return { kind: "branch", label: tab.branch.branch };
    case "agent":
      return { kind: "agent", label: tab.agent, cwd: tab.cwd, ptyId: tab.ptyId ?? null };
    case "task-history":
      return { kind: "task-history", label: "Completed tasks" };
    case "instructions":
      return { kind: "instructions", label: "Agent instructions" };
    default:
      return { kind: tab.type };
  }
}

/** Compact relative age for a unix-seconds timestamp. */
export const ago = (secs?: number) => {
  if (!secs) return "";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

// Collision-proof ids: a module counter resets on hot-reload and produced
// duplicate tab ids (closing one tab hit another).
export const tabId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** A one-line label for a tab, for the "all tabs" overflow menu. */
export function tabDisplayLabel(t: SubTab): string {
  switch (t.type) {
    case "terminal":
      return t.customTitle ?? t.title;
    case "file":
      return t.file.name;
    case "pr":
      return `#${t.pr.number} ${t.pr.title}`;
    case "ticket":
      return `${t.ticket.id} ${t.ticket.title}`;
    case "commit":
      return `${t.short} ${t.subject}`;
    case "branch":
      return t.branch.branch;
    case "agent":
      return `${t.agent} · ${
        t.digest?.branch ?? t.cwd.split("/").filter(Boolean).pop() ?? t.agent
      }`;
    case "chat":
      return t.name;
    case "collab":
      return t.name;
    case "review":
      return t.review.title;
    case "task-history":
      return "Completed tasks";
    case "instructions":
      return "Agent instructions";
    case "shared-project":
      return t.name;
    case "preview":
      return previewLabel(t.url);
  }
}

/** host[/path] for the tab strip; the scheme is noise at that width. */
export function previewLabel(url: string): string {
  if (!url) return "Preview";
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

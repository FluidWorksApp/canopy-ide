import type * as ipc from "../../ipc";
import type { AgentEventEntry, OpenFile, Notify, RelayHandle } from "../../types";
import type { ReviewPayload } from "../ReviewView";
import type { PreviewAnnotation } from "../../preview";
import type { DeviceAnnotation } from "../../android";
import type { Project } from "../../projects";
import { getSettings } from "../../settings";

export type SideTab =
  | "files"
  | "servers"
  | "changes"
  | "git"
  | "prs"
  | "trackers"
  | "tasks"
  | "research"
  | "agents"
  | "team"
  | "tools";

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

/** One research entry, open. Holds only the id: the entry changes while it is
 *  on screen (an agent appends to it, the watcher merges its PR) and the view
 *  re-reads the store on every research event, so a copy on the tab would be
 *  a second version of the truth going stale in the background. */
export interface ResearchSubTab {
  id: string;
  type: "research";
  researchId: string;
  /** Last known title, so the tab strip has a label before the first read. */
  title: string;
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
  /** A run to expand on arrival, when the tab was opened from that run's row.
   *  Carries a nonce so clicking the same row twice re-focuses it rather than
   *  looking like nothing happened. */
  focus?: { runId: string; nonce: number };
}

/** The instruction files every agent reads before it sees any code — the
 *  project's, the user's own, and the skill and subagent packs. One per
 *  project; `focus` is the file a panel row asked it to open on. */
export interface InstructionsSubTab {
  id: string;
  type: "instructions";
  focus?: string;
}

/** One MCP server, opened from the Tools panel: its consumers, its tools, and a
 *  way to call them. Carries the whole row rather than just the key so the
 *  header renders before the connection does — the configured facts are known
 *  the moment the tab opens, and only the tools have to be waited for. */
export interface McpSubTab {
  id: string;
  type: "mcp";
  server: ipc.McpServer;
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

/** A live Android device or emulator, shown as refreshing still frames.
 *
 *  Deliberately not a video stream: an agent drives the device and the user
 *  watches, so there is nothing to decode and the tab works identically on
 *  every platform Canopy runs on. Like PreviewSubTab, the selected device and
 *  collected annotations live on the tab so they survive switching away. */
export interface DeviceSubTab {
  id: string;
  type: "device";
  /** adb serial ("" until a device is picked). */
  serial: string;
  /** The Android project this device is showing, for SDK resolution and so
   *  feedback names the codebase to change. */
  projectDir: string;
  annotations: DeviceAnnotation[];
}

export type SubTab =
  | CollabSubTab
  | SharedProjectSubTab
  | PreviewSubTab
  | DeviceSubTab
  | TermSubTab
  | FileSubTab
  | PrSubTab
  | TicketSubTab
  | ResearchSubTab
  | CommitSubTab
  | BranchSubTab
  | ReviewSubTab
  | AgentSubTab
  | TaskHistorySubTab
  | InstructionsSubTab
  | McpSubTab
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

/** The side panel's three behaviour settings, read together — they're one
 *  decision about one panel, and reading them in three places invites two of
 *  them to disagree about which render they came from. */
export function sidebarPrefs() {
  const s = getSettings();
  return {
    hover: s.sidebarHover,
    clickOutsideCloses: s.sidebarClickOutsideCloses,
    overlay: s.sidebarOverlay,
  };
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
  /** Persist this project's custom tasks — they live on the project record, so
   *  writing one is a workspace save. */
  onSaveCustomTasks: (tasks: import("../../microTasks").CustomMicroTask[]) => void;
  /** App-wide team relay — same handle in every project. */
  relay: RelayHandle;
  /** A hibernated workspace to rebuild, handed over when the user wakes the
   *  project. Null in the ordinary case. The frost stays on screen (App renders
   *  it above this view) until `onRestored` fires. */
  restore?: import("../../hibernation").ProjectSnapshot | null;
  /** Progress of that rebuild, so the wake screen can tick the steps off. */
  onRestoreStep?: (done: number, total: number, label: string) => void;
  onRestored?: () => void;
}

/** One tab as canopy_editor_state describes it: enough for an agent to know
 *  what the user has in front of them, without shipping the tab's contents. */
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
    case "device":
      return { kind: "device", label: tab.serial || "Android device" };
    case "ticket":
      return { kind: "ticket", label: tab.ticket.title };
    case "research":
      // The id, not just the title: an agent told the user is looking at
      // research can call canopy_research get on it.
      return { kind: "research", label: tab.title, researchId: tab.researchId };
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
    case "mcp":
      return { kind: "mcp", label: tab.server.name };
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
    case "research":
      // Number first, the way the entry is cited everywhere else (a PR body, a
      // supersedes link), so the tab and the reference read the same.
      return `${t.researchId.split("-")[0]} ${t.title}`;
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
    case "mcp":
      return t.server.name;
    case "shared-project":
      return t.name;
    case "preview":
      return previewLabel(t.url);
    case "device":
      return deviceLabel(t.serial);
  }
}

/** The serial without adb's `emulator-` prefix, which is the same on every
 *  emulator and so tells the user nothing at tab-strip width. */
export function deviceLabel(serial: string): string {
  if (!serial) return "Device";
  return serial.startsWith("emulator-") ? `Emulator ${serial.slice(9)}` : serial;
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

import type * as ipc from "../../ipc";
import type { AgentEventEntry, OpenFile, Notify, RelayHandle } from "../../types";
import type { ReviewPayload } from "../ReviewView";
import type { PreviewAnnotation, PreviewShot } from "../../preview";
import type { DeviceAnnotation } from "../../android";
import type { Component, Project, RunCommand } from "../../projects";
import type { TabStatus } from "../../tabGroups";
import { getSettings } from "../../settings";
import { claimLabel } from "../../claims";
import { basename } from "../../paths";

export type SideTab =
  | "files"
  | "servers"
  | "changes"
  | "git"
  | "prs"
  | "trackers"
  | "tasks"
  | "notes"
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
  /** Agent-published one-line description, updated through canopy_name_task
   *  whenever the work changes. */
  description?: string;
  /** User-set name (double-click the tab). Wins over `title` for display and
   *  survives the shell repainting its own title; cleared by renaming to empty. */
  customTitle?: string;
  ptyId: number | null;
  /** When set, this tab attaches to an already-running headless PTY (spawned
   *  from the remote portal) instead of spawning its own. Closing it detaches;
   *  the agent keeps running for the phone. */
  attachId?: number;
  /** This tab reattached an app-owned PTY after its original tab was lost. It
   * attaches like a remote PTY, but closing it must still stop the process. */
  killAttachedOnClose?: boolean;
  command?: string;
  icon?: string;
  /** Stamped onto the shell at spawn. Carries the port lease of the workspace
   *  this terminal's cwd is in, so a run there serves on its own number.
   *  Restored with the tab, or a woken project's servers would all come back
   *  fighting for the same port. */
  env?: [string, string][];
  /** The non-default account this terminal was launched under. Display only —
   *  `env` carries the isolation — but restored with the tab. */
  profile?: string;
  /** Launched from a component run command — lives in the run rail, not the
   *  terminal strip. */
  run?: boolean;
  /** Stable configured-run identity. Legacy/restored tabs may omit these and
   *  are matched by cwd + command text until they are launched again. */
  componentId?: string;
  runCommandId?: string;
  /** A run that is an errand rather than a service: installing a CLI, updating
   *  one, installing a prerequisite. It has one outcome worth knowing and the
   *  chip's ✓ carries it, so a successful one closes itself (see runReap.ts).
   *  A failed one stays — that scrollback is why you'd look. */
  chore?: boolean;
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
  micro?: { taskId: string; runId?: string; attemptId?: string };
  /** Visual-only grouping. Every member remains a normal terminal tab with its
   * own PTY; ProjectView lays members of the same group into one split surface. */
  paneGroup?: string;
  /** Derived on the representative passed to PaneBar; never persisted. */
  multiplexCount?: number;
  /** Derived title of the currently focused member plus the sibling count. */
  multiplexTitle?: string;
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
  /** Local checkout whose remote owns this issue. */
  repo?: string;
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

/** One note, open. Holds only the id, for the same reason ResearchSubTab does:
 *  the note changes while it is on screen (you edit it, an agent links a PR)
 *  and the view re-reads the store on every notes event, so a copy on the tab
 *  would be a second version of the truth going stale in the background. */
export interface NoteSubTab {
  id: string;
  type: "note";
  noteId: string;
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

/** Agent management for this project: every running session with room to read
 *  it, the archive of past ones, and how each CLI is wired in. One per project,
 *  like the history tab — it is a view of the project's sessions, so a second
 *  would be a copy. */
export interface AgentsPageSubTab {
  id: string;
  type: "agents";
}

/** Full-page indexes. The side panels stay a recent glance; these tabs are the
 * searchable, uncapped lists that lead to the existing detail tabs. */
export interface ResearchListSubTab {
  id: string;
  type: "research-list";
}

export interface NotesListSubTab {
  id: string;
  type: "notes-list";
}

export interface PrsListSubTab {
  id: string;
  type: "prs-list";
}

export interface IssuesListSubTab {
  id: string;
  type: "issues-list";
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

/** One advisory file claim, opened from the Claimed files list: who holds it,
 *  why, since when, and — once it ends — how it ended and who it turned away
 *  meanwhile. Identity is the claim id, not the owner: an agent that claims,
 *  releases and claims again is two claims, and a tab opened on the first must
 *  not start showing the second. The row rides along so the header draws before
 *  the history loads, the way the MCP tab carries its server. */
export interface ClaimSubTab {
  id: string;
  type: "claim";
  claimId: string;
  claim: ipc.AgentClaim;
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
  /** Agent that created this preview. Its PTY is the primary destination for
   *  screenshots and annotations; absent for user-created/restored tabs. */
  initiatorPtyId?: number;
  /** Last running agent explicitly chosen from this preview's send menu. Kept
   *  for this window session so later incremental feedback goes there too. */
  recipientPtyId?: number;
  /** The user hid the feedback rail without clearing its retained items. */
  feedbackPanelHidden?: boolean;
  annotations: PreviewAnnotation[];
  /** Screenshots taken of this page, with the notes written on them. Absent on
   *  tabs restored from a session saved before the button existed. */
  shots?: PreviewShot[];
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
  | NoteSubTab
  | CommitSubTab
  | BranchSubTab
  | ReviewSubTab
  | AgentSubTab
  | AgentsPageSubTab
  | ResearchListSubTab
  | NotesListSubTab
  | PrsListSubTab
  | IssuesListSubTab
  | TaskHistorySubTab
  | InstructionsSubTab
  | McpSubTab
  | ClaimSubTab
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

/** A run of the tab strip. Agents stack by state, documents by kind — a PR has
 *  no state to settle, but "put the pull requests away" is the same gesture as
 *  folding Idle, so every run folds the same way. */
export interface StripGroup {
  key: string;
  /** Chip caption, or null for a run with no chip: the flat agent run that
   *  grouping-off renders, which has nothing to fold it into. */
  label: string | null;
  /** Set on the three agent runs — what colours the chip and its dot. */
  status: TabStatus | null;
  /** The kind icon a document run wears in place of a status dot. */
  icon: React.ReactNode;
  tabs: SubTab[];
  /** What the strip actually renders: everything while the stack is open,
   *  nothing while it is folded. A folded stack that kept one tab out read as a
   *  chip whose count disagreed with what was beside it. */
  shown: SubTab[];
}

/** The two tab-strip settings, in the units the strip wants them in. */
export function tabPrefs(): { grouped: boolean; idleDelayMs: number } {
  const s = getSettings();
  return {
    grouped: s.groupTabsByStatus,
    idleDelayMs: Math.max(0, s.idleGroupDelaySeconds) * 1000,
  };
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
  allProjects: { name: string; roots: string[]; asleep?: boolean }[];
  /** Pending-card keys the user dismissed (held app-wide so badges agree). */
  dismissedPending: Set<string>;
  onDismissPending: (key: string) => void;
  onEdit: () => void;
  onNotice: Notify;
  onShareContext: (on: boolean) => void;
  /** Persist this project's custom tasks — they live on the project record, so
   *  writing one is a workspace save. */
  onSaveCustomTasks: (tasks: import("../../microTasks").CustomMicroTask[]) => void;
  /** Persist an inferred Build target without opening or closing Engineer UI. */
  onPersistVibeTarget: (
    selection: import("../../vibeTargetInference").VibeTargetSelection,
  ) => Promise<boolean>;
  /** Persist one complete agent-proposed setup atomically. */
  onPersistVibeSetup: (project: Project) => Promise<boolean>;
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

export type VibeTargetResolution =
  | { kind: "ready"; component: Component; runCommand: RunCommand }
  | { kind: "needs-setup" };

/** Resolve only explicit, versioned IDs. A one-component project is still not a
 * configured Build target: guessing here would make later automation run in a
 * different directory after a reorder or rename. */
export function resolveVibeTarget(project: Project): VibeTargetResolution {
  const vibe = project.vibe;
  if (
    !vibe ||
    vibe.version !== 1 ||
    !vibe.setupRevision ||
    !vibe.requiredProcesses?.length ||
    !Array.isArray(vibe.externalServices) ||
    !vibe.componentId ||
    !vibe.runCommandId
  ) {
    return { kind: "needs-setup" };
  }
  const components = project.components.filter(
    (component) => component.id === vibe.componentId,
  );
  if (components.length !== 1) return { kind: "needs-setup" };
  const commands = (components[0].commands ?? []).filter(
    (command) => command.id === vibe.runCommandId,
  );
  if (commands.length !== 1 || (!commands[0].argv?.length && !commands[0].command.trim())) {
    return { kind: "needs-setup" };
  }
  return { kind: "ready", component: components[0], runCommand: commands[0] };
}

/** Stable run IDs identify the configured command; cwd identifies its checkout. */
export function matchesVibeRun(
  tab: Pick<
    TermSubTab,
    "cwd" | "command" | "componentId" | "runCommandId" | "exited"
  >,
  component: Pick<Component, "id" | "path">,
  runCommand: RunCommand,
): boolean {
  if (tab.exited || tab.cwd !== (runCommand.cwd ?? component.path)) return false;
  return tab.runCommandId
    ? tab.componentId === component.id && tab.runCommandId === runCommand.id
    : tab.command === runCommand.command;
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
    case "note":
      return { kind: "note", label: tab.title, noteId: tab.noteId };
    case "pr":
      return { kind: "pr", label: `#${tab.pr.number} ${tab.pr.title}` };
    case "commit":
      return { kind: "commit", label: `${tab.short} ${tab.subject}` };
    case "branch":
      return { kind: "branch", label: tab.branch.branch };
    case "agent":
      return { kind: "agent", label: tab.agent, cwd: tab.cwd, ptyId: tab.ptyId ?? null };
    case "agents":
      return { kind: "agents", label: "Agents" };
    case "research-list":
      return { kind: "research-list", label: "All research" };
    case "notes-list":
      return { kind: "notes-list", label: "Scratchpad" };
    case "prs-list":
      return { kind: "prs-list", label: "Pull requests" };
    case "issues-list":
      return { kind: "issues-list", label: "Issues" };
    case "task-history":
      return { kind: "task-history", label: "Completed tasks" };
    case "instructions":
      return { kind: "instructions", label: "Agent instructions" };
    case "mcp":
      return { kind: "mcp", label: tab.server.name };
    case "claim":
      // The owner, not the paths: an agent told the user is looking at a claim
      // wants to know whose it is before anything else.
      return { kind: "claim", label: tab.claim.owner, claimId: tab.claimId };
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
      return t.multiplexTitle ?? t.customTitle ?? t.title;
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
    case "note":
      // Same reasoning as research: the number is how a note is referred to.
      return `${t.noteId.split("-")[0]} ${t.title}`;
    case "commit":
      return `${t.short} ${t.subject}`;
    case "branch":
      return t.branch.branch;
    case "agent":
      return `${t.agent} · ${
        t.digest?.branch ?? (basename(t.cwd) || t.agent)
      }`;
    case "chat":
      return t.name;
    case "collab":
      return t.name;
    case "review":
      return t.review.title;
    case "agents":
      return "Agents";
    case "research-list":
      return "All research";
    case "notes-list":
      return "Scratchpad";
    case "prs-list":
      return "Pull requests";
    case "issues-list":
      return "Issues";
    case "task-history":
      return "Completed tasks";
    case "instructions":
      return "Agent instructions";
    case "mcp":
      return t.server.name;
    case "claim":
      return claimLabel(t.claim);
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

/** Which preview tab an agent's browser op acts on.
 *
 *  Two rules, and the pool is the one that matters. A session may reuse a tab it
 *  already owns, or one nobody has claimed — never another session's. Picking
 *  purely by origin put two agents on ONE native webview, where each navigation
 *  moved the page out from under the other and only one picture in picture
 *  existed to show for it. A tab IS a browser session, so two agents need two.
 *
 *  The second rule is which of a session's OWN tabs. An agent that calls
 *  open_preview twice owns two, and "the first one that has a URL" is the wrong
 *  answer: its pip follows the page it just opened, so a later snapshot or click
 *  would act on the tab it had left while the user watched the other one.
 *
 *  So the session's CURRENT tab wins — `currentTabId`, which is the tab its pip
 *  is pointed at, because the caller sets both from this function's own answer.
 *  That is what keeps the two from ever naming different pages, and it is not
 *  the same as newest: an agent that navigates back to the first page it opened
 *  is on that page afterwards, and creation order would still say the second.
 *  Recency is only the fallback, for a session whose current tab was closed or
 *  which has not driven one yet. An explicit origin still redirects a
 *  navigation to a page the session already has open, unless the current tab is
 *  already on that origin — two tabs on one dev server are told apart by which
 *  one the session is on, since the origin cannot tell them apart at all.
 *
 *  Owned tabs are the whole pool when there are any: an agent that has a page
 *  keeps it rather than taking over the user's. With no ptyId — a call with no
 *  session behind it — there is nothing to keep apart, every preview is a
 *  candidate, and the tab in front is the sensible default.
 *
 *  Returning undefined is a real answer: this session has no page of its own and
 *  none is free, so the caller opens one (or, for an op that isn't a navigation,
 *  says so rather than acting on someone else's page). */
export function pickBrowserTab<
  T extends { id: string; url: string; initiatorPtyId?: number | null },
>(
  previews: T[],
  op: {
    url?: string | null;
    ptyId?: number | null;
    navigating: boolean;
    /** The tab this session is on — where its pip points. Ignored when it names
     *  a tab that is gone or was never this session's. */
    currentTabId?: string | null;
  },
  activeTabId: string | null,
): T | undefined {
  const origin = (u: string): string | null => {
    try {
      return new URL(u).origin;
    } catch {
      return null;
    }
  };
  const wantOrigin = op.url ? origin(op.url) : null;
  const byOrigin = (pool: T[]) =>
    wantOrigin ? pool.find((t) => origin(t.url) === wantOrigin) : undefined;

  // Newest first, so the fallbacks below prefer the last tab the session opened.
  const mine =
    op.ptyId == null
      ? []
      : previews.filter((t) => t.initiatorPtyId === op.ptyId).reverse();
  if (mine.length) {
    const current = mine.find((t) => t.id === op.currentTabId);
    // The page it is on already satisfies the request — nothing to redirect.
    if (current && (!wantOrigin || origin(current.url) === wantOrigin)) return current;
    return (
      byOrigin(mine) ??
      current ??
      mine.find((t) => !!t.url) ??
      // A URL navigation can take over an empty (server-picker) preview tab.
      (op.navigating ? mine[0] : undefined)
    );
  }

  const pool =
    op.ptyId == null ? previews : previews.filter((t) => t.initiatorPtyId == null);
  return (
    byOrigin(pool) ??
    pool.find((t) => t.id === activeTabId && t.url) ??
    pool.find((t) => !!t.url) ??
    (op.navigating ? pool[0] : undefined)
  );
}

/**
 * The tab a restore leaves in front, given the ids it managed to reopen in
 * strip order and the index of the one that was in front when the work was put
 * away (null when the caller has no preference).
 *
 * Falls back to the first tab that did come back, because the tab that was in
 * front is the one most likely to be missing: a file deleted while the project
 * slept, a portal PTY that died, an agent session the CLI refused to resume.
 * Focusing nothing there is the worst outcome available — the strip comes back
 * full, every tab loads, and the workspace renders blank until the user clicks
 * one, which reads as the restore having failed.
 */
export function restoredFront(
  ids: readonly (string | null)[],
  wanted: number | null,
): string | null {
  const front = wanted != null ? ids[wanted] : null;
  return front ?? ids.find((id): id is string => Boolean(id)) ?? null;
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

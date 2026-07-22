// One open project: icon rail + collapsible side panel (components / changes /
// agents) + the main area where the AGENT is the hero. Agents and reference
// docs are sub-tabs; plain shells and long-running commands sit in compact
// right-hand rails (single chip, or a dropdown once there's more than one).
// Terminals stay mounted so TUIs keep running. Bottom status tray shows git
// branch, agents, model, tokens, cost.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import * as ipc from "../ipc";
import { getSettings } from "../settings";
import { modelFor, monaco, languageForPath } from "../monaco-setup";
import { GuestSession, OwnerSession } from "../collab";
import { CollabView } from "./CollabView";
import { SharedProjectView } from "./SharedProjectView";
import type { AgentCli, Project } from "../projects";
import {
  AGENT_CLIS,
  AGENT_PATTERN,
  checkCliUpdates,
  checkInstalledClis,
  startCommand,
  updateCommand,
} from "../projects";
import type { CliUpdate } from "../projects";
import {
  AgentIcon,
  AgentsIcon,
  CommitIcon,
  PullRequestIcon,
  TrackerIcon,
  DiffIcon,
  FilesIcon,
  GitBranchIcon,
  IssueIcon,
  SettingsIcon,
  SidebarIcon,
  CheckIcon,
  FailIcon,
  LiveDot,
  LiveShareIcon,
  PlayIcon,
  RestartIcon,
  StopIcon,
  TeamIcon,
  TerminalIcon,
} from "./icons";
import type { AgentEventEntry, OpenFile, Notify, RelayHandle } from "../types";
import {
  derivePending,
  eventsForProject,
  pendingForRoots,
  type PendingItem,
} from "../notifications";
import { viewerKindFor } from "./viewers";
import { ensureLanguageServer } from "../lsp/client";
import { Term, type TermHandle } from "./Term";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { FileTree } from "./FileTree";
import { FileView } from "./FileView";
import { ChangesPanel, type ChangeGroup } from "./ChangesPanel";
import { useEscape } from "../useEscape";
import { AgentsPanel } from "./AgentsPanel";
import { StatusBar } from "./StatusBar";
import { Palette, type PaletteMode } from "./Palette";
import { GitPanel } from "./GitPanel";
import { TicketsPanel, type AgentTarget } from "./TicketsPanel";
import { TicketView } from "./TicketView";
import { CommitView } from "./CommitView";
import { ReviewView, type ReviewPayload } from "./ReviewView";
import { BranchView } from "./BranchView";
import { ticketBranch, ticketContext, ticketWorktree } from "../trackers";
import { forgetSessions, markRestored, restorableFrom, type Restorable } from "../restorable";
import {
  forgetTerminals,
  rememberTerminals,
  rememberedTerminals,
  type RememberedTerminal,
} from "../terminalMemory";
import { PrView } from "./PrView";
import { ErrorBoundary } from "./ErrorBoundary";
import { TeamPanel } from "./TeamPanel";
import { ChatView } from "./ChatView";

type SideTab = "files" | "changes" | "git" | "trackers" | "agents" | "team";

interface TermSubTab {
  id: string;
  type: "terminal";
  cwd: string;
  /** Auto title, tracked from the shell/OSC. Shown unless the user renamed. */
  title: string;
  /** User-set name (double-click the tab). Wins over `title` for display and
   *  survives the shell repainting its own title; cleared by renaming to empty. */
  customTitle?: string;
  ptyId: number | null;
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
}

interface FileSubTab {
  id: string;
  type: "file";
  file: OpenFile;
}

interface TicketSubTab {
  id: string;
  type: "ticket";
  ticket: ipc.TicketInfo;
  source: string;
}

interface BranchSubTab {
  id: string;
  type: "branch";
  repo: string;
  branch: ipc.BranchWork;
}

interface CommitSubTab {
  id: string;
  type: "commit";
  repo: string;
  hash: string;
  short: string;
  subject: string;
}

interface PrSubTab {
  id: string;
  type: "pr";
  repo: string;
  pr: ipc.PrInfo;
}

interface ReviewSubTab {
  id: string;
  type: "review";
  review: ReviewPayload;
}

interface ChatSubTab {
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
interface CollabSubTab {
  id: string;
  type: "collab";
  doc: string;
  name: string;
  ownerName: string;
}

/** A whole project someone else shared, live: a browsable tree of their files,
 *  each opened on demand into a CollabSubTab. */
interface SharedProjectSubTab {
  id: string;
  type: "shared-project";
  doc: string;
  name: string;
  ownerName: string;
}

type SubTab =
  | CollabSubTab
  | SharedProjectSubTab
  | TermSubTab
  | FileSubTab
  | PrSubTab
  | TicketSubTab
  | CommitSubTab
  | BranchSubTab
  | ReviewSubTab
  | ChatSubTab;

const decoder = new TextDecoder();

/** Compact relative age for a unix-seconds timestamp. */
const ago = (secs?: number) => {
  if (!secs) return "";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};
// Collision-proof ids: a module counter resets on hot-reload and produced
// duplicate tab ids (closing one tab hit another).
const tabId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** A one-line label for a tab, for the "all tabs" overflow menu. */
function tabDisplayLabel(t: SubTab): string {
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
    case "chat":
      return t.name;
    case "collab":
      return t.name;
    case "review":
      return t.review.title;
    case "shared-project":
      return t.name;
  }
}

/** One entry in a right-hand rail (a shell or a running command). */
interface RailChip {
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

// A compact right-hand rail for terminals that aren't the hero — shells and
// running commands. One entry shows as a single chip; two or more collapse
// into a dropdown so the strip stays quiet and the agent keeps center stage.
function Rail({
  label,
  chips,
  summary,
  open,
  setOpen,
}: {
  label: string;
  chips: RailChip[];
  summary: React.ReactNode;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  if (chips.length === 0) return null;
  const chip = (c: RailChip, inMenu: boolean) => (
    <div
      key={c.id}
      className={`run-chip ${c.className ?? ""} ${c.active ? "run-chip-active" : ""} ${
        inMenu ? "rail-menu-chip" : ""
      }`}
      onClick={() => {
        c.onSelect();
        if (inMenu) setOpen(false);
      }}
      title={c.tooltip}
    >
      {c.dot}
      <span className="run-chip-title">{c.title}</span>
      {c.action}
      <span
        className="tab-close"
        onClick={(e) => {
          e.stopPropagation();
          c.onClose();
        }}
      >
        ✕
      </span>
    </div>
  );
  if (chips.length === 1) {
    return (
      <div className="run-rail">
        <span className="run-rail-label">{label}</span>
        {chip(chips[0], false)}
      </div>
    );
  }
  const active = chips.find((c) => c.active);
  return (
    <div className="run-rail rail-menu-anchor">
      <span className="run-rail-label">{label}</span>
      <button
        className={`run-chip rail-toggle ${active ? "run-chip-active" : ""}`}
        onClick={() => setOpen(!open)}
        title={`${chips.length} ${label.toLowerCase()}`}
      >
        {summary}
        <span className="run-chip-title">{active ? active.title : label}</span>
        <span className="rail-count">{chips.length}</span>
        <span className="rail-caret">▾</span>
      </button>
      {open && (
        <div className="cli-menu rail-menu" onMouseLeave={() => setOpen(false)}>
          {chips.map((c) => chip(c, true))}
        </div>
      )}
    </div>
  );
}

/** Endpoints a shell is actually serving, offered where you are looking.
 *
 *  The ports are already known — `lsof` collects them for the resource
 *  breakdown — but they were only ever shown in side panels, so starting a dev
 *  server still meant reading its banner and retyping the URL. Rendered as an
 *  overlay rather than a bar above the grid on purpose: the terminal's size is
 *  what the pty is told, and anything that changes its height risks the
 *  wrap-at-the-wrong-column class of bug. An absolute chip changes nothing. */
function TermPorts({ ptyId, stats }: { ptyId: number | null | undefined; stats: ipc.SessionStats[] }) {
  if (ptyId == null) return null;
  const ports = stats.find((s) => s.id === ptyId)?.ports ?? [];
  if (ports.length === 0) return null;
  return (
    <div className="term-ports">
      {ports.map((p) => (
        <button
          key={p}
          className="term-port"
          title={`Open http://localhost:${p} in your browser`}
          onClick={() =>
            void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
              openUrl(`http://localhost:${p}`),
            )
          }
        >
          localhost:{p}
        </button>
      ))}
    </div>
  );
}

// Real icons, not glyphs: this is a 5-item column where shape is the only
// thing distinguishing entries, and the Agents button used to be Claude's
// asterisk — which read as "Claude" rather than "agents".
const RAIL_TABS: {
  key: SideTab;
  Icon: (p: { size?: number; className?: string }) => React.ReactElement;
  title: string;
}[] = [
  { key: "files", Icon: FilesIcon, title: "Components & files" },
  { key: "changes", Icon: DiffIcon, title: "Session changes" },
  { key: "git", Icon: GitBranchIcon, title: "Git — branches, commits, worktrees, PRs" },
  { key: "trackers", Icon: IssueIcon, title: "Issues — GitHub, Linear, …" },
  { key: "agents", Icon: AgentsIcon, title: "Agents" },
  { key: "team", Icon: TeamIcon, title: "Team — relay, chat, notifications" },
];

interface ProjectViewProps {
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

export function ProjectView({ project, visible, zen, events, hookPath, allProjects, dismissedPending, onDismissPending, onEdit, onNotice, onShareContext, relay }: ProjectViewProps) {
  const [sideTab, setSideTab] = useState<SideTab>("files");
  const [collapsed, setCollapsed] = useState(false);
  const [tabs, setTabs] = useState<SubTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  /** Briefly ringed after a jump — with several similar terminal tabs open,
   *  activating one is not enough to show WHICH one you landed on. */
  const [flashTabId, setFlashTabId] = useState<string | null>(null);
  // Change feed comes from git, grouped by component (see refreshChanges).
  const [changeGroups, setChangeGroups] = useState<ChangeGroup[]>([]);
  const [changesLoading, setChangesLoading] = useState(false);
  // Which tab is being renamed inline, and the working text. Null = none.
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Right-click on the empty area below the file list creates here (the last
  // component's root — the tree that space sits under). Null = closed.
  const [rootCreate, setRootCreate] = useState<{ dir: string; kind: "file" | "dir"; value: string } | null>(null);
  useEscape(() => setRootCreate(null), rootCreate != null);
  const [cliMenuOpen, setCliMenuOpen] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [shareProjectMenuOpen, setShareProjectMenuOpen] = useState(false);
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const installedRef = useRef(installed);
  installedRef.current = installed;
  const [cliUpdates, setCliUpdates] = useState<Record<string, CliUpdate>>({});
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  // When set, the whole project's file surface (tree, quick-open, search, new
  // terminals) points at this worktree instead of the main checkout — so an
  // agent's worktree becomes the environment you actually work in.
  const [worktreeEnv, setWorktreeEnv] = useState<
    { repo: string; path: string; branch: string } | null
  >(null);

  const baselines = useRef(new Map<string, string>());
  const recentSaves = useRef(new Map<string, number>());
  const termHandles = useRef(new Map<string, TermHandle | null>());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const closeTabRef = useRef<(id: string) => void>(() => {});
  const openFileRef = useRef<(path: string, opts?: { diff?: boolean }) => Promise<void>>(
    async () => {},
  );

  // Process stats for THIS project's terminals only. Subscribed here rather
  // than in App: the monitor emits every 2s, and holding the array at App
  // level re-rendered every mounted ProjectView (tab strips, file trees, git
  // panels — for every open project) on every tick. Filtering at the door
  // also lets a project with no terminals skip the setState entirely, so it
  // never re-renders from stats at all.
  const [stats, setStats] = useState<ipc.SessionStats[]>([]);
  const statsRef = useRef(stats);
  statsRef.current = stats;
  // Hook-free waiting detection, for agents with no event integration (the
  // Antigravity permission prompt sat invisible because only claude/codex
  // emit hook events). An agent that burned real CPU and has now been
  // near-idle for 3 straight ticks (~6s) is either blocked on a prompt or
  // done — both mean "look at me", so the tab gets its attention ring.
  // Heuristic by design: it rings the tab, it never fabricates an urgent
  // pending card. Re-arms whenever the agent works again.
  const idleWatch = useRef(new Map<number, { busy: boolean; idle: number; flagged: boolean }>());
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    const sub = ipc.onPtyStats((all) => {
      const ids = new Set(
        tabsRef.current
          .filter((t): t is TermSubTab => t.type === "terminal")
          .map((t) => t.ptyId)
          .filter((id): id is number => id != null),
      );
      const mine = all.filter((s) => ids.has(s.id));
      for (const s of mine) {
        if (!s.procs.some((p) => AGENT_PATTERN.test(p.name))) {
          idleWatch.current.delete(s.id);
          continue;
        }
        const w = idleWatch.current.get(s.id) ?? { busy: false, idle: 0, flagged: false };
        if (s.total_cpu > 10) {
          idleWatch.current.set(s.id, { busy: true, idle: 0, flagged: false });
        } else if (w.busy && !w.flagged && ++w.idle >= 3) {
          w.flagged = true;
          idleWatch.current.set(s.id, w);
          const tab = tabsRef.current.find(
            (t): t is TermSubTab => t.type === "terminal" && t.ptyId === s.id,
          );
          // A ring on the tab you're watching is noise (same rule as OSC).
          if (tab && !(tab.id === activeTabIdRef.current && visibleRef.current)) {
            patchTab(tab.id, {
              notice: "Agent went quiet — it may be waiting on a prompt",
              unread: true,
            });
          }
        } else {
          idleWatch.current.set(s.id, w);
        }
      }
      setStats((prev) => (prev.length === 0 && mine.length === 0 ? prev : mine));
    });
    return () => void sub.then((fn) => fn());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A worktree mirrors its repo's tree, so a component inside the repo maps to
  // the same relative path inside the worktree.
  const components = project.components.map((c) => {
    if (
      worktreeEnv &&
      (c.path === worktreeEnv.repo || c.path.startsWith(worktreeEnv.repo + "/"))
    ) {
      return { ...c, path: worktreeEnv.path + c.path.slice(worktreeEnv.repo.length) };
    }
    return c;
  });
  const roots = components.map((c) => c.path);
  const rootsKey = roots.join("\n");
  // Cmd+T's listener is registered once; without this it closes over the
  // components from mount and opens shells in the main checkout even after a
  // worktree is activated — disagreeing with the panel's own terminal button.
  const componentsRef = useRef(components);
  componentsRef.current = components;
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  // Set from the memo below; the restore loader reads it without having to
  // re-subscribe every time an event arrives.
  const liveSessionIdsRef = useRef<string[]>([]);

  // ---------- terminals ----------

  const addTerminal = useCallback(
    (cwd: string, command?: string, title?: string, icon?: string, run = false) => {
      const id = tabId();
      setTabs((prev) => [
        ...prev,
        { id, type: "terminal", cwd, title: title ?? "shell", ptyId: null, command, icon, run },
      ]);
      setActiveTabId(id);
      // Returned so callers that must talk to the new terminal (seeding an
      // agent with an opening prompt) can find its pty once it spawns.
      return id;
    },
    [],
  );

  /** Open a pull request as its own tab, reusing one already open for it. */
  const openPr = useCallback((repo: string, pr: ipc.PrInfo) => {
    const existing = tabsRef.current.find(
      (t): t is PrSubTab => t.type === "pr" && t.repo === repo && t.pr.number === pr.number,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = tabId();
    setTabs((prev) => [...prev, { id, type: "pr", repo, pr }]);
    setActiveTabId(id);
  }, []);

  /** Open a code-review request that arrived over the relay — the diff came
   *  with it, so there is nothing to fetch. */
  const openReview = useCallback((review: ReviewPayload) => {
    const id = tabId();
    setTabs((prev) => [...prev, { id, type: "review", review }]);
    setActiveTabId(id);
  }, []);

  const patchTabRaw = useCallback((id: string, patch: Partial<SubTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? ({ ...t, ...patch } as SubTab) : t)));
  }, []);

  /** Open a relay conversation as its own tab — the everyone channel (peer
   *  null) or a DM — reusing one already open for it. */
  const openChat = useCallback((peer: string | null, name: string) => {
    const existing = tabsRef.current.find(
      (t): t is ChatSubTab => t.type === "chat" && t.peer === peer,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = tabId();
    setTabs((prev) => [...prev, { id, type: "chat", peer, name }]);
    setActiveTabId(id);
  }, []);

  // ---- live editing ----
  // Owner-side sessions this project started, keyed by path. Outside React
  // state on purpose: an OwnerSession holds a Monaco model subscription and
  // per-keystroke state, and copying it on every render would break both.
  const shared = useRef(new Map<string, OwnerSession>());
  // closeTab is a stable callback but needs the manager, which arrives as a
  // prop. The instance itself never changes; the ref is just how a [] callback
  // reaches it.
  const collabRef = useRef(relay.collab);
  collabRef.current = relay.collab;
  const ownerCursorAt = useRef(0);

  const sharedDocFor = useCallback((path: string) => shared.current.get(path), []);

  const sendOwnerCursor = useCallback((path: string, anchor: number, head: number) => {
    const s = shared.current.get(path);
    if (!s) return;
    // Same 50ms floor the guest view uses: presence is droppable, and a caret
    // dragged across a file must not become a frame per pixel.
    const now = Date.now();
    if (now - ownerCursorAt.current < 50) return;
    ownerCursorAt.current = now;
    s.sendCursor(anchor, head);
  }, []);

  /** Share the open file with a member, live. This is the ONLY place a path
   *  becomes a shareable document, and it is reachable only from a click. */
  const shareFileLive = useCallback(
    (path: string, name: string, member: string, memberName: string) => {
      let session = shared.current.get(path);
      if (!session) {
        const model = monaco.editor.getModel(monaco.Uri.file(path));
        if (!model) {
          onNotice("Open the file in the editor before sharing it live.", "error");
          return;
        }
        session = relay.collab.share(path, model);
        shared.current.set(path, session);
      }
      session.offerTo(member, name, languageForPath(path) ?? null);
      onNotice(`Offered ${name} to ${memberName} — live once they accept.`, "success");
    },
    [onNotice, relay],
  );

  /** Share the whole project with a member. The teammate browses the file tree
   *  and opens any file on demand; each open resolves to the same live-edit
   *  path as `shareFileLive`. Setting `onServeFile` here makes THIS project the
   *  one that answers those opens. */
  const shareProjectLive = useCallback(
    (member: string, memberName: string) => {
      const root = rootsRef.current[0];
      if (!root) {
        onNotice("This project has no folder to share.", "error");
        return;
      }
      relay.collab.onServeFile = async (r, relPath, to) => {
        const abs = r.endsWith("/") ? r + relPath : `${r}/${relPath}`;
        // Open it in our own editor and bring it to the front, so the sharer
        // sees and can follow whatever a teammate opens.
        await openFileRef.current(abs);
        let session = shared.current.get(abs);
        if (!session) {
          let model = monaco.editor.getModel(monaco.Uri.file(abs));
          if (!model) {
            try {
              model = modelFor(abs, await ipc.fsReadText(abs));
            } catch {
              onNotice(`Couldn't open ${relPath} to share.`, "error");
              return;
            }
          }
          session = relay.collab.share(abs, model);
          shared.current.set(abs, session);
        }
        session.offerTo(to, relPath.split("/").pop() ?? relPath, languageForPath(abs) ?? null);
        const opener = relay.status.members.find((m) => m.id === to)?.name ?? "A teammate";
        onNotice(`${opener} opened ${relPath.split("/").pop() ?? relPath}`);
      };
      relay.collab.shareProject(root, project.name, member);
      onNotice(`Sharing "${project.name}" with ${memberName} — they can open any file live.`, "success");
    },
    [onNotice, relay, project.name],
  );

  // Keep our owned-file handles in step with the manager: when a share ends
  // (the "Collaborating" cross, a closed tab, the relay dropping), drop the
  // stale entry so the file's "Share live" button stops reading as "Sharing".
  useEffect(() => {
    for (const [path, session] of [...shared.current]) {
      if (!relay.collab.get(session.doc)) shared.current.delete(path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relay.collabTick]);

  // A guest session appears only when the owner answers our `open` with a
  // snapshot, so the tab is opened from the manager's state rather than at the
  // moment we accept — there is nothing to show until the text arrives.
  useEffect(() => {
    const open = tabsRef.current.filter((t): t is CollabSubTab => t.type === "collab");
    for (const [doc, meta] of relay.collab.liveGuests()) {
      if (open.some((t) => t.doc === doc)) continue;
      const id = tabId();
      setTabs((prev) => [
        ...prev,
        { id, type: "collab", doc, name: meta.name, ownerName: meta.ownerName },
      ]);
      setActiveTabId(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relay.collabTick]);

  // A teammate shared their whole project: open one browser for it in the
  // project that's in front (guarding on `visible` keeps it from opening a
  // duplicate in every other mounted project).
  useEffect(() => {
    if (!visible) return;
    const open = tabsRef.current.filter(
      (t): t is SharedProjectSubTab => t.type === "shared-project",
    );
    for (const [doc, meta] of relay.collab.joinedProjects) {
      if (open.some((t) => t.doc === doc)) continue;
      const id = tabId();
      setTabs((prev) => [
        ...prev,
        { id, type: "shared-project", doc, name: meta.name, ownerName: meta.fromName },
      ]);
      setActiveTabId(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relay.collabTick, visible]);

  // Tell App which conversation is in front so it can skip toasts for it —
  // only the visible project speaks, or every mounted one would overwrite it.
  const activeTabForChat = tabs.find((t) => t.id === activeTabId);
  const activeChatPeer =
    visible && activeTabForChat?.type === "chat" ? activeTabForChat.peer : undefined;
  useEffect(() => {
    if (!visible) return;
    relay.reportActiveChat(activeChatPeer);
    return () => relay.reportActiveChat(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, activeChatPeer]);

  // Ring chat tabs that received something while not in front.
  //
  // Identity, not position. This tracked a running index into the transcript,
  // but App caps that transcript at 500 and empties it on disconnect — so once
  // 500 messages had gone by, the length stopped growing, `slice(500)` was
  // forever empty, and chat tabs never rang again for the rest of the session.
  // Disconnecting broke it the other way: the index pointed past the end of a
  // now-empty array, and nothing rang until 500 fresh messages had arrived.
  // Comparing ids against what we've already seen survives both, because it
  // never assumes the transcript only grows.
  const chatSeen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const seen = chatSeen.current;
    // First run seeds without ringing: history loaded before this view existed
    // is not "new", it is just history.
    chatSeen.current = new Set(relay.chat.map((m) => m.id));
    if (seen === null) return;
    const fresh = relay.chat.filter((m) => !seen.has(m.id));
    if (fresh.length === 0) return;
    const selfId = relay.status.self_id;
    setTabs((prev) =>
      prev.map((t) => {
        if (t.type !== "chat" || (t.id === activeTabId && visible)) return t;
        const mine = fresh.some((m) =>
          t.peer === null
            ? m.to === null && m.from !== selfId
            : m.from === t.peer && m.to === selfId,
        );
        return mine ? { ...t, unread: true } : t;
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relay.chat]);

  /** Act on a relay command: open-pr finds the local checkout whose origin
   *  matches the sender's repo and opens the PR natively in it. */
  const openInboxItem = useCallback(
    async (item: ipc.RelayCommandMsg) => {
      // A review request carries its own diff — open it directly, no repo
      // lookup needed (the reviewer may not even have the code).
      if (item.kind === "review") {
        openReview({ ...(item.payload as ReviewPayload), from: item.from_name });
        relay.dismissInbox(item.id);
        return;
      }
      if (item.kind !== "open-pr") {
        relay.dismissInbox(item.id);
        return;
      }
      const payload = item.payload as { repo?: string; pr?: ipc.PrInfo };
      if (!payload.pr) {
        onNotice("That request is missing its PR payload.", "error");
        return;
      }
      try {
        const repos = await ipc.gitRepos(
          componentsRef.current.map((c) => [c.label, c.path] as [string, string]),
        );
        for (const r of repos) {
          const url = await ipc.gitRemoteUrl(r.path).catch(() => "");
          if (url && payload.repo && url.toLowerCase() === payload.repo.toLowerCase()) {
            openPr(r.path, payload.pr);
            relay.dismissInbox(item.id);
            return;
          }
        }
        onNotice(
          `No component in this project has origin ${payload.repo ?? "?"} — open the matching project and try from there.`,
          "warn",
        );
      } catch (err) {
        onNotice(String(err), "error");
      }
    },
    [onNotice, openPr, openReview, relay],
  );

  // Restorable agent sessions, loaded while the launcher (empty state) is on
  // screen — that is precisely the moment "you left three agents mid-thought"
  // is worth saying, and it costs nothing the rest of the time.
  const [restorable, setRestorable] = useState<Restorable[]>([]);
  useEffect(() => {
    if (tabs.length > 0 || !visible) return;
    let live = true;
    const load = () =>
      void ipc
        .sessionDigests()
        .then((d) => {
          if (!live) return;
          const mine = d.filter((x) =>
            rootsRef.current.some((r) => x.cwd === r || (x.cwd ?? "").startsWith(r + "/")),
          );
          setRestorable(restorableFrom(mine, statsRef.current, liveSessionIdsRef.current));
        })
        .catch(() => live && setRestorable([]));
    load();
    const t = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [tabs.length, visible]);

  // Remember the terminal layout so it can be offered back on the empty
  // state. Snapshotted on change rather than on unmount: a crash or a force
  // quit never runs cleanup, and those are precisely the cases this exists
  // for.
  useEffect(() => {
    const open: RememberedTerminal[] = tabs
      .filter((t): t is TermSubTab => t.type === "terminal" && !t.exited)
      .map((t) => ({
        cwd: t.cwd,
        command: t.command,
        title: t.customTitle ?? t.title,
        icon: t.icon,
        run: t.run,
      }));
    rememberTerminals(project.id, open);
  }, [tabs, project.id]);

  const [remembered, setRemembered] = useState<RememberedTerminal[]>([]);
  useEffect(() => {
    if (tabs.length > 0 || !visible) return;
    setRemembered(rememberedTerminals(project.id));
  }, [tabs.length, visible, project.id]);

  // A terminal running `claude` or `omp` is an agent, not a shell — listing it
  // under "Terminals" was accurate about the mechanism and wrong about the
  // thing. Split by what the command actually starts.
  const rememberedAgents = remembered.filter((t) =>
    AGENT_CLIS.some((c) => (t.command ?? "").startsWith(c.bin)),
  );
  const rememberedShells = remembered.filter(
    (t) => !AGENT_CLIS.some((c) => (t.command ?? "").startsWith(c.bin)),
  );
  // An agent terminal whose directory already has a restorable session is
  // redundant — that row restores the same work WITH its history, so offering
  // "start it fresh" beside it is just a worse duplicate.
  const freshAgents = rememberedAgents.filter(
    (t) => !restorable.some((r) => r.cwd === t.cwd),
  );

  const reopenTerminal = useCallback(
    (t: RememberedTerminal) => addTerminal(t.cwd, t.command, t.title, t.icon, t.run),
    [addTerminal],
  );

  const resumeSession = useCallback(
    (r: Restorable) => {
      if (!r.command || !r.cwd) return;
      // Already open — focus that tab instead of spawning a second identical
      // resume. The resume command carries the session id, so command+cwd
      // uniquely identifies the terminal running this exact session; without
      // this, "Restore all", a double-click, or the row reappearing all stack
      // duplicate tabs of the same conversation.
      const open = tabsRef.current.find(
        (t): t is TermSubTab =>
          t.type === "terminal" && t.command === r.command && t.cwd === r.cwd,
      );
      if (open) {
        setActiveTabId(open.id);
        return;
      }
      // Hide it immediately rather than waiting for the next poll; the mark
      // is a bridge until the agent shows up in the process list, after which
      // the row's presence tracks whether that terminal is still open.
      markRestored(r.digest.session_id);
      setRestorable((prev) =>
        prev.filter((x) => x.digest.session_id !== r.digest.session_id),
      );
      addTerminal(
        r.cwd,
        r.command,
        r.digest.agent ?? "agent",
        AGENT_CLIS.find((c) => c.id === r.agentId)?.icon,
      );
    },
    [addTerminal],
  );

  // Worktrees for the ticket tab's cross-reference. Loaded when a ticket tab
  // opens rather than polled — the Issues panel keeps its own copy for rows.
  const [ticketWorktrees, setTicketWorktrees] = useState<ipc.WorktreeInfo[]>([]);
  const ticketRepo = useCallback(async () => {
    const repos = await ipc.gitRepos(
      componentsRef.current.map((c) => [c.label, c.path] as [string, string]),
    );
    return repos[0]?.path ?? null;
  }, []);

  /** Create or reuse the ticket's worktree and start an agent in it. The one
   *  implementation both the Issues panel and the ticket tab call. */
  const startTicketWork = useCallback(
    async (ticket: ipc.TicketInfo, agentId?: string) => {
      const repo = await ticketRepo();
      if (!repo) {
        onNotice("No git repository in this project.");
        return;
      }
      // The chosen agent, else the preference if it is installed, else the
      // first installed CLI. Never a hardcoded name, and never one that
      // isn't on the machine.
      const installedClis = AGENT_CLIS.filter((c) => installedRef.current[c.bin]);
      const preferred = getSettings().defaultAgent;
      const agent =
        agentId ||
        (installedClis.find((c) => c.id === preferred) ?? installedClis[0] ?? AGENT_CLIS[0])
          ?.id;
      const cli = AGENT_CLIS.find((c) => c.id === agent);
      const start = startCommand(agent, ticketContext(ticket));
      if (!cli || !start) {
        onNotice(`Unknown agent "${agent}".`);
        return;
      }
      // A CLI with no verified prompt syntax launches bare and gets the
      // ticket typed in once its TUI is up — the same two-write pattern the
      // model switcher uses, so nothing is silently dropped.
      const seed = (id: string) => {
        if (!start.typePrompt) return;
        const pty = tabsRef.current.find(
          (t): t is TermSubTab => t.id === id && t.type === "terminal",
        )?.ptyId;
        if (pty == null) return;
        void ipc.ptyWrite(pty, ticketContext(ticket));
        setTimeout(() => void ipc.ptyWrite(pty, "\r"), 250);
      };
      try {
        const worktrees = await ipc.gitWorktrees(repo).catch(() => [] as ipc.WorktreeInfo[]);
        const existing = ticketWorktree(ticket, worktrees);
        const title = `${ticket.id} · ${cli.name}`;
        if (existing) {
          const id = addTerminal(existing.path, start.command, title, cli.icon);
          setTicketWorktrees(worktrees);
          if (id) setTimeout(() => seed(id), 2500);
          return;
        }
        const branch = ticketBranch(ticket);
        const path = `${repo}-wt-${branch.replace(/\//g, "-")}`;
        const branches = await ipc.gitBranches(repo).catch(() => [] as ipc.BranchInfo[]);
        await ipc.gitWorktreeAdd(repo, path, branch, !branches.some((b) => b.name === branch));
        await ipc.workspaceAdd(path).catch(() => {});
        setTicketWorktrees(await ipc.gitWorktrees(repo).catch(() => worktrees));
        const id = addTerminal(path, start.command, title, cli.icon);
        if (id) setTimeout(() => seed(id), 2500);
      } catch (err) {
        onNotice(`Couldn't start work on ${ticket.id}: ${String(err)}`);
      }
    },
    [ticketRepo, addTerminal, onNotice],
  );

  /** Open a branch as its own tab — its uncommitted work, its commits, and
   *  its diff against the base. */
  const openBranch = useCallback(
    (repo: string, branch: ipc.BranchWork) => {
      const existing = tabsRef.current.find(
        (t): t is BranchSubTab => t.type === "branch" && t.branch.branch === branch.branch,
      );
      if (existing) {
        // The audit's copy is fresher (dirty counts move); take it.
        patchTabRaw(existing.id, { branch } as Partial<SubTab>);
        setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [...prev, { id, type: "branch", repo, branch }]);
      setActiveTabId(id);
    },
    [patchTabRaw],
  );

  /** Open a commit as its own tab, reusing one already open for it. */
  const openCommit = useCallback(
    (repo: string, commit: { hash: string; short: string; subject: string }) => {
      const existing = tabsRef.current.find(
        (t): t is CommitSubTab => t.type === "commit" && t.hash === commit.hash,
      );
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [...prev, { id, type: "commit", repo, ...commit }]);
      setActiveTabId(id);
    },
    [],
  );

  /** Open an issue as its own tab, reusing one already open for it. */
  const openTicket = useCallback(
    (ticket: ipc.TicketInfo, source: string) => {
      const existing = tabsRef.current.find(
        (t): t is TicketSubTab =>
          t.type === "ticket" && t.source === source && t.ticket.id === ticket.id,
      );
      if (existing) {
        // Refresh the payload: the panel's copy is newer than the tab's.
        patchTabRaw(existing.id, { ticket } as Partial<SubTab>);
        setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [...prev, { id, type: "ticket", ticket, source }]);
      setActiveTabId(id);
      void ticketRepo().then((repo) => {
        if (repo) void ipc.gitWorktrees(repo).then(setTicketWorktrees).catch(() => {});
      });
    },
    [patchTabRaw, ticketRepo],
  );

  /** Hand ticket context to an agent terminal that is already running. */
  const sendTicketToAgent = useCallback((target: AgentTarget, text: string) => {
    // Same two-write pattern as the model switcher: text, then Enter a beat
    // later so a TUI's autocomplete can't swallow the submit.
    void ipc.ptyWrite(target.ptyId, text);
    setTimeout(() => void ipc.ptyWrite(target.ptyId, "\r"), 250);
    setActiveTabId(target.tabId);
    setTimeout(() => termHandles.current.get(target.tabId)?.focus(), 50);
  }, []);

  /** Re-run a run tab's command in place, reusing the tab (and its position in
   *  the rail) rather than spawning a new one. */
  const restartRun = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (tab?.type !== "terminal") return;
      if (tab.ptyId != null) void ipc.ptyKill(tab.ptyId);
      // Remount Term with a fresh key by clearing the pty and exit state; the
      // effect below respawns it.
      setTabs((prev) =>
        prev.map((t) =>
          t.id === id
            ? ({ ...t, ptyId: null, exited: false, exitCode: undefined, epoch: (t as TermSubTab).epoch ?? 0 } as SubTab)
            : t,
        ),
      );
      setTimeout(() => {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === id && t.type === "terminal"
              ? // Re-clear exit state here too: the old pty's kill can emit a
                // late pty:exit in the gap since t=0 that flips `exited` back on.
                { ...t, epoch: (t.epoch ?? 0) + 1, exited: false, exitCode: undefined }
              : t,
          ),
        );
      }, 200);
    },
    [],
  );

  // Opening a project deliberately opens nothing: the empty state is the
  // launcher, so you pick the shell or agent you actually want rather than
  // being handed a shell you didn't ask for.

  // Re-probed whenever it could have changed: an install run finishing, or
  // the launcher opening. A one-shot probe at mount meant a finished install
  // still showed — and re-ran — the installer on every click.
  const refreshInstalled = useCallback(
    () => void checkInstalledClis().then(setInstalled),
    [],
  );
  // Version probing runs `<bin> --version` per CLI plus (at most 6-hourly) a
  // registry fetch — slower than which_check, so it rides in the background
  // and the launcher renders whatever the last probe knew.
  const refreshUpdates = useCallback(
    () => void checkCliUpdates().then(setCliUpdates),
    [],
  );
  useEffect(() => {
    refreshInstalled();
    refreshUpdates();
  }, [refreshInstalled, refreshUpdates]);

  // Looking at a tab is what marks it read. As an effect rather than something
  // hung off the tab's onClick, so every route in — clicking, Ctrl+Tab cycling,
  // a jump from the agents panel, closing the tab in front of it — clears the
  // ring without each one having to remember to.
  useEffect(() => {
    if (!visible || !activeTabId) return;
    setTabs((prev) =>
      prev.some(
        (t) => t.id === activeTabId && (t.type === "terminal" || t.type === "chat") && t.unread,
      )
        ? prev.map((t) => (t.id === activeTabId ? ({ ...t, unread: false } as SubTab) : t))
        : prev,
    );
  }, [activeTabId, visible, tabs]);

  // Menu shortcuts — only the visible project reacts.
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  // Keep the active tab in view when it changes (cycling, jumping, closing) —
  // a strip that scrolls but doesn't follow leaves you looking at the wrong tabs.
  const activeTabElRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!visible) return;
    activeTabElRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeTabId, visible]);
  useEffect(() => {
    if (!visible) return;
    const closeTabHandler = () => {
      if (activeTabIdRef.current) closeTabRef.current(activeTabIdRef.current);
    };
    const newTerminalHandler = () => {
      const first = componentsRef.current[0];
      if (first) addTerminal(first.path);
    };
    const toggleSidebarHandler = () => setCollapsed((v) => !v);
    const quickOpen = () => setPalette("files");
    const findInFiles = () => setPalette("search");
    const cycleTabs = (dir: 1 | -1) => {
      const list = tabsRef.current;
      if (list.length < 2) return;
      const i = list.findIndex((t) => t.id === activeTabIdRef.current);
      setActiveTabId(list[(i + dir + list.length) % list.length].id);
    };
    // The tab-cycle chord is a native menu accelerator, but when focus is in
    // the webview (Monaco/xterm) macOS never routes it to the menu — the
    // unhandled key just rings the system bell ("tuk"). Handle it here in
    // capture phase, preventDefault to silence the bell, and record the time so
    // the menu handler (if it also fires, in a native-focus context) doesn't
    // double-cycle. The keydown path always acts, so key-repeat is never
    // dropped — only a paired menu event is suppressed.
    const lastKeydownNav = { t: 0 };
    const recentKeydown = () => Date.now() - lastKeydownNav.t < 150;
    const onKeydown = (e: KeyboardEvent) => {
      if (!visibleRef.current) return;
      // Ctrl+Cmd+Arrow (matches the "Next/Previous Tab" accelerators).
      if (!(e.ctrlKey && (e.metaKey || e.altKey))) return;
      if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
        e.preventDefault();
        lastKeydownNav.t = Date.now();
        cycleTabs(e.code === "ArrowRight" ? 1 : -1);
      }
    };
    const next = () => {
      if (recentKeydown()) return;
      cycleTabs(1);
    };
    const prev = () => {
      if (recentKeydown()) return;
      cycleTabs(-1);
    };
    window.addEventListener("keydown", onKeydown, true);
    // Settings asks for interactive CLI flows (gh auth login/logout, brew
    // install) to run somewhere the user can actually answer prompts.
    const runCommand = (e: Event) => {
      const d = (e as CustomEvent).detail as { command?: string; title?: string };
      const first = componentsRef.current[0];
      if (d?.command && first) addTerminal(first.path, d.command, d.title ?? d.command, "⚙");
    };
    window.addEventListener("canopy:run-command", runCommand);
    window.addEventListener("menu:close-tab", closeTabHandler);
    window.addEventListener("menu:new-terminal", newTerminalHandler);
    window.addEventListener("menu:toggle-sidebar", toggleSidebarHandler);
    window.addEventListener("menu:next-tab", next);
    window.addEventListener("menu:prev-tab", prev);
    window.addEventListener("menu:quick-open", quickOpen);
    window.addEventListener("menu:find-in-files", findInFiles);
    return () => {
      window.removeEventListener("canopy:run-command", runCommand);
      window.removeEventListener("menu:close-tab", closeTabHandler);
      window.removeEventListener("menu:new-terminal", newTerminalHandler);
      window.removeEventListener("menu:toggle-sidebar", toggleSidebarHandler);
      window.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("menu:next-tab", next);
      window.removeEventListener("menu:prev-tab", prev);
      window.removeEventListener("menu:quick-open", quickOpen);
      window.removeEventListener("menu:find-in-files", findInFiles);
    };
  }, [visible, project.components, addTerminal]);

  const patchTab = useCallback((id: string, patch: Partial<TermSubTab> & Partial<FileSubTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? ({ ...t, ...patch } as SubTab) : t)));
  }, []);

  const patchFile = useCallback((path: string, patch: Partial<OpenFile>) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.type === "file" && t.file.path === path
          ? { ...t, file: { ...t.file, ...patch } }
          : t,
      ),
    );
  }, []);

  const closeTab = useCallback((id: string) => {
    termHandles.current.delete(id);
    setTabs((prev) => {
      const closing = prev.find((t) => t.id === id);
      if (closing?.type === "file") {
        // Closing the tab disposes the model the OwnerSession is subscribed
        // to, so the share has to end first — otherwise it sits there holding
        // a dead model and every remote edit throws.
        const share = shared.current.get(closing.file.path);
        if (share) {
          collabRef.current.close(share.doc);
          shared.current.delete(closing.file.path);
        }
        monaco.editor.getModel(monaco.Uri.file(closing.file.path))?.dispose();
        baselines.current.delete(closing.file.path);
      }
      if (closing?.type === "collab") {
        collabRef.current.close(closing.doc);
        monaco.editor
          .getModels()
          .find((m) => m.uri.scheme === "canopy-collab" && m.uri.path.startsWith(`/${closing.doc}/`))
          ?.dispose();
      }
      if (closing?.type === "shared-project") {
        collabRef.current.leaveProject(closing.doc);
      }
      const closingIndex = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((active) => {
        if (active !== id) return active;
        if (next.length === 0) return null;
        // Land on the neighbour that took the closed tab's place (the tab to
        // its right), or the new last one when the last tab was closed — so
        // closing left-to-right stays predictable instead of jumping away.
        return next[Math.min(closingIndex, next.length - 1)].id;
      });
      return next;
    });
  }, []);
  closeTabRef.current = closeTab;

  // The owner stopped sharing (or we left from elsewhere): close any shared
  // -project tab whose project is no longer joined.
  useEffect(() => {
    for (const t of tabsRef.current) {
      if (t.type === "shared-project" && !relay.collab.joinedProjects.has(t.doc)) {
        closeTabRef.current(t.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relay.collabTick]);

  // ---------- files ----------

  const openFile = useCallback(
    async (path: string, opts?: { diff?: boolean }) => {
      const existing = tabsRef.current.find(
        (t) => t.type === "file" && t.file.path === path,
      ) as FileSubTab | undefined;
      let bytes: Uint8Array;
      try {
        bytes = await ipc.fsReadFile(path);
      } catch (err) {
        console.warn("open failed", path, err);
        return;
      }
      const kind = viewerKindFor(path);
      // Proper diff for changed files: baseline is git HEAD. Any text-ish file
      // qualifies — gating on code/json/markdown silently denied a diff to
      // things like .gitignore, Dockerfile or .env, which are exactly the files
      // people click in the git panel.
      let diffOriginal: string | null = null;
      const diffable = !["pdf", "image", "sheet", "docx"].includes(kind);
      if (opts?.diff && diffable) {
        diffOriginal = await ipc.gitHeadContent(path).catch(() => null);
      }
      if (kind === "code" || diffOriginal != null) {
        const text = decoder.decode(bytes);
        if (!baselines.current.has(path)) baselines.current.set(path, text);
        modelFor(path, text);
        const root = roots.find((r) => path.startsWith(r + "/"));
        if (root && kind === "code") void ensureLanguageServer(path, root);
      }
      if (existing) {
        patchFile(path, {
          bytes,
          ...(diffOriginal != null ? { view: "diff" as const, diffOriginal } : {}),
        });
        setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [
        ...prev,
        {
          id,
          type: "file",
          file: {
            path,
            name: path.split("/").pop() ?? path,
            kind,
            view: diffOriginal != null ? "diff" : kind === "code" ? "source" : "preview",
            diffOriginal,
            dirty: false,
            external: null,
            bytes,
          },
        },
      ]);
      setActiveTabId(id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootsKey, patchFile],
  );
  openFileRef.current = openFile;

  const saveFile = useCallback(
    async (path: string) => {
      const model = monaco.editor.getModel(monaco.Uri.file(path));
      if (!model) return;
      const content = model.getValue();
      recentSaves.current.set(path, Date.now());
      try {
        await ipc.fsWriteFile(path, content);
        baselines.current.set(path, content);
        patchFile(path, { dirty: false });
      } catch (err) {
        console.error("save failed", path, err);
      }
    },
    [patchFile],
  );

  const findFile = (path: string): OpenFile | undefined => {
    const tab = tabsRef.current.find(
      (t) => t.type === "file" && t.file.path === path,
    ) as FileSubTab | undefined;
    return tab?.file;
  };

  const acceptExternal = useCallback(
    (path: string) => {
      const file = findFile(path);
      if (!file?.external) return;
      monaco.editor.getModel(monaco.Uri.file(path))?.setValue(file.external);
      baselines.current.set(path, file.external);
      patchFile(path, { external: null, dirty: false });
    },
    [patchFile],
  );

  const keepMine = useCallback(
    (path: string) => {
      const file = findFile(path);
      if (!file?.external) return;
      baselines.current.set(path, file.external);
      patchFile(path, { external: null, dirty: true });
    },
    [patchFile],
  );

  const toggleView = useCallback(
    (path: string) => {
      const file = findFile(path);
      if (!file) return;
      if (file.view === "preview" && file.bytes) {
        const text = decoder.decode(file.bytes);
        if (!baselines.current.has(path)) baselines.current.set(path, text);
        modelFor(path, text);
      }
      patchFile(path, {
        view: file.view === "preview" ? "source" : "preview",
        diffOriginal: null,
      });
    },
    [patchFile],
  );

  // ---------- diff-first: external changes scoped to this project ----------

  // The change feed is whatever git reports as changed, one group per
  // component. Git — not the raw fs watcher — is the source of truth, so the
  // list already honours .gitignore (including nested ones like
  // src-tauri/.gitignore) and never shows build output, object files or the
  // editor's atomic-write temp files. Two components resolving to the same repo
  // are collapsed to the first, so a file is never listed twice.
  const refreshChanges = useCallback(async () => {
    const comps = componentsRef.current;
    setChangesLoading(true);
    try {
      const results = await Promise.all(
        comps.map((c) =>
          ipc
            .gitRepoStatus(c.path)
            .then((s) => {
              const files = [...s.conflicted, ...s.staged, ...s.unstaged, ...s.untracked];
              const seen = new Set<string>();
              const unique = files.filter((f) => {
                if (seen.has(f.path)) return false;
                seen.add(f.path);
                return true;
              });
              return { component: c.label, repo: s.path, files: unique } as ChangeGroup;
            })
            .catch(() => null),
        ),
      );
      const seenRepo = new Set<string>();
      const groups = results.filter(
        (g): g is ChangeGroup =>
          g != null && g.files.length > 0 && !seenRepo.has(g.repo) && (seenRepo.add(g.repo), true),
      );
      setChangeGroups(groups);
    } finally {
      setChangesLoading(false);
    }
  }, []);

  // Query git on mount and whenever the component set changes.
  useEffect(() => {
    void refreshChanges();
  }, [refreshChanges, rootsKey]);

  // The fs watcher no longer *builds* the feed — it only triggers a debounced
  // re-query of git, and live-diffs files that are already open in a tab.
  useEffect(() => {
    let gitTimer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = ipc.onFsChange(async (e) => {
      clearTimeout(gitTimer);
      gitTimer = setTimeout(() => void refreshChanges(), 400);
      const now = Date.now();
      for (const path of e.paths) {
        if (!roots.some((r) => path.startsWith(r + "/"))) continue;
        const saved = recentSaves.current.get(path);
        if (saved && now - saved < 1500) continue;
        const file = findFile(path);
        if (!file || e.kind === "remove") continue;
        try {
          const bytes = await ipc.fsReadFile(path);
          if (file.kind === "code") {
            const newText = decoder.decode(bytes);
            const model = monaco.editor.getModel(monaco.Uri.file(path));
            if (!model || model.getValue() === newText) {
              baselines.current.set(path, newText);
              continue;
            }
            patchFile(path, { external: newText });
          } else {
            patchFile(path, { bytes });
          }
        } catch {
          // mid-write; next event catches it
        }
      }
    });
    return () => {
      clearTimeout(gitTimer);
      void unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, patchFile, refreshChanges]);

  // ---------- render ----------

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  // The pty of the terminal tab in front, so the Agents panel can highlight its
  // row — relating the tab you're looking at back to its entry in the list.
  const activePty = activeTab?.type === "terminal" ? activeTab.ptyId : null;
  const runTabs = tabs.filter(
    (t): t is TermSubTab => t.type === "terminal" && Boolean(t.run),
  );
  const ptyIds = new Set(
    tabs
      .filter((t): t is TermSubTab => t.type === "terminal")
      .map((t) => t.ptyId)
      .filter((id): id is number => id != null),
  );
  const projectStats = stats; // already filtered to this project's ptys at the door
  // Hooks are global, so the raw stream carries every agent on the machine.
  // Everything below this line sees only what our own terminals raised.
  const projectEvents = eventsForProject(events, ptyIds, roots);
  // Session ids seen on this project's live terminals during this app run. A
  // digest not in here has no terminal — either it ended, or the IDE died with
  // it running, which is exactly the case restore exists for. Derived from
  // events rather than stored, because pty ids restart from 1 each launch and
  // would otherwise collide with a previous run's.
  const liveSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of projectEvents) {
      try {
        const sid = (JSON.parse(e.raw) as { session_id?: unknown }).session_id;
        if (typeof sid === "string" && sid) ids.add(sid);
      } catch {
        // a malformed line shouldn't hide every restorable session
      }
    }
    return [...ids];
  }, [projectEvents]);
  liveSessionIdsRef.current = liveSessionIds;
  const runningAgents = projectStats.flatMap((s) =>
    s.procs
      .filter((p) => AGENT_PATTERN.test(p.name))
      .map((p) => ({ name: p.name, cpu: p.cpu })),
  );
  const changedPaths = new Set(changeGroups.flatMap((g) => g.files.map((f) => f.abs)));
  const changeCount = changeGroups.reduce((n, g) => n + g.files.length, 0);
  // Files teammates are editing live in a project we're sharing — no git
  // presence until saved, scoped to this project's roots.
  const collabChanges = useMemo(
    () =>
      relay.collab
        .ownerChanges()
        .filter((c) => rootsRef.current.some((r) => c.path === r || c.path.startsWith(r + "/"))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [relay.collabTick, rootsKey],
  );
  const collabEditedCount = collabChanges.filter((c) => c.edited).length;
  const collabPaths = new Set(collabChanges.filter((c) => c.edited).map((c) => c.path));
  const teamBadge =
    relay.inbox.length + Object.values(relay.unread).reduce((a, b) => a + b, 0);
  const sectionOpen = (path: string) => openSections[path] ?? true;
  const pending = pendingForRoots(derivePending(projectEvents), roots).filter(
    (i) => !dismissedPending.has(i.key),
  );
  // Blocked-on-you items drive the urgent styling; completions are quiet.
  const urgentPending = pending.filter((i) => i.kind !== "idle");

  // Jump to the terminal running the agent that raised the item: prefer a
  // terminal whose PTY tree contains an agent process, then match by cwd.
  /** Focus the tab a given pty is running in, and flash it so the eye lands
   *  on which of several near-identical tabs just became active. */
  const jumpToPty = useCallback((ptyId: number) => {
    const target = tabsRef.current.find(
      (t): t is TermSubTab => t.type === "terminal" && t.ptyId === ptyId,
    );
    if (!target) return;
    setActiveTabId(target.id);
    setFlashTabId(target.id);
    window.setTimeout(() => setFlashTabId((c) => (c === target.id ? null : c)), 1200);
    setTimeout(() => termHandles.current.get(target.id)?.focus(), 50);
  }, []);

  const jumpToTerminal = useCallback(
    (item: PendingItem) => {
      const termTabs = tabsRef.current.filter(
        (t): t is TermSubTab => t.type === "terminal",
      );
      const agentPtyIds = new Set(
        stats
          .filter((s) => s.procs.some((p) => AGENT_PATTERN.test(p.name)))
          .map((s) => s.id),
      );
      const target =
        // The event's own pty stamp is an identity, not a guess — prefer it.
        termTabs.find((t) => t.ptyId != null && t.ptyId === item.pty) ??
        termTabs.find(
          (t) =>
            t.ptyId != null &&
            agentPtyIds.has(t.ptyId) &&
            (item.cwd === t.cwd || item.cwd.startsWith(t.cwd + "/")),
        ) ??
        termTabs.find((t) => t.ptyId != null && agentPtyIds.has(t.ptyId)) ??
        termTabs.find((t) => item.cwd === t.cwd || item.cwd.startsWith(t.cwd + "/")) ??
        termTabs[0];
      if (target) {
        setActiveTabId(target.id);
        setTimeout(() => termHandles.current.get(target.id)?.focus(), 50);
      }
    },
    [stats],
  );

  // Answer a questionnaire straight from the panel by synthesising the
  // keystrokes the user would type into the agent's terminal. Claude's ask UI
  // selects an option by its digit and confirms with Enter; a multi-question
  // form advances to the next question on each Enter and ends on a Submit tab
  // the final Enter presses; a multi-select question toggles each chosen digit
  // before its confirming Enter. `selections[q]` is the option index(es) picked
  // for question q — one for single-select, zero-or-more for multi-select.
  //
  // Keystrokes are spaced out: the TUI needs a beat to register a key and
  // repaint before the next lands. The card dismisses immediately — the hook
  // stream resolves it for real once the tool call completes, and the terminal
  // is right there if a key mis-lands (best-effort, by design).
  const answerQuestions = useCallback(
    (item: PendingItem, selections: number[][]) => {
      const termTabs = tabsRef.current.filter(
        (t): t is TermSubTab => t.type === "terminal",
      );
      const target =
        termTabs.find((t) => t.ptyId != null && t.ptyId === item.pty) ??
        termTabs.find((t) => item.cwd === t.cwd || item.cwd.startsWith(t.cwd + "/"));
      if (target?.ptyId == null) {
        onNotice("Can't find the terminal this question came from — answer there.");
        return;
      }
      const ptyId = target.ptyId;
      let delay = 0;
      const press = (keys: string) => {
        const at = delay;
        setTimeout(() => void ipc.ptyWrite(ptyId, keys), at);
        delay += 150;
      };
      for (const chosen of selections) {
        for (const oi of chosen) press(String(oi + 1)); // highlight/toggle option(s)
        press("\r"); // confirm this question (advances if more follow)
      }
      // A multi-question form ends on its Submit tab; the trailing Enter presses
      // it. A single question's Enter above already submitted, so no extra.
      if ((item.questions?.length ?? 0) > 1) press("\r");
      onDismissPending(item.key);
      setActiveTabId(target.id);
      setTimeout(() => termHandles.current.get(target.id)?.focus(), 50);
    },
    [onNotice, onDismissPending],
  );

  // Respond to a permission prompt straight from the panel by synthesising the
  // keystroke the user would type: Allow presses the accept option (first in
  // claude/codex's numbered prompt), Deny sends Escape — which cancels the tool
  // in both and can never miscount into a "yes, don't ask again". Same PTY-write
  // path as answerQuestion, so it inherits the same terminal-focus behaviour.
  const respondPermission = useCallback(
    (item: PendingItem, decision: "approve" | "deny") => {
      const termTabs = tabsRef.current.filter(
        (t): t is TermSubTab => t.type === "terminal",
      );
      const target =
        termTabs.find((t) => t.ptyId != null && t.ptyId === item.pty) ??
        termTabs.find((t) => item.cwd === t.cwd || item.cwd.startsWith(t.cwd + "/"));
      if (target?.ptyId == null) {
        onNotice("Can't find the terminal this prompt came from — answer there.");
        return;
      }
      const ptyId = target.ptyId;
      if (decision === "approve") {
        void ipc.ptyWrite(ptyId, "1");
        setTimeout(() => void ipc.ptyWrite(ptyId, "\r"), 150);
      } else {
        void ipc.ptyWrite(ptyId, "\x1b");
      }
      onDismissPending(item.key);
      setActiveTabId(target.id);
      setTimeout(() => termHandles.current.get(target.id)?.focus(), 50);
    },
    [onNotice, onDismissPending],
  );

  // Looking at the terminal clears its *calm* cards — a "finished" notice has
  // done its job once your eye is on the tab. But an urgent card (a question,
  // a permission prompt) is the agent BLOCKED on you: focusing the terminal is
  // not answering it, and clearing it there is exactly how a question vanishes
  // from the panel the moment you glance at the tab it's in — the bug where a
  // visible prompt never shows in "Needs your input". Those stay until they
  // self-resolve: the answer produces a later hook event, which clears the
  // card in derivePending. Manual ✕ is always available in the meantime.
  useEffect(() => {
    if (!visible || !activeTabId) return;
    const tab = tabsRef.current.find((t) => t.id === activeTabId);
    if (tab?.type !== "terminal" || tab.ptyId == null) return;
    for (const item of pending) {
      if (item.kind === "idle" && item.pty != null && item.pty === tab.ptyId) {
        onDismissPending(item.key);
      }
    }
  }, [activeTabId, visible, pending, onDismissPending]);

  // Switch the model of the Claude session running in this project by typing
  // `/model <name>` into its terminal — the same thing the user would type, so
  // the CLI's own confirmations and context-size warnings appear right there.
  // The terminal is focused afterwards so those warnings are actually seen.
  const setAgentModel = useCallback(
    (model: string) => {
      const termTabs = tabsRef.current.filter(
        (t): t is TermSubTab => t.type === "terminal",
      );
      const claudePtys = new Set(
        statsRef.current
          .filter((s) => s.procs.some((p) => /claude/i.test(p.name)))
          .map((s) => s.id),
      );
      const target = termTabs.find((t) => t.ptyId != null && claudePtys.has(t.ptyId));
      if (target?.ptyId == null) {
        onNotice("No running Claude session in this project.");
        return;
      }
      const ptyId = target.ptyId;
      void ipc.ptyWrite(ptyId, `/model ${model}`);
      // Enter goes separately, a beat later: the slash-command menu opens while
      // the text streams in, and an Enter in the same write can select the
      // menu's highlighted entry instead of submitting the typed command.
      setTimeout(() => void ipc.ptyWrite(ptyId, "\r"), 250);
      setActiveTabId(target.id);
      setTimeout(() => termHandles.current.get(target.id)?.focus(), 50);
    },
    [onNotice],
  );
  const hasClaude = projectStats.some((s) =>
    s.procs.some((p) => /claude/i.test(p.name)),
  );

  // Launch an agent CLI in the project's first component — or, if it isn't on
  // PATH, run its install command in a terminal and re-probe afterwards.
  /** Launch an agent CLI. `at` defaults to the first component; right-clicking a
   *  component header passes that component's path so it starts in the right
   *  directory rather than wherever the ＋ menu would have put it. */
  const launchCli = (cli: AgentCli, at?: string) => {
    const cwd = at ?? components[0]?.path;
    if (!cwd) return;
    if (installed[cli.bin]) {
      addTerminal(cwd, cli.bin, cli.name, cli.icon);
    } else {
      // A run tab, so the installer exits when done — and that exit is the
      // signal to re-probe (see onExited below). No timers, no staleness.
      addTerminal(cwd, cli.install, `install ${cli.name}`, "⬇", true);
    }
  };

  /** Run `cli`'s updater in a run tab. Its exit re-probes versions (see
   *  onExited), so the badge clears the moment the update lands — no timers. */
  const runCliUpdate = (cli: AgentCli, at?: string) => {
    const cwd = at ?? components[0]?.path;
    if (!cwd) return;
    addTerminal(cwd, updateCommand(cli), `update ${cli.name}`, "⬆", true);
  };

  /** The launcher list — shell plus every agent CLI — for a given directory.
   *  Shared by the ＋ menu, the empty-state grid and the component right-click
   *  menu so the three can't drift apart. */
  const launcherItems = (cwd: string): MenuItem[] => [
    {
      label: "Shell",
      icon: <TerminalIcon size={15} />,
      onClick: () => addTerminal(cwd),
    },
    { label: "", separator: true },
    ...AGENT_CLIS.map((cli) => ({
      label: cli.name,
      icon: <AgentIcon id={cli.id} size={15} />,
      // A context-menu row has one click target, so the update hint here is
      // informational — the ＋ menu and launch grid carry the clickable badge.
      hint: installed[cli.bin]
        ? cliUpdates[cli.bin]?.hasUpdate
          ? `⇡ ${cliUpdates[cli.bin]?.latest}`
          : undefined
        : "install",
      onClick: () => launchCli(cli, cwd),
    })),
  ];

  const compMenu = useContextMenu();
  const tabMenu = useContextMenu();

  const submitRootCreate = async () => {
    if (!rootCreate) return;
    const name = rootCreate.value.trim();
    const { dir, kind } = rootCreate;
    setRootCreate(null);
    if (!name || name.includes("/")) return;
    const target = `${dir}/${name}`;
    try {
      if (kind === "file") {
        await ipc.fsCreateFile(target);
        void openFile(target);
      } else {
        await ipc.fsCreateDir(target);
      }
    } catch (e) {
      onNotice(String(e), "error");
    }
  };

  const startRename = (tab: TermSubTab) => {
    setRenamingTabId(tab.id);
    setRenameDraft(tab.customTitle ?? tab.title);
  };
  // Empty draft clears the custom name and falls back to the auto title.
  const commitRename = () => {
    if (renamingTabId) patchTab(renamingTabId, { customTitle: renameDraft.trim() || undefined });
    setRenamingTabId(null);
  };

  // Agents are the crux of this IDE, so they own the main strip. Detection is
  // by launch command OR by what's actually running in the pty tree, so a
  // `claude` typed by hand into a shell promotes that tab too. Plain shells and
  // long-running commands are demoted to their own right-hand rails (below);
  // reference docs (files, PRs, tickets) form a quieter group after the agents.
  const agentPtyIds = new Set(
    projectStats
      .filter((s) => s.procs.some((p) => AGENT_PATTERN.test(p.name)))
      .map((s) => s.id),
  );
  const isAgentTab = (t: SubTab): t is TermSubTab =>
    t.type === "terminal" &&
    (AGENT_PATTERN.test(t.command ?? "") ||
      (t.ptyId != null && agentPtyIds.has(t.ptyId)));
  const stripTabs = tabs.filter((t) => t.type !== "terminal" || !t.run);
  const shellTabs = stripTabs.filter(
    (t): t is TermSubTab => t.type === "terminal" && !isAgentTab(t),
  );
  const tabGroups: SubTab[][] = [
    stripTabs.filter(isAgentTab),
    stripTabs.filter((t) => t.type !== "terminal"),
  ];
  // Shells and runs each get a compact rail; Rail collapses to a dropdown at 2+.
  const shellChips: RailChip[] = shellTabs.map((tab) => ({
    id: tab.id,
    active: tab.id === activeTabId,
    dot: <TerminalIcon size={11} className="run-chip-shell-dot" />,
    title: tab.customTitle ?? tab.title,
    tooltip: `${tab.command ?? "shell"} — ${tab.cwd}`,
    onSelect: () => setActiveTabId(tab.id),
    onClose: () => closeTab(tab.id),
  }));
  const runChips: RailChip[] = runTabs.map((tab) => {
    const ok = tab.exitCode === 0;
    const state = !tab.exited ? "live" : ok ? "done" : "failed";
    return {
      id: tab.id,
      active: tab.id === activeTabId,
      className: `run-chip-${state}`,
      dot: !tab.exited ? (
        <LiveDot size={7} className="run-chip-dot" />
      ) : ok ? (
        <CheckIcon size={11} className="run-chip-ok" />
      ) : (
        <FailIcon size={11} className="run-chip-fail" />
      ),
      title: tab.title,
      tooltip: tab.exited
        ? `${ok ? "finished" : `exited ${tab.exitCode ?? "?"}`} — ${tab.command ?? ""}`
        : `running — ${tab.command ?? ""}`,
      action: tab.exited ? (
        <button
          className="icon-btn run-chip-btn"
          title="Run again"
          onClick={(e) => {
            e.stopPropagation();
            restartRun(tab.id);
          }}
        >
          <RestartIcon size={11} />
        </button>
      ) : undefined,
      onSelect: () => setActiveTabId(tab.id),
      onClose: () => closeTab(tab.id),
    };
  });
  // One summary glyph for the runs dropdown: any live wins, then any failure.
  const runSummary = runTabs.some((t) => !t.exited) ? (
    <LiveDot size={7} className="run-chip-dot" />
  ) : runTabs.some((t) => t.exitCode !== 0) ? (
    <FailIcon size={11} className="run-chip-fail" />
  ) : (
    <CheckIcon size={11} className="run-chip-ok" />
  );

  // Agent terminals that can receive a ticket, shared by the Issues panel and
  // the ticket tab.
  const agentTargets: AgentTarget[] = tabs
    .filter(
      (t): t is TermSubTab =>
        t.type === "terminal" && !t.run && isAgentTab(t) && t.ptyId != null,
    )
    .map((t) => {
      // Which CLI is actually in there: the process tree first (it knows even
      // when the agent was typed by hand into a plain shell), then the launch
      // command as a fallback.
      const procs = projectStats.find((s) => s.id === t.ptyId)?.procs ?? [];
      const byProc = AGENT_CLIS.find((c) =>
        procs.some((p) => p.name === c.bin || p.cmd.split(" ")[0]?.endsWith(c.bin)),
      );
      const byCommand = AGENT_CLIS.find((c) => (t.command ?? "").startsWith(c.bin));
      return {
        tabId: t.id,
        title: t.customTitle ?? t.title,
        ptyId: t.ptyId as number,
        agentId: (byProc ?? byCommand)?.id ?? "agent",
        dir: t.cwd.split("/").filter(Boolean).pop() ?? "",
      };
    });

  const mainArea = (
    <div className="project-main">
      {tabMenu.menu && (
        <ContextMenu
          x={tabMenu.menu.x}
          y={tabMenu.menu.y}
          items={tabMenu.menu.items}
          onClose={tabMenu.close}
        />
      )}
      <div className="pane-bar">
        <div className="tabs">
          {tabGroups.map((group, gi) =>
            group.length === 0 ? null : (
              <div className="tab-group" key={gi}>
                {group.map((tab) => (
              <div
                key={tab.id}
                ref={tab.id === activeTabId ? activeTabElRef : undefined}
                className={`tab ${tab.id === activeTabId ? "tab-active" : ""} ${
                  (tab.type === "terminal" || tab.type === "chat") && tab.unread
                    ? "tab-unread"
                    : ""
                } ${tab.type !== "terminal" ? "tab-doc" : isAgentTab(tab) ? "tab-agent" : ""} ${
                  tab.id === flashTabId ? "tab-flash" : ""
                }`}
                onClick={(e) => {
                  // e.detail is the click count and fires even though app chrome
                  // is user-select:none — unlike dblclick, which WebKit drops on
                  // non-selectable text. Second click on a terminal tab renames.
                  if (tab.type === "terminal" && e.detail === 2) startRename(tab);
                  else setActiveTabId(tab.id);
                }}
                onContextMenu={(e) => {
                  const items: MenuItem[] =
                    tab.type === "terminal"
                      ? [
                          { label: "Rename", onClick: () => startRename(tab) },
                          { label: "Close", danger: true, onClick: () => closeTab(tab.id) },
                        ]
                      : [{ label: "Close", danger: true, onClick: () => closeTab(tab.id) }];
                  tabMenu.open(e, items);
                }}
                title={
                  tab.type === "terminal"
                    ? `${tab.notice ? `${tab.notice}\n` : ""}${tab.command ?? ""} — ${tab.cwd}`
                    : tab.type === "pr"
                      ? `${tab.pr.title} — ${tab.pr.url}`
                      : tab.type === "ticket"
                        ? `${tab.ticket.id} — ${tab.ticket.title}\n${tab.ticket.url}`
                        : tab.type === "commit"
                          ? `${tab.short} — ${tab.subject}`
                          : tab.type === "branch"
                            ? `${tab.branch.branch}\n${tab.branch.worktree ?? "no worktree"}`
                            : tab.type === "chat"
                              ? tab.peer === null
                                ? "Team chat — everyone on the relay"
                                : `Direct chat with ${tab.name}`
                              : tab.type === "collab"
                                ? `${tab.name} — live, owned by ${tab.ownerName}`
                                : tab.type === "review"
                                  ? `Review from ${tab.review.from}: ${tab.review.title}`
                                  : tab.type === "shared-project"
                                    ? `${tab.name} — shared live by ${tab.ownerName}`
                                    : tab.file.path
                }
              >
                {tab.type === "terminal" ? (
                  <span className="tab-term-icon">
                    {isAgentTab(tab) && <LiveDot size={6} className="tab-agent-live" />}
                    {tab.icon ?? "❯_"}
                  </span>
                ) : tab.type === "pr" ? (
                  <PullRequestIcon size={12} className="tab-pr-icon" />
                ) : tab.type === "ticket" ? (
                  <TrackerIcon id={tab.source} size={12} className="tab-ticket-icon" />
                ) : tab.type === "commit" ? (
                  <CommitIcon size={12} className="tab-commit-icon" />
                ) : tab.type === "branch" ? (
                  <GitBranchIcon size={12} className="tab-branch-icon" />
                ) : tab.type === "chat" ? (
                  <TeamIcon size={12} className="tab-chat-icon" />
                ) : tab.type === "collab" ? (
                  <TeamIcon size={12} className="tab-collab-icon" />
                ) : tab.type === "review" ? (
                  <PullRequestIcon size={12} className="tab-pr-icon" />
                ) : tab.type === "shared-project" ? (
                  <LiveShareIcon size={12} className="tab-collab-icon" />
                ) : (
                  <>
                    {/* Live-collaborated file: a teammate is editing this one,
                        distinct from a plain unsaved dot. */}
                    {tab.type === "file" && collabPaths.has(tab.file.path) && (
                      <TeamIcon size={11} className="tab-collab-icon" />
                    )}
                    {tab.file.external != null && <span className="tab-external">●</span>}
                  </>
                )}
                {tab.type === "terminal" && renamingTabId === tab.id ? (
                  <input
                    className="tab-rename-input"
                    autoFocus
                    value={renameDraft}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenamingTabId(null);
                      }
                    }}
                  />
                ) : (
                  <span
                    className="tab-title"
                    title={tab.type === "terminal" ? "Double-click or right-click to rename" : undefined}
                  >
                    {tab.type === "terminal"
                      ? (tab.customTitle ?? tab.title)
                      : tab.type === "pr"
                        ? `#${tab.pr.number} ${tab.pr.title}`
                        : tab.type === "ticket"
                          ? `${tab.ticket.id} ${tab.ticket.title}`
                          : tab.type === "commit"
                            ? `${tab.short} ${tab.subject}`
                            : tab.type === "branch"
                              ? tab.branch.branch
                              : tab.type === "chat"
                                ? tab.name
                                : tab.type === "collab"
                                  ? `${tab.name} ⇄`
                                  : tab.type === "review"
                                    ? tab.review.title
                                    : tab.type === "shared-project"
                                      ? tab.name
                                      : `${tab.file.name}${tab.file.dirty ? " •" : ""}`}
                  </span>
                )}
                <span
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  ✕
                </span>
              </div>
                ))}
              </div>
            ),
          )}
        </div>
        {/* Plain shells and long-running commands aren't the hero — they live
            in compact right-hand rails, each collapsing to a dropdown at 2+. */}
        <Rail
          label="SHELLS"
          chips={shellChips}
          summary={<TerminalIcon size={11} className="run-chip-shell-dot" />}
          open={shellMenuOpen}
          setOpen={setShellMenuOpen}
        />
        <Rail
          label="RUNS"
          chips={runChips}
          summary={runSummary}
          open={runMenuOpen}
          setOpen={setRunMenuOpen}
        />
        <div className="pane-actions">
          {/* Jump to any open tab — the strip caps tab width and scrolls, so a
              crowded strip stays navigable without hunting. */}
          {stripTabs.length > 4 && (
            <button
              className="btn-icon"
              title="All open tabs"
              onClick={(e) =>
                tabMenu.open(
                  e,
                  stripTabs.map((t) => ({
                    label: `${t.id === activeTabId ? "› " : ""}${tabDisplayLabel(t)}`,
                    onClick: () => setActiveTabId(t.id),
                  })),
                )
              }
            >
              ⌄
            </button>
          )}
          {/* Live share. Offered for any open file on a live relay with a
              teammate connected — whatever the file is, if it has a text buffer
              it can be edited together; shareFileLive reports the rare case
              (e.g. a binary preview) with no buffer to synchronise. */}
          {activeTab?.type === "file" &&
            relay.status.role !== "off" &&
            relay.status.members.some((m) => m.id !== relay.status.self_id) && (
              <div className="cli-menu-anchor">
                <button
                  className={`btn btn-icon-text ${shared.current.has(activeTab.file.path) ? "btn-accent" : ""}`}
                  title="Edit this file live with a teammate"
                  onClick={() => setShareMenuOpen((v) => !v)}
                >
                  <LiveShareIcon size={14} />
                  {shared.current.has(activeTab.file.path) ? "Sharing" : "Share live"}
                </button>
                {shareMenuOpen && (
                  <div className="cli-menu" onMouseLeave={() => setShareMenuOpen(false)}>
                    {relay.status.members
                      .filter((m) => m.id !== relay.status.self_id)
                      .map((m) => (
                        <div
                          key={m.id}
                          className="cli-item"
                          onClick={() => {
                            setShareMenuOpen(false);
                            shareFileLive(
                              activeTab.file.path,
                              activeTab.file.name,
                              m.id,
                              m.name,
                            );
                          }}
                        >
                          <span>
                            <TeamIcon size={15} className="cli-icon" /> {m.name}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
          {/* Share the whole project: a teammate browses the tree and opens any
              file live. Available whenever the relay has a teammate, regardless
              of what tab is in front. Stopping is done from the "Collaborating"
              pill in the titlebar, not here — one place to end a session. */}
          {relay.status.role !== "off" &&
            relay.status.members.some((m) => m.id !== relay.status.self_id) && (
              <div className="cli-menu-anchor">
                <button
                  className={`btn btn-icon-text ${
                    relay.collab.ownedProjectFor(roots[0] ?? "") ? "btn-accent" : ""
                  }`}
                  title="Share this whole project live — teammates open any file to edit together"
                  onClick={() => setShareProjectMenuOpen((v) => !v)}
                >
                  <LiveShareIcon size={14} />
                  {relay.collab.ownedProjectFor(roots[0] ?? "") ? "Sharing project" : "Share project"}
                </button>
                {shareProjectMenuOpen &&
                  (() => {
                    const sharedWith = relay.collab.projectSharedWith(roots[0] ?? "");
                    return (
                      <div className="cli-menu" onMouseLeave={() => setShareProjectMenuOpen(false)}>
                        {relay.status.members
                          .filter((m) => m.id !== relay.status.self_id)
                          .map((m) => {
                            const already = sharedWith.has(m.id);
                            return (
                              <div
                                key={m.id}
                                className={`cli-item ${already ? "cli-item-done" : ""}`}
                                onClick={() => {
                                  if (already) return;
                                  setShareProjectMenuOpen(false);
                                  shareProjectLive(m.id, m.name);
                                }}
                              >
                                <span>
                                  <TeamIcon size={15} className="cli-icon" /> {m.name}
                                </span>
                                {already && <span className="cli-item-tick">✓ sharing</span>}
                              </div>
                            );
                          })}
                      </div>
                    );
                  })()}
              </div>
            )}
          {activeTab?.type === "file" &&
            ["markdown", "html", "notebook", "sheet", "json"].includes(activeTab.file.kind) && (
              <button className="btn" onClick={() => toggleView(activeTab.file.path)}>
                {activeTab.file.view === "preview" ? "Source" : "Preview"}
              </button>
            )}
          {activeTab?.type === "terminal" && (
            <>
              <button
                className="btn-icon"
                title="Clear scrollback"
                onClick={() => termHandles.current.get(activeTab.id)?.clearScrollback()}
              >
                ⌫
              </button>
              <button
                className="btn-icon"
                title="Hard reset"
                onClick={() => termHandles.current.get(activeTab.id)?.hardReset()}
              >
                ↺
              </button>
            </>
          )}
          <div className="cli-menu-anchor">
            <button
              className="btn"
              title="New terminal / agent"
              onClick={() => {
                // Opening the launcher re-probes, so a CLI installed outside
                // Canopy (or in another project) shows as installed here —
                // and its update badge reflects that install, not a stale one.
                if (!cliMenuOpen) {
                  refreshInstalled();
                  refreshUpdates();
                }
                setCliMenuOpen((v) => !v);
              }}
            >
              ＋ ▾
            </button>
            {cliMenuOpen && (
              <div className="cli-menu" onMouseLeave={() => setCliMenuOpen(false)}>
                <div
                  className="cli-item"
                  onClick={() => {
                    setCliMenuOpen(false);
                    if (components[0]) addTerminal(components[0].path);
                  }}
                >
                  <span>
                    <TerminalIcon size={15} className="cli-icon" /> Shell
                  </span>
                </div>
                <div className="cli-sep" />
                {AGENT_CLIS.map((cli) => (
                  <div
                    key={cli.id}
                    className="cli-item"
                    onClick={() => {
                      setCliMenuOpen(false);
                      launchCli(cli);
                    }}
                  >
                    <span>
                      <AgentIcon id={cli.id} size={15} className="cli-icon" /> {cli.name}
                    </span>
                    {!installed[cli.bin] && <span className="cli-install">install</span>}
                    {installed[cli.bin] && cliUpdates[cli.bin]?.hasUpdate && (
                      <span
                        className="cli-update"
                        title={`${cliUpdates[cli.bin]?.installed} → ${cliUpdates[cli.bin]?.latest} — click to update`}
                        onClick={(e) => {
                          // The row launches; only the badge updates.
                          e.stopPropagation();
                          setCliMenuOpen(false);
                          runCliUpdate(cli);
                        }}
                      >
                        ⇡ {cliUpdates[cli.bin]?.latest}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="project-content">
        {tabs
          .filter((t): t is TermSubTab => t.type === "terminal")
          .map((tab) => (
            <div
              key={tab.id}
              className="fill term-host"
              style={{ display: tab.id === activeTabId && visible ? "block" : "none" }}
            >
              <TermPorts ptyId={tab.ptyId} stats={stats} />
              <Term
                // epoch remounts the Term (fresh PTY) when a run tab restarts
                key={`${tab.id}:${tab.epoch ?? 0}`}
                ref={(h) => {
                  termHandles.current.set(tab.id, h);
                }}
                cwd={tab.cwd}
                active={tab.id === activeTabId && visible}
                // A run tab's shell exits with its command's status, so the
                // exit code below is the command's own — that's what makes
                // one-shot runs (build, install) report truthfully instead of
                // sitting at a prompt looking "running" forever.
                initialCommand={
                  tab.run && tab.command ? `${tab.command}; exit $?` : tab.command
                }
                onSpawned={(ptyId) =>
                  // A freshly spawned pty is alive by definition, so clear any
                  // stale exited/failed state. Restart kills the old pty and
                  // remounts a beat later; that kill's late pty:exit can land in
                  // the gap and wrongly mark the tab failed while THIS new
                  // process is the one now running (a red ✕ on a live server).
                  patchTab(tab.id, { ptyId, exited: false, exitCode: undefined })
                }
                onExited={(code) => {
                  // Shell tabs close on exit; run tabs stay so the output and
                  // exit status remain readable.
                  if (tab.run) {
                    patchTab(tab.id, { exited: true, exitCode: code, ptyId: null });
                    // An installer or updater finishing is the moment
                    // "install" labels and update badges go stale — re-probe
                    // right now, not on a timer.
                    if (
                      AGENT_CLIS.some(
                        (c) => c.install === tab.command || updateCommand(c) === tab.command,
                      )
                    ) {
                      refreshInstalled();
                      refreshUpdates();
                    }
                  } else closeTab(tab.id);
                }}
                onTitle={(title) => patchTab(tab.id, { title: title || tab.command || "shell" })}
                onNotify={(notice) =>
                  // Only unread if you aren't already looking at it — a ring on
                  // the tab you're watching is noise.
                  patchTab(tab.id, {
                    notice,
                    unread: !(tab.id === activeTabId && visible),
                  })
                }
              />
            </div>
          ))}
        {/* A non-terminal view throwing (a PR diff, an editor, a ticket) must
            not take the app — or the running terminals beside it — down. Keyed
            by tab so switching away from a crashed view clears the fallback.
            Terminals stay outside: they're display-toggled, not unmounted, and
            catching here would kill their PTYs. */}
        <ErrorBoundary key={activeTab?.id ?? "none"} label="this tab">
        {activeTab?.type === "branch" && (
          <BranchView
            relay={relay}
            key={activeTab.id}
            repo={activeTab.repo}
            branch={activeTab.branch}
            onOpenCommit={openCommit}
            onOpenTerminal={(cwd, label) => addTerminal(cwd, undefined, label)}
            onNotice={onNotice}
          />
        )}
        {activeTab?.type === "commit" && (
          <CommitView
            key={activeTab.id}
            repo={activeTab.repo}
            hash={activeTab.hash}
            onNotice={onNotice}
          />
        )}
        {activeTab?.type === "ticket" && (
          <TicketView
            key={activeTab.id}
            ticket={activeTab.ticket}
            source={activeTab.source}
            worktree={ticketWorktree(activeTab.ticket, ticketWorktrees)}
            agentTargets={agentTargets}
          installed={installed}
            onStartNew={(agentId) => void startTicketWork(activeTab.ticket, agentId)}
            onSendToAgent={(target) =>
              sendTicketToAgent(target, ticketContext(activeTab.ticket))
            }
          />
        )}
        {activeTab?.type === "pr" && (
          <PrView
            key={activeTab.id}
            repo={activeTab.repo}
            pr={activeTab.pr}
            onNotice={onNotice}
            relay={relay}
          />
        )}
        {activeTab?.type === "review" && (
          <ReviewView key={activeTab.id} review={activeTab.review} />
        )}
        {activeTab?.type === "chat" && (
          <ChatView
            key={activeTab.id}
            peer={activeTab.peer}
            title={activeTab.name}
            relay={relay}
            onNotice={onNotice}
          />
        )}
        {activeTab?.type === "collab" &&
          (() => {
            const session = relay.collab.get(activeTab.doc);
            return session instanceof GuestSession ? (
              <CollabView
                key={activeTab.id}
                session={session}
                ownerName={activeTab.ownerName}
                onNotice={onNotice}
              />
            ) : (
              <div className="editor-empty">
                <h2>{activeTab.name}</h2>
                <p>This live session has ended.</p>
              </div>
            );
          })()}
        {activeTab?.type === "shared-project" && (
          <SharedProjectView
            key={activeTab.id}
            name={activeTab.name}
            ownerName={activeTab.ownerName}
            paths={relay.collab.joinedProjects.get(activeTab.doc)?.paths ?? []}
            onOpen={(relPath) => relay.collab.openProjectFile(activeTab.doc, relPath)}
          />
        )}
        {activeTab?.type === "file" && (
          <FileView
            key={activeTab.id}
            file={activeTab.file}
            onCursor={
              // Only a shared file broadcasts a caret; every other tab passes
              // undefined and the subscription in MonacoEditor short-circuits.
              sharedDocFor(activeTab.file.path)
                ? (anchor, head) => sendOwnerCursor(activeTab.file.path, anchor, head)
                : undefined
            }
            onSave={() => void saveFile(activeTab.file.path)}
            onDirty={(dirty) => {
              if (activeTab.file.dirty !== dirty) patchFile(activeTab.file.path, { dirty });
            }}
            onAcceptExternal={() => acceptExternal(activeTab.file.path)}
            onKeepMine={() => keepMine(activeTab.file.path)}
            onCloseDiff={() =>
              patchFile(activeTab.file.path, { view: "source", diffOriginal: null })
            }
          />
        )}
        </ErrorBoundary>
        {tabs.length === 0 && (
          <div className="editor-empty">
            <h2>{project.name}</h2>
            {/* Same launchers as the ＋ menu, surfaced where the eye already is. */}
            <div className="launch-grid">
              <button
                className="launch-card"
                onClick={() => components[0] && addTerminal(components[0].path)}
              >
                <TerminalIcon size={26} />
                <span>Shell</span>
              </button>
              {AGENT_CLIS.map((cli) => (
                <button
                  key={cli.id}
                  className="launch-card"
                  onClick={() => launchCli(cli)}
                  title={installed[cli.bin] ? cli.bin : `not installed — runs: ${cli.install}`}
                >
                  <AgentIcon id={cli.id} size={26} />
                  <span>{cli.name}</span>
                  {!installed[cli.bin] && <span className="launch-install">install</span>}
                  {installed[cli.bin] && cliUpdates[cli.bin]?.hasUpdate && (
                    <span
                      className="launch-update"
                      title={`${cliUpdates[cli.bin]?.installed} → ${cliUpdates[cli.bin]?.latest} — click to update`}
                      onClick={(e) => {
                        // The card launches; only the badge updates. A span
                        // because a button can't nest inside the card button.
                        e.stopPropagation();
                        runCliUpdate(cli);
                      }}
                    >
                      ⇡ {cliUpdates[cli.bin]?.latest}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {(restorable.length > 0 ||
              freshAgents.length > 0 ||
              rememberedShells.length > 0) && (
              <div className="resume-block">
                <div className="resume-head">
                  <span>
                    Pick up where you left off
                    <span className="badge">
                      {restorable.length + freshAgents.length + rememberedShells.length}
                    </span>
                  </span>
                  <span className="resume-head-actions">
                    <button
                      className="btn"
                      title="Reopen everything below — agent sessions with their history, terminals with their command"
                      onClick={() => {
                        restorable.forEach(resumeSession);
                        freshAgents.forEach(reopenTerminal);
                        rememberedShells.forEach(reopenTerminal);
                      }}
                    >
                      Restore all
                    </button>
                    <button
                      className="btn-icon"
                      title="Forget everything here — remembered terminals and restorable agent sessions — for this project"
                      onClick={() => {
                        forgetTerminals(project.id);
                        setRemembered([]);
                        forgetSessions(restorable.map((r) => r.digest));
                        setRestorable([]);
                      }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
                {restorable.length > 0 &&
                  (freshAgents.length > 0 || rememberedShells.length > 0) && (
                    <div className="resume-subhead">Agent sessions — resume with history</div>
                  )}
                {restorable.map((r) => (
                  <div
                    key={r.digest.session_id}
                    className={`resume-row ${r.command ? "resume-row-click" : ""}`}
                    title={`${r.agentId} · ${r.cwd}`}
                    onClick={() => resumeSession(r)}
                  >
                    <AgentIcon id={r.agentId} size={14} />
                    <span className="resume-prompt">
                      {r.prompt || <em>(no prompt captured)</em>}
                    </span>
                    <span className="resume-dir">
                      {r.cwd.split("/").filter(Boolean).pop()}
                    </span>
                    {r.digest.branch && (
                      <span className="resume-branch">⑂ {r.digest.branch}</span>
                    )}
                    <span className="resume-age">{ago(r.digest.updated)}</span>
                    {r.command ? (
                      <button
                        className="btn-mini btn-accent"
                        title={r.command}
                        onClick={(e) => {
                          e.stopPropagation();
                          resumeSession(r);
                        }}
                      >
                        Resume
                      </button>
                    ) : (
                      <span className="resume-unsupported">can't resume</span>
                    )}
                    <button
                      className="btn-icon resume-forget"
                      title="Forget this session — stops it resurfacing unless it's used again"
                      onClick={(e) => {
                        e.stopPropagation();
                        forgetSessions([r.digest]);
                        setRestorable((prev) =>
                          prev.filter((x) => x.digest.session_id !== r.digest.session_id),
                        );
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}

                {freshAgents.length > 0 && (
                  <>
                    <div className="resume-subhead">
                      Agents — started fresh, no history to resume
                    </div>
                    {freshAgents.map((t, i) => {
                      const cli = AGENT_CLIS.find((c) => (t.command ?? "").startsWith(c.bin));
                      return (
                        <div
                          key={`a-${t.cwd}-${i}`}
                          className="resume-row resume-row-click"
                          title={`${t.command ?? ""} — ${t.cwd}`}
                          onClick={() => reopenTerminal(t)}
                        >
                          <AgentIcon id={cli?.id ?? "agent"} size={14} />
                          <span className="resume-prompt">{cli?.name ?? t.title}</span>
                          <span className="resume-dir">
                            {t.cwd.split("/").filter(Boolean).pop()}
                          </span>
                          <button
                            className="btn-mini"
                            onClick={(e) => {
                              e.stopPropagation();
                              reopenTerminal(t);
                            }}
                          >
                            Start
                          </button>
                        </div>
                      );
                    })}
                  </>
                )}

                {rememberedShells.length > 0 && (
                  <>
                    {(restorable.length > 0 || freshAgents.length > 0) && (
                      <div className="resume-subhead">
                        Terminals — reopened running their command again
                      </div>
                    )}
                    {rememberedShells.map((t, i) => (
                      <div
                        key={`t-${t.cwd}-${t.command ?? ""}-${i}`}
                        className="resume-row resume-row-click"
                        title={`${t.command ?? "shell"} — ${t.cwd}`}
                        onClick={() => reopenTerminal(t)}
                      >
                        <TerminalIcon size={13} />
                        <span className="resume-prompt">
                          {t.command ? <code>{t.command}</code> : <em>shell</em>}
                        </span>
                        <span className="resume-dir">
                          {t.cwd.split("/").filter(Boolean).pop()}
                        </span>
                        {t.run && <span className="resume-branch">run</span>}
                        <button
                          className="btn-mini"
                          onClick={(e) => {
                            e.stopPropagation();
                            reopenTerminal(t);
                          }}
                        >
                          Reopen
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <StatusBar
        roots={roots}
        agents={runningAgents}
        events={projectEvents}
        visible={visible}
        projects={allProjects}
        onSetModel={hasClaude ? setAgentModel : undefined}
        activePtyId={activeTab?.type === "terminal" ? activeTab.ptyId : null}
      />
    </div>
  );

  const sidePanel = (
    <div className="sidebar">
      {compMenu.menu && (
        <ContextMenu
          x={compMenu.menu.x}
          y={compMenu.menu.y}
          items={compMenu.menu.items}
          onClose={compMenu.close}
        />
      )}
      {rootCreate && (
        <div className="confirm-backdrop" onMouseDown={() => setRootCreate(null)}>
          <div className="confirm" onMouseDown={(e) => e.stopPropagation()}>
            <p>
              New {rootCreate.kind === "dir" ? "folder" : "file"} in{" "}
              <strong>{rootCreate.dir.split("/").pop()}</strong>
            </p>
            <input
              autoFocus
              className="git-branch-input"
              placeholder={rootCreate.kind === "dir" ? "folder name" : "name.ext"}
              value={rootCreate.value}
              onChange={(e) => setRootCreate((p) => (p ? { ...p, value: e.target.value } : p))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitRootCreate();
                }
              }}
            />
            <div className="confirm-actions">
              <button className="btn" onClick={() => setRootCreate(null)}>
                Cancel
              </button>
              <button className="btn btn-accent" onClick={() => void submitRootCreate()}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
      {sideTab === "files" && (
        <div
          className="components-panel"
          // The empty area below the file list still belongs to the last
          // component's tree. FileTree rows/containers stopPropagation, so this
          // fires only for genuinely blank space.
          onContextMenu={(e) => {
            const dir = components[components.length - 1]?.path;
            if (!dir) return;
            compMenu.open(e, [
              { label: "New File…", onClick: () => setRootCreate({ dir, kind: "file", value: "" }) },
              { label: "New Folder…", onClick: () => setRootCreate({ dir, kind: "dir", value: "" }) },
            ]);
          }}
        >
          <div className="side-panel-head">
            <span>Components</span>
            <button className="btn-icon" title="Edit project" onClick={onEdit}>
              ⚙
            </button>
          </div>
          {/* Which checkout these files come from. Always visible while a
              worktree is active, so you can never edit the wrong tree without
              knowing it. */}
          {worktreeEnv && (
            <div
              className="wt-env-tag"
              title={`Files, search and new terminals are using this worktree:\n${worktreeEnv.path}`}
            >
              <span className="wt-env-mark">⑂</span>
              <span className="wt-env-branch">{worktreeEnv.branch}</span>
              <button
                className="icon-btn"
                title="Leave this worktree — go back to the main checkout"
                onClick={() => setWorktreeEnv(null)}
              >
                ✕
              </button>
            </div>
          )}
          {components.map((c) => (
            <div key={c.path} className="component-section">
              <div
                className="component-header"
                onClick={() => setOpenSections((prev) => ({ ...prev, [c.path]: !sectionOpen(c.path) }))}
                onContextMenu={(e) => compMenu.open(e, launcherItems(c.path))}
              >
                <span className="tree-chevron">{sectionOpen(c.path) ? "▾" : "▸"}</span>
                <span className="component-title">{c.label}</span>
                <span className="component-actions">
                  <button
                    className="icon-btn"
                    title={`New terminal in ${c.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      addTerminal(c.path);
                    }}
                  >
                    <TerminalIcon size={13} />
                  </button>
                </span>
              </div>
              {sectionOpen(c.path) && (
                <>
                  {(c.commands ?? []).filter((cmd) => cmd.command.trim()).length > 0 && (
                    <div className="component-commands">
                      {(c.commands ?? [])
                        .filter((cmd) => cmd.command.trim())
                        .map((cmd) => {
                          const tab = tabs.find(
                            (t): t is TermSubTab =>
                              t.type === "terminal" &&
                              Boolean(t.run) &&
                              t.cwd === c.path &&
                              t.command === cmd.command,
                          );
                          // An open-but-finished tab isn't running: one-shot
                          // commands end on their own and must say so.
                          const running = tab && !tab.exited ? tab : undefined;
                          const finished = tab?.exited ? tab : undefined;
                          const start = () =>
                            tab
                              ? restartRun(tab.id)
                              : addTerminal(c.path, cmd.command, cmd.name || cmd.command, "▶", true);
                          const ok = finished?.exitCode === 0;
                          return (
                            <div
                              key={cmd.name + cmd.command}
                              className={`command-run-row ${running ? "command-running" : ""} ${
                                finished ? (ok ? "command-done" : "command-failed") : ""
                              }`}
                              title={
                                running
                                  ? `running — ${cmd.command}`
                                  : finished
                                    ? `${ok ? "finished" : `exited ${finished.exitCode ?? "?"}`} — ${cmd.command}`
                                    : cmd.command
                              }
                              onClick={() => (tab ? setActiveTabId(tab.id) : start())}
                            >
                              {running ? (
                                <LiveDot size={9} className="command-live-dot" />
                              ) : finished ? (
                                ok ? (
                                  <CheckIcon size={11} className="command-ok" />
                                ) : (
                                  <FailIcon size={11} className="command-fail" />
                                )
                              ) : (
                                <PlayIcon size={11} className="command-play" />
                              )}
                              <span className="command-run-name">{cmd.name || cmd.command}</span>
                              {finished && !ok && (
                                <span className="command-exit-code">{finished.exitCode}</span>
                              )}
                              <span
                                className="command-run-actions"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {running ? (
                                  <>
                                    <button
                                      className="icon-btn"
                                      title="Restart"
                                      onClick={() => restartRun(running.id)}
                                    >
                                      <RestartIcon size={14} />
                                    </button>
                                    <button
                                      className="icon-btn icon-btn-danger"
                                      title="Stop"
                                      onClick={() => {
                                        if (running.ptyId != null) void ipc.ptyKill(running.ptyId);
                                      }}
                                    >
                                      <StopIcon size={13} />
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    className="icon-btn"
                                    title={finished ? "Run again" : "Run"}
                                    onClick={start}
                                  >
                                    {finished ? <RestartIcon size={14} /> : <PlayIcon size={12} />}
                                  </button>
                                )}
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  )}
                  <FileTree
                    roots={[c.path]}
                    changedPaths={changedPaths}
                    onOpenFile={(p) => void openFile(p)}
                    onNotice={onNotice}
                    hideRootHeader
                  />
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {sideTab === "git" && (
        <GitPanel
          components={project.components.map((c) => ({ label: c.label, path: c.path }))}
          activeWorktree={worktreeEnv?.path ?? null}
          onUseWorktree={(repo, path, branch) => {
            void ipc.workspaceAdd(path).catch(() => {});
            setWorktreeEnv({ repo, path, branch });
            setSideTab("files");
          }}
          onOpenDiff={(_repo, f) => void openFile(f.abs, { diff: true })}
          onOpenPr={(repo, pr) => openPr(repo, pr)}
          onOpenCommit={openCommit}
          onOpenBranch={openBranch}
          onOpenTerminal={(cwd, label) => addTerminal(cwd, undefined, label)}
          onNotice={onNotice}
        />
      )}
      {sideTab === "changes" && (
        <ChangesPanel
          groups={changeGroups}
          loading={changesLoading}
          onOpen={(p) => void openFile(p, { diff: true })}
          onRefresh={() => void refreshChanges()}
          collab={collabChanges}
          onOpenCollab={(p) => void openFile(p, { diff: true })}
          onSaveCollab={(p) =>
            void saveFile(p).then(() => {
              relay.collab.markOwnerSaved(p);
              void refreshChanges();
            })
          }
        />
      )}
      {sideTab === "trackers" && (
        <TicketsPanel
          components={project.components.map((c) => ({ label: c.label, path: c.path }))}
          agentTargets={agentTargets}
          installed={installed}
          onStartWork={startTicketWork}
          onSendToAgent={sendTicketToAgent}
          onOpenTicket={openTicket}
          onOpenIntegrations={() => {
            window.dispatchEvent(
              new CustomEvent("canopy:open-settings", { detail: { tab: "integrations" } }),
            );
          }}
        />
      )}
      {sideTab === "team" && (
        <TeamPanel
          relay={relay}
          onOpenChat={openChat}
          onOpenInboxItem={(item) => void openInboxItem(item)}
          onNotice={onNotice}
        />
      )}
      {sideTab === "agents" && (
        <AgentsPanel
          stats={projectStats}
          hookPath={hookPath}
          pending={pending}
          onDismissPending={onDismissPending}
          onAnswer={answerQuestions}
          onRespond={respondPermission}
          onJumpToTerminal={jumpToTerminal}
          onJumpToPty={jumpToPty}
          activePty={activePty}
          roots={roots}
          shareContext={Boolean(project.shareContext)}
          onShareContext={onShareContext}
          liveSessionIds={liveSessionIds}
          onRestore={(cwd, cmd, title, agentId) =>
            addTerminal(cwd, cmd, title, AGENT_CLIS.find((c) => c.id === agentId)?.icon)
          }
          onNotice={onNotice}
        />
      )}
    </div>
  );

  return (
    <div className="project-view" style={{ display: visible ? "flex" : "none" }}>
      {!zen && (
        <div className="rail">
          {RAIL_TABS.map((t) => (
            <button
              key={t.key}
              className={`rail-btn ${!collapsed && sideTab === t.key ? "rail-btn-active" : ""}`}
              title={t.title}
              onClick={() => {
                if (collapsed) {
                  setCollapsed(false);
                  setSideTab(t.key);
                } else if (sideTab === t.key) {
                  setCollapsed(true);
                } else {
                  setSideTab(t.key);
                }
              }}
            >
              <t.Icon size={18} />
              {t.key === "changes" && changeCount + collabEditedCount > 0 && (
                <span className="rail-badge">{Math.min(changeCount + collabEditedCount, 99)}</span>
              )}
              {t.key === "agents" && pending.length > 0 && (
                <span
                  className={`rail-badge ${urgentPending.length > 0 ? "rail-badge-urgent" : ""}`}
                >
                  {pending.length}
                </span>
              )}
              {t.key === "team" && teamBadge > 0 && (
                <span className="rail-badge rail-badge-urgent">{Math.min(teamBadge, 99)}</span>
              )}
              {t.key === "team" && relay.status.role !== "off" && (
                <span
                  className="rail-conn"
                  title={relay.status.role === "host" ? "Hosting a relay" : "Connected to a relay"}
                />
              )}
            </button>
          ))}
          <div className="rail-spacer" />
          <button
            className="rail-btn"
            title="Settings (Cmd+,)"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("canopy:open-settings"))
            }
          >
            <SettingsIcon size={18} />
          </button>
          <button
            className="rail-btn"
            title="Toggle sidebar (Cmd+B)"
            onClick={() => setCollapsed((v) => !v)}
          >
            <SidebarIcon size={18} collapsed={collapsed} />
          </button>
        </div>
      )}
      {/* The PanelGroup renders in every mode on purpose. Swapping mainArea
          between a bare child and a <Panel> changes its element type, which
          unmounts the subtree — and Term's cleanup kills the PTY. Toggling
          focus mode would silently kill every terminal (and any agent running
          in one). Keeping the tree shape fixed keeps the PTYs alive. */}
      <PanelGroup direction="horizontal">
        {!collapsed && !zen && (
          <>
            <Panel id="side" order={1} defaultSize={20} minSize={13} maxSize={40}>
              {sidePanel}
            </Panel>
            <PanelResizeHandle className="resize-handle" />
          </>
        )}
        <Panel id="main" order={2}>
          {mainArea}
        </Panel>
      </PanelGroup>
      {palette && visible && (
        <Palette
          mode={palette}
          components={components.map((c) => ({ label: c.label, path: c.path }))}
          onOpen={(p) => void openFile(p)}
          onClose={() => setPalette(null)}
        />
      )}
    </div>
  );
}

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
import { modelFor, monaco } from "../monaco-setup";
import type { AgentCli, Project } from "../projects";
import { AGENT_CLIS, AGENT_PATTERN, checkInstalledClis, startCommand } from "../projects";
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
import { BranchView } from "./BranchView";
import { ticketBranch, ticketContext, ticketWorktree } from "../trackers";
import { markRestored, restorableFrom, type Restorable } from "../restorable";
import {
  forgetTerminals,
  rememberTerminals,
  rememberedTerminals,
  type RememberedTerminal,
} from "../terminalMemory";
import { PrView } from "./PrView";
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

interface ChatSubTab {
  id: string;
  type: "chat";
  /** Relay member id for a DM; null for the everyone channel. */
  peer: string | null;
  name: string;
  /** A message arrived while the tab wasn't in front. */
  unread?: boolean;
}

type SubTab =
  | TermSubTab
  | FileSubTab
  | PrSubTab
  | TicketSubTab
  | CommitSubTab
  | BranchSubTab
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
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const installedRef = useRef(installed);
  installedRef.current = installed;
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

  // Ring chat tabs that received something while not in front. The transcript
  // is app-level, so "new" is detected by length, not subscription.
  const chatSeen = useRef(0);
  useEffect(() => {
    const fresh = relay.chat.slice(chatSeen.current);
    chatSeen.current = relay.chat.length;
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
    [onNotice, openPr, relay],
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
              ? { ...t, epoch: (t.epoch ?? 0) + 1 }
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
  useEffect(() => {
    refreshInstalled();
  }, [refreshInstalled]);

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
    const cycle = (dir: 1 | -1) => () => {
      const list = tabsRef.current;
      if (list.length < 2) return;
      const i = list.findIndex((t) => t.id === activeTabIdRef.current);
      setActiveTabId(list[(i + dir + list.length) % list.length].id);
    };
    const next = cycle(1);
    const prev = cycle(-1);
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
        monaco.editor.getModel(monaco.Uri.file(closing.file.path))?.dispose();
        baselines.current.delete(closing.file.path);
      }
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((active) =>
        active === id ? (next.length ? next[next.length - 1].id : null) : active,
      );
      return next;
    });
  }, []);
  closeTabRef.current = closeTab;

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
  const sectionOpen = (path: string) => openSections[path] ?? true;
  const pending = pendingForRoots(derivePending(projectEvents), roots).filter(
    (i) => !dismissedPending.has(i.key),
  );
  // Blocked-on-you items drive the urgent styling; completions are quiet.
  const urgentPending = pending.filter((i) => i.kind !== "idle");

  // Jump to the terminal running the agent that raised the item: prefer a
  // terminal whose PTY tree contains an agent process, then match by cwd.
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

  // Answer a questionnaire straight from the panel: type the option's number
  // into the agent's terminal (Claude Code's ask UI selects by digit), then
  // Enter a beat later. The card dismisses immediately — the hook stream
  // resolves it for real once the tool call completes.
  const answerQuestion = useCallback(
    (item: PendingItem, optionIndex: number) => {
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
      void ipc.ptyWrite(ptyId, String(optionIndex + 1));
      setTimeout(() => void ipc.ptyWrite(ptyId, "\r"), 150);
      onDismissPending(item.key);
      setActiveTabId(target.id);
      setTimeout(() => termHandles.current.get(target.id)?.focus(), 50);
    },
    [onNotice, onDismissPending],
  );

  // Looking at the terminal IS reading its cards. When the active tab is the
  // terminal a pending item came from, the item's job is done — same rule as
  // the tab unread-dot. This is also what keeps answered-in-terminal asks
  // from lingering as stale cards.
  useEffect(() => {
    if (!visible || !activeTabId) return;
    const tab = tabsRef.current.find((t) => t.id === activeTabId);
    if (tab?.type !== "terminal" || tab.ptyId == null) return;
    for (const item of pending) {
      if (item.pty != null && item.pty === tab.ptyId) onDismissPending(item.key);
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
      hint: installed[cli.bin] ? undefined : "install",
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
                className={`tab ${tab.id === activeTabId ? "tab-active" : ""} ${
                  (tab.type === "terminal" || tab.type === "chat") && tab.unread
                    ? "tab-unread"
                    : ""
                } ${tab.type !== "terminal" ? "tab-doc" : isAgentTab(tab) ? "tab-agent" : ""}`}
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
                ) : (
                  tab.file.external != null && <span className="tab-external">●</span>
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
                // Canopy (or in another project) shows as installed here.
                if (!cliMenuOpen) refreshInstalled();
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
              className="fill"
              style={{ display: tab.id === activeTabId && visible ? "block" : "none" }}
            >
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
                onSpawned={(ptyId) => patchTab(tab.id, { ptyId })}
                onExited={(code) => {
                  // Shell tabs close on exit; run tabs stay so the output and
                  // exit status remain readable.
                  if (tab.run) {
                    patchTab(tab.id, { exited: true, exitCode: code, ptyId: null });
                    // An installer finishing is the moment "install" labels
                    // go stale — re-probe right now, not on a timer.
                    if (AGENT_CLIS.some((c) => c.install === tab.command)) {
                      refreshInstalled();
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
        {activeTab?.type === "branch" && (
          <BranchView
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
        {activeTab?.type === "chat" && (
          <ChatView
            key={activeTab.id}
            peer={activeTab.peer}
            title={activeTab.name}
            relay={relay}
            onNotice={onNotice}
          />
        )}
        {activeTab?.type === "file" && (
          <FileView
            key={activeTab.id}
            file={activeTab.file}
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
                      title="Forget the remembered terminals for this project"
                      onClick={() => {
                        forgetTerminals(project.id);
                        setRemembered([]);
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
          onAnswer={answerQuestion}
          onJumpToTerminal={jumpToTerminal}
          roots={roots}
          shareContext={Boolean(project.shareContext)}
          onShareContext={onShareContext}
          liveSessionIds={liveSessionIds}
          onRestore={(cwd, cmd, title, agentId) =>
            addTerminal(cwd, cmd, title, AGENT_CLIS.find((c) => c.id === agentId)?.icon)
          }
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
              {t.key === "changes" && changeCount > 0 && (
                <span className="rail-badge">{Math.min(changeCount, 99)}</span>
              )}
              {t.key === "agents" && pending.length > 0 && (
                <span
                  className={`rail-badge ${urgentPending.length > 0 ? "rail-badge-urgent" : ""}`}
                >
                  {pending.length}
                </span>
              )}
              {t.key === "team" && relay.inbox.length > 0 && (
                <span className="rail-badge rail-badge-urgent">{relay.inbox.length}</span>
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

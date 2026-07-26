// One open project: icon rail + collapsible side panel (components / changes /
// agents) + the main area where the AGENT is the hero. Agents and reference
// docs are sub-tabs; plain shells and long-running commands sit in compact
// right-hand rails (single chip, or a dropdown once there's more than one).
// Terminals stay mounted so TUIs keep running. Bottom status tray shows git
// branch, agents, model, tokens, cost.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import * as ipc from "../../ipc";
import { getSettings } from "../../settings";
import { modelFor, monaco, languageForPath } from "../../monaco-setup";
import { getCaret, subscribeCaret } from "../../editorState";
import { GuestSession, OwnerSession } from "../../collab";
import { CollabView } from "../CollabView";
import { SharedProjectView } from "../SharedProjectView";
import type { AgentCli } from "../../projects";
import {
  AGENT_CLIS,
  binName,
  SHELL_PATTERN,
  currentPlatform,
  PREREQS,
  restoreCommand,
  resumeSessionId,
  shellBin,
  startCommand,
  updateCommand,
} from "../../projects";
import {
  AgentIcon,
  CheckIcon,
  FailIcon,
  LiveDot,
  PlayIcon,
  RestartIcon,
  StopIcon,
  TerminalIcon,
} from "../icons";
import type { OpenFile } from "../../types";
import {
  derivePending,
  eventPtyId,
  eventsForProject,
  isStopFor,
  pendingForRoots,
  type PendingItem,
} from "../../notifications";
import {
  addressPrCommentsTask,
  adhocTaskDef,
  customTaskDef,
  microTaskProtocol,
  raisePrTask,
  reviewPrTask,
  type CustomMicroTask,
  type MicroTaskDef,
  type MicroTaskEnv,
} from "../../microTasks";
import { TasksPanel, type RunningMicroTask } from "../TasksPanel";
import { TaskHistoryView } from "../TaskHistoryView";
import { InstructionsView } from "../InstructionsView";
import {
  endAbandonedRun,
  recordTaskEnd,
  recordTaskStart,
  updateTaskRun,
  type TaskRun,
} from "../../taskHistory";
import { taskMenuItem, type TaskChoice } from "../../taskMenu";
import { viewerKindFor } from "../viewers";
import { ensureLanguageServer } from "../../lsp/client";
import { Term, type TermHandle } from "../Term";
import { ContextMenu, useContextMenu, type MenuItem } from "../ContextMenu";
import { FileTree } from "../FileTree";
import { FileView } from "../FileView";
import { ChangesPanel, type ChangeGroup } from "../ChangesPanel";
import { useEscape } from "../../useEscape";
import { useTabDrag, applyOrder } from "../../tabDrag";
import { agentIdForCommand, identifyAgent } from "../../agentIdentity";
import { AgentsPanel, digestBySurface } from "../AgentsPanel";
import { StatusBar } from "../StatusBar";
import { Palette, type PaletteMode } from "../Palette";
import { GitPanel } from "../GitPanel";
import { TicketsPanel, type AgentTarget } from "../TicketsPanel";
import { TicketView } from "../TicketView";
import { CommitView } from "../CommitView";
import { ReviewView, type ReviewPayload } from "../ReviewView";
import { BranchView } from "../BranchView";
import { AgentWorkspaceView } from "../AgentWorkspaceView";
import { PreviewView } from "../PreviewView";
import type { PreviewServer } from "../../preview";
import { dispatchBrowserOp } from "../../previewAgent";
import { serverForUrl } from "../../preview";
import { ticketBranch, ticketContext, ticketWorktree } from "../../trackers";
import { prConflictContext, prReviewContext, prWorktree } from "../../prs";
import { fileDiffContext, reviewContext, sessionChangesContext } from "../../diffContext";
import { AgentQueryBar } from "../AgentQueryBar";
import { forgetSessions, markRestored, restorableFrom, type Restorable } from "../../restorable";
import {
  forgetTerminals,
  rememberTerminals,
  rememberedTerminals,
  type RememberedTerminal,
} from "../../terminalMemory";
import { PrView } from "../PrView";
import { ErrorBoundary } from "../ErrorBoundary";
import { TeamPanel } from "../TeamPanel";
import { ChatView } from "../ChatView";
import { Coachmark } from "../Coachmark";
import { shouldShowTip, markTipSeen, type CoachTip } from "../../coachmarks";
import { ActivityRail } from "../ActivityRail";
import { PaneBar } from "../PaneBar";
import { useCliLauncher } from "./hooks/useCliLauncher";

import {
  ago,
  describeTab,
  previewLabel,
  tabDisplayLabel,
  tabId,
  type SideTab,
  type SubTab,
  type DocSubTab,
  type TermSubTab,
  type FileSubTab,
  type TicketSubTab,
  type BranchSubTab,
  type CommitSubTab,
  type PrSubTab,
  type ReviewSubTab,
  type AgentSubTab,
  type TaskHistorySubTab,
  type InstructionsSubTab,
  type ChatSubTab,
  type CollabSubTab,
  type SharedProjectSubTab,
  type PreviewSubTab,
  type RailChip,
  type ProjectViewProps,
} from "./helpers";
export { tabDisplayLabel, previewLabel };
export type {
  SideTab,
  SubTab,
  TermSubTab,
  FileSubTab,
  TicketSubTab,
  BranchSubTab,
  CommitSubTab,
  PrSubTab,
  ReviewSubTab,
  AgentSubTab,
  TaskHistorySubTab,
  InstructionsSubTab,
  ChatSubTab,
  CollabSubTab,
  SharedProjectSubTab,
  PreviewSubTab,
  RailChip,
};

const decoder = new TextDecoder();

/** How a doc tab's host is hidden when it isn't the front tab.
 *
 *  `display: none` for everything, with one exception: a preview tab keeps its
 *  box. A `display: none` iframe has no layout at all — every element in the
 *  previewed page reports a zero rect — so a backgrounded preview would answer
 *  canopy_browser_snapshot with an empty page and click the wrong coordinates.
 *  `visibility: hidden` keeps the page laid out (and unpainted) so an agent can
 *  drive it while the user works in another tab; absolute + no pointer events
 *  keeps it out of the flow and out of the way of the tab that is in front. */
function hostStyle(front: boolean, keepLaidOut: boolean): CSSProperties {
  if (front) return { display: "block" };
  if (!keepLaidOut) return { display: "none" };
  return {
    display: "block",
    position: "absolute",
    inset: 0,
    visibility: "hidden",
    pointerEvents: "none",
  };
}

/** Endpoints a shell is actually serving, offered where you are looking.
 *
 *  The ports are already known — `lsof` collects them for the resource
 *  breakdown — but they were only ever shown in side panels, so starting a dev
 *  server still meant reading its banner and retyping the URL. Rendered as an
 *  overlay rather than a bar above the grid on purpose: the terminal's size is
 *  what the pty is told, and anything that changes its height risks the
 *  wrap-at-the-wrong-column class of bug. An absolute chip changes nothing. */
function TermPorts({
  ptyId,
  stats,
  onPreview,
}: {
  ptyId: number | null | undefined;
  stats: ipc.SessionStats[];
  /** Open in the in-app preview tab; plain click. ⌘/ctrl-click still goes to
   *  the system browser for the times a real browser is the point. */
  onPreview: (url: string) => void;
}) {
  if (ptyId == null) return null;
  const ports = stats.find((s) => s.id === ptyId)?.ports ?? [];
  if (ports.length === 0) return null;
  return (
    <div className="term-ports">
      {ports.map((p) => (
        <button
          key={p}
          className="term-port"
          title={`Preview http://localhost:${p} in Canopy — ⌘-click for your browser`}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey) {
              void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
                openUrl(`http://localhost:${p}`),
              );
            } else {
              onPreview(`http://localhost:${p}`);
            }
          }}
        >
          localhost:{p}
        </button>
      ))}
    </div>
  );
}

/** How long the pointer must rest ON a rail icon before its panel slides out —
 *  and it has to be resting, not merely passing: leaving the icon cancels the
 *  clock, so crossing the rail on the way elsewhere never opens anything.
 *  Long enough to be a decision, short enough to still feel like hover. */
const HOVER_INTENT_MS = 280;
/** The grace period after the pointer leaves both rail and panel. Generous on
 *  purpose: the gap between "reading the file tree" and "reaching for it again"
 *  is longer than a menu's flyout delay. */
const PEEK_CLOSE_MS = 1500;
/** The pointer is still in the rail but has moved off the tabs — it has said
 *  where it's going, so there is nothing left to wait for. Short enough that the
 *  panel is gone before a tooltip can appear over where it was. */
const PEEK_LEAVE_MS = 220;
const SIDE_DEFAULT_W = 300;
const SIDE_MIN_W = 200;
const SIDE_MAX_W = 560;

export function ProjectView({ project, visible, zen, events, hookPath, allProjects, dismissedPending, onDismissPending, onEdit, onNotice, onShareContext, relay }: ProjectViewProps) {
  const [sideTab, setSideTab] = useState<SideTab>("files");
  // Monaco's caret, for the context snapshot. Subscribed rather than passed
  // down: the editor sits several components below, and this is read-only.
  const caret = useSyncExternalStore(subscribeCaret, getCaret);
  // The side panel is a hover overlay, not a docked column. `pinned` is the
  // click/Cmd+B latch that keeps it out; `peeking` is the transient hover state
  // that the debounce below retracts. Either one shows it.
  const [pinned, setPinned] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [sideWidth, setSideWidth] = useState(SIDE_DEFAULT_W);
  const sideWidthRef = useRef(SIDE_DEFAULT_W);
  const sideOpen = !zen && (pinned || peeking);
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
  const { installed, prereqs, getInstalled, cliUpdates, refreshInstalled, refreshUpdates } = useCliLauncher();
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
  // A plain shell that an agent ran inside of is classified as an agent only
  // while that process lives (see agentPtyIds in the render). Once the agent
  // exits, the still-open shell would silently demote into the SHELLS rail and
  // bump its count "by itself". Track ptys that have hosted an agent and, once
  // the agent has been gone two ticks (guards a stats-sampling blip), close the
  // tab instead of letting it reappear as a shell.
  const agentLife = useRef(new Map<number, number>());
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
        const hasAgent = !!identifyAgent(s.agent_hint);
        if (hasAgent) {
          agentLife.current.set(s.id, 0);
        } else if (agentLife.current.has(s.id)) {
          // The agent is gone. If the user has since put this shell to real
          // work — a server, a build, any non-shell/non-agent process still
          // running — it's a working shell now, not a spent agent shell:
          // stop tracking it and never auto-close it out from under them.
          const hasRealWork = s.procs.some((p) => !SHELL_PATTERN.test(p.name));
          if (hasRealWork) {
            agentLife.current.delete(s.id);
          } else {
            const gone = (agentLife.current.get(s.id) ?? 0) + 1;
            if (gone >= 2) {
              agentLife.current.delete(s.id);
              const tab = tabsRef.current.find(
                (t): t is TermSubTab => t.type === "terminal" && t.ptyId === s.id,
              );
              // A launched agent tab (command matches) or a run stays put; only
              // an idle plain shell that hosted a now-exited agent gets closed.
              if (tab && !tab.run && !agentIdForCommand(tab.command)) {
                closeTabRef.current(tab.id);
              }
            } else {
              agentLife.current.set(s.id, gone);
            }
          }
        }
        if (!hasAgent) {
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

  /** Open (or re-focus) a tab attached to a headless PTY the remote portal
   *  spawned. Idempotent by pty id, so a re-dispatched event just re-focuses
   *  the existing tab rather than stacking duplicates. */
  const attachTerminal = useCallback(
    (ptyId: number, cwd: string, title: string) => {
      const existing = tabsRef.current.find(
        (t): t is TermSubTab => t.type === "terminal" && t.attachId === ptyId,
      );
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [
        ...prev,
        {
          id,
          type: "terminal",
          cwd,
          title: title || "agent",
          ptyId,
          attachId: ptyId,
          icon: "📱",
        },
      ]);
      setActiveTabId(id);
    },
    [],
  );

  // A PTY spawned from the phone (App routes pty:spawned to the project whose
  // components own its cwd). Not gated on `visible`: a remote spawn can target a
  // project sitting in the background, and the tab should be waiting there.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        projectId: string;
        ptyId: number;
        cwd: string;
        title: string;
      };
      if (d?.projectId !== project.id) return;
      attachTerminal(d.ptyId, d.cwd, d.title);
    };
    window.addEventListener("canopy:attach-terminal", onAttach);
    return () => window.removeEventListener("canopy:attach-terminal", onAttach);
  }, [project.id, attachTerminal]);

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

  /** Open an embedded-browser preview tab. With no URL the tab opens on the
   *  pick-a-server form; a URL (a run rail's detected server, a reopened tab)
   *  loads immediately. Returns the new tab's id (agent ops target it). */
  const openPreview = useCallback((url = "") => {
    const id = tabId();
    setTabs((prev) => [...prev, { id, type: "preview", url, annotations: [] }]);
    setActiveTabId(id);
    return id;
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

  // Session digests + this launch's tag, so the "Agent Workspace" overlay can
  // resolve the agent behind the active terminal the same way AgentsPanel does
  // (by PTY surface id). Polled while an agent terminal is open; idle otherwise.
  const [wsDigests, setWsDigests] = useState<ipc.SessionDigest[]>([]);
  const [thisInstance, setThisInstance] = useState<string | null>(null);
  /** Which agent terminals have their workspace overlay open, by ptyId.
   *
   *  Per-terminal, not one global flag. Opening the workspace is a statement
   *  about the agent you opened it on — with a single boolean, switching to
   *  another agent's terminal found the overlay already up and silently
   *  re-pointed at that agent, so you'd land on a workspace you never asked to
   *  see, covering the terminal you did. A Set also means A stays open when you
   *  duck over to B and come back. */
  const [wsOpenPtys, setWsOpenPtys] = useState<ReadonlySet<number>>(new Set());
  // Mirrored for the agent-action handler, which is mounted once and must not
  // re-subscribe every time a digest poll lands.
  const wsDigestsRef = useRef(wsDigests);
  wsDigestsRef.current = wsDigests;
  const thisInstanceRef = useRef(thisInstance);
  thisInstanceRef.current = thisInstance;
  useEffect(() => {
    void ipc.instanceId().then(setThisInstance).catch(() => {});
  }, []);
  useEffect(() => {
    const load = () =>
      void ipc
        .sessionDigests()
        .then((d) =>
          setWsDigests(
            d.filter((x) =>
              rootsRef.current.some((r) => x.cwd === r || (x.cwd ?? "").startsWith(r + "/")),
            ),
          ),
        )
        .catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

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
  // Micro-task tabs are excluded: they're one-shot and ephemeral, so
  // "reopen it" would re-run a task that already finished.
  useEffect(() => {
    const open: RememberedTerminal[] = tabs
      .filter((t): t is TermSubTab => t.type === "terminal" && !t.exited && !t.micro)
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
    // The command marker drops micro-tasks snapshotted before they were
    // excluded above — they'd otherwise sit in the list until overwritten.
    setRemembered(
      rememberedTerminals(project.id).filter(
        (t) => !(t.command ?? "").includes("CANOPY_MICRO_TASK="),
      ),
    );
  }, [tabs.length, visible, project.id]);

  // A terminal running `claude` or `omp` is an agent, not a shell — listing it
  // under "Terminals" was accurate about the mechanism and wrong about the
  // thing. Split by what the command actually starts.
  const rememberedAgents = remembered.filter((t) => agentIdForCommand(t.command));
  const rememberedShells = remembered.filter((t) => !agentIdForCommand(t.command));
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
      const installedClis = AGENT_CLIS.filter((c) => getInstalled()[c.bin]);
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
    [ticketRepo, addTerminal, onNotice, getInstalled],
  );

  /** Check out a PR's head branch in a worktree (reusing one already on it)
   *  and start an agent there to review it. The mirror of startTicketWork —
   *  same worktree-then-agent shape — but the PR already carries its branch, so
   *  there's nothing to invent, and the branch already exists upstream, so we
   *  only ever check it out (create=false, letting git DWIM the remote branch),
   *  never `-b` a fresh one off HEAD (which would "review" empty changes). */
  // Start an agent on a PR in its own worktree. `mode` only swaps the prompt it
  // is seeded with (review vs. resolve-the-conflicts) and the error wording —
  // the worktree checkout/reuse and seeding are identical.
  const startPrAgent = useCallback(
    async (mode: "review" | "resolve", repo: string, pr: ipc.PrInfo, agentId?: string) => {
      const noun = mode === "resolve" ? "conflict resolution on" : "a review of";
      const installedClis = AGENT_CLIS.filter((c) => getInstalled()[c.bin]);
      const preferred = getSettings().defaultAgent;
      const agent =
        agentId ||
        (installedClis.find((c) => c.id === preferred) ?? installedClis[0] ?? AGENT_CLIS[0])?.id;
      const cli = AGENT_CLIS.find((c) => c.id === agent);
      if (!cli) {
        onNotice(`Unknown agent "${agent}".`);
        return;
      }
      try {
        // Reuse a worktree already holding this PR's branch; otherwise make an
        // ephemeral one — fetching the PR head (fork-safe, and without switching
        // the main checkout's branch) so it works even for a PR you've never
        // checked out. Only a worktree WE created is disposable, so only then do
        // we tell the agent to remove it and skip registering it as a component.
        const worktrees = await ipc.gitWorktrees(repo).catch(() => [] as ipc.WorktreeInfo[]);
        const existing = prWorktree(pr, worktrees);
        const path = existing?.path ?? `${repo}-wt-pr-${pr.number}`;
        const cleanup = existing ? undefined : { repo, worktree: path };
        const context =
          mode === "resolve" ? prConflictContext(pr, cleanup) : prReviewContext(pr, cleanup);
        const start = startCommand(agent, context);
        if (!start) {
          onNotice(`Unknown agent "${agent}".`);
          return;
        }
        if (!existing) {
          await ipc.gitWorktreeAddPr(repo, path, pr.number, pr.branch);
        }
        const title = `PR #${pr.number} · ${cli.name}`;
        const id = addTerminal(path, start.command, title, cli.icon);
        if (id && start.typePrompt) {
          setTimeout(() => {
            const pty = tabsRef.current.find(
              (t): t is TermSubTab => t.id === id && t.type === "terminal",
            )?.ptyId;
            if (pty == null) return;
            void ipc.ptyWrite(pty, context);
            setTimeout(() => void ipc.ptyWrite(pty, "\r"), 250);
          }, 2500);
        }
      } catch (err) {
        // A private fork you can't fetch is the one case even pull/<n>/head
        // can't reach; "Checkout" (gh pr checkout) authenticates and fetches it.
        onNotice(
          `Couldn't start ${noun} PR #${pr.number}: ${String(err)}. ` +
            `If it's from a private fork you can't fetch, click Checkout first.`,
        );
      }
    },
    [addTerminal, onNotice, getInstalled],
  );
  const startPrReview = useCallback(
    (repo: string, pr: ipc.PrInfo, agentId?: string) => startPrAgent("review", repo, pr, agentId),
    [startPrAgent],
  );
  const startPrConflictResolve = useCallback(
    (repo: string, pr: ipc.PrInfo, agentId?: string) => startPrAgent("resolve", repo, pr, agentId),
    [startPrAgent],
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

  /** Open an agent's workspace as its own tab — the files it changed, its
   *  commits, and the PR from its branch. Identity is the live agent (the
   *  process running in the terminal), never a stale hook digest; the digest,
   *  when present, is only enrichment. The repo is matched from the agent's
   *  cwd; the backend's worktree authorization is the real gate, so a wrong
   *  guess degrades to an error banner, not someone else's diff. */
  const openAgent = useCallback(
    async (p: {
      agent: string;
      cwd: string;
      ptyId?: number;
      sessionId?: string;
      digest?: ipc.SessionDigest;
    }) => {
      // One workspace per live terminal; fall back to session id for the rare
      // terminal-less case.
      const existing = tabsRef.current.find(
        (t): t is AgentSubTab =>
          t.type === "agent" &&
          (p.ptyId != null ? t.ptyId === p.ptyId : t.sessionId === p.sessionId),
      );
      if (existing) {
        // The panel's copy is fresher (agent, cwd, state and branch all move).
        patchTabRaw(existing.id, {
          agent: p.agent,
          cwd: p.cwd,
          sessionId: p.sessionId,
          digest: p.digest,
          ptyId: p.ptyId,
        } as Partial<SubTab>);
        setActiveTabId(existing.id);
        return;
      }
      let repo: string | null = null;
      try {
        const repos = await ipc.gitRepos(
          componentsRef.current.map((c) => [c.label, c.path] as [string, string]),
        );
        const cwd = p.cwd;
        repo =
          repos.find((r) => cwd === r.path || cwd.startsWith(`${r.path}/`))?.path ??
          // Sibling worktrees follow the `<repo>-wt-<branch>` convention.
          repos.find((r) => cwd.startsWith(`${r.path}-wt-`))?.path ??
          repos[0]?.path ??
          null;
      } catch {
        repo = null;
      }
      const id = tabId();
      setTabs((prev) => [
        ...prev,
        {
          id,
          type: "agent",
          repo,
          agent: p.agent,
          cwd: p.cwd,
          sessionId: p.sessionId,
          digest: p.digest,
          ptyId: p.ptyId,
        },
      ]);
      setActiveTabId(id);
    },
    [patchTabRaw],
  );

  /** Open the completed-tasks tab, or focus it if it's already up. Only ever
   *  one — it's a view of a single app-wide log, so a second would be a copy. */
  const openTaskHistory = useCallback(() => {
    const existing = tabsRef.current.find((t) => t.type === "task-history");
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = tabId();
    setTabs((prev) => [...prev, { id, type: "task-history" }]);
    setActiveTabId(id);
  }, []);

  /** Open the agent-instructions tab, focused on one file when a panel row
   *  asked for it. One per project, like the history tab. */
  const openInstructions = useCallback((focus?: string) => {
    const existing = tabsRef.current.find((t) => t.type === "instructions");
    if (existing) {
      if (focus) patchTabRaw(existing.id, { focus } as Partial<SubTab>);
      setActiveTabId(existing.id);
      return;
    }
    const id = tabId();
    setTabs((prev) => [...prev, { id, type: "instructions", focus }]);
    setActiveTabId(id);
  }, [patchTabRaw]);

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

  /** Start a fresh agent CLI in `dir`, seeded with `seed`. The diff surfaces
   *  (session changes, a file diff, a relay review) work on the working tree
   *  that's already there, so unlike a PR/ticket there's no worktree to make —
   *  the agent just opens in the existing checkout. Same resolve-CLI-then-seed
   *  shape as startTicketWork/startPrAgent. */
  const startAgentInDir = useCallback(
    (dir: string, agentId: string | undefined, seed: string, title: string) => {
      const installedClis = AGENT_CLIS.filter((c) => getInstalled()[c.bin]);
      const preferred = getSettings().defaultAgent;
      const agent =
        agentId ||
        (installedClis.find((c) => c.id === preferred) ?? installedClis[0] ?? AGENT_CLIS[0])?.id;
      const cli = AGENT_CLIS.find((c) => c.id === agent);
      const start = agent ? startCommand(agent, seed) : null;
      if (!cli || !start) {
        onNotice(`Unknown agent "${agent}".`);
        return;
      }
      const id = addTerminal(dir, start.command, `${title} · ${cli.name}`, cli.icon);
      if (id && start.typePrompt) {
        setTimeout(() => {
          const pty = tabsRef.current.find(
            (t): t is TermSubTab => t.id === id && t.type === "terminal",
          )?.ptyId;
          if (pty == null) return;
          void ipc.ptyWrite(pty, seed);
          setTimeout(() => void ipc.ptyWrite(pty, "\r"), 250);
        }, 2500);
      }
    },
    [addTerminal, onNotice, getInstalled],
  );

  /** Launch a micro-task: a one-shot agent seeded with the task's brief plus
   *  the completion protocol, in a tab marked ephemeral. The CANOPY_MICRO_TASK
   *  prefix reaches the MCP sidecar through PTY env inheritance and marks the
   *  session as one whose job_done must always be honored. Prefers claude —
   *  the only CLI with the MCP registration — over the default agent; others
   *  still work via the protocol's printed-fallback ending, minus auto-close. */
  const startMicroTask = useCallback(
    async <P,>(def: MicroTaskDef<P>, payload: P, userQuery: string) => {
      const installedClis = AGENT_CLIS.filter((c) => getInstalled()[c.bin]);
      if (installedClis.length === 0) {
        onNotice("Running a task needs an agent CLI — install one in Settings → Agents.");
        return;
      }
      const preferred = getSettings().defaultAgent;
      const agent = (
        installedClis.find((c) => c.id === "claude") ??
        installedClis.find((c) => c.id === preferred) ??
        installedClis[0]
      )?.id;
      const cli = AGENT_CLIS.find((c) => c.id === agent);
      if (!cli || !agent) {
        onNotice(`No agent CLI installed to run "${def.label}".`);
        return;
      }
      // A task that edits files gets the PR's branch in a worktree of its own,
      // same deal as startPrAgent: reuse the worktree already holding it, else
      // make a throwaway the brief tells the agent to remove. If that fails we
      // stop rather than fall back to the shared checkout — the agent would
      // commit onto whatever branch happens to be sitting there.
      let dir = def.cwd(payload);
      let env: MicroTaskEnv | undefined;
      if (def.isolation) {
        const { repo, pr } = def.isolation.target(payload);
        try {
          const worktrees = await ipc.gitWorktrees(repo).catch(() => [] as ipc.WorktreeInfo[]);
          const existing = prWorktree(pr, worktrees);
          const path = existing?.path ?? `${repo}-wt-pr-${pr.number}`;
          if (!existing) await ipc.gitWorktreeAddPr(repo, path, pr.number, pr.branch);
          dir = path;
          env = existing ? undefined : { cleanup: { repo, worktree: path } };
        } catch (err) {
          onNotice(
            `Couldn't check PR #${pr.number} out for "${def.label}": ${String(err)}. ` +
              `If it's from a private fork you can't fetch, click Checkout first.`,
            "error",
          );
          return;
        }
      }
      const seed = `${def.buildContext(payload, userQuery, env)} ${microTaskProtocol()}`;
      const start = startCommand(agent, seed);
      if (!start) {
        onNotice(`No agent CLI installed to run "${def.label}".`);
        return;
      }
      const id = addTerminal(
        dir,
        `CANOPY_MICRO_TASK=1 ${start.command}`,
        `${def.label} · ${cli.name}`,
        def.icon,
      );
      if (!id) return;
      // Logged at launch, not at completion: a task that is stopped, or whose
      // agent dies without ever reporting, still has to leave a trace — and the
      // brief is only in hand here. The protocol is stripped back off; it is the
      // same boilerplate on every run and pure noise in the history.
      const runId = recordTaskStart({
        taskId: def.id,
        label: def.label,
        icon: def.icon,
        agent: cli.id,
        cwd: dir,
        projectId: project.id,
        projectName: project.name,
        brief: def.buildContext(payload, userQuery, env),
      });
      patchTabRaw(id, { micro: { taskId: def.id, runId } } as Partial<SubTab>);
      if (start.typePrompt) {
        setTimeout(() => {
          const pty = tabsRef.current.find(
            (t): t is TermSubTab => t.id === id && t.type === "terminal",
          )?.ptyId;
          if (pty == null) return;
          void ipc.ptyWrite(pty, seed);
          setTimeout(() => void ipc.ptyWrite(pty, "\r"), 250);
        }, 2500);
      }
    },
    [addTerminal, patchTabRaw, onNotice, project.id, getInstalled],
  );

  /** Run a brief that was composed on the spot (a diff surface's "ask about
   *  this" box, the Tasks panel's one-off composer) as a one-shot task — same
   *  lifecycle as a saved one, no entry in the registry. The context builder
   *  already folded the user's words in, so nothing more is passed. A label is
   *  only given where the surface has a better one than the brief's own head. */
  const runAdhocTask = useCallback(
    (brief: string, dir: string, label?: string) => {
      void startMicroTask(adhocTaskDef(brief, label), { dir }, "");
    },
    [startMicroTask],
  );

  /** Micro-task tabs waiting to close: job_done was acknowledged, and we hold
   *  off killing the PTY until the agent's turn actually ends (its Stop hook)
   *  so the tool result and last words land — with a timer as backstop for a
   *  broken hook. Keyed by pty id; sid is captured at job_done time because the
   *  event stream goes quiet once the PTY dies. */
  const microFinish = useRef(
    new Map<number, { tabId: string; sid?: string; since: number; timer: number }>(),
  );

  const reapMicroTask = useCallback((ptyId: number) => {
    const entry = microFinish.current.get(ptyId);
    if (!entry) return;
    microFinish.current.delete(ptyId);
    window.clearTimeout(entry.timer);
    const sid = entry.sid ?? liveSessionByPtyRef.current.get(ptyId);
    // Grace-kill (SIGTERM + 2.5s) lets claude flush its transcript and run its
    // last hooks; pty:exit then auto-closes the tab like any spent terminal.
    void ipc.ptyKill(ptyId).finally(() => {
      // The SessionEnd hook rewrites the digest as the CLI dies — forget after
      // that final write, or the delete would race it and the session would
      // resurface in restorables.
      if (sid) setTimeout(() => void ipc.sessionForget(sid).catch(() => {}), 500);
    });
    // The promise is that the terminal closes itself, so don't leave that to
    // pty:exit alone: a CLI that wedges on its way out never reaches EOF, and
    // the finished task would sit there for good. A clean exit closes the tab
    // long before this fires, and closing an already-closed tab is a no-op.
    setTimeout(() => closeTabRef.current(entry.tabId), 4000);
  }, []);

  const finishMicroTask = useCallback(
    (tab: TermSubTab) => {
      if (tab.ptyId == null) return;
      const ptyId = tab.ptyId;
      if (microFinish.current.has(ptyId)) return;
      const timer = window.setTimeout(() => reapMicroTask(ptyId), 10_000);
      microFinish.current.set(ptyId, {
        tabId: tab.id,
        sid: liveSessionByPtyRef.current.get(ptyId),
        since: Date.now(),
        timer,
      });
    },
    [reapMicroTask],
  );

  // The wait-for-Stop half of the micro-task close: once the turn that called
  // job_done ends, reap. `ts >= since` skips Stop events from earlier turns of
  // the same session (a blocked task the user replied to, then finished).
  useEffect(() => {
    if (microFinish.current.size === 0) return;
    for (const [ptyId, entry] of microFinish.current) {
      if (events.some((e) => e.ts >= entry.since && isStopFor(e.raw, ptyId))) {
        reapMicroTask(ptyId);
      }
    }
  }, [events, reapMicroTask]);

  /** A relay review's diff isn't in any local checkout, so an agent can't
   *  `git diff` for it — write the patch into the project (an authorized
   *  workspace, so the write is in scope) and hand the agent that path. Returns
   *  the file path, or null if there's nowhere to write it. */
  const writeReviewPatch = useCallback(
    async (review: ReviewPayload): Promise<string | null> => {
      const dir = componentsRef.current[0]?.path;
      if (!dir) {
        onNotice("No project directory to stage the review in.");
        return null;
      }
      const safe = (review.branch || "review").replace(/[^A-Za-z0-9._-]+/g, "-");
      const path = `${dir}/.canopy-review-${safe}.patch`;
      try {
        await ipc.fsWriteFile(path, review.patch);
        return path;
      } catch (err) {
        onNotice(`Couldn't stage the review diff: ${String(err)}`, "error");
        return null;
      }
    },
    [onNotice],
  );

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
    const toggleSidebarHandler = () => {
      setPinned((v) => !v);
      setPeeking(false);
    };
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

  // An agent asked the IDE to do something through the MCP bridge — start a
  // run command, or open a preview. App routed it here by matching the action's
  // path to this project; act on it with the same handlers the UI buttons use.
  useEffect(() => {
    const onAction = (e: Event) => {
      const d = (e as CustomEvent).detail as { projectId: string | null; action: ipc.AgentAction };
      const a = d.action;
      // restart is keyed by terminal, not project: only the ProjectView that
      // owns that pty acts, whatever project it belongs to.
      if (a.kind === "restart_server") {
        const tab = tabsRef.current.find(
          (t): t is TermSubTab => t.type === "terminal" && t.ptyId === a.ptyId,
        );
        if (tab) restartRun(tab.id);
        return;
      }
      // A micro-task reported in (App already surfaced the notice). Done →
      // wait out the turn, then kill + close + forget. Blocked → bring the tab
      // forward so the user can answer. Only ever closes tabs marked micro: a
      // normal session that somehow calls the tool gets the notice and nothing
      // else.
      if (a.kind === "job_done") {
        const tab = tabsRef.current.find(
          (t): t is TermSubTab => t.type === "terminal" && a.ptyId != null && t.ptyId === a.ptyId,
        );
        if (!tab || !tab.micro) return;
        const runId = tab.micro.runId;
        // Files the session touched, when a hook wrote a digest for it — the
        // same pty→digest binding the Agents panel uses.
        const files =
          tab.ptyId != null
            ? digestBySurface(wsDigestsRef.current, thisInstanceRef.current).get(
                String(tab.ptyId),
              )?.files
            : undefined;
        if (a.status === "blocked") {
          // Blocked is not an ending — the agent is waiting on the user and the
          // run continues. Keep what it said and mark that it asked, so that if
          // the user walks away instead of answering, closing the tab can settle
          // it as "blocked" rather than the flatter "stopped".
          if (runId)
            updateTaskRun(runId, {
              summary: a.summary,
              url: a.url,
              files,
              askedForUser: true,
            });
          setActiveTabId(tab.id);
        } else {
          if (runId)
            recordTaskEnd(runId, { status: "done", summary: a.summary, url: a.url, files });
          finishMicroTask(tab);
        }
        return;
      }
      if (d?.projectId !== project.id) return;
      if (a.kind === "open_preview" && a.url) {
        openPreview(a.url);
      } else if (a.kind === "start_server" && a.dir && a.command) {
        // `command` is the resolved command line, `name` its label — the same
        // pair the component-commands ▶ uses. Reuse a tab already on it.
        const existing = tabsRef.current.find(
          (t): t is TermSubTab =>
            t.type === "terminal" && Boolean(t.run) && t.cwd === a.dir && t.command === a.command,
        );
        if (existing && !existing.exited) setActiveTabId(existing.id);
        else if (existing) restartRun(existing.id);
        else addTerminal(a.dir, a.command, a.name || a.command, "▶", true);
      } else if ((a.kind === "open_file" || a.kind === "show_diff") && a.path) {
        // "Look at line 340" — put the file in front of the user and land on
        // the line. The reveal is an event because the tab may already be open,
        // and because opening is async either way.
        const path = a.path;
        const line = a.line;
        void openFileRef.current(path, { diff: a.kind === "show_diff" }).then(() => {
          if (line)
            requestAnimationFrame(() =>
              window.dispatchEvent(
                new CustomEvent("canopy:reveal-line", { detail: { path, line } }),
              ),
            );
        });
      }
    };
    window.addEventListener("canopy:agent-action", onAction);
    return () => window.removeEventListener("canopy:agent-action", onAction);
  }, [project.id, openPreview, addTerminal, restartRun, finishMicroTask]);

  // A browser-control op (canopy_browser_*): pick the preview tab it targets —
  // by origin when it names a URL, else the active/first preview tab, creating
  // one when navigation asks for a page and none is open — and hand the op to
  // the PreviewView through the queueing bus. Everything else, including
  // answering the bridge, happens in the view; only the no-tab case must answer
  // here or the agent would wait out the bridge's timeout.
  //
  // The op does NOT steal the front tab. Opening the preview brings it forward
  // once (that's the moment worth showing); after that an agent clicking and
  // typing must not yank the user off the file they're editing every few
  // seconds. An open preview tab stays laid out while it's in the background
  // (see the doc-host styling below) so its page keeps real geometry and the
  // ops that need it — snapshot, click — work unwatched. Screenshot is the one
  // exception: it captures pixels off the window, so it has to be in front.
  useEffect(() => {
    const originOf = (u: string): string | null => {
      try {
        return new URL(u).origin;
      } catch {
        return null;
      }
    };
    const onBrowserOp = (e: Event) => {
      const d = (e as CustomEvent).detail as { projectId: string; op: ipc.AgentBrowserOp };
      if (d?.projectId !== project.id) return;
      const op = d.op;
      const previews = tabsRef.current.filter((t): t is PreviewSubTab => t.type === "preview");
      const wantOrigin = op.url ? originOf(op.url) : null;
      const tab =
        (wantOrigin && previews.find((t) => originOf(t.url) === wantOrigin)) ||
        previews.find((t) => t.id === activeTabIdRef.current && t.url) ||
        previews.find((t) => !!t.url) ||
        // A URL navigation can take over an empty (server-picker) preview tab.
        (op.op === "navigate" && op.url ? previews[0] : undefined);
      if (tab) {
        if (op.op === "screenshot") setActiveTabId(tab.id);
        dispatchBrowserOp(tab.id, op);
      } else if (op.op === "navigate" && op.url) {
        dispatchBrowserOp(openPreview(op.url), op);
      } else {
        void ipc.browserResult(
          op.id,
          false,
          "No preview page is open in this project. Call canopy_browser_navigate with a url first — canopy_project's runServers lists the addresses.",
        );
      }
    };
    window.addEventListener("canopy:agent-browser", onBrowserOp);
    return () => window.removeEventListener("canopy:agent-browser", onBrowserOp);
  }, [project.id, openPreview]);

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
    // The last moment the terminal's scrollback exists: the handle goes on the
    // next line and the buffer dies with the unmount. Both endings pass through
    // here — job_done's self-close and the user closing the tab — so capturing
    // once here covers a finished task and an abandoned one alike. recordTaskEnd
    // ignores a run that already settled, so "stopped" can't clobber "done".
    const closingTab = tabsRef.current.find((t) => t.id === id);
    if (closingTab?.type === "terminal" && closingTab.micro?.runId) {
      const runId = closingTab.micro.runId;
      const output = termHandles.current.get(id)?.captureText(8000) || undefined;
      if (output) updateTaskRun(runId, { output });
      // A no-op for a run that already reported done; otherwise it settles as
      // "blocked" if the agent had asked for the user, else "stopped".
      endAbandonedRun(runId, output);
    }
    termHandles.current.delete(id);
    setTabs((prev) => {
      const closing = prev.find((t) => t.id === id);
      if (closing?.type === "terminal" && closing.micro && closing.ptyId != null) {
        // A micro-task session never reaches restorables, however it ends —
        // that includes the user closing the tab mid-run. Forget after the
        // unmount-kill's grace window so the delete lands on the CLI's final
        // digest write instead of racing it.
        const sid = liveSessionByPtyRef.current.get(closing.ptyId);
        if (sid) setTimeout(() => void ipc.sessionForget(sid).catch(() => {}), 4000);
      }
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

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  // The pty of the terminal tab in front, so the Agents panel can highlight its
  // row — relating the tab you're looking at back to its entry in the list.
  const activePty = activeTab?.type === "terminal" ? activeTab.ptyId : null;
  const runTabs = useMemo(
    () => tabs.filter((t): t is TermSubTab => t.type === "terminal" && Boolean(t.run)),
    [tabs],
  );
  const ptyIds = useMemo(
    () =>
      new Set(
        tabs
          .filter((t): t is TermSubTab => t.type === "terminal")
          .map((t) => t.ptyId)
          .filter((id): id is number => id != null),
      ),
    [tabs],
  );
  const projectStats = stats; // already filtered to this project's ptys at the door
  // Hooks are global, so the raw stream carries every agent on the machine.
  // Everything below this line sees only what our own terminals raised.
  // Memoized so the derived pending/urgent arrays keep a stable identity —
  // that's what lets the memoized ActivityRail skip unrelated re-renders.
  const projectEvents = useMemo(
    () => eventsForProject(events, ptyIds, roots),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, ptyIds, rootsKey],
  );
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
  // The session actually running in each live terminal, keyed by the pty id the
  // hook stamped on its events *this* launch (`canopy_pty`) — not the digest's
  // `surface`, which is the pty from whenever the hook last wrote and goes stale
  // across a restart/restore. This is the authoritative terminal→session bond:
  // it can never bind a tab to an unrelated session whose recycled pty number
  // happens to collide. Latest event per pty wins.
  const liveSessionByPty = useMemo(() => {
    const latest = new Map<number, { sid: string; ts: number }>();
    for (const e of projectEvents) {
      const pty = eventPtyId(e.raw);
      if (pty == null) continue;
      let sid: unknown;
      try {
        sid = (JSON.parse(e.raw) as { session_id?: unknown }).session_id;
      } catch {
        continue;
      }
      if (typeof sid !== "string" || !sid) continue;
      const prev = latest.get(pty);
      if (!prev || e.ts >= prev.ts) latest.set(pty, { sid, ts: e.ts });
    }
    const m = new Map<number, string>();
    for (const [pty, v] of latest) m.set(pty, v.sid);
    return m;
  }, [projectEvents]);
  liveSessionIdsRef.current = liveSessionIds;
  const liveSessionByPtyRef = useRef(liveSessionByPty);
  liveSessionByPtyRef.current = liveSessionByPty;

  // Deliver a message (a workspace review, today) to the agent that owns a
  // session: typed into its live PTY when it has one, else the session is
  // resumed and the text delivered once it reports back. Best-effort — returns
  // whether it landed plus a line to show the user. The two-write (text, then a
  // beat, then Enter) is the same pattern the agent seeder uses so the TUI has
  // settled the paste before it submits.
  const messageAgent = useCallback(
    async (opts: {
      ptyId?: number | null;
      sessionId?: string;
      agentId?: string;
      cwd: string;
      text: string;
    }): Promise<{ delivered: boolean; note: string; ptyId?: number }> => {
      const { sessionId, cwd, text } = opts;
      const agentId = opts.agentId ?? "agent";
      const alive = (pty: number | null | undefined): pty is number =>
        pty != null && statsRef.current.some((s) => s.id === pty);
      const typeInto = (pty: number) => {
        void ipc.ptyWrite(pty, text);
        window.setTimeout(() => void ipc.ptyWrite(pty, "\r"), 350);
      };
      const livePtyForSession = () =>
        [...liveSessionByPtyRef.current.entries()].find(([p, sid]) => sid === sessionId && alive(p))?.[0];
      // 1) The workspace's own terminal, if it's still live.
      if (alive(opts.ptyId)) {
        typeInto(opts.ptyId);
        return { delivered: true, note: `Sent to ${agentId}.`, ptyId: opts.ptyId };
      }
      // 2) Any live terminal running this session (it may have moved tabs).
      const moved = sessionId ? livePtyForSession() : undefined;
      if (moved != null) {
        typeInto(moved);
        return { delivered: true, note: `Sent to ${agentId}.`, ptyId: moved };
      }
      // 3) Ended: resume, wait for the session to report a PTY, then deliver.
      if (!sessionId) {
        return { delivered: false, note: "No live agent to receive the comments — open its terminal first." };
      }
      const cmd = restoreCommand(agentId, sessionId);
      if (!cmd) {
        return { delivered: false, note: `${agentId} can't be resumed to receive the comments.` };
      }
      addTerminal(cwd, cmd, agentId, AGENT_CLIS.find((c) => c.id === agentId)?.icon);
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const back = livePtyForSession();
        if (back != null) {
          // A moment past first paint before pasting into the resumed TUI.
          await new Promise((r) => setTimeout(r, 800));
          typeInto(back);
          return {
            delivered: true,
            note: `Resumed ${agentId} and sent the comments.`,
            ptyId: back,
          };
        }
      }
      return {
        delivered: false,
        note: "Resumed the session, but it didn't come back in time — your comments are still saved.",
      };
    },
    [addTerminal],
  );
  const runningAgents = projectStats.flatMap((s) => {
    const agent = identifyAgent(s.agent_hint);
    return agent ? [{ name: agent.label, cpu: s.total_cpu }] : [];
  });
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
  const collabPaths = useMemo(
    () => new Set(collabChanges.filter((c) => c.edited).map((c) => c.path)),
    [collabChanges],
  );
  const teamBadge =
    relay.inbox.length + Object.values(relay.unread).reduce((a, b) => a + b, 0);
  const sectionOpen = (path: string) => openSections[path] ?? true;
  const pending = useMemo(
    () =>
      pendingForRoots(derivePending(projectEvents), roots).filter(
        (i) => !dismissedPending.has(i.key),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectEvents, rootsKey, dismissedPending],
  );
  // Blocked-on-you items drive the urgent styling; completions are quiet.
  const urgentPending = useMemo(
    () => pending.filter((i) => i.kind !== "idle"),
    [pending],
  );

  // Stable ActivityRail handlers. Identity only changes with pinned/sideTab
  // (a user action), not on every render — so the memoized rail stays put while
  // terminals stream, agents tick, and stats update.
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const resizing = useRef(false);

  const cancelPeekClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const schedulePeekClose = useCallback(
    (delay = PEEK_CLOSE_MS) => {
      cancelPeekClose();
      // Not while a width drag is in flight: the pointer routinely leaves the
      // panel mid-drag, and retracting it out from under the grip is maddening.
      if (resizing.current) return;
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        setPeeking(false);
      }, delay);
    },
    [cancelPeekClose],
  );
  const cancelPeekOpen = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);
  useEffect(() => () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  /** Hover-intent, not hover. A panel is only committed once the pointer has
   *  settled on an icon — otherwise sweeping the rail on the way to Settings
   *  would mount every panel behind it, and the trackers panel mounting means
   *  a round trip to GitHub/Jira for a tab you never meant to open.
   *
   *  A pinned panel ignores hover entirely. Pinning says "keep THIS one out",
   *  and a pointer drifting over the rail on its way somewhere else has no
   *  business swapping it — a peek is transient, a pin is a choice. */
  const hoverSideTab = useCallback(
    (tab: SideTab) => {
      if (pinned) return;
      cancelPeekClose();
      cancelPeekOpen();
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null;
        setSideTab(tab);
        setPeeking(true);
      }, HOVER_INTENT_MS);
    },
    [cancelPeekClose, cancelPeekOpen, pinned],
  );
  const leaveSideHover = useCallback(
    (prompt?: boolean) => {
      cancelPeekOpen();
      schedulePeekClose(prompt ? PEEK_LEAVE_MS : PEEK_CLOSE_MS);
    },
    [cancelPeekOpen, schedulePeekClose],
  );

  /** A click anywhere else dismisses the panel on the spot — pinned included.
   *  The panel covers the editor, so a click past it is someone reaching for
   *  what's underneath; leaving it up to be clicked through twice is the one
   *  thing an overlay must not do. The grace period is for a wandering pointer,
   *  and a click says the pointer has arrived somewhere on purpose.
   *
   *  Clicks inside the panel or on the rail are exempt — the panel's own
   *  context menus and dialogs are descendants of it, so they are covered too.
   *  On pointerdown, not click: waiting for mouseup leaves the panel sitting
   *  over whatever you are in the middle of pressing. */
  useEffect(() => {
    if (!sideOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest(".side-peek, .rail")) return;
      cancelPeekOpen();
      cancelPeekClose();
      setPeeking(false);
      setPinned(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [sideOpen, cancelPeekOpen, cancelPeekClose]);

  // Click is the latch: it pins the panel open so it survives the pointer
  // leaving. Clicking the pinned tab again puts it away.
  const selectSideTab = useCallback(
    (tab: SideTab) => {
      cancelPeekOpen();
      cancelPeekClose();
      if (pinned && sideTab === tab) {
        setPinned(false);
        setPeeking(false);
      } else {
        setSideTab(tab);
        setPinned(true);
      }
    },
    [cancelPeekClose, cancelPeekOpen, pinned, sideTab],
  );
  const openSettings = useCallback(
    () => window.dispatchEvent(new CustomEvent("canopy:open-settings")),
    [],
  );
  const toggleSidebar = useCallback(() => {
    cancelPeekOpen();
    cancelPeekClose();
    setPinned((v) => !v);
    setPeeking(false);
  }, [cancelPeekClose, cancelPeekOpen]);

  /** Drag the panel's right edge. The overlay is out of flow, so the old
   *  PanelGroup percentage no longer applies — the width is plain pixels. */
  const startSideResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sideWidthRef.current;
    resizing.current = true;
    const move = (ev: PointerEvent) => {
      const w = Math.max(SIDE_MIN_W, Math.min(SIDE_MAX_W, startW + ev.clientX - startX));
      sideWidthRef.current = w;
      setSideWidth(w);
    };
    const up = () => {
      resizing.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

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
        stats.filter((s) => identifyAgent(s.agent_hint)).map((s) => s.id),
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
      // Only a single-page form is answered here. Multi-question forms need
      // page-to-page navigation the synthesised keystrokes can't keep in sync
      // (the CLI records "declined"), so the panel routes those to the terminal
      // and never calls this — the guard just makes that invariant explicit.
      if ((item.questions?.length ?? 0) > 1) {
        setActiveTabId(target.id);
        setTimeout(() => termHandles.current.get(target.id)?.focus(), 50);
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
        press("\r"); // confirm the single-page answer
      }
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
  const launchCli = useCallback((cli: AgentCli, at?: string) => {
    const cwd = at ?? componentsRef.current[0]?.path;
    if (!cwd) return;
    if (installed[cli.bin]) {
      addTerminal(cwd, shellBin(cli.bin), cli.name, cli.icon);
      // Surface the new agent where it lives: the Agents section, expanded so
      // the just-launched row is actually in view.
      setSideTab("agents");
      setPinned(true);
    } else if (cli.rebound) {
      // The vendor's installer would install the vendor's binary, which an
      // override pointing somewhere else can never be satisfied by — so the
      // "install" offer would repeat forever, which is the loop rebinding
      // exists to end. Send them to the setting that is actually wrong.
      onNotice(
        `${cli.name} is set to \`${cli.bin}\`, which isn't on this machine — check Settings → Agents.`,
      );
    } else {
      // A run tab, so the installer exits when done — and that exit is the
      // signal to re-probe (see onExited below). No timers, no staleness.
      addTerminal(cwd, cli.install, `install ${cli.name}`, "⬇", true);
    }
  }, [installed, addTerminal, onNotice]);

  /** Run `cli`'s updater in a run tab. Its exit re-probes versions (see
   *  onExited), so the badge clears the moment the update lands — no timers. */
  const runCliUpdate = useCallback((cli: AgentCli, at?: string) => {
    const cwd = at ?? componentsRef.current[0]?.path;
    if (!cwd) return;
    // Route to the command matched to the install source (e.g. `brew upgrade`);
    // fall back to the CLI's own updater when the source is a plain registry.
    const cmd = cliUpdates[cli.bin]?.updateCmd ?? updateCommand(cli);
    addTerminal(cwd, cmd, `update ${cli.name}`, "⬆", true);
  }, [cliUpdates, addTerminal]);

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
  const termMenu = useContextMenu();
  /** Prefill for the Tasks panel's composer — set when the user makes a task
   *  out of something they're looking at (selected terminal text, a file in the
   *  tree, a tab). `mode` picks which composer opens: the full create form, or
   *  the one-off box that runs the brief and saves nothing. The nonce re-opens
   *  it even for the same seed twice. */
  const [taskSeed, setTaskSeed] = useState<{
    brief: string;
    mode: "save" | "once";
    nonce: number;
  } | null>(null);
  const openTaskComposer = useCallback((brief: string, mode: "save" | "once") => {
    setPinned(true);
    setSideTab("tasks");
    setTaskSeed((prev) => ({ brief, mode, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const seedTaskFrom = useCallback(
    (brief: string) => openTaskComposer(brief, "save"),
    [openTaskComposer],
  );
  /** The "Tasks ▸" submenu for a right-clicked row, wherever it lives: write a
   *  new task about it, run a one-off about it, then the two groups of tasks.
   *  The surfaces stay ignorant of the task registry — they ask for the item
   *  and splice it into their menu. */
  const taskMenu = useCallback(
    (seed: string, runnable?: TaskChoice[]) =>
      taskMenuItem({
        seed,
        runnable,
        onNewTask: seedTaskFrom,
        onOneOff: (brief) => openTaskComposer(brief, "once"),
        onRunSaved: (t) => void startMicroTask(customTaskDef(t), { dir: roots[0] ?? "" }, ""),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seedTaskFrom, openTaskComposer, startMicroTask, roots[0]],
  );

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

  const startRename = useCallback((tab: TermSubTab) => {
    setRenamingTabId(tab.id);
    setRenameDraft(tab.customTitle ?? tab.title);
  }, []);
  // Empty draft clears the custom name and falls back to the auto title.
  const commitRename = useCallback(() => {
    if (renamingTabId) patchTab(renamingTabId, { customTitle: renameDraft.trim() || undefined });
    setRenamingTabId(null);
  }, [renamingTabId, renameDraft, patchTab]);
  const cancelRename = useCallback(() => setRenamingTabId(null), []);

  // Agents are the crux of this IDE, so they own the main strip. Detection is
  // by launch command OR by what's actually running in the pty tree, so a
  // `claude` typed by hand into a shell promotes that tab too. Plain shells and
  // long-running commands are demoted to their own right-hand rails (below);
  // reference docs (files, PRs, tickets) form a quieter group after the agents.
  // Detection uses the agentIdentity module (agent_hint from stats, command
  // for launched tabs). Content-keyed: `stats` re-samples every ~4s, but this
  // set only earns a new identity when the set of agent-bearing ptys actually
  // changes — so the memoized PaneBar isn't repainted by a sample that changed
  // nothing.
  const agentPtyList = projectStats
    .filter((s) => identifyAgent(s.agent_hint))
    .map((s) => s.id);
  const agentPtyKey = agentPtyList.slice().sort((a, b) => a - b).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const agentPtyIds = useMemo(() => new Set(agentPtyList), [agentPtyKey]);
  const isAgentTab = useCallback(
    (t: SubTab): t is TermSubTab =>
      t.type === "terminal" &&
      (!!agentIdForCommand(t.command) ||
        (t.ptyId != null && agentPtyIds.has(t.ptyId))),
    [agentPtyIds],
  );
  // A single dot carries an agent tab's whole state: orange sharp-pulse when it
  // wants attention (unread — set by OSC or the went-quiet heuristic), gray
  // soft-pulse while its work burns CPU, gray steady when idle.
  // Same content-keying as agentPtyIds: identity changes only when the set of
  // busy ptys crosses the CPU threshold, not on every sample.
  const busyPtyList = projectStats.filter((s) => s.total_cpu > 10).map((s) => s.id);
  const busyPtyKey = busyPtyList.slice().sort((a, b) => a - b).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const busyPtyIds = useMemo(() => new Set(busyPtyList), [busyPtyKey]);
  // The tab dot's state. For an agent tab we use the authoritative session state
  // — resolved through the live pty→session→digest binding the workspace uses —
  // so the titlebar and the Agents panel never disagree, and `waiting` (blocked
  // on you) and `ended` are shown as themselves rather than guessed. A plain
  // shell, or an agent whose session we can't resolve yet, falls back to the CPU
  // heuristic. `unread` (unseen activity) is layered on separately as a ring.
  const tabState = useCallback(
    (t: TermSubTab): "working" | "waiting" | "idle" | "ended" => {
      if (isAgentTab(t) && t.ptyId != null) {
        const sid = liveSessionByPty.get(t.ptyId);
        const st = sid ? wsDigests.find((d) => d.session_id === sid)?.state : undefined;
        if (st === "working" || st === "waiting" || st === "idle" || st === "ended") return st;
      }
      return t.ptyId != null && busyPtyIds.has(t.ptyId) ? "working" : "idle";
    },
    [isAgentTab, liveSessionByPty, wsDigests, busyPtyIds],
  );
  // Micro-task tabs, for the Tasks panel's Running list. Same state resolution
  // as the tab dots so the two never disagree.
  const runningMicro: RunningMicroTask[] = useMemo(
    () =>
      tabs
        .filter((t): t is TermSubTab => t.type === "terminal" && Boolean(t.micro))
        .map((t) => ({
          tabId: t.id,
          title: t.customTitle || t.title,
          state: tabState(t),
          icon: t.icon,
        })),
    [tabs, tabState],
  );
  const stripTabs = useMemo(
    () => tabs.filter((t) => t.type !== "terminal" || !t.run),
    [tabs],
  );
  const shellTabs = useMemo(
    () => stripTabs.filter((t): t is TermSubTab => t.type === "terminal" && !isAgentTab(t)),
    [stripTabs, isAgentTab],
  );
  const tabGroups: SubTab[][] = useMemo(
    () => [
      stripTabs.filter(isAgentTab),
      stripTabs.filter((t) => t.type !== "terminal"),
    ],
    [stripTabs, isAgentTab],
  );
  // Drag to reorder, one strip per group: agents stay left of docs however you
  // shuffle them, and a tab dropped outside its own group simply snaps back.
  // The order lives in `tabs` itself, so the panes (which are all mounted)
  // follow along without anything else having to know about the drag.
  const reorderGroup = useCallback(
    (ids: string[]) => setTabs((prev) => applyOrder(prev, (t) => t.id, ids)),
    [],
  );
  const agentDrag = useTabDrag(
    tabGroups[0].map((t) => t.id),
    reorderGroup,
  );
  const docDrag = useTabDrag(
    tabGroups[1].map((t) => t.id),
    reorderGroup,
  );
  const groupDrags = useMemo(() => [agentDrag, docDrag], [agentDrag, docDrag]);
  // Shells and runs each get a compact rail; Rail collapses to a dropdown at 2+.
  const shellChips: RailChip[] = useMemo(
    () =>
      shellTabs.map((tab) => ({
        id: tab.id,
        active: tab.id === activeTabId,
        dot: <TerminalIcon size={11} className="run-chip-shell-dot" />,
        title: tab.customTitle ?? tab.title,
        tooltip: `${tab.command ?? "shell"} — ${tab.cwd}`,
        onSelect: () => setActiveTabId(tab.id),
        onClose: () => closeTab(tab.id),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shellTabs, activeTabId, closeTab],
  );
  const runChips: RailChip[] = useMemo(
    () =>
      runTabs.map((tab) => {
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
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runTabs, activeTabId, closeTab, restartRun],
  );
  // Which pane-bar section owns the active tab. The other sections recede
  // (dimmed + softly blurred) so it's unmistakable where you are: closing a
  // shell no longer means squinting past an equally-bright "IDE" tab and
  // hitting it by mistake. Clicking a recessed section shifts focus here and
  // clears the dim.
  const activeSection: "tabs" | "shells" | "runs" = useMemo(
    () =>
      shellChips.some((c) => c.active)
        ? "shells"
        : runChips.some((c) => c.active)
          ? "runs"
          : "tabs",
    [shellChips, runChips],
  );

  // First-run coach-marks: spotlight each new workspace section the first time
  // it appears — the SHELLS rail when a terminal opens, RUNS when something
  // runs, and the agent's tab when one is focused. Each fires once (localStorage
  // -gated), only on the visible project, and only one shows at a time; the
  // effect re-picks the next eligible tip after one is dismissed.
  const [coachTip, setCoachTip] = useState<CoachTip | null>(null);
  const agentTabOpen = activeTab?.type === "agent";
  useEffect(() => {
    if (!visible || coachTip) return;
    if (shellChips.length && shouldShowTip("shells")) setCoachTip("shells");
    else if (runChips.length && shouldShowTip("runs")) setCoachTip("runs");
    else if (agentTabOpen && shouldShowTip("agent")) setCoachTip("agent");
  }, [visible, coachTip, shellChips.length, runChips.length, agentTabOpen]);

  const dismissCoach = () => {
    if (coachTip) markTipSeen(coachTip);
    setCoachTip(null);
  };
  const COACH_TIPS: Record<CoachTip, { selector: string; title: string; body: string }> = {
    shells: {
      selector: '[data-rail="SHELLS"]',
      title: "Your shell lives here",
      body: "Every plain terminal you open shows up in the SHELLS rail — click a chip to jump back to it, ✕ to close it.",
    },
    runs: {
      selector: '[data-rail="RUNS"]',
      title: "Your runs live here",
      body: "Run commands and dev servers land in the RUNS rail as live services, each with a status dot. Every server you start shows up here.",
    },
    agent: {
      selector: ".tab.tab-active",
      title: "Your agent workspace lives here",
      body: "This tab is the agent's workspace — its terminal, diffs and activity. Reopen it any time from the tab strip.",
    },
  };

  // One summary glyph for the runs dropdown: any live wins, then any failure.
  const runSummary = useMemo(
    () =>
      runTabs.some((t) => !t.exited) ? (
        <LiveDot size={7} className="run-chip-dot" />
      ) : runTabs.some((t) => t.exitCode !== 0) ? (
        <FailIcon size={11} className="run-chip-fail" />
      ) : (
        <CheckIcon size={11} className="run-chip-ok" />
      ),
    [runTabs],
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
      // Folded through binName on both sides: an override can be a full path
      // while a process table reports a basename, and an exact fold is what
      // keeps `amp` from matching a process called `ramp`.
      const byProc = AGENT_CLIS.find((c) =>
        procs.some(
          (p) => binName(p.name) === binName(c.bin) || binName(p.cmd.split(" ")[0] ?? "") === binName(c.bin),
        ),
      );
      // Via the registry id, so a terminal remembered from before a rebind —
      // still carrying the vendor's name — keeps its agent and its icon.
      const byCommand = AGENT_CLIS.find((c) => c.id === agentIdForCommand(t.command));
      return {
        tabId: t.id,
        title: t.customTitle ?? t.title,
        ptyId: t.ptyId as number,
        agentId: (byProc ?? byCommand)?.id ?? "agent",
        dir: t.cwd.split("/").filter(Boolean).pop() ?? "",
      };
    });

  // The session changeset shaped for the agent context builder: component
  // label plus each file's repo-relative path.
  const changeContextGroups = () =>
    changeGroups.map((g) => ({ component: g.component, paths: g.files.map((f) => f.path) }));

  // Which component checkout an absolute path lives in — the cwd a fresh agent
  // opened on that file should start in. Falls back to the first component.
  const repoForFile = (abs: string) =>
    componentsRef.current.find((c) => abs === c.path || abs.startsWith(`${c.path}/`))?.path ??
    componentsRef.current[0]?.path ??
    null;

  // Every port something in this project's terminals is listening on, tied to
  // the component whose directory the terminal runs in. This is what makes a
  // previewed URL traceable to a codebase: the preview tab lists exactly these,
  // and feedback from a linked page targets that component. RUNS-rail servers
  // sort first — they're the configured dev servers, a shell's port is a bonus.
  const previewServers: PreviewServer[] = tabs
    .filter(
      (t): t is TermSubTab => t.type === "terminal" && t.ptyId != null && !t.exited,
    )
    .flatMap((t) => {
      const ports = projectStats.find((s) => s.id === t.ptyId)?.ports ?? [];
      const comp =
        components.find((c) => t.cwd === c.path || t.cwd.startsWith(`${c.path}/`)) ?? null;
      return ports.map((p) => ({
        url: `http://localhost:${p}`,
        port: p,
        ptyId: t.ptyId as number,
        title: t.customTitle ?? t.title,
        command: t.command,
        cwd: t.cwd,
        componentLabel: comp?.label ?? null,
        componentPath: comp?.path ?? t.cwd,
        run: !!t.run,
      }));
    })
    .sort((a, b) => Number(b.run) - Number(a.run));

  // Mirror this project's live shape — components, run servers, agents — into
  // the Rust context bridge, where `canopy-hook --mcp` serves it to agents as
  // the canopy_* tools. Runs every render, but the stringify diff means a
  // publish only crosses IPC when something actually changed.
  const lastContextRef = useRef("");
  useEffect(() => {
    const snapshot = JSON.stringify({
      id: project.id,
      name: project.name,
      components: components.map((c) => ({
        label: c.label,
        path: c.path,
        commands: c.commands ?? [],
      })),
      runServers: tabs
        .filter((t): t is TermSubTab => t.type === "terminal" && !!t.run)
        .map((t) => ({
          ptyId: t.ptyId,
          title: t.customTitle ?? t.title,
          command: t.command ?? "",
          cwd: t.cwd,
          component:
            components.find((c) => t.cwd === c.path || t.cwd.startsWith(`${c.path}/`))?.label ??
            null,
          listeningPorts: projectStats.find((s) => s.id === t.ptyId)?.ports ?? [],
          running: !t.exited && t.ptyId != null,
          exitCode: t.exitCode ?? null,
        })),
      agents: agentTargets.map((a) => ({
        ptyId: a.ptyId,
        agent: a.agentId,
        title: a.title,
        dir: a.dir,
      })),
      // Preview annotations, so canopy_annotations can serve the visual
      // feedback the user marked — element, comment, and serving component.
      annotations: tabs
        .filter((t): t is PreviewSubTab => t.type === "preview")
        .flatMap((t) => {
          const server = serverForUrl(t.url, previewServers);
          return t.annotations.map((a) => ({
            n: a.n,
            selector: a.selector,
            component: a.components[0] ?? null,
            tag: a.tag,
            text: a.text,
            comment: a.comment,
            pageUrl: a.pageUrl || t.url,
            servingComponent: server?.componentLabel ?? null,
            servingComponentPath: server?.componentPath ?? null,
          }));
        }),
      // Open preview tabs, so agents know what the browser-control tools
      // (canopy_browser_*) are currently pointed at.
      previews: tabs
        .filter((t): t is PreviewSubTab => t.type === "preview")
        .map((t) => ({ url: t.url || null, annotations: t.annotations.length })),
      // What the user is looking at (canopy_editor_state) — the tab in front of
      // them, the caret, the selection. Deixis: "fix this" has a referent, and
      // this is it.
      editor: {
        focused: visible,
        activeTab: describeTab(tabs.find((t) => t.id === activeTabId)),
        openTabs: tabs.map(describeTab).filter(Boolean),
        caret:
          caret && tabs.some((t) => t.type === "file" && t.file.path === caret.path)
            ? caret
            : null,
      },
    });
    if (snapshot !== lastContextRef.current) {
      lastContextRef.current = snapshot;
      void ipc.contextPublish(project.id, snapshot);
    }
  });
  // A closed project's servers die with it; drop its snapshot too.
  useEffect(() => () => void ipc.contextRemove(project.id), [project.id]);

  // The agent behind the active *terminal* tab, if any — the "Agent Workspace"
  // toggle and its overlay only exist here. Identity is the live process (same
  // resolution as the tab icon), so it's right for every agent CLI — not just
  // the hook-reporting ones. The workspace is driven off the terminal's cwd;
  // the hook digest, when there is one, only rides along as enrichment, and
  // only when it genuinely belongs to this agent (a reused PTY can still carry
  // a previous CLI's digest — attaching it is exactly the bug this replaces).
  const agentTermWs =
    activeTab?.type === "terminal" && isAgentTab(activeTab) && activeTab.ptyId != null
      ? (() => {
          const stat = projectStats.find((s) => s.id === activeTab.ptyId);
          const procs = stat?.procs ?? [];
          const byProc = AGENT_CLIS.find((c) =>
            procs.some(
              (p) =>
                binName(p.name) === binName(c.bin) ||
                binName(p.cmd.split(" ")[0] ?? "") === binName(c.bin),
            ),
          );
          const byCommand = AGENT_CLIS.find((c) => c.id === agentIdForCommand(activeTab.command));
          const agent = (byProc ?? byCommand)?.id ?? "agent";
          // The live session cwd — the same source the Agents panel keys off,
          // so the overlay and a panel-opened tab resolve the same workspace.
          const cwd = stat?.cwd || activeTab.cwd || "";
          const repo =
            components.find((c) => cwd === c.path || cwd.startsWith(c.path + "/"))?.path ?? null;
          // Bind to the session actually running in this terminal by identity,
          // never by the digest's `surface` (the pty from whenever the hook last
          // wrote — stale across a restart, which is what stapled a dead session
          // onto a live tab). In order of reliability:
          //   1. Live hook events on this pty (`canopy_pty`) name the session
          //      directly, whatever pty number this launch happened to assign.
          //   2. A resume command carries the session id outright — restart-proof
          //      and correct even before the resumed agent's first event fires.
          //   3. Only a hookless CLI that was never resumed falls back to the
          //      surface binding, and even then a digest from another launch
          //      (untagged/other-instance) is rejected rather than shown.
          const boundSid =
            liveSessionByPty.get(activeTab.ptyId as number) ??
            resumeSessionId(activeTab.command);
          let digest: ipc.SessionDigest | undefined;
          let sessionId: string | undefined;
          if (boundSid) {
            const ld = wsDigests.find((x) => x.session_id === boundSid);
            digest = ld && (ld.agent ?? "agent") === agent ? ld : undefined;
            sessionId = boundSid;
          } else {
            const d = digestBySurface(wsDigests, thisInstance).get(String(activeTab.ptyId));
            const belongs = d && (!thisInstance || d.instance === thisInstance);
            digest = belongs && (d.agent ?? "agent") === agent ? d : undefined;
            sessionId = digest?.session_id;
          }
          return { repo, agent, cwd, sessionId, digest, ptyId: activeTab.ptyId as number };
        })()
      : null;
  // Derived, not stored: the overlay shows when the terminal in front is one you
  // opened it on. Anything else in front — another agent, a file, no agent tab
  // at all — and there is nothing to close, because it was never open for that.
  const wsDrawerPty = agentTermWs?.ptyId ?? null;
  const wsDrawerOpen = wsDrawerPty != null && wsOpenPtys.has(wsDrawerPty);
  const setWsDrawerOpen = useCallback(
    (open: boolean) => {
      if (wsDrawerPty == null) return;
      setWsOpenPtys((prev) => {
        if (prev.has(wsDrawerPty) === open) return prev;
        const next = new Set(prev);
        if (open) next.add(wsDrawerPty);
        else next.delete(wsDrawerPty);
        return next;
      });
    },
    [wsDrawerPty],
  );
  // Forget terminals that have gone away. PTY ids can be reused, and a stale
  // entry would open the workspace unbidden on whatever inherits the number.
  const liveTermPtys = useMemo(
    () => tabs.filter((t): t is TermSubTab => t.type === "terminal").map((t) => t.ptyId),
    [tabs],
  );
  useEffect(() => {
    setWsOpenPtys((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(liveTermPtys);
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [liveTermPtys]);
  // Esc closes the overlay, matching every other overlay in the app.
  useEffect(() => {
    if (!wsDrawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWsDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wsDrawerOpen, setWsDrawerOpen]);

  const peerMembers = useMemo(
    () => relay.status.members.filter((m) => m.id !== relay.status.self_id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [relay.status.members, relay.status.self_id],
  );
  const isRelayConnectedWithPeers =
    relay.status.role !== "off" && peerMembers.length > 0;
  const activeFileTab = useMemo(
    () => (activeTab?.type === "file" ? activeTab : null),
    [activeTab],
  );
  const activeTermTab = useMemo(
    () => (activeTab?.type === "terminal" ? activeTab : null),
    [activeTab],
  );

  // Stable PaneBar callbacks — identity only changes when their actual deps change,
  // not on every 4s stats sample, so the memoized PaneBar stays put between samples.
  const isSharedFile = useMemo(
    () => activeFileTab != null && shared.current.has(activeFileTab.file.path),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeFileTab, relay.collabTick],
  );
  const isProjectShared = useCallback(
    (memberId: string) =>
      relay.collab.projectSharedWith(rootsRef.current[0] ?? "").has(memberId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [relay.collabTick],
  );
  const onSelectTab = useCallback(
    (id: string, clickCount?: number) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (tab?.type === "terminal" && clickCount === 2) startRename(tab);
      else setActiveTabId(id);
    },
    [startRename],
  );
  const onTabContextMenu = useCallback(
    (e: React.MouseEvent, tab: SubTab) => {
      // Every tab kind that names a concrete thing can seed a task about it —
      // the same create-form flow as a terminal selection, with the tab's
      // subject prefilled (and a quick-run action where one applies).
      const taskItem: MenuItem[] =
        tab.type === "file"
          ? [taskMenu(`In \`${tab.file.path}\`: `)]
          : tab.type === "pr"
            ? [
                taskMenu(`About PR #${tab.pr.number} "${tab.pr.title}" (${tab.pr.url}): `, [
                  {
                    id: reviewPrTask.id,
                    label: `Review PR #${tab.pr.number}`,
                    icon: reviewPrTask.icon,
                    run: () => void startMicroTask(reviewPrTask, { repo: tab.repo, pr: tab.pr }, ""),
                  },
                  {
                    id: addressPrCommentsTask.id,
                    label: `Address comments on #${tab.pr.number}`,
                    icon: addressPrCommentsTask.icon,
                    run: () =>
                      void startMicroTask(
                        addressPrCommentsTask,
                        { repo: tab.repo, pr: tab.pr },
                        "",
                      ),
                  },
                ]),
              ]
            : tab.type === "branch"
              ? [
                  taskMenu(
                    `On branch ${tab.branch.branch}: `,
                    tab.branch.merged
                      ? undefined
                      : [
                          {
                            id: raisePrTask.id,
                            label: `Raise PR for ${tab.branch.branch}`,
                            icon: raisePrTask.icon,
                            run: () =>
                              void startMicroTask(
                                raisePrTask,
                                {
                                  repo: tab.repo,
                                  branch: tab.branch.branch,
                                  worktree: tab.branch.worktree,
                                  unpushed: !tab.branch.upstream || tab.branch.ahead > 0,
                                },
                                "",
                              ),
                          },
                        ],
                  ),
                ]
              : tab.type === "ticket"
                ? [
                    taskMenu(
                      `About ticket ${tab.ticket.id} "${tab.ticket.title}" (${tab.ticket.url}): `,
                    ),
                  ]
                : [];
      const items: MenuItem[] =
        tab.type === "terminal"
          ? [
              { label: "Rename", onClick: () => { if (tab.type === "terminal") startRename(tab); } },
              { label: "Close", danger: true, onClick: () => closeTab(tab.id) },
            ]
          : [
              ...taskItem,
              { label: "Close", danger: true, onClick: () => closeTab(tab.id) },
            ];
      tabMenu.open(e, items);
    },
    [startRename, closeTab, tabMenu.open, taskMenu, startMicroTask],
  );
  const onClearScrollback = useCallback(() => {
    if (activeTermTab) termHandles.current.get(activeTermTab.id)?.clearScrollback();
  }, [activeTermTab]);
  const onHardReset = useCallback(() => {
    if (activeTermTab) termHandles.current.get(activeTermTab.id)?.hardReset();
  }, [activeTermTab]);
  const onToggleView = useCallback(() => {
    if (activeFileTab) toggleView(activeFileTab.file.path);
  }, [activeFileTab, toggleView]);
  const onShareFile = useCallback(
    (memberId: string, memberName: string) => {
      if (activeFileTab)
        shareFileLive(activeFileTab.file.path, activeFileTab.file.name, memberId, memberName);
    },
    [activeFileTab, shareFileLive],
  );
  const onShareProject = useCallback(
    (memberId: string, memberName: string) => shareProjectLive(memberId, memberName),
    [shareProjectLive],
  );
  const onNewShell = useCallback(
    () => { const cwd = componentsRef.current[0]?.path; if (cwd) addTerminal(cwd); },
    [addTerminal],
  );
  const onLaunchCli = useCallback((cli: AgentCli) => launchCli(cli), [launchCli]);
  const onRunCliUpdate = useCallback(
    (cli: AgentCli, _e: React.MouseEvent) => runCliUpdate(cli),
    [runCliUpdate],
  );
  const onOpenAllTabs = useCallback(
    (e: React.MouseEvent) =>
      tabMenu.open(
        e,
        stripTabs.map((t) => ({
          label: `${t.id === activeTabId ? "› " : ""}${tabDisplayLabel(t)}`,
          onClick: () => setActiveTabId(t.id),
        })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabMenu.open, stripTabs, activeTabId],
  );

  // ---------- document tabs ----------
  // Doc tabs used to render only while active, so switching away and back
  // rebuilt the view from scratch: scroll jumped to the top, loaded data was
  // refetched, and a preview reloaded its page (losing whatever you had it in
  // the middle of). They now stay mounted and are display-toggled, exactly
  // like the terminals above.
  //
  // The catch is that ProjectView re-renders often (pty stats tick every 2s),
  // and re-rendering ten mounted views on each tick — PR diffs, editors —
  // would be real work for nothing. So an inactive pane whose own tab data
  // hasn't changed is handed back the SAME element it last rendered: React
  // compares element identity and skips that subtree entirely. A pane is
  // rebuilt when it's in front (so it always sees current props) or when its
  // tab changed underneath it.
  const docTabs = tabs.filter((t): t is DocSubTab => t.type !== "terminal");
  const panes = useRef(new Map<string, { tab: DocSubTab; el: ReactNode }>());
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id));
    for (const id of [...panes.current.keys()]) if (!live.has(id)) panes.current.delete(id);
  }, [tabs]);
  const paneFor = (tab: DocSubTab): ReactNode => {
    const cached = panes.current.get(tab.id);
    if (cached && cached.tab === tab && tab.id !== activeTabId) return cached.el;
    const el = docTabView(tab);
    panes.current.set(tab.id, { tab, el });
    return el;
  };

  function docTabView(tab: DocSubTab): ReactNode {
    switch (tab.type) {
      case "branch":
        return (
          <BranchView
            relay={relay}
            repo={tab.repo}
            branch={tab.branch}
            onOpenCommit={openCommit}
            onOpenTerminal={(cwd, label) => addTerminal(cwd, undefined, label)}
            onNotice={onNotice}
            onMicroTask={startMicroTask}
          />
        );
      case "agent":
        return (
          <AgentWorkspaceView
            repo={tab.repo}
            agent={tab.agent}
            cwd={tab.cwd}
            sessionId={tab.sessionId}
            digest={tab.digest}
            onOpenCommit={openCommit}
            onOpenPr={openPr}
            onOpenTerminal={(cwd, label) => addTerminal(cwd, undefined, label)}
            onNotice={onNotice}
            onMessageAgent={(text) =>
              messageAgent({
                sessionId: tab.sessionId,
                agentId: tab.agent,
                cwd: tab.cwd,
                text,
              })
            }
            onFocusAgent={jumpToPty}
            onRaisePrTask={
              tab.repo
                ? (branch, worktree) =>
                    void startMicroTask(raisePrTask, { repo: tab.repo as string, branch, worktree }, "")
                : undefined
            }
            onReviewPrTask={
              tab.repo
                ? (pr) => void startMicroTask(reviewPrTask, { repo: tab.repo as string, pr }, "")
                : undefined
            }
            onAddressPrCommentsTask={
              tab.repo
                ? (pr) =>
                    void startMicroTask(addressPrCommentsTask, { repo: tab.repo as string, pr }, "")
                : undefined
            }
            onRunSavedTask={(task, dir) => void startMicroTask(customTaskDef(task), { dir }, "")}
            onRunOneOff={(brief, dir) => runAdhocTask(brief, dir)}
          />
        );
      case "commit":
        return <CommitView repo={tab.repo} hash={tab.hash} onNotice={onNotice} />;
      case "ticket":
        return (
          <TicketView
            ticket={tab.ticket}
            source={tab.source}
            worktree={ticketWorktree(tab.ticket, ticketWorktrees)}
            agentTargets={agentTargets}
            installed={installed}
            onStartNew={(agentId) => void startTicketWork(tab.ticket, agentId)}
            onSendToAgent={(target) => sendTicketToAgent(target, ticketContext(tab.ticket))}
          />
        );
      case "pr":
        return (
          <PrView
            repo={tab.repo}
            pr={tab.pr}
            onNotice={onNotice}
            relay={relay}
            agentTargets={agentTargets}
            installed={installed}
            onStartReview={(agentId) => void startPrReview(tab.repo, tab.pr, agentId)}
            onSendToAgent={(target) => sendTicketToAgent(target, prReviewContext(tab.pr))}
            onStartResolve={(agentId) => void startPrConflictResolve(tab.repo, tab.pr, agentId)}
            onSendResolve={(target) => sendTicketToAgent(target, prConflictContext(tab.pr))}
            onMicroTask={startMicroTask}
          />
        );
      case "review":
        return (
          <ReviewView
            review={tab.review}
            agentBar={
              <AgentQueryBar
                placeholder="Ask an agent to review this…"
                onRunTask={(query) =>
                  void writeReviewPatch(tab.review).then((path) => {
                    const dir = componentsRef.current[0]?.path;
                    if (!path || !dir) return;
                    runAdhocTask(
                      reviewContext(tab.review, path, query),
                      dir,
                      `Review ${tab.review.branch}`,
                    );
                  })
                }
              />
            }
          />
        );
      case "preview":
        return (
          <PreviewView
            tabId={tab.id}
            url={tab.url}
            annotations={tab.annotations}
            onPatch={(patch) => patchTabRaw(tab.id, patch as Partial<SubTab>)}
            servers={previewServers}
            agentTargets={agentTargets}
            installed={installed}
            onSendToAgent={sendTicketToAgent}
            onStartNew={(agentId, text, cwd) => {
              // The serving component's checkout when the page is linked to
              // one; the first component only as a last resort.
              const dir = cwd ?? componentsRef.current[0]?.path;
              if (!dir) {
                onNotice("No project directory to start the agent in.");
                return;
              }
              startAgentInDir(dir, agentId, text, "Preview feedback");
            }}
            onNotice={onNotice}
          />
        );
      case "task-history":
        return (
          <TaskHistoryView
            projectId={project.id}
            projectName={project.name}
            // Re-runs the stored brief rather than the task definition: a
            // built-in's payload came from the surface it was clicked on
            // (a branch tab, a PR), which is long gone — but the brief that
            // payload produced was recorded, and it says everything.
            onRunAgain={(run: TaskRun) =>
              runAdhocTask(run.brief, run.cwd, run.label)
            }
            onOpenFile={(path) => void openFile(path)}
          />
        );
      case "instructions":
        return (
          <InstructionsView
            roots={roots}
            installed={installed}
            focus={tab.focus}
            active={tab.id === activeTabId && visible}
            onNotice={onNotice}
          />
        );
      case "chat":
        return <ChatView peer={tab.peer} title={tab.name} relay={relay} onNotice={onNotice} />;
      case "collab": {
        const session = relay.collab.get(tab.doc);
        return session instanceof GuestSession ? (
          <CollabView session={session} ownerName={tab.ownerName} onNotice={onNotice} />
        ) : (
          <div className="editor-empty">
            <h2>{tab.name}</h2>
            <p>This live session has ended.</p>
          </div>
        );
      }
      case "shared-project":
        return (
          <SharedProjectView
            name={tab.name}
            ownerName={tab.ownerName}
            paths={relay.collab.joinedProjects.get(tab.doc)?.paths ?? []}
            onOpen={(relPath) => relay.collab.openProjectFile(tab.doc, relPath)}
          />
        );
      case "file":
        return (
          <FileView
            file={tab.file}
            onCursor={
              // Only a shared file broadcasts a caret; every other tab passes
              // undefined and the subscription in MonacoEditor short-circuits.
              sharedDocFor(tab.file.path)
                ? (anchor, head) => sendOwnerCursor(tab.file.path, anchor, head)
                : undefined
            }
            onSave={() => void saveFile(tab.file.path)}
            onDirty={(dirty) => {
              if (tab.file.dirty !== dirty) patchFile(tab.file.path, { dirty });
            }}
            onAcceptExternal={() => acceptExternal(tab.file.path)}
            onKeepMine={() => keepMine(tab.file.path)}
            onCloseDiff={() => patchFile(tab.file.path, { view: "source", diffOriginal: null })}
            diffAgentBar={
              <AgentQueryBar
                placeholder="Ask an agent about this file's changes…"
                onRunTask={(query) => {
                  const dir = repoForFile(tab.file.path);
                  if (!dir) return onNotice("No git repository in this project.");
                  runAdhocTask(fileDiffContext(tab.file.path, query), dir, tab.file.name);
                }}
              />
            }
          />
        );
    }
  }

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
      {termMenu.menu && (
        <ContextMenu
          x={termMenu.menu.x}
          y={termMenu.menu.y}
          items={termMenu.menu.items}
          onClose={termMenu.close}
        />
      )}
      <PaneBar
        tabGroups={tabGroups}
        groupDrags={groupDrags}
        stripTabs={stripTabs}
        activeTabId={activeTabId}
        flashTabId={flashTabId}
        renamingTabId={renamingTabId}
        renameDraft={renameDraft}
        collabPaths={collabPaths}
        isAgentTab={isAgentTab}
        tabState={tabState}
        shellChips={shellChips}
        runChips={runChips}
        runSummary={runSummary}
        shellMenuOpen={shellMenuOpen}
        setShellMenuOpen={setShellMenuOpen}
        runMenuOpen={runMenuOpen}
        setRunMenuOpen={setRunMenuOpen}
        activeSection={activeSection}
        activeFileKind={activeFileTab?.file.kind}
        activeFileView={activeFileTab?.file.view}
        isSharedFile={isSharedFile}
        isRelayConnectedWithPeers={isRelayConnectedWithPeers}
        cliMenuOpen={cliMenuOpen}
        setCliMenuOpen={setCliMenuOpen}
        installed={installed}
        cliUpdates={cliUpdates}
        shareMenuOpen={shareMenuOpen}
        setShareMenuOpen={setShareMenuOpen}
        shareProjectMenuOpen={shareProjectMenuOpen}
        setShareProjectMenuOpen={setShareProjectMenuOpen}
        relayMembers={peerMembers}
        isProjectShared={isProjectShared}
        isTerminalTab={activeTermTab !== null}
        onSelectTab={onSelectTab}
        onTabContextMenu={onTabContextMenu}
        onCloseTab={closeTab}
        onCommitRename={commitRename}
        onCancelRename={cancelRename}
        onRenameDraftChange={setRenameDraft}
        onNewShell={onNewShell}
        onClearScrollback={onClearScrollback}
        onHardReset={onHardReset}
        onToggleView={onToggleView}
        onShareFile={onShareFile}
        onShareProject={onShareProject}
        onOpenPreview={openPreview}
        onLaunchCli={onLaunchCli}
        onRunCliUpdate={onRunCliUpdate}
        onRefreshInstalled={refreshInstalled}
        onRefreshUpdates={refreshUpdates}
        onOpenAllTabs={onOpenAllTabs}
        activeTabElRef={activeTabElRef}
      />
      <div className="project-content">
        {tabs
          .filter((t): t is TermSubTab => t.type === "terminal")
          .map((tab) => (
            <div
              key={tab.id}
              className="fill term-host"
              style={{ display: tab.id === activeTabId && visible ? "block" : "none" }}
              // Selected text is a task waiting to be written down — an error,
              // a TODO the shell just printed, a command worth automating.
              // Right-click offers to make one; without a selection the event
              // passes through untouched.
              onContextMenu={(e) => {
                const sel = termHandles.current.get(tab.id)?.getSelection().trim();
                if (!sel) return;
                termMenu.open(e, [taskMenu(sel)]);
              }}
            >
              <TermPorts ptyId={tab.ptyId} stats={stats} onPreview={openPreview} />
              <Term
                // epoch remounts the Term (fresh PTY) when a run tab restarts
                key={`${tab.id}:${tab.epoch ?? 0}`}
                ref={(h) => {
                  termHandles.current.set(tab.id, h);
                }}
                cwd={tab.cwd}
                active={tab.id === activeTabId && visible}
                attachId={tab.attachId}
                // A run tab hands its command to the shell to run-and-exit
                // (runCommand) so the pty's exit code is the command's own —
                // one-shot runs (build, install) report truthfully instead of
                // sitting at a prompt looking "running" forever — and it's
                // correct on cmd.exe / PowerShell, not just POSIX. A non-run tab
                // types its command (e.g. launching an agent CLI).
                //
                // Micro-tasks go the runCommand way too, for a different
                // reason: their brief is a whole paragraph on one line, and a
                // command that long typed at a shell that is still starting
                // loses its Enter to zsh's line editor — the task sat unrun at
                // a prompt. As an argv it never touches the tty.
                initialCommand={tab.run || tab.micro ? undefined : tab.command}
                runCommand={(tab.run || tab.micro) && tab.command ? tab.command : undefined}
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
                      tab.command?.startsWith("brew upgrade ") ||
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
        {/* Doc tabs, mounted for as long as they're open and shown by display
            like the terminals above — see docTabView. Each pane carries its own
            boundary: a view throwing (a PR diff, an editor, a ticket) must not
            take the app — or the running terminals beside it — down, and only
            the offending tab shows the fallback ("Reload this panel" clears it).
            Terminals stay outside: catching around them would kill their PTYs. */}
        {docTabs.map((tab) => (
          <div
            key={tab.id}
            className="fill doc-host"
            style={hostStyle(tab.id === activeTabId && visible, tab.type === "preview")}
          >
            <ErrorBoundary label="this tab">{paneFor(tab)}</ErrorBoundary>
          </div>
        ))}
        {tabs.length === 0 && (
          <div className="editor-empty">
            <h2>{project.name}</h2>
            {/* Missing foundations the CLI installers themselves need (Node for
                `npm install -g …`, git for everything). One-click install runs
                the OS-correct command in a terminal, same as a CLI install, and
                the tab's exit re-probes so the banner clears itself. */}
            {PREREQS.some((p) => prereqs[p.bin] === false) && (
              <div className="prereq-banner">
                <span className="prereq-note">
                  Missing prerequisites — the agent CLIs need these:
                </span>
                <div className="prereq-actions">
                  {PREREQS.filter((p) => prereqs[p.bin] === false).map((p) => (
                    <button
                      key={p.id}
                      className="prereq-install"
                      title={`For ${p.why}\nruns: ${p.install[currentPlatform()]}`}
                      onClick={() =>
                        components[0] &&
                        addTerminal(
                          components[0].path,
                          p.install[currentPlatform()],
                          `install ${p.name}`,
                          "⬇",
                          true,
                        )
                      }
                    >
                      Install {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
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
                      const cli = AGENT_CLIS.find((c) => c.id === agentIdForCommand(t.command));
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
        {/* Agent Workspace — a full-screen glassmorphic overlay for the active
            agent terminal, opened from a handle on the terminal's right edge.
            An OVERLAY, never a layout panel or a new tab: the terminal
            underneath stays mounted (unmounting a Term kills its PTY) and shows
            faintly through the frosted glass. The layer stays in the DOM so it
            can fade; the heavy AgentWorkspaceView only mounts while open. */}
        {agentTermWs && (
          <>
            {!wsDrawerOpen && (
              <button
                className="workspace-handle"
                title="Open agent workspace — files, diffs, commits & PR"
                aria-label="Open agent workspace"
                onClick={() => setWsDrawerOpen(true)}
              >
                <AgentIcon id={agentTermWs.agent} size={15} />
                <span className="workspace-handle-label">Workspace</span>
              </button>
            )}
            <div
              className={`workspace-overlay-layer ${wsDrawerOpen ? "open" : ""}`}
              aria-hidden={!wsDrawerOpen}
            >
              <section
                className="workspace-overlay"
                role="dialog"
                aria-modal="true"
                aria-label="Agent workspace"
              >
                {/* No chrome header here — AgentWorkspaceView's own banner is
                    the single header, and it renders the close button (passed
                    below) so the agent name/branch aren't repeated twice. */}
                <div className="workspace-overlay-body">
                  {wsDrawerOpen && (
                    <AgentWorkspaceView
                      key={agentTermWs.ptyId}
                      repo={agentTermWs.repo}
                      agent={agentTermWs.agent}
                      cwd={agentTermWs.cwd}
                      sessionId={agentTermWs.sessionId}
                      digest={agentTermWs.digest}
                      onOpenCommit={openCommit}
                      onOpenPr={openPr}
                      onOpenTerminal={(cwd, label) => addTerminal(cwd, undefined, label)}
                      onNotice={onNotice}
                      onMessageAgent={(text) =>
                        messageAgent({
                          ptyId: agentTermWs.ptyId,
                          sessionId: agentTermWs.sessionId,
                          agentId: agentTermWs.agent,
                          cwd: agentTermWs.cwd,
                          text,
                        })
                      }
                      onFocusAgent={jumpToPty}
                      onClose={() => setWsDrawerOpen(false)}
                      onRaisePrTask={
                        agentTermWs.repo
                          ? (branch, worktree) =>
                              void startMicroTask(
                                raisePrTask,
                                { repo: agentTermWs.repo as string, branch, worktree },
                                "",
                              )
                          : undefined
                      }
                      onReviewPrTask={
                        agentTermWs.repo
                          ? (pr) =>
                              void startMicroTask(
                                reviewPrTask,
                                { repo: agentTermWs.repo as string, pr },
                                "",
                              )
                          : undefined
                      }
                      onAddressPrCommentsTask={
                        agentTermWs.repo
                          ? (pr) =>
                              void startMicroTask(
                                addressPrCommentsTask,
                                { repo: agentTermWs.repo as string, pr },
                                "",
                              )
                          : undefined
                      }
                      onRunSavedTask={(task, dir) =>
                        void startMicroTask(customTaskDef(task), { dir }, "")
                      }
                      onRunOneOff={(brief, dir) => runAdhocTask(brief, dir)}
                    />
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );

  // ---------- side panels ----------
  // The rail has the same problem the doc tabs had: a panel unmounted the
  // moment you picked another icon, so coming back collapsed the file tree you
  // had expanded, threw away a commit message you had half-typed, and refetched
  // the ticket list. They stay mounted now, and are display-toggled — but only
  // from the first time each is opened, so a project never pays for a panel you
  // never look at (trackers talks to GitHub/Jira on mount).
  //
  // `display: contents` rather than block: the panels are flex children of
  // .sidebar and size themselves with flex, so the wrapper has to disappear
  // from the layout rather than become a box in it.
  //
  // Inactive panels reuse their last element for the same reason doc panes do —
  // a hidden panel has nothing to say. It still updates itself if its own state
  // changes (a file watcher firing, a fetch landing); the bailout only skips
  // re-rendering it from here. What it must NOT do is keep polling while nobody
  // is looking, so the two panels that poll take a `visible` prop.
  const [sideSeen, setSideSeen] = useState<SideTab[]>([sideTab]);
  useEffect(() => {
    setSideSeen((prev) => (prev.includes(sideTab) ? prev : [...prev, sideTab]));
  }, [sideTab]);
  const sidePanes = useRef(new Map<SideTab, { active: boolean; el: ReactNode }>());
  const sidePane = (key: SideTab, build: () => ReactNode) => {
    if (!sideSeen.includes(key)) return null;
    const active = sideTab === key;
    const cached = sidePanes.current.get(key);
    // Rebuilt while in front, and once more on the way out — that last build is
    // what hands a polling panel `visible: false`. After that it sits still.
    if (cached && !active && !cached.active) {
      return <div style={{ display: "none" }}>{cached.el}</div>;
    }
    const el = build();
    sidePanes.current.set(key, { active, el });
    return <div style={{ display: active ? "contents" : "none" }}>{el}</div>;
  };

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
      {sidePane("files", () => (
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
                    selectedPath={activeFileTab?.file.path ?? null}
                    onOpenFile={(p) => void openFile(p)}
                    onNotice={onNotice}
                    hideRootHeader
                    taskMenuFor={(p) => taskMenu(`In \`${p}\`: `)}
                  />
                </>
              )}
            </div>
          ))}
        </div>
      ))}
      {sidePane("git", () => (
        <GitPanel
          visible={sideTab === "git" && visible && sideOpen}
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
          branchTaskMenu={(repo, branch, worktree, merged) =>
            taskMenu(
              `On branch ${branch}: `,
              merged
                ? undefined
                : [
                    {
                      id: raisePrTask.id,
                      label: `Raise PR for ${branch}`,
                      icon: raisePrTask.icon,
                      run: () => void startMicroTask(raisePrTask, { repo, branch, worktree }, ""),
                    },
                  ],
            )
          }
          prTaskMenu={(repo, pr) =>
            taskMenu(`About PR #${pr.number} "${pr.title}" (${pr.url}): `, [
              {
                id: reviewPrTask.id,
                label: `Review PR #${pr.number}`,
                icon: reviewPrTask.icon,
                run: () => void startMicroTask(reviewPrTask, { repo, pr }, ""),
              },
              {
                id: addressPrCommentsTask.id,
                label: `Address comments on #${pr.number}`,
                icon: addressPrCommentsTask.icon,
                run: () => void startMicroTask(addressPrCommentsTask, { repo, pr }, ""),
              },
            ])
          }
        />
      ))}
      {sidePane("changes", () => (
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
          agentBar={
            <AgentQueryBar
              placeholder="Ask an agent about these changes…"
              onRunTask={(query) => {
                const dir = changeGroups[0]?.repo ?? componentsRef.current[0]?.path;
                if (!dir) return onNotice("No git repository in this project.");
                runAdhocTask(sessionChangesContext(changeContextGroups(), query), dir, "Changes");
              }}
            />
          }
        />
      ))}
      {sidePane("trackers", () => (
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
      ))}
      {sidePane("team", () => (
        <TeamPanel
          relay={relay}
          onOpenChat={openChat}
          onOpenInboxItem={(item) => void openInboxItem(item)}
          onNotice={onNotice}
        />
      ))}
      {sidePane("tasks", () => (
        <TasksPanel
          components={components.map((c) => ({ label: c.label, path: c.path }))}
          running={runningMicro}
          seed={taskSeed}
          onFocus={setActiveTabId}
          onStop={closeTab}
          onRunCustom={(task: CustomMicroTask, dir: string, query: string) =>
            void startMicroTask(customTaskDef(task), { dir }, query)
          }
          onRunOneOff={(brief: string, dir: string) => runAdhocTask(brief, dir)}
          onOpenHistory={openTaskHistory}
          projectId={project.id}
        />
      ))}
      {sidePane("agents", () => (
        <AgentsPanel
          visible={sideTab === "agents" && visible && sideOpen}
          stats={projectStats}
          hookPath={hookPath}
          pending={pending}
          onDismissPending={onDismissPending}
          onAnswer={answerQuestions}
          onRespond={respondPermission}
          onJumpToTerminal={jumpToTerminal}
          onJumpToPty={jumpToPty}
          onPreviewUrl={openPreview}
          onOpenAgent={(p) => void openAgent(p)}
          activePty={activePty}
          roots={roots}
          shareContext={Boolean(project.shareContext)}
          onShareContext={onShareContext}
          liveSessionIds={liveSessionIds}
          onRestore={(cwd, cmd, title, agentId) =>
            addTerminal(cwd, cmd, title, AGENT_CLIS.find((c) => c.id === agentId)?.icon)
          }
          onNotice={onNotice}
          onOpenInstructions={openInstructions}
          installed={installed}
        />
      ))}
    </div>
  );

  return (
    <div className="project-view" style={{ display: visible ? "flex" : "none" }}>
      {/* Rail + panels share a row; the status bar sits below it so it spans the
          full window width (rail + sidebar + main), not just the editor column. */}
      <div className="project-body">
        {!zen && (
          <ActivityRail
            sideTab={sideTab}
            open={sideOpen}
            pinned={pinned}
            changeBadge={changeCount + collabEditedCount}
            tasksBadge={runningMicro.length}
            pendingCount={pending.length}
            urgentCount={urgentPending.length}
            teamBadge={teamBadge}
            relayRole={relay.status.role}
            onSelectTab={selectSideTab}
            onHoverTab={hoverSideTab}
            onHoverCancel={cancelPeekOpen}
            onHoverLeave={leaveSideHover}
            onOpenSettings={openSettings}
            onToggleSidebar={toggleSidebar}
          />
        )}
        {/* The PanelGroup renders in every mode on purpose. Swapping mainArea
            between a bare child and a <Panel> changes its element type, which
            unmounts the subtree — and Term's cleanup kills the PTY. Toggling
            focus mode would silently kill every terminal (and any agent running
            in one). Keeping the tree shape fixed keeps the PTYs alive. */}
        <PanelGroup direction="horizontal">
          <Panel id="main" order={2}>
            {mainArea}
          </Panel>
        </PanelGroup>
        {/* The side panel floats over the editor instead of displacing it: the
            main area never reflows, so a peek costs nothing but a repaint — and
            a terminal never re-wraps because you glanced at the file tree.
            Always mounted, slid out of frame when closed, for the same reason
            the panes inside it are display-toggled. */}
        {!zen && (
          <div className="side-peek-layer">
            <div
              className={`side-peek ${sideOpen ? "open" : ""}`}
              style={{ width: sideWidth }}
              onMouseEnter={cancelPeekClose}
              onMouseLeave={() => schedulePeekClose()}
            >
              {/* The frost is its own layer, not a background on .side-peek.
                  backdrop-filter makes an element a containing block for fixed
                  descendants — with it on the wrapper, every context menu and
                  confirm dialog inside the panel would anchor to the panel
                  instead of the viewport. */}
              <div className="side-peek-frost" />
              {sidePanel}
              {/* No title here either — a tooltip on the panel's own edge would
                  cover the panel. The col-resize cursor is the affordance. */}
              <div className="side-peek-grip" onPointerDown={startSideResize} />
            </div>
          </div>
        )}
      </div>
      {/* Full-width, spanning rail + sidebar + main. Zen hides it via CSS. */}
      <StatusBar
        roots={roots}
        agents={runningAgents}
        events={projectEvents}
        visible={visible}
        projects={allProjects}
        onSetModel={hasClaude ? setAgentModel : undefined}
        activePtyId={activeTab?.type === "terminal" ? activeTab.ptyId : null}
      />
      {palette && visible && (
        <Palette
          mode={palette}
          components={components.map((c) => ({ label: c.label, path: c.path }))}
          onOpen={(p) => void openFile(p)}
          onClose={() => setPalette(null)}
        />
      )}
      {coachTip && visible && (
        <Coachmark
          targetSelector={COACH_TIPS[coachTip].selector}
          title={COACH_TIPS[coachTip].title}
          body={COACH_TIPS[coachTip].body}
          onDismiss={dismissCoach}
        />
      )}
    </div>
  );
}

// Shell: project tabs on top; each open project is a fully mounted (hidden
// when inactive) ProjectView so its terminals keep running across switches.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as ipc from "./ipc";
import {
  adoptLegacyCustomTasks,
  emptyWorkspace,
  exportProject,
  exportWorkspace,
  importFile,
  loadWorkspace,
  newProjectId,
  saveWorkspace,
  type Project,
  type WorkspaceState,
} from "./projects";
import type { AgentEventEntry, NoticeKind, RelayHandle } from "./types";
import type { CustomMicroTask } from "./microTasks";
import {
  derivePending,
  parseAgentEvent,
  pendingForRoots,
} from "./notifications";
import {
  formatDeepLink,
  parseDeepLink,
  projectForLink,
  type DeepLink,
} from "./deepLinks";
import {
  attentionItems,
  badgeFor,
  dismissToast,
  forProject,
  isOutstanding,
  liveToasts,
  osPayload,
  postAttention,
  resolveAttention,
  resolveAttentionByKey,
  shouldReachOS,
  toastMs,
  type AttentionItem,
} from "./attention";
import { useAttention } from "./useAttention";
import { NotificationCenter } from "./components/NotificationCenter";
import { runUiOp, type CompanionOps, type WorkspaceProject } from "./agentOps";
import { workspaceAgents, workspaceGit, workspaceSearch } from "./companionWorkspace";
import { companionName } from "./companion";
import type { CompanionProposal } from "./companionSession";
import { getSettings, subscribeSettings, THEME_CHANGE_EVENT } from "./settings";
import { useTabDrag } from "./tabDrag";
import * as prWatch from "./prWatchStore";
import * as clipboardStore from "./clipboardStore";
import { CollabManager, safeName } from "./collab";
import { ProjectView } from "./components/ProjectView";
import { TitleBar } from "./components/TitleBar";
import {
  FreezeOverlay,
  HibernationView,
  type WakeProgress,
} from "./components/HibernationView";
import {
  clearHibernation,
  hibernatedProjects,
  hibernationOf,
  isHibernating,
  wakeSteps,
  HIBERNATE_EVENT,
  HIBERNATED_EVENT,
  HIBERNATION_CHANGE_EVENT,
  type ProjectSnapshot,
} from "./hibernation";
import { UpdateToast, NoticeToast } from "./components/Toast";
import { ProjectDialog } from "./components/ProjectDialog";
import { ProjectManager } from "./components/ProjectManager";
import { SettingsDialog } from "./components/SettingsDialog";
import { HelpDialog } from "./components/HelpDialog";
import { AskDialog } from "./components/AskDialog";
import { AboutDialog } from "./components/AboutDialog";
import { Dictation } from "./components/Dictation";
import { Companion } from "./components/Companion";
import { startCompanion, stopCompanion } from "./companionSession";
import { companionToolNames } from "./companionTools";
import { checkInstalledClis } from "./projects";
import { TooltipLayer } from "./components/TooltipLayer";
import { Onboarding } from "./components/Onboarding";
import { Welcome } from "./components/Welcome";
import { Dialog } from "./components/Dialog";
import { shouldOnboard, markOnboarded } from "./onboarding";
import { isSelftest, setSelftestMode } from "./selftest/mode";
import { startBrowserWatchdog } from "./browserWatchdog";
import { browserViewSnapshots } from "./browserSignals";
import { startSpotIndexJob } from "./spotIndexJob";
import { useNoteReminders } from "./useNoteReminders";
import { loadZoom, setZoom, applyZoom, STEP } from "./zoom";
import { stopWorkspaceServers } from "./lsp/client";
import { sweepStaleRuns } from "./taskHistory";
import {
  digitFromCode,
  hintModifierOnly,
  useHeldModifier,
} from "./useHeldModifier";
import { commandHeld, matches, terminalOwnsCtrl } from "./shortcuts";
import {
  checkForUpdateAnyChannel,
  installUpdate,
  type UpdateAvailability,
} from "./updater";

/** Tell the hook helper which projects share context between their sessions.
 *  Every project is listed with its opt-in state, so turning sharing off
 *  actively revokes it rather than just omitting the entry. */
// Relay chat is persisted per-relay, keyed by the host's stable identity key
// (its Ed25519 pubkey) — not the ephemeral session id — so history survives
// restarts and re-associates with the same relay on reconnect. Capped, and
// scoped by relay so joining a different team never mixes transcripts.
const RELAY_CHAT_PREFIX = "canopy.relayChat:";
function loadRelayChat(label: string): ipc.RelayChatMsg[] {
  try {
    const raw = localStorage.getItem(RELAY_CHAT_PREFIX + label);
    return raw ? (JSON.parse(raw) as ipc.RelayChatMsg[]) : [];
  } catch {
    return [];
  }
}
function saveRelayChat(label: string, msgs: ipc.RelayChatMsg[]) {
  try {
    localStorage.setItem(
      RELAY_CHAT_PREFIX + label,
      JSON.stringify(msgs.slice(-500)),
    );
  } catch {
    // Storage full/blocked — history is a convenience, never fail over it.
  }
}

/** Ops that answer without a project to answer about.
 *
 *  `ask` is a background agent's question, whose cwd may be a worktree Canopy
 *  does not track. The rest are the companion's: it runs in no project by
 *  design, and its whole job is the view across all of them. */
const PROJECTLESS_OPS = new Set([
  "ask",
  "confirm",
  "workspace",
  "workspace_git",
  "workspace_agents",
  "workspace_search",
  "open_project",
  "recall",
  "remember",
]);

function publishScopes(state: WorkspaceState) {
  void ipc
    .setContextScopes(
      state.projects.map((p) => ({
        name: p.name,
        roots: p.components.map((c) => c.path),
        enabled: Boolean(p.shareContext),
      })),
    )
    .catch(() => {});
}

export default function App() {
  const [ws, setWs] = useState<WorkspaceState>(emptyWorkspace);
  const [loaded, setLoaded] = useState(false);
  const [dialog, setDialog] = useState<
    { mode: "new" } | { mode: "edit"; project: Project } | null
  >(null);
  const [agentEvents, setAgentEvents] = useState<AgentEventEntry[]>([]);
  // Pending cards the user waved away. Session-scoped on purpose: a dismissed
  // card is "seen", not "never tell me again". Held here (not in the panel)
  // because the project-tab badges count from the same derived list.
  const [dismissedPending, setDismissedPending] = useState<Set<string>>(
    new Set(),
  );
  const [manager, setManager] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState<null | {
    tab?: import("./components/SettingsDialog").SettingsTab;
  }>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  // First-run walkthrough. Seeded once, after the workspace has loaded, so a
  // fresh install lands on the welcome flow while returning users never see it.
  const [onboarding, setOnboarding] = useState(false);
  // One delete confirm for every entry point (manager, Welcome) — deleting a
  // project was a bare single click before, one misclick from losing a setup.
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);
  const [confirmClose, setConfirmClose] = useState<Project | null>(null);
  const [hookPath, setHookPath] = useState<string | null>(null);
  const [zen, setZen] = useState(false);
  // Transient "110%" chip shown for ~1s after a zoom change, then cleared.
  const [zoomPct, setZoomPct] = useState<number | null>(null);
  const zoomHideTimer = useRef<number | null>(null);
  // Everything that has asked for the user's attention (attention.ts). One
  // queue, one urgency model, one rule for when something leaves the app for
  // the OS — replacing a single-slot toast that the next caller overwrote, and
  // eight call sites that each decided for themselves whether to raise a
  // native banner and what to call it.
  const attention = useAttention();
  // The old `Notify` signature, unchanged, because it is threaded through
  // nearly every component and is the migration seam. A caller that knows more
  // than a string and a tone — which project, where a click should land, and
  // whether it is asking rather than announcing — calls `postAttention`
  // directly instead.
  const notify = useCallback(
    (text: string, kind: NoticeKind = "info") =>
      void postAttention({ kind: "fyi", tone: kind, title: text, source: "app" }),
    [],
  );
  /** Which project a path belongs to, as the `projectId` / `projectName` pair
   *  every posted item carries. The name is stamped in rather than looked up
   *  later, like TaskRun.projectName: the history outlives the project being
   *  closed or renamed, and an id alone tells the reader nothing.
   *
   *  Most specific component root wins, so a path inside a nested component
   *  lands in the project that owns it rather than an ancestor containing it. */
  const projectIdentity = useCallback(
    (path: string | undefined): { projectId?: string; projectName?: string } => {
      if (!path) return {};
      const norm = (p: string) => p.replace(/\/+$/, "");
      const c = norm(path);
      let best: Project | undefined;
      let bestLen = -1;
      for (const p of wsRef.current.projects) {
        for (const comp of p.components) {
          const r = norm(comp.path);
          if (r && (c === r || c.startsWith(r + "/")) && r.length > bestLen) {
            bestLen = r.length;
            best = p;
          }
        }
      }
      return best ? { projectId: best.id, projectName: best.name } : {};
    },
    [],
  );
  // Note reminders that have come due, in any project — including ones a
  // launchd job already put on screen while Canopy was closed. Named here
  // rather than inside the hook because only App holds the workspace, and a
  // banner with no project on it is the thing deepLinks.ts exists to end.
  const projectNameFor = useCallback(
    (id: string) => wsRef.current.projects.find((p) => p.id === id)?.name,
    [],
  );
  useNoteReminders(projectNameFor);
  // A micro-task in flight when Canopy last quit has no terminal to come back
  // to — its tab is ephemeral and never restored — so it can never report.
  // Settle those before anything new is recorded, or they stay "running"
  // forever: hidden from the history tab, still holding one of its slots.
  useEffect(() => {
    sweepStaleRuns();
    // Its question goes with it, and so does every other question that was
    // waiting on a process rather than on a fact. A micro-task's pty and an
    // agent's session both died with the last launch, so nothing can answer
    // them; left alone they sit in the waiting count for good — a stall that
    // outlives the thing that stalled, which is a worse lie than no
    // notification at all. Anything still genuinely pending is re-posted
    // within the first tick by the bridge, off the live hook stream.
    for (const item of attentionItems()) {
      const key = item.dedupeKey;
      if (!isOutstanding(item) || !key) continue;
      if (key.startsWith("task:") || key.startsWith("agent:"))
        resolveAttentionByKey(key, "withdrawn");
    }
  }, []);
  // The one place anything leaves the app for the OS.
  //
  // Was `if (document.hasFocus()) return;` copied into every call site that
  // wanted a banner, each with its own hand-written title. Now the decision is
  // `shouldReachOS` (attention.ts) and the strings come from the item, so a new
  // caller gets routing and a deep-linked click by posting — not by remembering
  // to also call something.
  //
  // Keyed on ids already sent, because a question re-derived from a hook event
  // stream updates its item in place and must not re-notify each time.
  const notifiedIds = useRef(new Set<string>());
  useEffect(() => {
    for (const item of attention) {
      if (notifiedIds.current.has(item.id)) continue;
      notifiedIds.current.add(item.id);
      if (!shouldReachOS(item, document.hasFocus())) continue;
      const { title, body } = osPayload(item);
      void ipc
        .notifyNative(
          title,
          body,
          formatDeepLink(item.where ?? { kind: "app" }),
        )
        // Notifications are a garnish — never fail anything over them.
        .catch(() => {});
    }
  }, [attention]);
  // Toasts fade on a clock the store knows nothing about, so a tick drives the
  // re-render that retires them. Only while something is actually on screen:
  // an idle app should not hold a repeating timer for an empty overlay.
  const [toastTick, setToastTick] = useState(0);
  const toasts = useMemo(
    () => liveToasts(attention, Date.now()),
    // `toastTick` is the clock this depends on — the items themselves do not
    // change when one merely ages out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attention, toastTick],
  );
  useEffect(() => {
    if (!toasts.some((t) => toastMs(t) != null)) return;
    const t = window.setInterval(() => setToastTick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [toasts]);
  // Team relay: one socket per app, so the state lives here and every
  // ProjectView renders the same picture. Chat keeps a rolling transcript
  // (received + our own sends); the inbox holds commands awaiting action.
  const [relayStatus, setRelayStatus] = useState<ipc.RelayStatus>({
    role: "off",
    code: null,
    port: null,
    ips: [],
    addr: null,
    self_id: null,
    name: null,
    visibility: null,
    public_ip: null,
    members: [],
  });
  const [relayChat, setRelayChat] = useState<ipc.RelayChatMsg[]>([]);
  const [relayInbox, setRelayInbox] = useState<ipc.RelayCommandMsg[]>([]);
  const [relayTransfers, setRelayTransfers] = useState<
    import("./types").RelayTransfer[]
  >([]);
  // The agent-facing ops read the inbox from an event handler that outlives any
  // one render, so they read it through a ref.
  const relayInboxRef = useRef(relayInbox);
  relayInboxRef.current = relayInbox;
  /** A question an agent put to the user (canopy_ask_user), held until they
   *  answer — the agent's tool call is parked on the other end of `resolve`. */
  const [ask, setAsk] = useState<{
    id: number;
    /** The channel item this question posted, so answering resolves it rather
     *  than leaving it in the waiting count for good. */
    attentionId: string;
    question: string;
    options: string[];
    resolve: (answer: string) => void;
  } | null>(null);
  const relayIntentional = useRef(false);
  const prevRelayRole = useRef(relayStatus.role);
  useEffect(() => {
    const was = prevRelayRole.current;
    const now = relayStatus.role;
    prevRelayRole.current = now;
    if ((was === "host" || was === "client") && now === "off") {
      if (relayIntentional.current) {
        relayIntentional.current = false;
      } else {
        postAttention({
          kind: "fyi",
          tone: "error",
          title: "Disconnected from the team relay.",
          source: "team",
          where: { kind: "panel", panel: "team" },
        });
      }
    }
  }, [relayStatus.role]);
  // Live editing. The manager is a plain mutable object deliberately kept out
  // of React state — it holds Monaco models and per-keystroke session state,
  // neither of which survives being copied. `collabTick` is how a change in it
  // reaches the render tree.
  const collab = useRef<CollabManager | null>(null);
  if (!collab.current) collab.current = new CollabManager();
  // Narrowed once here: the useMemo below can't see the control-flow guard.
  const collabMgr = collab.current;
  const [collabTick, setCollabTick] = useState(0);
  // The relay we're persisting chat under = the host's stable identity key.
  // Null when off, so the persist effect never writes an empty transcript.
  const relayChatLabel = useRef<string | null>(null);
  // Hydrate the transcript when we (re)join a relay; drop the label when off.
  useEffect(() => {
    const label = relayStatus.members.find((m) => m.is_host)?.key ?? null;
    if (label && label !== relayChatLabel.current) {
      relayChatLabel.current = label;
      setRelayChat(loadRelayChat(label));
    } else if (!label) {
      relayChatLabel.current = null;
    }
  }, [relayStatus]);
  // The collab manager follows the relay's lifecycle: it needs our member id to
  // recognise its own operations coming back, and every session is over the
  // moment the relay is. Members who vanish take their carets with them —
  // otherwise a caret sits on a line forever after its owner closed the lid.
  const seenMembers = useRef<string[]>([]);
  useEffect(() => {
    const mgr = collab.current!;
    if (relayStatus.role === "off") {
      seenMembers.current = [];
      mgr.reset();
      setCollabTick((n) => n + 1);
      return;
    }
    if (relayStatus.self_id) mgr.setSelf(relayStatus.self_id);
    const now = relayStatus.members.map((m) => m.id);
    for (const gone of seenMembers.current.filter((id) => !now.includes(id))) {
      mgr.dropMember(gone);
    }
    seenMembers.current = now;
  }, [relayStatus]);

  // A session opening or closing (ours or a guest's) has no relay frame of its
  // own on the local side, so the manager pokes us to re-read `activeCount` for
  // the global collaborating indicator.
  useEffect(() => {
    const mgr = collab.current!;
    mgr.onChange = () => setCollabTick((n) => n + 1);
    // Owner side of project sharing: list the shared root's files as paths
    // relative to it — an absolute path never crosses the wire (COLLAB-1).
    mgr.onListProject = async (root) => {
      const prefix = root.endsWith("/") ? root : `${root}/`;
      const abs = await ipc.fsListFiles([root]);
      return abs
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length));
    };
    mgr.onProjectOffer = (doc) => {
      const o = mgr.projectOffers.get(doc);
      if (!o) return;
      const what = `${o.fromName} wants to share their project "${o.name}" with you`;
      // An FYI, though it reads like a question: an offer is accepted or
      // declined in the Team panel, and nothing here is told which happened.
      // A question that can never be resolved would sit in the waiting count
      // for good, which is worse than one that fades — so it stays an FYI
      // until the offer has a settle path to hang a `resolveAttention` on.
      postAttention({
        kind: "fyi",
        tone: "info",
        title: what,
        body: "See the Team panel",
        source: "team",
        where: { kind: "panel", panel: "team" },
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist as it grows. The length guard means clearing the in-memory view on
  // disconnect can't wipe the stored history.
  useEffect(() => {
    if (relayChatLabel.current && relayChat.length > 0) {
      saveRelayChat(relayChatLabel.current, relayChat);
    }
  }, [relayChat]);
  // Which conversation is on screen (null = team chat, undefined = none) —
  // a toast for a message the user is already reading is noise.
  const activeChatRef = useRef<string | null | undefined>(undefined);
  // Per-conversation "last read" timestamps, so the Team panel can show how
  // many messages each member (and the everyone channel) has waiting. Keyed by
  // convoKey: "" for the team channel, the member id for a DM. A message counts
  // as unread when it postdates the last time that conversation was on screen.
  const [chatSeen, setChatSeen] = useState<Record<string, number>>({});
  const markSeen = useCallback((peer: string | null) => {
    const key = peer ?? "";
    setChatSeen((s) => ({ ...s, [key]: Date.now() }));
  }, []);
  const [updateAvail, setUpdateAvail] = useState<UpdateAvailability>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  // "Later" mutes that version for this run; the next launch may ask again.
  const dismissedUpdate = useRef<string | null>(null);

  const wsRef = useRef(ws);
  wsRef.current = ws;
  // One press can reach us from both the menu accelerator and the webview key
  // handler; without this they'd cancel each other and focus mode would look
  // stuck. First one wins, the echo inside the window is ignored.
  // Shared by the File menu and the `canopy <dir>` CLI path.
  const openDirAsProject = useCallback(async (dir: string) => {
    // Reuse a project already pointing at this folder instead of duplicating it.
    const existing = wsRef.current.projects.find((p) =>
      p.components.some((c) => c.path === dir),
    );
    if (existing) {
      await openProjectRef.current(existing.id);
      return;
    }
    const name = dir.split(/[\\/]/).pop() || dir;
    await saveProjectRef.current({
      id: newProjectId(),
      name,
      components: [{ label: name, path: dir, commands: [] }],
    });
  }, []);

  // File menu. The workspace already auto-persists to
  // ~/.canopy/projects.json — these are explicit open/export on top.
  const openProjectFromDisk = useCallback(async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, title: "Open project folder" });
    if (typeof dir !== "string") return;
    await openDirAsProject(dir);
  }, [openDirAsProject]);

  const saveProjectAs = useCallback(async () => {
    const state = wsRef.current;
    const project = state.projects.find((p) => p.id === state.activeId);
    if (!project) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      title: "Save project",
      defaultPath: `${project.name}.canopy-project.json`,
      filters: [{ name: "canopy project", extensions: ["json"] }],
    });
    if (!path) return;
    await exportProject(path, project).catch((e) => notify(String(e), "error"));
  }, []);

  const saveWorkspaceAs = useCallback(async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      title: "Save workspace",
      defaultPath: "workspace.canopy.json",
      filters: [{ name: "canopy workspace", extensions: ["json"] }],
    });
    if (!path) return;
    await exportWorkspace(path, wsRef.current).catch((e) =>
      notify(String(e), "error"),
    );
  }, []);

  const openWorkspaceFile = useCallback(async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      title: "Open workspace or project",
      filters: [{ name: "canopy", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    let file: { projects: Project[]; openIds: string[] };
    try {
      file = await importFile(path);
    } catch (err) {
      notify(String(err instanceof Error ? err.message : err), "error");
      return;
    }
    // Merge rather than replace: importing a workspace must never silently
    // discard projects the user already has. Same id = same project, updated.
    const state = wsRef.current;
    const byId = new Map(state.projects.map((p) => [p.id, p]));
    for (const p of file.projects) byId.set(p.id, p);
    const projects = [...byId.values()];
    const openIds = [...new Set([...state.openIds, ...file.openIds])];
    for (const id of file.openIds) {
      const project = projects.find((p) => p.id === id);
      for (const c of project?.components ?? []) {
        await ipc.workspaceAdd(c.path).catch(() => {});
      }
    }
    wsRef.current = { ...state, projects, openIds };
    updateRef.current({
      projects,
      openIds,
      activeId: file.openIds[0] ?? state.activeId,
    });
  }, []);

  const lastZenToggle = useRef(0);
  const toggleZen = useCallback((_source: string) => {
    const now = Date.now();
    if (now - lastZenToggle.current < 250) return;
    lastZenToggle.current = now;
    setZen((v) => !v);
  }, []);
  // menu handler is registered before these are defined
  const closeProjectRef = useRef<(id: string) => Promise<void>>(async () => {});
  const openProjectRef = useRef<(id: string) => Promise<void>>(async () => {});
  /** Open a project because something wants to happen *in* it — an agent
   *  action, a PR handed over from the inbox, a PTY spawned from the phone.
   *  Unlike a plain open, this wakes a hibernating project: there is no
   *  ProjectView behind the frost to receive the event, and dropping it
   *  silently is worse than deciding the project is needed now. */
  const openForActionRef = useRef<(id: string) => Promise<void>>(
    async () => {},
  );
  const saveProjectRef = useRef<(p: Project) => Promise<void>>(async () => {});
  const updateRef = useRef<(patch: Partial<WorkspaceState>) => void>(() => {});

  // Load persisted workspace; re-register watchers/scopes for open projects.
  // A tab that was asleep when the app last quit comes back asleep — and a
  // sleeping project watches nothing, so it registers nothing until it wakes.
  useEffect(() => {
    void loadWorkspace().then(async (loadedState) => {
      // Custom tasks moved from settings onto the project; anything left in the
      // old app-wide home is adopted here, once, before anything reads it.
      const state = adoptLegacyCustomTasks(loadedState);
      if (state !== loadedState) await saveWorkspace(state);
      for (const id of state.openIds) {
        if (isHibernating(id)) continue;
        const project = state.projects.find((p) => p.id === id);
        for (const c of project?.components ?? []) {
          await ipc.workspaceAdd(c.path).catch(() => {});
        }
      }
      setWs(state);
      publishScopes(state);
      setLoaded(true);
    });
    const subs = [
      ipc.onAgentEvents((raws) => {
        // Parsed once here; consumers read fields off `data`. Re-parsing the
        // raw line at every consumer was a measurable main-thread cost, as was
        // one setState per line — the bridge batches each 500ms window.
        const ts = Date.now();
        setAgentEvents((prev) =>
          [
            ...prev,
            ...raws.map((raw) => ({ ts, data: parseAgentEvent(raw) })),
          ].slice(-200),
        );
      }),
      ipc.onRelayState(setRelayStatus),
      ipc.onRelayChat((m) => {
        setRelayChat((prev) => [...prev.slice(-499), m]);
        // A DM lives in the sender's conversation; a broadcast in the team
        // chat (null). Toast only when that conversation isn't on screen.
        const convo = m.to === null ? null : m.from;
        const text = m.text.length > 120 ? `${m.text.slice(0, 120)}…` : m.text;
        // If the user is looking at this conversation, it's already read;
        // otherwise it stays unread (the panel badge) and we toast.
        // "Already read" needs the conversation on screen AND someone in front
        // of it. With the tab open but Canopy in the background, the message is
        // not read — it is missed, which is exactly when the banner matters.
        if (activeChatRef.current === convo && document.hasFocus()) {
          markSeen(convo);
        } else {
          postAttention({
            kind: "fyi",
            tone: "info",
            title: `${m.from_name}${m.to === null ? " (team chat)" : ""}`,
            body: text,
            source: "team",
            // Straight into the conversation it came from — the one target
            // where "take me there" is unambiguous.
            where: { kind: "chat", peer: convo },
          });
        }
      }),
      ipc.onRelayCommand((m) => {
        setRelayInbox((prev) =>
          prev.some((x) => x.id === m.id) ? prev : [...prev, m],
        );
        const pr = (
          m.payload as { pr?: { number?: number; title?: string } } | null
        )?.pr;
        const file = (m.payload as { name?: string } | null)?.name;
        const text =
          m.kind === "open-pr" && pr
            ? `${m.from_name} asked you to review PR #${pr.number}: ${pr.title}`
            : m.kind === "review"
              ? `${m.from_name} asked you to review ${(m.payload as { title?: string } | null)?.title ?? "a branch"}`
              : m.kind === "file-offer" && file
                ? `${m.from_name} wants to send you ${file}`
                : `${m.from_name} sent a ${m.kind} command`;
        postAttention({
          kind: "fyi",
          tone: "info",
          title: text,
          body: "See the Team panel",
          source: "team",
          where: { kind: "panel", panel: "team" },
        });
      }),
      ipc.onRelayCollab((m) => {
        const mgr = collab.current!;
        const known = mgr.get(m.doc) !== undefined;
        mgr.receive(m);
        setCollabTick((n) => n + 1);
        // Only the invitation is worth interrupting for. Everything else on
        // this channel is a keystroke.
        if (!known && m.body.kind === "offer") {
          const what = `${m.from_name} wants to edit ${safeName(m.body.name)} with you`;
          postAttention({
            kind: "fyi",
            tone: "info",
            title: what,
            body: "See the Team panel",
            source: "team",
            where: { kind: "panel", panel: "team" },
          });
        }
      }),
      ipc.onRelayTransferProgress((p) => {
        // Upsert the live row; a progress tick can arrive before any terminal
        // event, so it creates the row if missing.
        setRelayTransfers((prev) => {
          const next = prev.filter((x) => x.id !== p.id);
          next.push({
            id: p.id,
            direction: p.direction,
            name: p.name,
            done: p.done,
            total: p.total,
            status: "active",
          });
          return next;
        });
      }),
      ipc.onRelayTransfer((t) => {
        const msg =
          t.direction === "in"
            ? t.ok
              ? `Received ${t.name} — saved to ${t.detail}`
              : `Receiving ${t.name} failed: ${t.detail}`
            : t.ok
              ? `Sent ${t.name} to ${t.detail}`
              : `Sending ${t.name} failed: ${t.detail}`;
        postAttention({
          kind: "fyi",
          tone: t.ok ? "success" : "error",
          title: msg,
          source: "team",
          where: { kind: "panel", panel: "team" },
        });
        // A completed transfer is part of the conversation, not just a toast
        // that scrolls away: record it in the transcript with the peer it was
        // with (a DM, since files are always one-to-one), so history shows what
        // was sent and received alongside what was said. Only successes — a
        // failed transfer left nothing to reference.
        if (t.ok && t.peer) {
          const selfId = relayStatus.self_id ?? "";
          const fileMsg: ipc.RelayChatMsg = {
            id: `file-${t.id}`,
            from: t.direction === "out" ? selfId : t.peer,
            from_name: t.direction === "out" ? "you" : "",
            to: t.direction === "out" ? t.peer : selfId,
            text: "",
            ts: Date.now(),
            file: {
              name: t.name,
              path: t.direction === "in" ? t.detail : null,
              direction: t.direction,
            },
          };
          setRelayChat((prev) =>
            prev.some((m) => m.id === fileMsg.id)
              ? prev
              : [...prev.slice(-499), fileMsg],
          );
        }
        // Mark the row terminal, then retire it after a beat so the bar's
        // final state is visible before it disappears.
        setRelayTransfers((prev) => {
          const row = prev.find((x) => x.id === t.id);
          const done = t.ok ? t.total : (row?.done ?? 0);
          const others = prev.filter((x) => x.id !== t.id);
          return [
            ...others,
            {
              id: t.id,
              direction: t.direction,
              name: t.name,
              done,
              total: t.total,
              status: t.ok ? "ok" : "failed",
              detail: t.detail,
            },
          ];
        });
        window.setTimeout(
          () => setRelayTransfers((prev) => prev.filter((x) => x.id !== t.id)),
          t.ok ? 4000 : 8000,
        );
      }),
      // Native menu accelerators (Cmd+W etc.) → scoped in-app actions. The
      // visible ProjectView handles tab-level ones; close-project is ours.
      import("@tauri-apps/api/event").then(({ listen }) =>
        listen<string>("menu", (e) => {
          if (e.payload === "close-project") {
            const active = wsRef.current.activeId;
            if (active) void closeProjectRef.current(active);
          } else if (
            e.payload === "next-project" ||
            e.payload === "prev-project"
          ) {
            const dir = e.payload === "next-project" ? 1 : -1;
            const { openIds, activeId } = wsRef.current;
            if (openIds.length > 1) {
              const i = Math.max(0, openIds.indexOf(activeId ?? ""));
              updateRef.current({
                activeId: openIds[(i + dir + openIds.length) % openIds.length],
              });
            }
          } else if (e.payload === "toggle-zen") {
            toggleZen("menu");
          } else if (e.payload === "check-updates") {
            // Explicit ask — always answer, even for a version "Later" muted.
            void checkForUpdateAnyChannel()
              .then(async (u) => {
                if (u) {
                  setUpdateAvail(u);
                  return;
                }
                const { getVersion } = await import("@tauri-apps/api/app");
                notify(
                  `Canopy is up to date (${await getVersion()}).`,
                  "success",
                );
              })
              .catch((err) => notify(`Update check failed: ${err}`, "error"));
          } else if (e.payload === "install-cli") {
            void import("@tauri-apps/api/core").then(({ invoke }) =>
              invoke<string>("cli_install_shim")
                .then((m) => notify(m, "success"))
                .catch((err) => notify(String(err), "error")),
            );
          } else if (e.payload === "new-launcher") {
            // ⌘N asks the active project for a new tab (ProjectView answers on
            // menu:new-launcher). With no project open there is no tab to make,
            // so the only "new" left that means anything is a new project.
            if (wsRef.current.activeId)
              window.dispatchEvent(new CustomEvent("menu:new-launcher"));
            else setDialog({ mode: "new" });
          } else if (e.payload === "new-project") {
            setDialog({ mode: "new" });
          } else if (e.payload === "open-project") {
            void openProjectFromDisk();
          } else if (e.payload === "manage-projects") {
            setManager(true);
          } else if (e.payload === "settings") {
            setSettingsOpen({});
          } else if (e.payload === "help") {
            setHelpOpen(true);
          } else if (e.payload === "about") {
            setAboutOpen(true);
          } else if (e.payload === "support") {
            void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
              openUrl("https://canopyide.dev/support"),
            );
          } else if (e.payload === "save-project") {
            void saveProjectAs();
          } else if (e.payload === "open-workspace") {
            void openWorkspaceFile();
          } else if (e.payload === "save-workspace") {
            void saveWorkspaceAs();
          } else {
            window.dispatchEvent(new CustomEvent(`menu:${e.payload}`));
          }
        }),
      ),
    ];
    // Agent integrations used to be re-injected from here — one fire-and-forget
    // invoke per CLI, `.catch(() => {})` on each. That wrote into the config of
    // CLIs the machine didn't have and, because every error was discarded, let
    // a registration fail on every launch without a trace. The same work now
    // runs in agents::heal_integrations at startup, where it can see what's
    // installed and report what it did. Only failures are surfaced: a healthy
    // launch has nothing to say, and a repair that worked is not news.
    // The pass starts before this webview does, so the event can fire with
    // nobody listening. Ask for the cached report too, and let whichever
    // arrives first be the one that speaks — a report that exists to break a
    // silence must not be lost to a race.
    let reported = false;
    const reportHealth = (report: ipc.HealthReport | null) => {
      if (reported || !report || report.failed.length === 0) return;
      reported = true;
      notify(
        `Agent integration needs attention — ${report.failed.join("; ")}`,
        "warn",
      );
    };
    subs.push(ipc.onIntegrationHealth(reportHealth));
    void ipc
      .agentHealthReport()
      .then(reportHealth)
      .catch(() => {});
    // Focus mode is reachable two ways: the native menu accelerator, and a
    // webview key handler. Belt and braces — the accelerator is what the menu
    // advertises, but a native Cmd+Shift+Enter can be swallowed before it
    // reaches the menu, which left users stuck inside focus mode with no way
    // back out. The dedupe below means whichever arrives first wins and a
    // second path firing for the same press can't toggle it straight back.
    // Show the zoom chip and (re)arm its 1s auto-hide.
    const flashZoom = (z: number) => {
      setZoomPct(Math.round(z * 100));
      if (zoomHideTimer.current !== null)
        window.clearTimeout(zoomHideTimer.current);
      zoomHideTimer.current = window.setTimeout(() => setZoomPct(null), 1000);
    };
    const keys = (e: KeyboardEvent) => {
      const mod = commandHeld(e);
      // On Linux/Windows Ctrl is the modifier, but Ctrl+- and Ctrl+0 are also
      // meaningful inside terminals (readline undo, NUL). macOS uses Cmd so
      // there's no conflict there. Skip zoom if focus is inside an xterm canvas
      // or textarea so the keypress reaches the shell rather than being consumed.
      if (
        terminalOwnsCtrl(e) &&
        (e.target as HTMLElement | null)?.closest(
          ".xterm-screen, .xterm-helper-textarea",
        )
      ) {
        return;
      }
      if (e.key === "Escape") {
        setZen(false);
      } else if (matches(e, "toggle-zen")) {
        e.preventDefault();
        toggleZen("keydown");
      } else if (mod && !e.altKey) {
        // Window zoom: Cmd/Ctrl with +, -, or 0. Match both the main-row and
        // numpad keys; "=" is the unshifted "+" key on US layout; "+" always
        // requires Shift, so zoom-in allows shiftKey. e.code covers layouts
        // where the character is remapped (QWERTZ, AZERTY, etc.).
        const inKey =
          e.key === "+" ||
          e.key === "=" ||
          e.code === "Equal" ||
          e.code === "NumpadAdd";
        const outKey =
          !e.shiftKey &&
          (e.key === "-" || e.code === "Minus" || e.code === "NumpadSubtract");
        const resetKey =
          !e.shiftKey &&
          (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0");
        if (inKey) {
          e.preventDefault();
          flashZoom(setZoom(loadZoom() + STEP));
        } else if (outKey) {
          e.preventDefault();
          flashZoom(setZoom(loadZoom() - STEP));
        } else if (resetKey) {
          e.preventDefault();
          flashZoom(setZoom(1));
        }
      }
    };
    window.addEventListener("keydown", keys);
    // Restore the persisted zoom level on launch.
    void applyZoom(loadZoom());
    // The status bar's 🎨 button (and anything else outside App) opens
    // Settings at a specific tab through this event.
    const openSettings = (e: Event) =>
      setSettingsOpen({ tab: (e as CustomEvent).detail?.tab });
    window.addEventListener("canopy:open-settings", openSettings);
    void ipc.hookBridgePath().then(setHookPath);
    // A relay may already be live (hot reload in dev, a future auto-start) —
    // ask rather than assume "off".
    void ipc
      .relayStatus()
      .then(setRelayStatus)
      .catch(() => {});
    return () => {
      window.removeEventListener("keydown", keys);
      window.removeEventListener("canopy:open-settings", openSettings);
      if (zoomHideTimer.current !== null)
        window.clearTimeout(zoomHideTimer.current);
      subs.forEach((s) => void s.then((fn) => fn()));
    };
  }, []);

  // First launch on this machine: greet with the walkthrough once the
  // workspace has loaded (so it sits above the empty Welcome, not a blank app).
  useEffect(() => {
    if (loaded && shouldOnboard()) setOnboarding(true);
  }, [loaded]);

  // Keep the bridge's copy of the tool switches (Settings → Agents) current.
  // Republished on every settings write, because the sidecar reads it when an
  // agent asks for its tool list — which can be at any moment.
  useEffect(() => {
    const publish = () => void ipc.contextTools(getSettings().disabledTools);
    publish();
    window.addEventListener(THEME_CHANGE_EVENT, publish);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, publish);
  }, []);

  // `canopy <dir>` delivery. Cold start: the arg waited in Rust state while
  // the webview booted — collect it once the workspace is loaded (opening a
  // project before load would be clobbered by setWs). Warm: a second CLI
  // invocation's argv arrives as a cli-open event via the single-instance
  // plugin.
  useEffect(() => {
    if (!loaded) return;
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<string | null>("cli_take_pending_open")
        .then((dir) => (dir ? openDirAsProject(dir) : undefined))
        .catch(() => {}),
    );
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<string>("cli-open", (e) => void openDirAsProject(e.payload)).then(
        (fn) => {
          unlisten = fn;
        },
      ),
    );
    return () => unlisten?.();
  }, [loaded, openDirAsProject]);

  // The embedded browser's invariants, watched while the app runs (see
  // browserWatchdog.ts). Dev builds always; a release build only when somebody
  // has explicitly turned it on, so nothing about a shipped launch changes.
  useEffect(() => startBrowserWatchdog(), []);

  // A breach is reported to the console, to the app log under a stable
  // `browser:INVARIANT` prefix, and to the selftest through watchdogViolations()
  // — deliberately nowhere on screen.
  //
  // It used to raise a dev error notice here, to be impossible to miss. That
  // notice is itself a surface over the pane, so reporting the breach hid the
  // very view it was reporting on: the page froze into its last frame (nothing
  // on the site responded to a click), and the invariant CLEARED some 50ms
  // later because the view was no longer visible — the report destroying the
  // state it existed to make visible. A measurement that changes what it
  // measures is worse than a quiet one, and it made the app look broken in a
  // way the bug never did.

  // `canopy --selftest=browser`: the app drives a scripted browser scenario
  // against a page it serves itself, then exits with a machine-readable report.
  // An ordinary launch gets `null` back and loads none of it.
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    void ipc.selftestConfig().then((cfg) => {
      if (!cfg || cancelled) return;
      setSelftestMode(cfg.scenario);
      void import("./selftest/browserSelftest")
        .then((m) =>
          m.runBrowserSelftest(cfg, {
            openDirAsProject,
            projectIdFor: (dir) =>
              wsRef.current.projects.find((p) =>
                p.components.some((c) => c.path === dir),
              )?.id,
          }),
        )
        // A scenario that cannot even start must still report, or the run ends
        // as a timeout that says nothing about why.
        .catch((err) =>
          ipc.selftestFinish({ ok: false, error: String(err), scenario: cfg.scenario }),
        );
    });
    return () => {
      cancelled = true;
    };
  }, [loaded, openDirAsProject]);

  // Background update checks: shortly after launch (delayed so it never
  // competes with boot), then every 12h for the long-lived windows people
  // leave open for days. Quiet by design — failures and "already current"
  // say nothing; only a real update surfaces the toast.
  useEffect(() => {
    const tick = () => {
      // A toast arriving over the page mid-scenario would cover exactly what
      // the scenario is watching, and it would be right to fail.
      if (isSelftest()) return;
      void checkForUpdateAnyChannel()
        .then((u) => {
          if (!u || dismissedUpdate.current === u.info.version) return;
          // Never clobber a toast the user is already looking at (or an
          // install in progress) with a fresh check's result.
          setUpdateAvail((cur) => cur ?? u);
        })
        .catch(() => {});
    };
    const first = window.setTimeout(tick, 10_000);
    const every = window.setInterval(tick, 12 * 60 * 60 * 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, []);

  const update = useCallback((patch: Partial<WorkspaceState>) => {
    setWs((prev) => {
      const next = { ...prev, ...patch };
      // After the updater returns — a disk write and an IPC don't belong in
      // the render phase.
      queueMicrotask(() => {
        void saveWorkspace(next);
        publishScopes(next);
      });
      return next;
    });
  }, []);

  const openProject = useCallback(
    async (id: string) => {
      const project = wsRef.current.projects.find((p) => p.id === id);
      if (!project) return;
      if (!wsRef.current.openIds.includes(id)) {
        // Nothing to watch while it sleeps: opening a hibernating project lands
        // on the wake screen, and waking is what registers its paths.
        if (!isHibernating(id)) {
          for (const c of project.components) {
            await ipc
              .workspaceAdd(c.path)
              .catch((e) => console.warn("scope add failed", e));
          }
        }
        update({ openIds: [...wsRef.current.openIds, id], activeId: id });
      } else {
        update({ activeId: id });
      }
    },
    [update],
  );

  /** Give back the OS-level resources one project holds — file watchers, scopes,
   *  language servers — for every component path no *awake* project still needs.
   *  Shared by closing a project and by putting one to sleep, which differ only
   *  in whether the tab goes with it. A sleeping project is not counted as a
   *  user of its paths: it registered none. */
  const releaseProject = useCallback(async (id: string, keepIds: string[]) => {
    const state = wsRef.current;
    const project = state.projects.find((p) => p.id === id);
    const stillUsed = new Set(
      keepIds.flatMap(
        (x) =>
          state.projects
            .find((p) => p.id === x)
            ?.components.map((c) => c.path) ?? [],
      ),
    );
    for (const c of project?.components ?? []) {
      if (!stillUsed.has(c.path)) {
        await ipc.workspaceRemove(c.path).catch(() => {});
        await stopWorkspaceServers(c.path);
      }
    }
  }, []);
  const releaseProjectRef = useRef(releaseProject);
  releaseProjectRef.current = releaseProject;

  const closeProject = useCallback(
    async (id: string) => {
      const state = wsRef.current;
      const openIds = state.openIds.filter((x) => x !== id);
      await releaseProject(
        id,
        openIds.filter((x) => !isHibernating(x)),
      );
      update({
        openIds,
        activeId:
          state.activeId === id
            ? (openIds[openIds.length - 1] ?? null)
            : state.activeId,
      });
    },
    [update, releaseProject],
  );
  closeProjectRef.current = closeProject;
  openProjectRef.current = openProject;
  updateRef.current = update;

  // ---------- hibernation ----------
  // Sleep is a third state between open and closed. The project's whole
  // arrangement is written down and everything it was holding is given back —
  // PTYs, agents, language servers, editor models, file watchers — but its tab
  // stays exactly where it was, frosted over: hibernating is a state a project
  // is *in*, not a way of closing it, and a tab that vanished would make it
  // look like one. Clicking the tab lands on the wake screen. The snapshot
  // store is the only marker; see hibernation.ts for why nothing else records
  // "asleep".
  const [hibernated, setHibernated] = useState<Record<string, ProjectSnapshot>>(
    () => hibernatedProjects(),
  );
  useEffect(() => {
    const sync = () => setHibernated(hibernatedProjects());
    window.addEventListener(HIBERNATION_CHANGE_EVENT, sync);
    return () => window.removeEventListener(HIBERNATION_CHANGE_EVENT, sync);
  }, []);
  // The project frosting over right now, and the snapshot it produced (shown
  // as the frost forms, so you see what is being put away). `leaving` is the
  // handover: the frost lifts while the wake screen takes its place underneath,
  // so the two cards cross-fade instead of one popping in.
  const [freezing, setFreezing] = useState<{
    id: string;
    snapshot: ProjectSnapshot | null;
    leaving?: boolean;
  } | null>(null);
  // Projects being woken: the snapshot handed to their ProjectView, plus how
  // far through rebuilding it is. The frost stays on top until it's done.
  const [waking, setWaking] = useState<
    Record<string, { snapshot: ProjectSnapshot; progress: WakeProgress }>
  >({});

  const hibernateProject = useCallback(
    (id: string) => {
      const state = wsRef.current;
      const project = state.projects.find((p) => p.id === id);
      if (!project || !state.openIds.includes(id)) return;
      // Freeze what you're looking at: a background project asked to sleep
      // comes to the front first, so the animation isn't happening off screen.
      if (state.activeId !== id) update({ activeId: id });
      setFreezing({ id, snapshot: null });
      let settled = false;
      let timer = 0;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.removeEventListener(HIBERNATED_EVENT, onSnapshot);
        window.clearTimeout(timer);
        if (!ok) {
          setFreezing(null);
          notify(
            `Couldn't snapshot ${project.name}, so it stays open.`,
            "error",
          );
          return;
        }
        setFreezing({ id, snapshot: hibernationOf(id) });
        // Let the frost finish forming first. Only then does the view behind it
        // swap to the wake screen — keeping the ProjectView mounted until now is
        // what lets its own teardown run (models disposed, shares ended, PTYs
        // killed as each terminal unmounts) instead of being dropped mid-flight.
        window.setTimeout(() => {
          setFreezing((f) => (f?.id === id ? { ...f, leaving: true } : f));
          void releaseProjectRef.current(
            id,
            wsRef.current.openIds.filter((x) => x !== id && !isHibernating(x)),
          );
          notify(
            `${project.name} is hibernating — its tab is still there, wake it when you need it.`,
            "success",
          );
          window.setTimeout(
            () => setFreezing((f) => (f?.id === id ? null : f)),
            420,
          );
        }, 1100);
      };
      const onSnapshot = (e: Event) => {
        const d = (e as CustomEvent).detail as {
          projectId?: string;
          ok?: boolean;
        } | null;
        if (d?.projectId !== id) return;
        finish(Boolean(d.ok));
      };
      window.addEventListener(HIBERNATED_EVENT, onSnapshot);
      // The view answers synchronously; the timeout only covers a project whose
      // view somehow isn't mounted, and it leaves the project open.
      timer = window.setTimeout(() => finish(false), 2500);
      window.dispatchEvent(
        new CustomEvent(HIBERNATE_EVENT, { detail: { projectId: id } }),
      );
    },
    [notify, update],
  );

  /** Hand the snapshot to a freshly mounted ProjectView and let it rebuild
   *  underneath the wake screen. Clearing the store is what mounts the view —
   *  the project stops being asleep the moment its restore begins. */
  const wakeProject = useCallback((id: string) => {
    const snapshot = hibernationOf(id);
    if (!snapshot) return;
    // Its paths went back when it fell asleep; the tree, the search and the
    // change feed all need them again before the first tab reopens.
    for (const c of wsRef.current.projects.find((p) => p.id === id)
      ?.components ?? []) {
      void ipc.workspaceAdd(c.path).catch(() => {});
    }
    const steps = wakeSteps(snapshot);
    setWaking((prev) => ({
      ...prev,
      [id]: {
        snapshot,
        progress: {
          done: 0,
          total: steps.length,
          label: steps[0]?.label ?? "Ready",
          finished: false,
        },
      },
    }));
    clearHibernation(id);
  }, []);

  openForActionRef.current = useCallback(
    async (id: string) => {
      await openProjectRef.current(id);
      if (isHibernating(id)) wakeProject(id);
    },
    [wakeProject],
  );

  const restoreStep = useCallback(
    (id: string, done: number, total: number, label: string) =>
      setWaking((prev) =>
        prev[id]
          ? {
              ...prev,
              [id]: {
                ...prev[id],
                progress: { done, total, label, finished: false },
              },
            }
          : prev,
      ),
    [],
  );

  const restoreDone = useCallback((id: string) => {
    setWaking((prev) =>
      prev[id]
        ? {
            ...prev,
            [id]: {
              ...prev[id],
              progress: {
                ...prev[id].progress,
                done: prev[id].progress.total,
                finished: true,
              },
            },
          }
        : prev,
    );
    // The thaw: the frost dissolves off the finished workspace, then unmounts.
    window.setTimeout(
      () =>
        setWaking((prev) => {
          if (!prev[id]) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        }),
      900,
    );
  }, []);

  // A project closed mid-wake never reports finishing (its view is gone), so
  // drop it here rather than leaving a wake screen that can never end — it
  // would come back the moment the project was reopened.
  useEffect(() => {
    setWaking((prev) => {
      const live = Object.keys(prev).filter((id) => ws.openIds.includes(id));
      if (live.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(live.map((id) => [id, prev[id]]));
    });
  }, [ws.openIds]);

  /** Throw a snapshot away and open the project empty — the escape hatch for a
   *  workspace you no longer want back. */
  const discardHibernation = useCallback(
    (id: string) => {
      clearHibernation(id);
      notify("Snapshot discarded — the project opens empty.");
    },
    [notify],
  );

  // Tell the PR watcher which repos matter: every component of every OPEN
  // project. Closed projects are not polled — the point of one poller is that
  // its budget goes on what the user is actually working on. The backend folds
  // these paths onto their repo toplevels and de-duplicates, so passing raw
  // component paths (and re-passing them on every workspace edit) is cheap; the
  // store drops identical sets before they reach IPC.
  // A hibernating project keeps its tab but is not "what the user is working
  // on" by any measure that matters here: nothing in it is running, and its
  // PRs can wait until it is woken.
  const watchedPaths = useMemo(() => {
    const open = new Set(ws.openIds ?? []);
    return ws.projects
      .filter((p) => open.has(p.id) && !hibernated[p.id])
      .flatMap((p) => p.components.map((c) => c.path))
      .sort();
  }, [ws.projects, ws.openIds, hibernated]);
  useEffect(() => {
    prWatch.setPaths(watchedPaths);
  }, [watchedPaths]);

  // The clipboard watcher's rules live in Settings and its project tag is
  // whichever project is in front. Re-declared on both — the store drops an
  // unchanged declaration before it reaches IPC, so this is free while nothing
  // moves, and off by default means the common case declares "don't watch" once
  // and never opens a store at all.
  useEffect(() => {
    clipboardStore.sync(ws.activeId ?? "");
  }, [ws.activeId]);

  // SpotSearch's index, kept up to date and pruned while the app runs rather
  // than only when someone opens ⌘K (see spotIndexJob.ts). Every project the
  // user has, not just the open ones: the index is machine-wide, and a store
  // that files itself per project can only be found by handing over the path.
  const spotRoots = useRef<string[]>([]);
  spotRoots.current = useMemo(
    () => ws.projects.flatMap((p) => p.components.map((c) => c.path)),
    [ws.projects],
  );
  useEffect(() => startSpotIndexJob(() => spotRoots.current), []);

  // A PTY opened from the phone (spawn_headless emits pty:spawned). Route it to
  // the project whose component path most-specifically contains its cwd, open
  // that project, and hand the tab to its ProjectView. The desktop mirrors the
  // agent the phone started — same session, both surfaces driving one PTY.
  useEffect(() => {
    const norm = (p: string) => p.replace(/\/+$/, "");
    // Deepest matching component path wins, so a broad root never steals an
    // agent from a nested project (mirrors model.ts bestProjectId).
    const projectForCwd = (cwd: string): string | undefined => {
      const c = norm(cwd);
      let bestId: string | undefined;
      let bestLen = -1;
      for (const p of wsRef.current.projects) {
        for (const comp of p.components) {
          const r = norm(comp.path);
          if (r && (c === r || c.startsWith(r + "/")) && r.length > bestLen) {
            bestLen = r.length;
            bestId = p.id;
          }
        }
      }
      return bestId;
    };
    let un: (() => void) | undefined;
    void ipc
      .onPtySpawned(async (e) => {
        const projectId = projectForCwd(e.cwd);
        if (!projectId) {
          notify(
            `A remote agent started in ${e.cwd}, outside any project.`,
            "info",
          );
          return;
        }
        await openForActionRef.current(projectId);
        // A beat so a not-yet-open project's ProjectView mounts and registers
        // its listener before the event fires; attachTerminal is idempotent by
        // pty id, so a redundant dispatch just re-focuses the tab. A timer, not
        // requestAnimationFrame: rAF stops firing while the window is occluded,
        // and these flows start from an agent/phone precisely when the user is
        // looking elsewhere. React commits (and timers) run fine unpainted.
        window.setTimeout(
          () =>
            window.dispatchEvent(
              new CustomEvent("canopy:attach-terminal", {
                detail: { projectId, ptyId: e.id, cwd: e.cwd, title: e.title },
              }),
            ),
          80,
        );
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, [notify]);

  // A clicked notification, or a `canopy 'canopy://…'` from a terminal.
  //
  // The whole point is that the target was composed minutes ago, against a
  // workspace that has since moved on — the terminal exited, the project was
  // closed, the teammate left. So this never insists: it resolves the project,
  // opens it (waking it if it was hibernating — there is no ProjectView behind
  // the frost to receive anything), and hands the link down. The ProjectView
  // takes it as far as it can and says so if the exact surface is gone. With
  // no project to resolve at all, the window is already up, which is where
  // this used to stop for every notification.
  //
  // Extracted from the IPC listener so that clicking a row in the notification
  // list goes down the identical path as clicking the OS banner for the same
  // item. Two routers would drift, and the fallback chain is the part worth
  // having exactly once.
  const followDeepLink = useCallback(
    async (link: DeepLink | null) => {
      if (!link || link.kind === "app") return;
      const state = wsRef.current;
      // Team surfaces (chat, transfers, the inbox) are global but rendered
      // inside a project, so they carry no project hint and are perfectly
      // happy in whichever one is in front. A link that *does* name a
      // project and doesn't resolve is a different story — dropping the user
      // into an unrelated project would be worse than saying so.
      const hinted = Boolean(link.projectId || link.path);
      const projectId =
        projectForLink(link, state.projects) ??
        // An agent running in a worktree has a cwd (`<repo>-wt-…`) under no
        // component root, so a hinted link can still fail to resolve. With
        // exactly one project open there is only one place it could mean —
        // the same fallback agent actions already take.
        (hinted
          ? state.openIds.length === 1
            ? state.openIds[0]
            : undefined
          : (state.activeId ?? state.openIds[0]));
      if (!projectId) {
        notify(
          hinted
            ? "That notification's project isn't in this workspace any more."
            : "Nothing to open — no project is open.",
          "info",
        );
        return;
      }
      await openForActionRef.current(projectId);
      if (link.kind === "project") return;
      // Timer, not rAF — a project that was hibernating has only just
      // mounted its ProjectView, and a listener registered during that
      // mount would miss an event dispatched in the same frame.
      window.setTimeout(
        () =>
          window.dispatchEvent(
            new CustomEvent("canopy:deep-link", {
              detail: { projectId, link },
            }),
          ),
        80,
      );
    },
    [notify],
  );
  useEffect(() => {
    if (!loaded) return;
    let un: (() => void) | undefined;
    void ipc
      .onDeepLink((raw) => void followDeepLink(parseDeepLink(raw)))
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, [loaded, followDeepLink]);

  // The same link, delivered by a cold start. A reminder's banner is posted by
  // launchd while Canopy is closed (src-tauri/src/remind.rs), so clicking it
  // launches the app with `canopy://note?…` in argv — there was no process to
  // send an event to. The link waited in Rust state through boot; collect it
  // once the workspace is loaded, exactly as `canopy <dir>` does, or resolving
  // the project would race the workspace it resolves against.
  useEffect(() => {
    if (!loaded) return;
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<string | null>("cli_take_pending_link")
        .then((raw) => (raw ? followDeepLink(parseDeepLink(raw)) : undefined))
        .catch(() => {}),
    );
  }, [loaded, followDeepLink]);

  // An action an agent requested via the MCP context bridge (canopy_start_server
  // / canopy_open_preview). Routed exactly like a phone-spawned PTY: find the
  // project whose component most-specifically contains the action's `route`
  // path, open it, and hand the action to that ProjectView.
  useEffect(() => {
    const norm = (p: string) => p.replace(/\/+$/, "");
    const projectForCwd = (cwd: string): string | undefined => {
      const c = norm(cwd);
      let bestId: string | undefined;
      let bestLen = -1;
      for (const p of wsRef.current.projects) {
        for (const comp of p.components) {
          const r = norm(comp.path);
          if (r && (c === r || c.startsWith(r + "/")) && r.length > bestLen) {
            bestLen = r.length;
            bestId = p.id;
          }
        }
      }
      return bestId;
    };
    let un: (() => void) | undefined;
    void ipc
      .onAgentAction(async (a) => {
        // Keyed by terminal id, not a path: the project owning that pty is
        // already open (its server is running), so just broadcast — the owning
        // ProjectView matches by pty and acts, the rest ignore it.
        // Same routing for an agent closing itself: the tab lives in whichever
        // ProjectView owns that pty, and the terminal is the only address the
        // action has — canopy_close_session takes no arguments at all.
        // A task naming itself (canopy_name_task). Routed like the rest of the
        // pty-keyed actions and deliberately silent: it changes a row's label
        // in a panel the user may not even have open, and a toast for every
        // agent that gets around to introducing itself would be noise.
        if (
          a.kind === "restart_server" ||
          a.kind === "close_session" ||
          a.kind === "task_named"
        ) {
          window.dispatchEvent(
            new CustomEvent("canopy:agent-action", {
              detail: { projectId: null, action: a },
            }),
          );
          return;
        }
        // A micro-task reporting in. Surface the outcome here — the user has
        // likely tabbed away, which is the whole point of a fire-and-forget
        // task — then broadcast by pty like restart_server so the owning
        // ProjectView can close (done) or focus (blocked) the tab.
        if (a.kind === "job_done") {
          const ok = a.status === "done";
          const summary = a.summary ?? "A micro-task finished.";
          const taskKey = a.ptyId != null ? `task:${a.ptyId}` : undefined;
          // A blocked task is a *question*, not an FYI, and this is the split
          // the channel exists to close: a task that stops to ask and an agent
          // that stops to ask are the same event to the user, and used to have
          // completely different fates — one a toast that faded, the other a
          // rail badge in a panel. Both post a question now, both are counted,
          // and neither can be retired by a timer.
          //
          // Blocked means the agent is still there, waiting on an answer — send
          // the click to its terminal. Done means the opposite: the ProjectView
          // below is about to kill the pty and close the tab, so the only thing
          // left to look at is the run's row in Tasks.
          if (ok && taskKey) {
            // It asked, then got unstuck on its own (or the user answered in
            // the terminal without ever opening the list). Either way nothing
            // is waiting any more.
            resolveAttentionByKey(taskKey, "withdrawn");
          }
          postAttention({
            kind: ok ? "fyi" : "question",
            tone: ok ? "success" : "warn",
            title: ok ? `Task done: ${summary}` : `Task blocked: ${summary}`,
            body: a.url ?? undefined,
            source: "task",
            ...projectIdentity(a.route),
            where:
              !ok && a.ptyId != null
                ? { kind: "terminal", ptyId: a.ptyId, path: a.route }
                : { kind: "panel", panel: "tasks", path: a.route },
            ...(ok ? {} : { dedupeKey: taskKey }),
          });
          window.dispatchEvent(
            new CustomEvent("canopy:agent-action", {
              detail: { projectId: null, action: a },
            }),
          );
          return;
        }
        // An agent reaching for the user (canopy_notify) — often one running in
        // a terminal nobody is watching. It doesn't move the app on its own:
        // an agent saying something is not grounds for yanking the user out of
        // what they're doing, so it lands as a notice here. The native banner
        // is the one that carries a target, because by the time it's read the
        // user has already left, and "which terminal said that?" is the entire
        // question. The sidecar stamps the terminal it ran in; without one
        // (an agent outside a Canopy tab) the cwd still names the project.
        if (a.kind === "notify") {
          postAttention({
            kind: "fyi",
            tone: (a.level ?? "info") as NoticeKind,
            title: a.text ?? "",
            source: "agent",
            ...projectIdentity(a.route),
            where:
              a.ptyId != null
                ? { kind: "terminal", ptyId: a.ptyId, path: a.route }
                : { kind: "project", path: a.route },
          });
          return;
        }
        const projectId =
          // A path the action NAMES beats the directory its caller happens to
          // sit in. This is what the companion needs and every agent benefits
          // from: `canopy_start_server({ dir })` says which checkout it means,
          // and honouring the caller's cwd instead sent it to whichever project
          // that cwd fell in — for the companion, which deliberately runs
          // inside no project, that was always the same wrong one.
          (a.dir ? projectForCwd(a.dir) : undefined) ??
          projectForCwd(a.route) ??
          // A worktree the agent runs in follows `<repo>-wt-…`; fall back to the
          // single open project so an action still lands somewhere sensible.
          (wsRef.current.openIds.length === 1
            ? wsRef.current.openIds[0]
            : undefined);
        if (!projectId) {
          notify(
            "An agent asked to act, but its directory isn't in any open project.",
            "info",
          );
          return;
        }
        await openForActionRef.current(projectId);
        // Timer, not rAF — see the attach-terminal dispatch above.
        window.setTimeout(
          () =>
            window.dispatchEvent(
              new CustomEvent("canopy:agent-action", {
                detail: { projectId, action: a },
              }),
            ),
          80,
        );
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, [notify, projectIdentity]);

  // A browser-control op (canopy_browser_*). Routed like agent:action, but
  // request/response: an op that can't reach a project must answer the bridge
  // now, or the agent's tool call sits on the full timeout for nothing.
  useEffect(() => {
    const norm = (p: string) => p.replace(/\/+$/, "");
    const projectForCwd = (cwd: string): string | undefined => {
      const c = norm(cwd);
      let bestId: string | undefined;
      let bestLen = -1;
      for (const p of wsRef.current.projects) {
        for (const comp of p.components) {
          const r = norm(comp.path);
          if (r && (c === r || c.startsWith(r + "/")) && r.length > bestLen) {
            bestLen = r.length;
            bestId = p.id;
          }
        }
      }
      return bestId;
    };
    let un: (() => void) | undefined;
    void ipc
      .onAgentBrowser(async (op) => {
        const projectId =
          projectForCwd(op.route) ??
          (wsRef.current.openIds.length === 1
            ? wsRef.current.openIds[0]
            : undefined);
        if (!projectId) {
          void ipc.browserResult(
            op.id,
            false,
            "This session's directory isn't inside any open Canopy project, so there's no preview to drive.",
          );
          return;
        }
        await openForActionRef.current(projectId);
        // Timer, not rAF: rAF starves while the window is occluded, which held
        // the agent's request open until the bridge's timeout even though the
        // op would have run fine — the whole preview pipeline (React commits,
        // iframe loads, postMessage) works without paints.
        window.setTimeout(
          () =>
            window.dispatchEvent(
              new CustomEvent("canopy:agent-browser", {
                detail: { projectId, op },
              }),
            ),
          80,
        );
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, []);

  // The ops only this window can answer (canopy_diagnostics, canopy_references,
  // canopy_definition, canopy_tickets, canopy_reviews, canopy_ask_user). Unlike
  // the browser ops these need no tab, so they're answered here: find the
  // project the agent is working in, hand it the roots and repos, answer.
  useEffect(() => {
    let un: (() => void) | undefined;
    void ipc
      .onAgentUi(async (op) => {
        const norm = (p: string) => p.replace(/\/+$/, "");
        const project =
          wsRef.current.projects.find((p) =>
            p.components.some((c) => {
              const r = norm(c.path);
              const cwd = norm(op.route);
              return r && (cwd === r || cwd.startsWith(r + "/"));
            }),
          ) ??
          (wsRef.current.openIds.length === 1
            ? wsRef.current.projects.find(
                (p) => p.id === wsRef.current.openIds[0],
              )
            : undefined);
        const roots = project?.components.map((c) => c.path) ?? [];
        // An "ask" needs no project — a background agent with a question is
        // exactly the case where its cwd may be a worktree we don't track. The
        // companion's ops are the same case taken further: it deliberately runs
        // inside no project (so it inherits no repo's CLAUDE.md), and every one
        // of them answers ACROSS projects rather than about the one its caller
        // sits in. Requiring a project here rejected the only agent that was
        // never meant to have one.
        if (!roots.length && !PROJECTLESS_OPS.has(op.op)) {
          void ipc.browserResult(
            op.id,
            false,
            "This session's directory isn't inside any open Canopy project, so the IDE has nothing to answer with.",
          );
          return;
        }
        try {
          const repos = project
            ? await ipc
                .gitRepos(
                  project.components.map(
                    (c) => [c.label, c.path] as [string, string],
                  ),
                )
                .then((rs) => [...new Set(rs.map((r) => r.path))])
                .catch(() => [])
            : [];
          const data = await runUiOp(op, {
            roots,
            repos,
            inbox: relayInboxRef.current,
            // An agent's question, which until now was the one attention
            // mechanism with no notification at all: a modal that existed only
            // while you happened to be looking at Canopy, left no trace when
            // answered, and never named the project it came from. The dialog
            // stays — the agent is blocked, so interrupting is right — but the
            // question also goes into the channel, where it is counted, it
            // reaches the OS, and it survives as history.
            ask: (question, options) =>
              new Promise<string>((resolve) => {
                const attentionId = postAttention({
                  kind: "question",
                  tone: "info",
                  title: question,
                  body: "An agent is asking",
                  source: "agent",
                  ...projectIdentity(op.route),
                  where: { kind: "project", path: op.route },
                });
                setAsk({ id: op.id, attentionId, question, options, resolve });
              }),
            // The companion's cross-project handlers, read through a ref so
            // this long-lived listener always calls the current ones without
            // re-subscribing on every workspace change. Absent when the
            // companion is off, which is what makes the workspace ops fail
            // honestly for a coding agent instead of answering for one project
            // as though it were all of them.
            ...(companionOpsRef.current ?? {}),
            // The page an agent's browser ops are driving, for the vault ops.
            // The tab id comes from the view snapshots; the URL comes from the
            // page itself, because a redirect (every login flow has one) moves
            // it without anything on this side re-rendering.
            preview: async () => {
              const tabId = browserViewSnapshots().find((v) => v.wanted)?.tabId;
              if (!tabId) return null;
              const here = await ipc.browserHere(tabId).catch(() => null);
              return here?.url ? { tabId, url: here.url } : null;
            },
          });
          void ipc.browserResult(op.id, true, data);
        } catch (err) {
          void ipc.browserResult(
            op.id,
            false,
            String(err instanceof Error ? err.message : err),
          );
        }
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, [projectIdentity]);

  const saveProject = useCallback(
    async (project: Project) => {
      const state = wsRef.current;
      const exists = state.projects.some((p) => p.id === project.id);
      const projects = exists
        ? state.projects.map((p) => (p.id === project.id ? project : p))
        : [...state.projects, project];
      update({ projects });
      setDialog(null);
      if (state.openIds.includes(project.id)) {
        // components may have changed; ensure scopes exist
        for (const c of project.components) {
          await ipc.workspaceAdd(c.path).catch(() => {});
        }
      } else {
        // ref may lag one render; recompute from the fresh list
        wsRef.current = { ...state, projects };
        await openProject(project.id);
      }
    },
    [update, openProject],
  );

  saveProjectRef.current = saveProject;

  const deleteProject = useCallback(
    (id: string) => {
      const state = wsRef.current;
      if (state.openIds.includes(id)) void closeProject(id);
      update({ projects: state.projects.filter((p) => p.id !== id) });
    },
    [update, closeProject],
  );

  // Stable titlebar handlers — kept out of render so the memoized TitleBar
  // only re-renders when its data props change, not on every App state tick.
  const selectProject = useCallback(
    (id: string) => update({ activeId: id }),
    [update],
  );
  /** ⌥/Alt held: the project pills wear the digit that jumps to them, the way
   *  ⌘ numbers the tabs inside a project. Two layers, one gesture. */
  const projectHints = useHeldModifier("projects");
  useEffect(() => {
    // Capture phase: a focused terminal or editor would otherwise swallow the
    // digit (and on macOS ⌥3 would type "£" into the shell).
    const onKeydown = (e: KeyboardEvent) => {
      const digit = digitFromCode(e.code);
      if (digit === null || !hintModifierOnly(e, "projects")) return;
      const { openIds, projects } = wsRef.current;
      // The same order the pills are drawn in: ids without a project are
      // filtered out of the strip, so they must not be counted here either.
      const id = openIds.filter((i) => projects.some((p) => p.id === i))[
        digit - 1
      ];
      if (!id) return;
      e.preventDefault();
      updateRef.current({ activeId: id });
    };
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  }, []);
  const handleCloseProject = useCallback(
    (id: string) => {
      const project = wsRef.current.projects.find((p) => p.id === id);
      if (project) setConfirmClose(project);
    },
    [],
  );
  const stopCollab = useCallback(() => {
    collab.current?.stopAll();
    notify("Collaboration ended.");
  }, [notify]);
  const newProject = useCallback(() => setDialog({ mode: "new" }), []);
  const editProject = useCallback(
    (p: Project) => setDialog({ mode: "edit", project: p }),
    [],
  );
  const openManager = useCallback(() => setManager(true), []);

  // Update-toast handlers.
  const openDownloadsPage = useCallback(() => {
    void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
      openUrl("https://canopyide.dev/downloads"),
    );
  }, []);
  const installAndRestart = useCallback(() => {
    setUpdateProgress(0);
    void installUpdate(setUpdateProgress).catch((err) => {
      setUpdateProgress(null);
      setUpdateAvail(null);
      notify(`Update failed: ${err}`, "error");
    });
  }, [notify]);
  const dismissUpdate = useCallback(() => {
    if (updateAvail) dismissedUpdate.current = updateAvail.info.version;
    setUpdateAvail(null);
  }, [updateAvail]);
  /** Clicking an item, from the toast or from the list.
   *
   *  Follows the target; deliberately does NOT resolve a question. Arriving at
   *  a blocked agent's terminal is not answering it — the agent is still
   *  waiting until something is typed, and the asker is what says so: the
   *  bridge withdraws when the agent moves on, `AskDialog` resolves on answer.
   *  Clearing the count on arrival would put the stall back exactly where it
   *  was, invisible. */
  const followAttention = useCallback(
    async (item: AttentionItem) => {
      dismissToast(item.id);
      await followDeepLink(item.where ?? null);
    },
    [followDeepLink],
  );
  const [notifOpen, setNotifOpen] = useState(false);
  const notifBadge = useMemo(() => badgeFor(attention), [attention]);
  // Stable, so TitleBar's memo isn't defeated by a fresh closure every tick.
  const openNotifications = useCallback(() => setNotifOpen(true), []);

  // The relay handle every ProjectView shares. Sends append the stamped
  // message locally — the relay never echoes a frame back to its author, so
  // this is the only way our own words reach our own transcript.
  const relaySendChat = useCallback(async (to: string | null, text: string) => {
    const msg = await ipc.relaySendChat(to, text);
    setRelayChat((prev) => [...prev.slice(-499), msg]);
  }, []);
  const relaySendCommand = useCallback(
    async (to: string | null, kind: string, payload: unknown) => {
      await ipc.relaySendCommand(to, kind, payload);
    },
    [],
  );
  // Unread-per-conversation, derived: a message someone else sent, newer than
  // the last time that conversation was read. "" is the team channel; a member
  // id is a DM. Own messages never count.
  const unread = useMemo(() => {
    const self = relayStatus.self_id;
    const counts: Record<string, number> = {};
    for (const m of relayChat) {
      if (m.from === self) continue;
      const key = m.to === null ? "" : m.to === self ? m.from : null;
      if (key === null) continue;
      if (m.ts > (chatSeen[key] ?? 0)) counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [relayChat, chatSeen, relayStatus.self_id]);
  // Memoized: this handle is threaded through every ProjectView and beyond,
  // and a fresh object per App render is what used to defeat memo barriers
  // downstream (PaneBar, and now ProjectView itself).
  const relay: RelayHandle = useMemo(
    () => ({
      status: relayStatus,
      chat: relayChat,
      inbox: relayInbox,
      transfers: relayTransfers,
      collab: collabMgr,
      collabTick,
      hostStart: async (name, visibility, port) => {
        setRelayStatus(await ipc.relayHostStart(name, visibility, port));
      },
      hostStop: async () => {
        relayIntentional.current = true;
        setRelayStatus(await ipc.relayHostStop());
        setRelayChat([]);
      },
      regenerateCode: async () => {
        setRelayStatus(await ipc.relayRegenerateCode());
      },
      connect: async (addr, code, name) => {
        setRelayStatus(await ipc.relayConnect(addr, code, name));
      },
      disconnect: async () => {
        relayIntentional.current = true;
        setRelayStatus(await ipc.relayDisconnect());
        setRelayChat([]);
      },
      sendChat: relaySendChat,
      sendCommand: relaySendCommand,
      dismissInbox: (id) =>
        setRelayInbox((prev) => prev.filter((m) => m.id !== id)),
      reportActiveChat: (peer) => {
        activeChatRef.current = peer;
        // Opening (or having open) a conversation reads it.
        if (peer !== undefined) markSeen(peer);
      },
      unread,
    }),
    [
      relayStatus,
      relayChat,
      relayInbox,
      relayTransfers,
      collabMgr,
      collabTick,
      relaySendChat,
      relaySendCommand,
      markSeen,
      unread,
    ],
  );

  const openProjects = useMemo(
    () =>
      ws.openIds
        .map((id) => ws.projects.find((p) => p.id === id))
        .filter((p): p is Project => Boolean(p)),
    [ws.openIds, ws.projects],
  );
  // The companion's reach: EVERY project, not just the open ones. That is the
  // whole point of it — "which repos have unpushed work" is a question about
  // the workspace, and answering only for the tabs that happen to be open
  // would make it quietly wrong rather than usefully scoped.
  const companionProjects = useMemo(
    () =>
      ws.projects.map((p) => ({
        name: p.name,
        roots: p.components.map((c) => c.path),
        open: ws.openIds.includes(p.id),
        hibernated: Boolean(hibernated[p.id]),
        // The configured commands come along, or canopy_start_server is
        // unusable: it takes a command by name, and nothing else tells the
        // companion what those names are.
        components: p.components.map((c) => ({
          label: c.label,
          path: c.path,
          commands: (c.commands ?? []).map((cmd) => cmd.name),
        })),
      })),
    [ws.projects, ws.openIds, hibernated],
  );
  const companionOn = useSyncExternalStore(
    subscribeSettings,
    () => getSettings().companionEnabled,
    () => false,
  );
  /** A proposal waiting on the user, rendered as a chip in the companion's
   *  chat. One at a time: the agent is blocked on the answer, so it cannot be
   *  asking two things at once. */
  const [proposal, setProposal] = useState<CompanionProposal | null>(null);
  const companionOpsRef = useRef<CompanionOps | null>(null);
  companionOpsRef.current = useMemo(
    () =>
      companionOn
        ? {
            workspace: (): WorkspaceProject[] => companionProjects,
            confirm: (p: Parameters<CompanionOps["confirm"]>[0]) =>
              new Promise<{ accepted: boolean; note?: string }>((resolve) => {
                // Posted to the attention channel as well as shown, for the
                // same reason an agent's question is: the companion may be
                // asking about a project the user cannot see, and a chip that
                // exists only while they are looking at Canopy is not a
                // question that was actually asked.
                const attentionId = postAttention({
                  kind: "question",
                  tone: "info",
                  title: p.action,
                  body: p.project
                    ? `${companionName()} wants to act in ${p.project}`
                    : `${companionName()} is asking`,
                  source: "agent",
                });
                setProposal({ ...p, attentionId, resolve });
              }),
            openProject: async (name: string, why?: string | null) => {
              const target = wsRef.current.projects.find(
                (p) => p.name.toLowerCase() === name.trim().toLowerCase(),
              );
              if (!target) throw new Error(`no project called "${name}"`);
              await openProjectRef.current?.(target.id);
              if (why) notify(`${companionName()}: ${why}`, "info");
              return target.name;
            },
            workspaceGit: (project: string | null | undefined) =>
              workspaceGit(companionProjects, project),
            agents: (project: string | null | undefined) =>
              workspaceAgents(companionProjects, project),
            search: (query: string, limit: number) => workspaceSearch(query, limit),
          }
        : null,
    // `companionProjects` is the only live input; everything else is a ref or
    // a module function.
    [companionOn, companionProjects, notify],
  );
  // Start and stop with the setting, and restart when the workspace changes
  // shape — the brief names every project and the session is given every root,
  // so a project added after launch would otherwise be invisible to it until
  // the app restarted.
  useEffect(() => {
    if (!companionOn) {
      void stopCompanion();
      return;
    }
    let cancelled = false;
    void checkInstalledClis().then((installed) => {
      if (cancelled) return;
      void startCompanion({
        projects: companionProjects,
        installed: (bin) => Boolean(installed[bin]),
        tools: companionToolNames(
          getSettings().disabledTools,
          getSettings().companionAuthority,
        ),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [companionOn, companionProjects]);
  // Quitting must not leave an agent running and billing.
  useEffect(() => () => void stopCompanion(), []);

  const allProjectRoots = useMemo(
    () =>
      openProjects.map((x) => ({
        name: x.name,
        roots: x.components.map((c) => c.path),
        // Carried because the cleanup task must not offer to delete what a wake
        // expects to find (installs, build output) — hibernating is "put away",
        // not "finished with".
        asleep: Boolean(hibernated[x.id]),
      })),
    [openProjects, hibernated],
  );
  const allPending = useMemo(
    () =>
      derivePending(agentEvents).filter((i) => !dismissedPending.has(i.key)),
    [agentEvents, dismissedPending],
  );
  // Agents blocked on the user, into the same queue as everything else.
  //
  // This is the other half of the split the channel closes. A micro-task that
  // stopped to ask raised a toast and a banner; an agent that stopped to ask
  // moved a number on a rail inside its own project — so the identical
  // situation was loud in one case and, in a project you were not looking at,
  // completely silent in the other. Both are questions now, both counted, and
  // an agent blocked in a background project finally reaches the OS.
  //
  // Derived, not posted at the moment it happens: `derivePending` recomputes
  // the whole picture from the hook stream on every event, so the bridge posts
  // under a stable per-session key and withdraws whatever the new picture no
  // longer contains. An agent that moved on withdraws its own question.
  const bridgedAgentKeys = useRef(new Set<string>());
  useEffect(() => {
    // `idle` is an agent that finished and is waiting — worth a calm card in
    // its panel, but nothing is blocked on the user, so it is not a question.
    const blocked = allPending.filter((i) => i.kind !== "idle");
    const live = new Set(blocked.map((i) => `agent:${i.sessionId}`));
    for (const p of blocked) {
      postAttention({
        kind: "question",
        tone: "info",
        title:
          p.kind === "question"
            ? (p.questions?.[0]?.question ?? `${p.agent} is asking`)
            : (p.message ?? `${p.agent} needs your attention`),
        body: p.agent,
        source: "agent",
        ...projectIdentity(p.cwd),
        // The terminal it is blocked in is the only place the answer can be
        // typed. Without a pty stamp (codex, an agent outside a Canopy tab)
        // the Agents panel is the nearest true answer.
        where:
          p.pty != null
            ? { kind: "terminal", ptyId: p.pty, path: p.cwd }
            : { kind: "panel", panel: "agents", path: p.cwd },
        dedupeKey: `agent:${p.sessionId}`,
      });
    }
    for (const key of bridgedAgentKeys.current) {
      if (!live.has(key)) resolveAttentionByKey(key, "withdrawn");
    }
    bridgedAgentKeys.current = live;
  }, [allPending, projectIdentity]);
  // Resolved rather than asserted: a project can be deleted from the manager
  // while its frost is still forming.
  const freezingProject = freezing
    ? (ws.projects.find((p) => p.id === freezing.id) ?? null)
    : null;
  /** Whether a project's tab shows the wake screen instead of a workspace. It
   *  is asleep and not being woken — except during the freeze itself, where the
   *  ProjectView stays mounted behind the frost until it has finished putting
   *  itself away. */
  const showsWakeScreen = (id: string) =>
    Boolean(hibernated[id]) &&
    !waking[id] &&
    !(freezing?.id === id && !freezing.leaving);
  // Project tabs are draggable; their order is the workspace's own, so it
  // persists with everything else in the workspace file.
  const tabDrag = useTabDrag(ws.openIds, (openIds) => update({ openIds }));
  // Tab badges count only what's blocked on the user — an agent that finished
  // and is idling is not urgent. Content-stable: most hook events move no
  // badge, and only a count actually changing should break TitleBar's memo.
  //
  // Read off the channel rather than counted here from the hook stream, which
  // is what made this a fourth independent mechanism. The number now means the
  // same thing everywhere and covers everything that can wait on you in a
  // project — a blocked agent, a micro-task that stopped to ask, an agent's
  // `canopy_ask_user` — where before it saw only the first.
  const pendingCountsSig = JSON.stringify(
    Object.fromEntries(
      openProjects.map((p) => [
        p.id,
        forProject(attention, p.id).filter(isOutstanding).length,
      ]),
    ),
  );
  const pendingCounts = useMemo(
    () => JSON.parse(pendingCountsSig) as Record<string, number>,
    [pendingCountsSig],
  );
  const pendingCount = useCallback(
    (p: Project) => pendingCounts[p.id] ?? 0,
    [pendingCounts],
  );

  // Stable per-project handlers, so memo(ProjectView) isn't defeated by fresh
  // closures. Each reads the current project through wsRef at call time.
  const projectHandlers = useRef(
    new Map<
      string,
      {
        onRestoreStep: (done: number, total: number, label: string) => void;
        onRestored: () => void;
        onEdit: () => void;
        onShareContext: (on: boolean) => void;
        onSaveCustomTasks: (tasks: CustomMicroTask[]) => void;
      }
    >(),
  );
  const handlersFor = (id: string) => {
    let h = projectHandlers.current.get(id);
    if (!h) {
      const find = () => wsRef.current.projects.find((x) => x.id === id);
      h = {
        onRestoreStep: (done, total, label) =>
          restoreStep(id, done, total, label),
        onRestored: () => restoreDone(id),
        onEdit: () => {
          const p = find();
          if (p) setDialog({ mode: "edit", project: p });
        },
        onShareContext: (on) => {
          const p = find();
          if (p) void saveProject({ ...p, shareContext: on });
        },
        onSaveCustomTasks: (tasks) => {
          const p = find();
          if (p) void saveProject({ ...p, customTasks: tasks });
        },
      };
      projectHandlers.current.set(id, h);
    }
    return h;
  };
  const dismissPending = useCallback((key: string) => {
    // Bail unchanged when already dismissed: the auto-clear effect fires per
    // render, and a fresh Set each time would loop it.
    setDismissedPending((prev) =>
      prev.has(key) ? prev : new Set(prev).add(key),
    );
  }, []);

  if (!loaded) return null;

  return (
    <div className={`app ${zen ? "zen" : ""}`}>
      {/* Focus mode: chrome slides away but stays reachable — hovering the top
          edge brings the project tabs and the tab strip back. */}
      {zen && <div className="zen-hotzone" />}
      {/* Transient zoom level, shown ~1s after Cmd +/-/0. */}
      {zoomPct !== null && <div className="zoom-indicator">{zoomPct}%</div>}
      <TitleBar
        openProjects={openProjects}
        activeId={ws.activeId}
        pendingCount={pendingCount}
        collabActive={collabTick >= 0 && (collab.current?.activeCount ?? 0) > 0}
        tabDragId={tabDrag.dragId}
        tabDragOffsetX={tabDrag.dragOffsetX}
        tabDragItemProps={tabDrag.itemProps}
        hibernated={hibernated}
        showHints={projectHints}
        notifCount={notifBadge.count}
        notifUrgency={notifBadge.urgency}
        onOpenNotifications={openNotifications}
        onSelectProject={selectProject}
        onCloseProject={handleCloseProject}
        onHibernateProject={hibernateProject}
        onWakeProject={wakeProject}
        onEditProject={editProject}
        onStopCollab={stopCollab}
        onNewProject={newProject}
        onManageProjects={openManager}
      />

      <div className="app-body">
        {openProjects.length === 0 && (
          <Welcome
            projects={ws.projects}
            hibernated={hibernated}
            onOpen={(id) => void openProject(id)}
            onNew={() => setDialog({ mode: "new" })}
            onDelete={(id) => {
              const p = wsRef.current.projects.find((x) => x.id === id);
              if (p) setConfirmDelete(p);
            }}
          />
        )}
        {/* A project that is asleep and not being woken has no ProjectView at
            all — that is the saving. It's the frost, and a button. */}
        {openProjects
          .filter((p) => showsWakeScreen(p.id))
          .map((p) => (
            <div
              key={p.id}
              className="project-view"
              style={{ display: p.id === ws.activeId ? "flex" : "none" }}
            >
              <HibernationView
                project={p}
                snapshot={hibernated[p.id]}
                progress={null}
                onWake={() => wakeProject(p.id)}
                onDiscard={() => discardHibernation(p.id)}
              />
            </div>
          ))}
        {openProjects
          .filter((p) => !showsWakeScreen(p.id))
          .map((p) => (
            <ProjectView
              key={p.id}
              project={p}
              visible={p.id === ws.activeId}
              restore={waking[p.id]?.snapshot ?? null}
              onRestoreStep={handlersFor(p.id).onRestoreStep}
              onRestored={handlersFor(p.id).onRestored}
              zen={zen}
              allProjects={allProjectRoots}
              events={agentEvents}
              hookPath={hookPath}
              relay={relay}
              dismissedPending={dismissedPending}
              onDismissPending={dismissPending}
              onEdit={handlersFor(p.id).onEdit}
              onNotice={notify}
              onShareContext={handlersFor(p.id).onShareContext}
              onSaveCustomTasks={handlersFor(p.id).onSaveCustomTasks}
            />
          ))}

        {/* The frost, layered over the project area. Going to sleep it forms
            over the live workspace; waking, it stays put while the workspace
            rebuilds underneath and only then dissolves. */}
        {freezing && freezingProject && (
          <div className="hib-layer">
            <FreezeOverlay
              project={freezingProject}
              snapshot={freezing.snapshot}
              leaving={Boolean(freezing.leaving)}
            />
          </div>
        )}
        {Object.entries(waking).map(([id, w]) => {
          const project = ws.projects.find((p) => p.id === id);
          if (!project || id !== ws.activeId) return null;
          return (
            <div key={id} className="hib-layer">
              <HibernationView
                project={project}
                snapshot={w.snapshot}
                progress={w.progress}
              />
            </div>
          );
        })}
      </div>

      {updateAvail && (
        <UpdateToast
          update={updateAvail}
          progress={updateProgress}
          onOpenDownloads={openDownloadsPage}
          onInstall={installAndRestart}
          onDismiss={dismissUpdate}
        />
      )}

      {/* A stack, not a slot. Two things reporting at once used to mean the
          first was destroyed before it could be read. Newest at the bottom,
          nearest the corner the eye is already in.

          Suppressed while the companion is up: the same items are delivered by
          it instead, from wherever it is standing. This is a second *renderer*
          on the one attention queue, never a second queue — urgency, fading and
          whether something reaches the OS are still decided in attention.ts,
          and a question is still outstanding until it is answered rather than
          until its card is closed. */}
      {toasts.length > 0 && !companionOn && (
        <div className="notice-stack">
          {toasts.map((t) => (
            <NoticeToast
              key={t.id}
              item={t}
              onDismiss={() => dismissToast(t.id)}
              onFollow={() => void followAttention(t)}
            />
          ))}
        </div>
      )}

      {companionOn && (
        <Companion
          notices={toasts}
          onDismissNotice={dismissToast}
          onFollowNotice={(item) => void followAttention(item)}
          proposal={proposal}
          onAnswerProposal={(accepted) => {
            if (!proposal) return;
            // Answering retires the attention item too. Dismissing the *card*
            // never did — the question was outstanding until answered, which
            // is exactly the distinction attention.ts draws.
            if (proposal.attentionId) {
              resolveAttention(proposal.attentionId, accepted ? "answered" : "dismissed");
            }
            proposal.resolve({ accepted });
            setProposal(null);
          }}
        />
      )}

      {notifOpen && (
        <NotificationCenter
          items={attention}
          onFollow={(item) => void followAttention(item)}
          onClose={() => setNotifOpen(false)}
        />
      )}

      {manager && (
        <ProjectManager
          projects={ws.projects}
          openIds={ws.openIds}
          hibernated={hibernated}
          onHibernate={hibernateProject}
          onWake={wakeProject}
          onOpen={(id) => void openProject(id)}
          onNew={() => {
            setManager(false);
            setDialog({ mode: "new" });
          }}
          onEdit={(p) => {
            setManager(false);
            setDialog({ mode: "edit", project: p });
          }}
          onRequestDelete={setConfirmDelete}
          onClose={() => setManager(false)}
        />
      )}

      {confirmClose && (() => {
        const roots = confirmClose.components.map((c) => c.path);
        const activeAgents = pendingForRoots(allPending, roots).filter((i) => i.kind !== "idle");
        const isAsleep = confirmClose.id in hibernated;
        const metaLine = confirmClose.components
          .map((c) => `${c.label}  ${c.path}`)
          .join("\n");
        const extraActions: import("./components/Dialog").DialogAction[] = [];
        if (!isAsleep) {
          extraActions.push({
            label: "❄ Hibernate",
            onClick: () => {
              const id = confirmClose.id;
              setConfirmClose(null);
              hibernateProject(id);
            },
          });
        }
        extraActions.push({
          label: "Close project",
          primary: true,
          onClick: () => {
            const id = confirmClose.id;
            setConfirmClose(null);
            void closeProject(id);
          },
        });
        return (
          <Dialog
            key={confirmClose.id}
            variant="danger"
            title={`Close ${confirmClose.name}?`}
            body={
              activeAgents.length > 0
                ? `${activeAgents.length === 1 ? "1 agent is actively working" : `${activeAgents.length} agents are actively working`} — closing will interrupt ${activeAgents.length === 1 ? "it" : "them"}. All terminals and servers will be stopped.`
                : "All terminals, agents, and servers in this project will be stopped."
            }
            meta={metaLine}
            dismissLabel="Keep open"
            onDismiss={() => setConfirmClose(null)}
            actions={extraActions}
          />
        );
      })()}

      {confirmDelete && (
        <Dialog
          variant="danger"
          title={`Delete project ${confirmDelete.name}?`}
          body="Removes it from Canopy only — the folders on disk are untouched. If it is open, its terminals (and anything running in them) will be closed."
          dismissLabel="Cancel"
          onDismiss={() => setConfirmDelete(null)}
          actions={[
            {
              label: "Delete",
              primary: true,
              onClick: () => {
                deleteProject(confirmDelete.id);
                setConfirmDelete(null);
              },
            },
          ]}
        />
      )}

      {ask && (
        <AskDialog
          question={ask.question}
          options={ask.options}
          onAnswer={(answer) => {
            ask.resolve(answer);
            resolveAttention(ask.attentionId, "answered");
            setAsk(null);
          }}
        />
      )}

      {dialog && (
        <ProjectDialog
          existing={dialog.mode === "edit" ? dialog.project : undefined}
          onSave={(p) => void saveProject(p)}
          onCancel={() => setDialog(null)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          initialTab={settingsOpen.tab}
          onClose={() => setSettingsOpen(null)}
        />
      )}
      {helpOpen && (
        <HelpDialog
          onClose={() => setHelpOpen(false)}
          onReplayIntro={() => {
            setHelpOpen(false);
            setOnboarding(true);
          }}
        />
      )}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      {onboarding && (
        <Onboarding
          onClose={() => {
            markOnboarded();
            setOnboarding(false);
          }}
          onCreateProject={() => {
            markOnboarded();
            setOnboarding(false);
            setDialog({ mode: "new" });
          }}
        />
      )}
      <Dictation />
      {/* Last, and once: every `title` in the app is drawn by this one bubble
          instead of the webview's native grey box. */}
      <TooltipLayer />
    </div>
  );
}

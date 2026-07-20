// Shell: project tabs on top; each open project is a fully mounted (hidden
// when inactive) ProjectView so its terminals keep running across switches.
import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "./ipc";
import {
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
import { derivePending, pendingForRoots } from "./notifications";
import { ProjectView } from "./components/ProjectView";
import { ProjectDialog } from "./components/ProjectDialog";
import { ProjectManager } from "./components/ProjectManager";
import { SettingsDialog } from "./components/SettingsDialog";
import { HelpDialog } from "./components/HelpDialog";
import { Welcome } from "./components/Welcome";
import { stopWorkspaceServers } from "./lsp/client";
import { checkForUpdateAnyChannel, installUpdate, type UpdateAvailability } from "./updater";

/** Tell the hook helper which projects share context between their sessions.
 *  Every project is listed with its opt-in state, so turning sharing off
 *  actively revokes it rather than just omitting the entry. */
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
  const [dialog, setDialog] = useState<{ mode: "new" } | { mode: "edit"; project: Project } | null>(null);
  const [agentEvents, setAgentEvents] = useState<AgentEventEntry[]>([]);
  // Pending cards the user waved away. Session-scoped on purpose: a dismissed
  // card is "seen", not "never tell me again". Held here (not in the panel)
  // because the project-tab badges count from the same derived list.
  const [dismissedPending, setDismissedPending] = useState<Set<string>>(new Set());
  const [manager, setManager] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState<null | { tab?: import("./components/SettingsDialog").SettingsTab }>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // One delete confirm for every entry point (manager, Welcome) — deleting a
  // project was a bare single click before, one misclick from losing a setup.
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);
  const [hookPath, setHookPath] = useState<string | null>(null);
  const [zen, setZen] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: NoticeKind } | null>(null);
  const notify = useCallback(
    (text: string, kind: NoticeKind = "info") => setNotice({ text, kind }),
    [],
  );
  // Native (macOS) notification for team activity landing while Canopy isn't
  // the focused app — the in-app toast can't be seen from another Space.
  // First call asks the OS for permission; a denial just means silence.
  const nativeNotify = useCallback(async (title: string, body: string) => {
    if (document.hasFocus()) return;
    try {
      const { isPermissionGranted, requestPermission, sendNotification } = await import(
        "@tauri-apps/plugin-notification"
      );
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) sendNotification({ title, body });
    } catch {
      // Notifications are a garnish — never fail anything over them.
    }
  }, []);
  // Successes and status lines are transient; a failure stays until it has
  // been read and dismissed.
  useEffect(() => {
    if (!notice || notice.kind === "error") return;
    const t = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(t);
  }, [notice]);
  // Team relay: one socket per app, so the state lives here and every
  // ProjectView renders the same picture. Chat keeps a rolling transcript
  // (received + our own sends); the inbox holds commands awaiting action.
  const [relayStatus, setRelayStatus] = useState<ipc.RelayStatus>({
    role: "off", code: null, port: null, ips: [], addr: null, self_id: null, name: null,
    visibility: null, public_ip: null, members: [],
  });
  const [relayChat, setRelayChat] = useState<ipc.RelayChatMsg[]>([]);
  const [relayInbox, setRelayInbox] = useState<ipc.RelayCommandMsg[]>([]);
  // Which conversation is on screen (null = team chat, undefined = none) —
  // a toast for a message the user is already reading is noise.
  const activeChatRef = useRef<string | null | undefined>(undefined);
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
    await exportWorkspace(path, wsRef.current).catch((e) => notify(String(e), "error"));
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
  const saveProjectRef = useRef<(p: Project) => Promise<void>>(async () => {});
  const updateRef = useRef<(patch: Partial<WorkspaceState>) => void>(() => {});

  // Load persisted workspace; re-register watchers/scopes for open projects.
  useEffect(() => {
    void loadWorkspace().then(async (state) => {
      for (const id of state.openIds) {
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
      ipc.onAgentEvent((raw) =>
        setAgentEvents((prev) => [...prev.slice(-199), { raw, ts: Date.now() }]),
      ),
      ipc.onRelayState(setRelayStatus),
      ipc.onRelayChat((m) => {
        setRelayChat((prev) => [...prev.slice(-499), m]);
        // A DM lives in the sender's conversation; a broadcast in the team
        // chat (null). Toast only when that conversation isn't on screen.
        const convo = m.to === null ? null : m.from;
        const text = m.text.length > 120 ? `${m.text.slice(0, 120)}…` : m.text;
        if (activeChatRef.current !== convo) {
          notify(`${m.from_name}: ${text}`);
        }
        void nativeNotify(
          m.to === null ? `${m.from_name} (team chat)` : m.from_name,
          text,
        );
      }),
      ipc.onRelayCommand((m) => {
        setRelayInbox((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
        const pr = (m.payload as { pr?: { number?: number; title?: string } } | null)?.pr;
        const file = (m.payload as { name?: string } | null)?.name;
        const text =
          m.kind === "open-pr" && pr
            ? `${m.from_name} asked you to review PR #${pr.number}: ${pr.title}`
            : m.kind === "file-offer" && file
              ? `${m.from_name} wants to send you ${file}`
              : `${m.from_name} sent a ${m.kind} command`;
        notify(`${text} — see the Team panel`);
        void nativeNotify("Canopy — Team", text);
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
        notify(msg, t.ok ? "success" : "error");
        void nativeNotify("Canopy — File transfer", msg);
      }),
      // Native menu accelerators (Cmd+W etc.) → scoped in-app actions. The
      // visible ProjectView handles tab-level ones; close-project is ours.
      import("@tauri-apps/api/event").then(({ listen }) =>
        listen<string>("menu", (e) => {
          if (e.payload === "close-project") {
            const active = wsRef.current.activeId;
            if (active) void closeProjectRef.current(active);
          } else if (e.payload === "next-project" || e.payload === "prev-project") {
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
                notify(`Canopy is up to date (${await getVersion()}).`, "success");
              })
              .catch((err) => notify(`Update check failed: ${err}`, "error"));
          } else if (e.payload === "install-cli") {
            void import("@tauri-apps/api/core").then(({ invoke }) =>
              invoke<string>("cli_install_shim")
                .then((m) => notify(m, "success"))
                .catch((err) => notify(String(err), "error")),
            );
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
    // Auto-inject agent hooks (idempotent) so tool events stream in without setup.
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      // Every CLI with a setup arm (see setup_agent_hooks). Each is
      // idempotent; ones whose CLI hasn't run yet fail quietly and succeed on
      // a later launch.
      for (const agent of ["claude", "codex", "agy", "aider", "opencode", "omp", "amp"]) {
        void invoke("setup_agent_hooks", { agent }).catch(() => {});
      }
    });
    // Focus mode is reachable two ways: the native menu accelerator, and a
    // webview key handler. Belt and braces — the accelerator is what the menu
    // advertises, but a native Cmd+Shift+Enter can be swallowed before it
    // reaches the menu, which left users stuck inside focus mode with no way
    // back out. The dedupe below means whichever arrives first wins and a
    // second path firing for the same press can't toggle it straight back.
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setZen(false);
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "Enter") {
        e.preventDefault();
        toggleZen("keydown");
      }
    };
    window.addEventListener("keydown", keys);
    // The status bar's 🎨 button (and anything else outside App) opens
    // Settings at a specific tab through this event.
    const openSettings = (e: Event) =>
      setSettingsOpen({ tab: (e as CustomEvent).detail?.tab });
    window.addEventListener("canopy:open-settings", openSettings);
    void ipc.hookBridgePath().then(setHookPath);
    // A relay may already be live (hot reload in dev, a future auto-start) —
    // ask rather than assume "off".
    void ipc.relayStatus().then(setRelayStatus).catch(() => {});
    return () => {
      window.removeEventListener("keydown", keys);
      window.removeEventListener("canopy:open-settings", openSettings);
      subs.forEach((s) => void s.then((fn) => fn()));
    };
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
      listen<string>("cli-open", (e) => void openDirAsProject(e.payload)).then((fn) => {
        unlisten = fn;
      }),
    );
    return () => unlisten?.();
  }, [loaded, openDirAsProject]);

  // Background update checks: shortly after launch (delayed so it never
  // competes with boot), then every 12h for the long-lived windows people
  // leave open for days. Quiet by design — failures and "already current"
  // say nothing; only a real update surfaces the toast.
  useEffect(() => {
    const tick = () => {
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
      void saveWorkspace(next);
      publishScopes(next);
      return next;
    });
  }, []);

  const openProject = useCallback(
    async (id: string) => {
      const project = wsRef.current.projects.find((p) => p.id === id);
      if (!project) return;
      if (!wsRef.current.openIds.includes(id)) {
        for (const c of project.components) {
          await ipc.workspaceAdd(c.path).catch((e) => console.warn("scope add failed", e));
        }
        update({ openIds: [...wsRef.current.openIds, id], activeId: id });
      } else {
        update({ activeId: id });
      }
    },
    [update],
  );

  const closeProject = useCallback(
    async (id: string) => {
      const state = wsRef.current;
      const project = state.projects.find((p) => p.id === id);
      const openIds = state.openIds.filter((x) => x !== id);
      // Drop watchers/scopes not used by any other open project.
      const stillUsed = new Set(
        openIds.flatMap(
          (x) => state.projects.find((p) => p.id === x)?.components.map((c) => c.path) ?? [],
        ),
      );
      for (const c of project?.components ?? []) {
        if (!stillUsed.has(c.path)) {
          await ipc.workspaceRemove(c.path).catch(() => {});
          await stopWorkspaceServers(c.path);
        }
      }
      update({
        openIds,
        activeId: state.activeId === id ? (openIds[openIds.length - 1] ?? null) : state.activeId,
      });
    },
    [update],
  );
  closeProjectRef.current = closeProject;
  openProjectRef.current = openProject;
  updateRef.current = update;

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

  // The relay handle every ProjectView shares. Sends append the stamped
  // message locally — the relay never echoes a frame back to its author, so
  // this is the only way our own words reach our own transcript.
  const relaySendChat = useCallback(async (to: string | null, text: string) => {
    const msg = await ipc.relaySendChat(to, text);
    setRelayChat((prev) => [...prev.slice(-499), msg]);
  }, []);
  const relaySendCommand = useCallback(async (to: string | null, kind: string, payload: unknown) => {
    await ipc.relaySendCommand(to, kind, payload);
  }, []);
  const relay: RelayHandle = {
    status: relayStatus,
    chat: relayChat,
    inbox: relayInbox,
    hostStart: async (name, visibility, port) => {
      setRelayStatus(await ipc.relayHostStart(name, visibility, port));
    },
    hostStop: async () => {
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
      setRelayStatus(await ipc.relayDisconnect());
      setRelayChat([]);
    },
    sendChat: relaySendChat,
    sendCommand: relaySendCommand,
    dismissInbox: (id) => setRelayInbox((prev) => prev.filter((m) => m.id !== id)),
    reportActiveChat: (peer) => {
      activeChatRef.current = peer;
    },
  };

  if (!loaded) return null;

  const openProjects = ws.openIds
    .map((id) => ws.projects.find((p) => p.id === id))
    .filter((p): p is Project => Boolean(p));
  const allPending = derivePending(agentEvents).filter((i) => !dismissedPending.has(i.key));
  // Tab badges count only what's blocked on the user — an agent that finished
  // and is idling is not urgent.
  const pendingCount = (p: Project) =>
    pendingForRoots(allPending, p.components.map((c) => c.path)).filter(
      (i) => i.kind !== "idle",
    ).length;

  return (
    <div className={`app ${zen ? "zen" : ""}`}>
      {/* Focus mode: chrome slides away but stays reachable — hovering the top
          edge brings the project tabs and the tab strip back. */}
      {zen && <div className="zen-hotzone" />}
      <div className="titlebar">
        <div className="project-tabs">
          {openProjects.map((p) => (
            <div
              key={p.id}
              className={`project-tab ${p.id === ws.activeId ? "project-tab-active" : ""}`}
              onClick={() => update({ activeId: p.id })}
              title={p.components.map((c) => c.path).join("\n")}
            >
              <span>{p.name}</span>
              {pendingCount(p) > 0 && (
                <span className="badge badge-urgent" title="agent needs your input">
                  {pendingCount(p)}
                </span>
              )}
              <span
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeProject(p.id);
                }}
              >
                ✕
              </span>
            </div>
          ))}
          <button className="btn-icon" title="New project" onClick={() => setDialog({ mode: "new" })}>
            ＋
          </button>
        </div>
        <div className="titlebar-spacer" />
        <button
          className="btn project-manage-btn"
          title="Manage projects — open, create, edit, delete"
          onClick={() => setManager(true)}
        >
          Projects ▾
        </button>
      </div>

      <div className="app-body">
        {openProjects.length === 0 && (
          <Welcome
            projects={ws.projects}
            onOpen={(id) => void openProject(id)}
            onNew={() => setDialog({ mode: "new" })}
            onDelete={(id) => {
              const p = wsRef.current.projects.find((x) => x.id === id);
              if (p) setConfirmDelete(p);
            }}
          />
        )}
        {openProjects.map((p) => (
          <ProjectView
            key={p.id}
            project={p}
            visible={p.id === ws.activeId}
            zen={zen}
            allProjects={openProjects.map((x) => ({
              name: x.name,
              roots: x.components.map((c) => c.path),
            }))}
            events={agentEvents}
            hookPath={hookPath}
            relay={relay}
            dismissedPending={dismissedPending}
            onDismissPending={(key) =>
              // Bail unchanged when already dismissed: the auto-clear effect
              // fires per render, and a fresh Set each time would loop it.
              setDismissedPending((prev) =>
                prev.has(key) ? prev : new Set(prev).add(key),
              )
            }
            onEdit={() => setDialog({ mode: "edit", project: p })}
            onNotice={notify}
            onShareContext={(on) =>
              void saveProject({ ...p, shareContext: on })
            }
          />
        ))}
      </div>

      {updateAvail && (
        <div className="update-toast">
          <div className="update-head">
            <strong>Canopy {updateAvail.info.version}</strong> is available
          </div>
          {updateAvail.info.notes && <div className="update-notes">{updateAvail.info.notes}</div>}
          {updateAvail.kind === "manual" ? (
            <div className="update-actions">
              {/* This install type can't self-update (.deb/.rpm — the package
                  manager owns it, but there's no apt/dnf repo to serve it) —
                  hand off to the downloads page rather than pretend. */}
              <button
                className="btn btn-accent"
                onClick={() => {
                  void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
                    openUrl("https://canopyide.dev/downloads"),
                  );
                }}
              >
                Open downloads page
              </button>
              <button
                className="btn"
                onClick={() => {
                  dismissedUpdate.current = updateAvail.info.version;
                  setUpdateAvail(null);
                }}
              >
                Later
              </button>
            </div>
          ) : updateProgress === null ? (
            <div className="update-actions">
              {/* Never install without asking: the terminals hold live agent
                  sessions whose scrollback exists nowhere else, and installing
                  relaunches the app. */}
              <button
                className="btn btn-accent"
                onClick={() => {
                  setUpdateProgress(0);
                  void installUpdate(setUpdateProgress).catch((err) => {
                    setUpdateProgress(null);
                    setUpdateAvail(null);
                    notify(`Update failed: ${err}`, "error");
                  });
                }}
              >
                Install and restart
              </button>
              <button
                className="btn"
                onClick={() => {
                  dismissedUpdate.current = updateAvail.info.version;
                  setUpdateAvail(null);
                }}
              >
                Later
              </button>
            </div>
          ) : (
            <div className="update-progress">
              <div
                className="update-bar"
                style={{ width: `${Math.round(updateProgress * 100)}%` }}
              />
              <span className="update-pct">
                {Math.round(updateProgress * 100)}% — Canopy will restart itself
              </span>
            </div>
          )}
        </div>
      )}

      {notice && (
        <div
          className={`notice notice-${notice.kind}`}
          onClick={() => setNotice(null)}
          title="dismiss"
        >
          {notice.text}
        </div>
      )}

      {manager && (
        <ProjectManager
          projects={ws.projects}
          openIds={ws.openIds}
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

      {confirmDelete && (
        <div className="confirm-backdrop" onMouseDown={() => setConfirmDelete(null)}>
          <div className="confirm" onMouseDown={(e) => e.stopPropagation()}>
            <p>
              Delete project <strong>{confirmDelete.name}</strong>?
            </p>
            <p className="confirm-sub">
              Removes it from Canopy only — the folders on disk are untouched.
              If it is open, its terminals (and anything running in them) will
              be closed.
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger-solid"
                onClick={() => {
                  deleteProject(confirmDelete.id);
                  setConfirmDelete(null);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
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
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

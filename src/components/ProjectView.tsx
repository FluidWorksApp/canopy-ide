// One open project: icon rail + collapsible side panel (components / changes /
// agents) + the main area where the TERMINAL is the hero. Terminals and files
// are sub-tabs; terminals stay mounted so TUIs keep running. Bottom status tray
// shows git branch, agents, model, tokens, cost.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import * as ipc from "../ipc";
import { modelFor, monaco } from "../monaco-setup";
import type { AgentCli, Project } from "../projects";
import { AGENT_CLIS, checkInstalledClis } from "../projects";
import {
  AgentIcon,
  CheckIcon,
  FailIcon,
  LiveDot,
  PlayIcon,
  RestartIcon,
  StopIcon,
  TerminalIcon,
} from "./icons";
import type { AgentEventEntry, OpenFile } from "../types";
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
import { PrView } from "./PrView";

type SideTab = "files" | "changes" | "git" | "agents";

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

interface PrSubTab {
  id: string;
  type: "pr";
  repo: string;
  pr: ipc.PrInfo;
}

type SubTab = TermSubTab | FileSubTab | PrSubTab;

const decoder = new TextDecoder();
// Collision-proof ids: a module counter resets on hot-reload and produced
// duplicate tab ids (closing one tab hit another).
const tabId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const AGENT_PATTERN =
  /\b(claude|codex|aider|goose|gemini|opencode|amp|copilot|cursor-agent|qwen|droid)\b/i;

const RAIL_TABS: { key: SideTab; icon: string; title: string }[] = [
  { key: "files", icon: "🗂", title: "Components & files" },
  { key: "changes", icon: "±", title: "Session changes" },
  { key: "git", icon: "⎇", title: "Git — branches, commit, sync, PRs" },
  { key: "agents", icon: "✳", title: "Agents" },
];

interface ProjectViewProps {
  project: Project;
  visible: boolean;
  zen: boolean;
  events: AgentEventEntry[];
  hookPath: string | null;
  /** Pending-card keys the user dismissed (held app-wide so badges agree). */
  dismissedPending: Set<string>;
  onDismissPending: (key: string) => void;
  onEdit: () => void;
  onNotice: (msg: string) => void;
  onShareContext: (on: boolean) => void;
}

export function ProjectView({ project, visible, zen, events, hookPath, dismissedPending, onDismissPending, onEdit, onNotice, onShareContext }: ProjectViewProps) {
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
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
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
  useEffect(() => {
    const sub = ipc.onPtyStats((all) => {
      const ids = new Set(
        tabsRef.current
          .filter((t): t is TermSubTab => t.type === "terminal")
          .map((t) => t.ptyId)
          .filter((id): id is number => id != null),
      );
      const mine = all.filter((s) => ids.has(s.id));
      setStats((prev) => (prev.length === 0 && mine.length === 0 ? prev : mine));
    });
    return () => void sub.then((fn) => fn());
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

  // ---------- terminals ----------

  const addTerminal = useCallback(
    (cwd: string, command?: string, title?: string, icon?: string, run = false) => {
      const id = tabId();
      setTabs((prev) => [
        ...prev,
        { id, type: "terminal", cwd, title: title ?? "shell", ptyId: null, command, icon, run },
      ]);
      setActiveTabId(id);
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

  useEffect(() => {
    void checkInstalledClis().then(setInstalled);
  }, []);

  // Looking at a tab is what marks it read. As an effect rather than something
  // hung off the tab's onClick, so every route in — clicking, Ctrl+Tab cycling,
  // a jump from the agents panel, closing the tab in front of it — clears the
  // ring without each one having to remember to.
  useEffect(() => {
    if (!visible || !activeTabId) return;
    setTabs((prev) =>
      prev.some((t) => t.id === activeTabId && t.type === "terminal" && t.unread)
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
    window.addEventListener("menu:close-tab", closeTabHandler);
    window.addEventListener("menu:new-terminal", newTerminalHandler);
    window.addEventListener("menu:toggle-sidebar", toggleSidebarHandler);
    window.addEventListener("menu:next-tab", next);
    window.addEventListener("menu:prev-tab", prev);
    window.addEventListener("menu:quick-open", quickOpen);
    window.addEventListener("menu:find-in-files", findInFiles);
    return () => {
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
      addTerminal(cwd, cli.install, `install ${cli.name}`, "⬇");
      setTimeout(() => void checkInstalledClis().then(setInstalled), 60_000);
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
      onNotice(String(e));
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
          {tabs
            .filter((t) => t.type !== "terminal" || !t.run)
            .map((tab) => (
              <div
                key={tab.id}
                className={`tab ${tab.id === activeTabId ? "tab-active" : ""} ${
                  tab.type === "terminal" && tab.unread ? "tab-unread" : ""
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
                      : tab.file.path
                }
              >
                {tab.type === "terminal" ? (
                  <span className="tab-term-icon">{tab.icon ?? "❯_"}</span>
                ) : tab.type === "pr" ? (
                  <span className="tab-pr-icon">⑃</span>
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
        {/* Long-running commands live in their own right-hand rail — they are
            services, not shells, so they never mix with the terminal tabs. */}
        {runTabs.length > 0 && (
          <div className="run-rail">
            <span className="run-rail-label">RUNS</span>
            {runTabs.map((tab) => {
              const ok = tab.exitCode === 0;
              const state = !tab.exited ? "live" : ok ? "done" : "failed";
              return (
                <div
                  key={tab.id}
                  className={`run-chip run-chip-${state} ${tab.id === activeTabId ? "run-chip-active" : ""}`}
                  onClick={() => setActiveTabId(tab.id)}
                  title={
                    tab.exited
                      ? `${ok ? "finished" : `exited ${tab.exitCode ?? "?"}`} — ${tab.command ?? ""}`
                      : `running — ${tab.command ?? ""}`
                  }
                >
                  {!tab.exited ? (
                    <LiveDot size={7} className="run-chip-dot" />
                  ) : ok ? (
                    <CheckIcon size={11} className="run-chip-ok" />
                  ) : (
                    <FailIcon size={11} className="run-chip-fail" />
                  )}
                  <span className="run-chip-title">{tab.title}</span>
                  {tab.exited && (
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
              );
            })}
          </div>
        )}
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
            <button className="btn" title="New terminal / agent" onClick={() => setCliMenuOpen((v) => !v)}>
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
                  if (tab.run) patchTab(tab.id, { exited: true, exitCode: code, ptyId: null });
                  else closeTab(tab.id);
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
        {activeTab?.type === "pr" && (
          <PrView
            key={activeTab.id}
            repo={activeTab.repo}
            pr={activeTab.pr}
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
          </div>
        )}
      </div>
      <StatusBar
        roots={roots}
        agents={runningAgents}
        events={projectEvents}
        visible={visible}
        onSetModel={hasClaude ? setAgentModel : undefined}
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
      {sideTab === "agents" && (
        <AgentsPanel
          stats={projectStats}
          hookPath={hookPath}
          pending={pending}
          onDismissPending={onDismissPending}
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
              {t.icon}
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
            </button>
          ))}
          <div className="rail-spacer" />
          <button
            className="rail-btn"
            title="Toggle sidebar (Cmd+B)"
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? "⇥" : "⇤"}
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

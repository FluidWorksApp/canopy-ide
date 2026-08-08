import {
  memo,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import { BellIcon, CloseIcon, FrostIcon } from "./icons";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import type { Urgency } from "../attention";
import type { Project } from "../projects";
import type { TabDrag } from "../tabDrag";
// macOS gets the frameless "Overlay" titlebar (set in tauri.conf.json), so our
// TitleBar becomes the real window titlebar: it must reserve space for the
// native traffic lights on the left and act as the window drag handle. On
// Windows/Linux the native bar stays, `titleBarStyle` is ignored, and the
// class is simply absent — nothing changes there.
import { IS_MAC } from "../platform";
import { Button } from "./ui";
import { CAPTURE_MODES, captureModeLabel } from "../pageCapture";
import {
  getVibePreviewContext,
  subscribeVibePreviewContext,
} from "../vibePreviewContext";

/** True while the window is in macOS fullscreen, where the traffic lights are
 *  hidden and the space reserved for them would read as a dead gap. There's no
 *  dedicated fullscreen event, but every enter/exit resizes the window, so
 *  onResized is the reliable trigger. Always false off macOS and outside
 *  Tauri, where the import throws and the class is never applied anyway. */
function useMacFullscreen(): boolean {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!IS_MAC) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const sync = async () => {
          const v = await win.isFullscreen();
          if (!cancelled) setFull(v);
        };
        await sync();
        const off = await win.onResized(() => void sync());
        if (cancelled) off();
        else unlisten = off;
      } catch {
        // Not under Tauri (browser dev) — stay false.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return full;
}

interface TitleBarProps {
  projects: Project[];
  openProjects: Project[];
  activeId: string | null;
  /** Count of agent items blocked on the user for a project — drives the pill badge. */
  pendingCount: (p: Project) => number;
  /** True while a live collaboration session is active anywhere. */
  collabActive: boolean;
  /** Which project pill is currently being dragged (null if none). */
  tabDragId: string | null;
  /** Current translateX offset of the dragged pill, in px. */
  tabDragOffsetX: number;
  /** Returns pointer-event props for a draggable pill by project id. */
  tabDragItemProps: TabDrag["itemProps"];
  /** Projects that are asleep — their pill wears the frost and the menu offers
   *  to wake them rather than to put them under again. */
  hibernated: Record<string, unknown>;
  /** True while ⌥/Alt is held: each of the first nine pills shows the digit
   *  that jumps to it (see useHeldModifier). */
  showHints: boolean;
  /** The attention channel's badge: how many, and how loudly (attention.ts).
   *  Zero means no badge at all. */
  notifCount: number;
  notifUrgency: Urgency;
  onOpenNotifications: () => void;
  onOpenProject: (id: string) => void;
  onSelectProject: (id: string) => void;
  onCloseProject: (id: string) => void;
  onHibernateProject: (id: string) => void;
  onWakeProject: (id: string) => void;
  onToggleVibe: (id: string) => void;
  onEditProject: (p: Project) => void;
  onStopCollab: () => void;
  onNewProject: () => void;
  onManageProjects: () => void;
}

/** Build has one browser chrome row: this title bar. PreviewView publishes its
 * live controls here instead of rendering a second URL/action shelf above the
 * page. Text labels stay in accessible names; the chrome itself remains quiet. */
function BuildBrowserControls({ projectId }: {
  projectId: string;
}) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeVibePreviewContext(projectId, listener),
    [projectId],
  );
  const snapshot = useCallback(() => getVibePreviewContext(projectId), [projectId]);
  const preview = useSyncExternalStore(subscribe, snapshot, () => null);
  const [draft, setDraft] = useState(preview?.url ?? "");
  const captureMenu = useContextMenu();

  useEffect(() => setDraft(preview?.url ?? ""), [preview?.url]);

  // Empty Build preview is already explained by the canvas. Browser chrome is
  // useful only once there is a page it can control; before that it is a false
  // address field and competes with the setup state for attention.
  if (!preview?.url.trim()) return null;

  const openCaptureOptions = (event: MouseEvent) =>
    captureMenu.open(
      event,
      CAPTURE_MODES.map((mode) => ({
        label: mode.label,
        hint: mode.id === preview.captureMode ? "default" : mode.hint,
        onClick: () => preview.capture(mode.id),
      })),
    );

  return (
    <div className="build-browser-controls">
      <Button icon className="build-browser-control" title="Back" onClick={() => preview.go(-1)}>
        ‹
      </Button>
      <Button icon className="build-browser-control" title="Forward" onClick={() => preview.go(1)}>
        ›
      </Button>
      <Button icon className="build-browser-control" title="Reload" onClick={() => preview.go(0)}>
        ↻
      </Button>
      <form
        className="build-browser-form"
        onSubmit={(event) => {
          event.preventDefault();
          preview.navigate(draft);
          (event.currentTarget.firstElementChild as HTMLInputElement | null)?.blur();
        }}
      >
        <span className="build-browser-dot" aria-hidden />
        <input
          className="build-browser-input"
          aria-label="Preview address"
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => setDraft(preview.url)}
        />
      </form>
      <Button
        icon
        className={`build-browser-control ${preview.picking ? "active" : ""}`}
        title="Annotate page"
        aria-label={`Annotate page${preview.annotations.length ? `, ${preview.annotations.length} retained` : ""}`}
        onClick={preview.togglePicking}
      >
        ◎
      </Button>
      <Button
        icon
        className="build-browser-control"
        title={`Capture ${captureModeLabel(preview.captureMode).toLowerCase()}`}
        aria-label={`Capture screenshot${preview.shots.length ? `, ${preview.shots.length} retained` : ""}`}
        disabled={preview.capturing}
        onClick={() => preview.capture(preview.captureMode)}
        onContextMenu={openCaptureOptions}
      >
        ▣
      </Button>
      <Button
        icon
        className="build-browser-control build-browser-capture-options"
        title="Choose capture type"
        aria-label="Choose capture type"
        disabled={preview.capturing}
        onClick={openCaptureOptions}
      >
        ⌄
      </Button>
      {captureMenu.menu && (
        <ContextMenu
          x={captureMenu.menu.x}
          y={captureMenu.menu.y}
          items={captureMenu.menu.items}
          onClose={captureMenu.close}
        />
      )}
    </div>
  );
}

// Top chrome: one pill per open project, a live-collab indicator, and the
// Projects menu. Memoized — it only re-renders when the project set, the
// active id, or the collab state actually change, not on every App state tick.
function TitleBarImpl({
  projects,
  openProjects,
  activeId,
  pendingCount,
  collabActive,
  tabDragId,
  tabDragOffsetX,
  tabDragItemProps,
  hibernated,
  showHints,
  notifCount,
  notifUrgency,
  onOpenNotifications,
  onOpenProject,
  onSelectProject,
  onCloseProject,
  onHibernateProject,
  onWakeProject,
  onToggleVibe,
  onEditProject,
  onStopCollab,
  onNewProject,
  onManageProjects,
}: TitleBarProps) {
  const fullscreen = useMacFullscreen();
  const menu = useContextMenu();
  const activeProject = openProjects.find((project) => project.id === activeId);
  const buildMode = activeProject?.vibe?.enabled === true;
  const chooseProject = (id: string) =>
    openProjects.some((project) => project.id === id)
      ? onSelectProject(id)
      : onOpenProject(id);
  const openProjectMenu = (event: MouseEvent) =>
    menu.open(event, [
      ...projects.map((project) => ({
        label: `${project.id === activeId ? "✓  " : ""}${project.name}`,
        onClick: () => chooseProject(project.id),
      })),
      { separator: true },
      { label: "New project…", icon: "+", onClick: onNewProject },
      { label: "Manage projects…", icon: "⋯", onClick: onManageProjects },
    ]);
  return (
    // data-tauri-drag-region makes the bar background draggable (like grabbing
    // a native titlebar). Tauri checks the mousedown target, so interactive
    // children (pills, buttons) — which are the target, not this div — still
    // register clicks normally without opting out.
    <div
      className={`titlebar ${buildMode ? "titlebar-build" : ""} ${IS_MAC ? "titlebar-overlay" : ""} ${
        IS_MAC && fullscreen ? "titlebar-fullscreen" : ""
      }`}
      data-tauri-drag-region
    >
      {/* The strip around the pills is draggable too — the pills/badges/close
          are their own click targets, so they still work. */}
      {buildMode && activeProject ? (
        <BuildBrowserControls
          projectId={activeProject.id}
        />
      ) : (
      <div className="project-tabs" data-tauri-drag-region>
        {openProjects.map((p, i) => {
          const asleep = p.id in hibernated;
          // Only the first nine are reachable by digit, so only they wear one.
          const hint = showHints && i < 9 ? i + 1 : null;
          return (
          <div
            key={p.id}
            className={`project-tab ${p.id === activeId ? "project-tab-active" : ""} ${
              p.id === tabDragId ? "tab-dragging" : ""
            } ${asleep ? "project-tab-asleep" : ""}`}
            style={p.id === tabDragId && tabDragOffsetX !== 0 ? { transform: `translateX(${tabDragOffsetX}px)` } : undefined}
            {...tabDragItemProps(p.id)}
            onClick={() => onSelectProject(p.id)}
            onContextMenu={(e) =>
              menu.open(e, [
                { label: p.name, separator: true },
                asleep
                  ? {
                      label: "Wake from hibernation",
                      icon: "☀",
                      onClick: () => {
                        onSelectProject(p.id);
                        onWakeProject(p.id);
                      },
                    }
                  : {
                      label: "Hibernate project",
                      icon: <FrostIcon size={12} />,
                      hint: "frees its terminals",
                      onClick: () => onHibernateProject(p.id),
                    },
                { separator: true },
                { label: "Edit project…", icon: "⚙", onClick: () => onEditProject(p) },
                { label: "Close project", icon: "✕", onClick: () => onCloseProject(p.id) },
              ])
            }
            title={
              (asleep ? "Hibernating — open its tab to wake it\n\n" : "") +
              p.components.map((c) => c.path).join("\n")
            }
          >
            {asleep && (
              <span className="project-tab-frost" title="Hibernating — open its tab to wake it">
                <FrostIcon size={12} />
              </span>
            )}
            <span>{p.name}</span>
            {/* Nothing is running in a sleeping project, so nothing there can
                be waiting on you — its agents' last words are history, not a
                queue. */}
            {!asleep && pendingCount(p) > 0 && (
              <span className="badge badge-urgent" title="agent needs your input">
                {pendingCount(p)}
              </span>
            )}
            {hint !== null && <span className="tab-hint">{hint}</span>}
            <span
              className="tab-close"
              title="Close project"
              onClick={(e) => {
                e.stopPropagation();
                onCloseProject(p.id);
              }}
            >
              <CloseIcon size={12} />
            </span>
          </div>
          );
        })}
        <Button icon title="New project" onClick={onNewProject}>
          ＋
        </Button>
      </div>
      )}
      <div className="titlebar-spacer" data-tauri-drag-region />
      {activeProject && !(activeProject.id in hibernated) && (
        <button
          type="button"
          className="project-mode-toggle"
          aria-label={`Switch to ${buildMode ? "Engineer" : "Build"} mode`}
          aria-pressed={buildMode}
          title={`Switch ${activeProject.name} to ${buildMode ? "Engineer" : "Build"} mode`}
          onClick={() => onToggleVibe(activeProject.id)}
        >
          <span className={buildMode ? "active" : ""}>Build</span>
          <span className="project-mode-arrow" aria-hidden>
            ⇄
          </span>
          <span className={buildMode ? "" : "active"}>Engineer</span>
        </button>
      )}
      {collabActive && !buildMode && (
        <div
          className="collab-live"
          title="Live collaboration in progress — click ✕ to end every share and session"
        >
          <span className="collab-live-dot" />
          Collaborating
          <button
            className="collab-live-stop"
            title="Stop collaborating — end every share and live session"
            onClick={onStopCollab}
          >
            ✕
          </button>
        </div>
      )}
      {/* The channel's one opener. App-level rather than in a project's rail,
          because the queue is the workspace's: the whole point is to see that
          a project you are NOT looking at is waiting on you. */}
      <button
        className={`notif-bell${
          notifCount > 0 ? ` notif-bell-lit notif-bell-counted notif-bell-${buildMode ? "low" : notifUrgency}` : ""
        }`}
        title={
          notifCount > 0
            ? `${notifCount} ${notifUrgency === "high" ? "waiting on you" : "unread"}`
            : "Notifications"
        }
        aria-label="Notifications"
        onClick={onOpenNotifications}
      >
        <BellIcon size={15} />
        {/* Beside the bell, not on it: a two-digit count pinned to the glyph's
            corner covered the glyph. */}
        {notifCount > 0 && (
          <span className="notif-bell-count">{notifCount > 99 ? "99+" : notifCount}</span>
        )}
      </button>
      {buildMode ? (
        <Button
          className="build-project-menu"
          title="Switch or create a project"
          aria-label="Projects"
          onClick={openProjectMenu}
        >
          <span>{activeProject?.name}</span>
          <span aria-hidden>⌄</span>
        </Button>
      ) : (
        <Button className="project-manage-btn"
          title="Manage projects — open, create, edit, delete"
          onClick={onManageProjects}>
          Projects ▾
        </Button>
      )}
      {menu.menu && (
        <ContextMenu
          x={menu.menu.x}
          y={menu.menu.y}
          items={menu.menu.items}
          onClose={menu.close}
        />
      )}
    </div>
  );
}

export const TitleBar = memo(TitleBarImpl);

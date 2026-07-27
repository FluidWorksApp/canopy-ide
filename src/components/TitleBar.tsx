import { memo, useEffect, useState } from "react";
import { CloseIcon, FrostIcon } from "./icons";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import type { Project } from "../projects";
import type { TabDrag } from "../tabDrag";
// macOS gets the frameless "Overlay" titlebar (set in tauri.conf.json), so our
// TitleBar becomes the real window titlebar: it must reserve space for the
// native traffic lights on the left and act as the window drag handle. On
// Windows/Linux the native bar stays, `titleBarStyle` is ignored, and the
// class is simply absent — nothing changes there.
import { IS_MAC } from "../platform";

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
  openProjects: Project[];
  activeId: string | null;
  /** Count of agent items blocked on the user for a project — drives the pill badge. */
  pendingCount: (p: Project) => number;
  /** True while a live collaboration session is active anywhere. */
  collabActive: boolean;
  /** Which project pill is currently being dragged (null if none). */
  tabDragId: string | null;
  /** Returns pointer-event props for a draggable pill by project id. */
  tabDragItemProps: TabDrag["itemProps"];
  /** Projects that are asleep — their pill wears the frost and the menu offers
   *  to wake them rather than to put them under again. */
  hibernated: Record<string, unknown>;
  /** True while ⌥/Alt is held: each of the first nine pills shows the digit
   *  that jumps to it (see useHeldModifier). */
  showHints: boolean;
  onSelectProject: (id: string) => void;
  onCloseProject: (id: string) => void;
  onHibernateProject: (id: string) => void;
  onWakeProject: (id: string) => void;
  onEditProject: (p: Project) => void;
  onStopCollab: () => void;
  onNewProject: () => void;
  onManageProjects: () => void;
}

// Top chrome: one pill per open project, a live-collab indicator, and the
// Projects menu. Memoized — it only re-renders when the project set, the
// active id, or the collab state actually change, not on every App state tick.
function TitleBarImpl({
  openProjects,
  activeId,
  pendingCount,
  collabActive,
  tabDragId,
  tabDragItemProps,
  hibernated,
  showHints,
  onSelectProject,
  onCloseProject,
  onHibernateProject,
  onWakeProject,
  onEditProject,
  onStopCollab,
  onNewProject,
  onManageProjects,
}: TitleBarProps) {
  const fullscreen = useMacFullscreen();
  const menu = useContextMenu();
  return (
    // data-tauri-drag-region makes the bar background draggable (like grabbing
    // a native titlebar). Tauri checks the mousedown target, so interactive
    // children (pills, buttons) — which are the target, not this div — still
    // register clicks normally without opting out.
    <div
      className={`titlebar ${IS_MAC ? "titlebar-overlay" : ""} ${
        IS_MAC && fullscreen ? "titlebar-fullscreen" : ""
      }`}
      data-tauri-drag-region
    >
      {/* The strip around the pills is draggable too — the pills/badges/close
          are their own click targets, so they still work. */}
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
        <button className="btn-icon" title="New project" onClick={onNewProject}>
          ＋
        </button>
      </div>
      <div className="titlebar-spacer" data-tauri-drag-region />
      {collabActive && (
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
      <button
        className="btn project-manage-btn"
        title="Manage projects — open, create, edit, delete"
        onClick={onManageProjects}
      >
        Projects ▾
      </button>
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

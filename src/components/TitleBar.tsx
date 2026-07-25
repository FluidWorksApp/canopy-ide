import { memo } from "react";
import { CloseIcon } from "./icons";
import type { Project } from "../projects";
import type { TabDrag } from "../tabDrag";

// macOS gets the frameless "Overlay" titlebar (set in tauri.conf.json), so our
// TitleBar becomes the real window titlebar: it must reserve space for the
// native traffic lights on the left and act as the window drag handle. On
// Windows/Linux the native bar stays, `titleBarStyle` is ignored, and this
// class is simply absent — nothing changes there.
const IS_MAC =
  typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

interface TitleBarProps {
  openProjects: Project[];
  activeId: string | null;
  /** Count of agent items blocked on the user for a project — drives the pill badge. */
  pendingCount: (p: Project) => number;
  /** True while a live collaboration session is active anywhere. */
  collabActive: boolean;
  /** Drag-to-reorder for the project pills; order persists in the workspace. */
  tabDrag: TabDrag;
  onSelectProject: (id: string) => void;
  onCloseProject: (id: string) => void;
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
  tabDrag,
  onSelectProject,
  onCloseProject,
  onStopCollab,
  onNewProject,
  onManageProjects,
}: TitleBarProps) {
  return (
    // data-tauri-drag-region makes the bar background draggable (like grabbing
    // a native titlebar). Tauri checks the mousedown target, so interactive
    // children (pills, buttons) — which are the target, not this div — still
    // register clicks normally without opting out.
    <div
      className={`titlebar ${IS_MAC ? "titlebar-overlay" : ""}`}
      data-tauri-drag-region
    >
      {/* The strip around the pills is draggable too — the pills/badges/close
          are their own click targets, so they still work. */}
      <div className="project-tabs" data-tauri-drag-region>
        {openProjects.map((p) => (
          <div
            key={p.id}
            className={`project-tab ${p.id === activeId ? "project-tab-active" : ""} ${
              p.id === tabDrag.dragId ? "tab-dragging" : ""
            }`}
            {...tabDrag.itemProps(p.id)}
            onClick={() => onSelectProject(p.id)}
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
              title="Close project"
              onClick={(e) => {
                e.stopPropagation();
                onCloseProject(p.id);
              }}
            >
              <CloseIcon size={12} />
            </span>
          </div>
        ))}
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
    </div>
  );
}

export const TitleBar = memo(TitleBarImpl);

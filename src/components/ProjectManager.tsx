// All-projects CRUD in one place, reachable any time from the titlebar —
// create, open, edit, delete. Before this, delete only existed on the Welcome
// screen, which disappears the moment any project is open.
import type { Project } from "../projects";
import { useEscape } from "../useEscape";

interface ProjectManagerProps {
  projects: Project[];
  openIds: string[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onEdit: (project: Project) => void;
  /** Ask to delete — the confirm dialog lives in App so Welcome shares it. */
  onRequestDelete: (project: Project) => void;
  onClose: () => void;
}

export function ProjectManager({
  projects,
  openIds,
  onOpen,
  onNew,
  onEdit,
  onRequestDelete,
  onClose,
}: ProjectManagerProps) {
  useEscape(onClose, true);
  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div
        className="confirm project-manager"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="side-panel-head">
          <span>Projects</span>
          <button className="btn btn-accent" onClick={onNew}>
            ＋ New
          </button>
        </div>
        {projects.length === 0 && (
          <p className="confirm-sub">No projects yet — create one.</p>
        )}
        <div className="pm-list">
          {projects.map((p) => {
            const open = openIds.includes(p.id);
            return (
              <div
                key={p.id}
                className="pm-row"
                onClick={() => {
                  onOpen(p.id);
                  onClose();
                }}
                title={p.components.map((c) => c.path).join("\n")}
              >
                <div className="pm-row-main">
                  <span className="pm-row-name">
                    {p.name}
                    {open && <span className="pm-open-badge">open</span>}
                  </span>
                  <span className="pm-row-dirs">
                    {p.components.map((c) => c.label).join(" · ")}
                  </span>
                </div>
                <span className="pm-row-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn-icon"
                    title="Edit project (name, components, run commands)"
                    onClick={() => onEdit(p)}
                  >
                    ⚙
                  </button>
                  <button
                    className="btn-icon btn-danger"
                    title="Delete project — folders on disk are untouched"
                    onClick={() => onRequestDelete(p)}
                  >
                    🗑
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

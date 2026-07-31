// All-projects CRUD in one place, reachable any time from the titlebar —
// create, open, edit, delete. Before this, delete only existed on the Welcome
// screen, which disappears the moment any project is open.
import type { Project } from "../projects";
import { FrostIcon } from "./icons";
import { useEscape } from "../useEscape";
import { Button } from "./ui";

interface ProjectManagerProps {
  projects: Project[];
  openIds: string[];
  /** Projects that are asleep, by id. */
  hibernated: Record<string, unknown>;
  onOpen: (id: string) => void;
  onNew: () => void;
  onEdit: (project: Project) => void;
  /** Put an open project to sleep, or bring a sleeping one back. */
  onHibernate: (id: string) => void;
  onWake: (id: string) => void;
  /** Ask to delete — the confirm dialog lives in App so Welcome shares it. */
  onRequestDelete: (project: Project) => void;
  onClose: () => void;
}

export function ProjectManager({
  projects,
  openIds,
  hibernated,
  onOpen,
  onNew,
  onEdit,
  onHibernate,
  onWake,
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
          <Button variant="accent" onClick={onNew}>
            ＋ New
          </Button>
        </div>
        {projects.length === 0 && (
          <p className="confirm-sub">No projects yet — create one.</p>
        )}
        <div className="pm-list">
          {projects.map((p) => {
            const open = openIds.includes(p.id);
            const asleep = p.id in hibernated;
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
                    {open && !asleep && <span className="pm-open-badge">open</span>}
                    {asleep && (
                      <span className="hib-chip">
                        <FrostIcon size={10} /> hibernating
                      </span>
                    )}
                  </span>
                  <span className="pm-row-dirs">
                    {p.components.map((c) => c.label).join(" · ")}
                  </span>
                </div>
                <span className="pm-row-actions" onClick={(e) => e.stopPropagation()}>
                  {asleep ? (
                    <Button icon
                      title="Wake it — everything it had open comes back"
                      onClick={() => {
                        onOpen(p.id);
                        onWake(p.id);
                        onClose();
                      }}>
                      ☀
                    </Button>
                  ) : (
                    open && (
                      <Button icon
                        title="Hibernate — snapshot everything open and free its terminals"
                        onClick={() => {
                          onHibernate(p.id);
                          onClose();
                        }}>
                        <FrostIcon size={13} />
                      </Button>
                    )
                  )}
                  <Button icon
                    title="Edit project (name, components, run commands)"
                    onClick={() => onEdit(p)}>
                    ⚙
                  </Button>
                  <Button icon variant="danger"
                    title="Delete project — folders on disk are untouched"
                    onClick={() => onRequestDelete(p)}>
                    🗑
                  </Button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

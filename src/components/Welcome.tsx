// Shown when no project is open. Projects are the entry point — no terminal,
// no editor until one is opened.
import type { Project } from "../projects";

interface WelcomeProps {
  projects: Project[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export function Welcome({ projects, onOpen, onNew, onDelete }: WelcomeProps) {
  return (
    <div className="welcome">
      <h1>Canopy</h1>
      <p className="welcome-sub">
        Vibe-coding-first IDE — open a project, get a terminal in it, let your
        agents work, review the diffs.
      </p>
      <button className="btn btn-accent welcome-new" onClick={onNew}>
        ＋ New project
      </button>
      {projects.length > 0 && (
        <div className="welcome-list">
          <div className="side-panel-head">
            <span>Your projects</span>
          </div>
          {projects.map((p) => (
            <div key={p.id} className="welcome-project" onClick={() => onOpen(p.id)}>
              <div className="welcome-project-main">
                <span className="welcome-project-name">{p.name}</span>
                <span className="welcome-project-dirs">
                  {p.components.map((c) => c.label).join(" · ")}
                </span>
              </div>
              <button
                className="btn-icon btn-danger"
                title="Delete project (folders are untouched)"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(p.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

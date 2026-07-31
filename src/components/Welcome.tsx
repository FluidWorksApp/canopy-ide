// Shown when no project is open. Projects are the entry point — no terminal,
// no editor until one is opened.
import { FrostIcon } from "./icons";
import type { Project } from "../projects";
import { Button } from "./ui";

interface WelcomeProps {
  projects: Project[];
  /** Projects that are asleep: opening one lands on the wake screen, with
   *  everything it had open waiting behind it. */
  hibernated: Record<string, unknown>;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export function Welcome({ projects, hibernated, onOpen, onNew, onDelete }: WelcomeProps) {
  return (
    <div className="welcome">
      <h1>Canopy</h1>
      <p className="welcome-sub">
        Vibe-coding-first IDE — open a project, get a terminal in it, let your
        agents work, review the diffs.
      </p>
      <Button variant="accent" className="welcome-new" onClick={onNew}>
        ＋ New project
      </Button>
      {projects.length > 0 && (
        <div className="welcome-list">
          <div className="side-panel-head">
            <span>Your projects</span>
          </div>
          {projects.map((p) => (
            <div key={p.id} className="welcome-project" onClick={() => onOpen(p.id)}>
              <div className="welcome-project-main">
                <span className="welcome-project-name">
                  {p.name}
                  {p.id in hibernated && (
                    <span className="hib-chip" title="Hibernating — opens on its wake screen">
                      <FrostIcon size={10} /> hibernating
                    </span>
                  )}
                </span>
                <span className="welcome-project-dirs">
                  {p.components.map((c) => c.label).join(" · ")}
                </span>
              </div>
              <Button icon variant="danger"
                title="Delete project (folders are untouched)"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(p.id);
                }}>
                ✕
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

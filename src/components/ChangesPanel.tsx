// Session change feed: files modified on disk while the IDE is open —
// the heart of the diff-first workflow.
import type { ChangeEntry } from "../types";

interface ChangesPanelProps {
  changes: ChangeEntry[];
  onOpen: (path: string) => void;
  onClear: () => void;
}

export function ChangesPanel({ changes, onOpen, onClear }: ChangesPanelProps) {
  return (
    <div className="side-panel">
      <div className="side-panel-head">
        <span>{changes.length} changed file{changes.length === 1 ? "" : "s"}</span>
        {changes.length > 0 && (
          <button className="btn-icon" title="Clear list" onClick={onClear}>
            ✕
          </button>
        )}
      </div>
      {changes.length === 0 ? (
        <div className="tree-empty">
          No external changes yet. Run an agent in the terminal — its edits will
          show up here as diffs.
        </div>
      ) : (
        changes.map((c) => (
          <div key={c.path} className="change-row" onClick={() => onOpen(c.path)}>
            <span className={`change-kind change-${c.kind}`}>
              {c.kind === "create" ? "A" : c.kind === "remove" ? "D" : "M"}
            </span>
            <span className="change-name">{c.path.split("/").pop()}</span>
            <span className="change-dir" title={c.path}>
              {c.path.split("/").slice(-3, -1).join("/")}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

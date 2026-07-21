// Session change view: the files git reports as changed, grouped by the
// component they live in. Git is the source of truth — not the raw fs watcher —
// so this list already excludes everything in .gitignore (build output, object
// files, editor temp files) and reflects real staged/unstaged/untracked state.
import type { FileChange } from "../ipc";

export interface ChangeGroup {
  /** Component label this repo is shown under. */
  component: string;
  /** Resolved git top-level for the component. */
  repo: string;
  files: FileChange[];
}

/** A file being edited live by a teammate on a project this app owns. It has
 *  no git presence until saved — that's the whole reason it's listed here. */
export interface CollabChange {
  path: string;
  name: string;
  edited: boolean;
}

interface ChangesPanelProps {
  groups: ChangeGroup[];
  /** Whether a git query is in flight (first paint / manual refresh). */
  loading: boolean;
  onOpen: (path: string) => void;
  onRefresh: () => void;
  /** Files teammates are editing live in a project you're sharing. */
  collab?: CollabChange[];
  onOpenCollab?: (path: string) => void;
  onSaveCollab?: (path: string) => void;
}

const kindClass = (f: FileChange) =>
  f.conflicted ? "conflicted" : f.untracked ? "untracked" : f.staged ? "staged" : "unstaged";

// Two-letter porcelain code -> single badge letter, matching git's own status.
const badge = (f: FileChange) => {
  if (f.conflicted) return "!";
  if (f.untracked) return "A";
  const code = f.status.trim();
  return code[0] === "?" ? "A" : (code[0] ?? "M");
};

export function ChangesPanel({
  groups,
  loading,
  onOpen,
  onRefresh,
  collab,
  onOpenCollab,
  onSaveCollab,
}: ChangesPanelProps) {
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  // Only files with unsaved live edits — a shared-but-untouched file isn't a
  // change worth listing.
  const collabEdited = (collab ?? []).filter((c) => c.edited);
  const shown = total + collabEdited.length;
  return (
    <div className="side-panel">
      <div className="side-panel-head">
        <span>
          {shown} changed file{shown === 1 ? "" : "s"}
        </span>
        <button className="icon-btn" title="Refresh" onClick={onRefresh}>
          ↻
        </button>
      </div>
      {collabEdited.length > 0 && (
        <div className="change-group changes-collab">
          <div className="git-section-head change-group-head">
            Collaboration — unsaved ({collabEdited.length})
          </div>
          {collabEdited.map((c) => (
            <div
              key={c.path}
              className="change-row change-collab-row"
              title={`Edited live by a teammate — not yet on disk\n${c.path}`}
              onClick={() => onOpenCollab?.(c.path)}
            >
              <span className="change-kind change-collab-tag">live</span>
              <span className="change-name">{c.name}</span>
              <span className="change-dir">{c.path.split("/").slice(0, -1).join("/")}</span>
              <button
                className="btn-mini change-collab-save"
                title="Write these edits to disk (then git tracks them normally)"
                onClick={(e) => {
                  e.stopPropagation();
                  onSaveCollab?.(c.path);
                }}
              >
                Save
              </button>
            </div>
          ))}
        </div>
      )}
      {total === 0 && collabEdited.length === 0 ? (
        <div className="tree-empty">
          {loading
            ? "Checking for changes…"
            : "Working tree clean. Edits made by agents or by you show up here as diffs against HEAD."}
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.repo} className="change-group">
            <div className="git-section-head change-group-head">
              {g.component} ({g.files.length})
            </div>
            {g.files.map((f) => (
              <div
                key={f.path}
                className="change-row"
                title={`${f.status.trim() || "??"} ${f.path}`}
                onClick={() => onOpen(f.abs)}
              >
                <span className={`change-kind change-${kindClass(f)}`}>{badge(f)}</span>
                <span className="change-name">{f.path.split("/").pop()}</span>
                <span className="change-dir">{f.path.split("/").slice(0, -1).join("/")}</span>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

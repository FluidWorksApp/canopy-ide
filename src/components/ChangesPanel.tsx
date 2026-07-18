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

interface ChangesPanelProps {
  groups: ChangeGroup[];
  /** Whether a git query is in flight (first paint / manual refresh). */
  loading: boolean;
  onOpen: (path: string) => void;
  onRefresh: () => void;
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

export function ChangesPanel({ groups, loading, onOpen, onRefresh }: ChangesPanelProps) {
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  return (
    <div className="side-panel">
      <div className="side-panel-head">
        <span>
          {total} changed file{total === 1 ? "" : "s"}
        </span>
        <button className="icon-btn" title="Refresh" onClick={onRefresh}>
          ↻
        </button>
      </div>
      {total === 0 ? (
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

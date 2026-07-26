// Session change view: the files git reports as changed, grouped by the
// component they live in. Git is the source of truth — not the raw fs watcher —
// so this list already excludes everything in .gitignore (build output, object
// files, editor temp files) and reflects real staged/unstaged/untracked state.
import { useState, type ReactNode } from "react";
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
  /** "Ask an agent about these changes" control, shown when the tree isn't clean. */
  agentBar?: ReactNode;
  /** Stage or unstage one file. Given together with `onCommit`, the list stops
   *  being a read-only view and becomes the place you actually commit from. */
  onStage?: (repo: string, paths: string[]) => void;
  onUnstage?: (repo: string, paths: string[]) => void;
  /** Commit what's staged in one repo. Resolves so the box can clear itself. */
  onCommit?: (repo: string, message: string) => Promise<unknown>;
}

/** Staged / not-yet-staged within one repo group. Conflicted files are neither:
 *  they have to be resolved before they can be committed at all. */
const stagedIn = (g: ChangeGroup) => g.files.filter((f) => f.staged && !f.conflicted).length;
const unstagedIn = (g: ChangeGroup) => g.files.filter((f) => !f.staged && !f.conflicted);

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
  agentBar,
  onStage,
  onUnstage,
  onCommit,
}: ChangesPanelProps) {
  /** One message per repo: a project with two components has two working trees
   *  and two commits to write, and sharing one box between them would put the
   *  wrong message on whichever you pressed second. */
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [committing, setCommitting] = useState<string | null>(null);
  const setMessage = (repo: string, text: string) =>
    setMessages((m) => ({ ...m, [repo]: text }));
  const commit = (repo: string) => {
    const text = (messages[repo] ?? "").trim();
    if (!text || !onCommit) return;
    setCommitting(repo);
    void Promise.resolve(onCommit(repo, text))
      .then(() => setMessage(repo, ""))
      .finally(() => setCommitting(null));
  };
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
      {total > 0 && agentBar}
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
            {/* Commit lives with the files it commits. This is the only commit
                box in the app now — the Git panel's copy of this list is gone,
                and a list you can't act on is a list you have to leave. */}
            {onCommit && (
              <div className="git-commit-box change-commit-box">
                <textarea
                  className="git-commit-msg"
                  rows={2}
                  placeholder={
                    stagedIn(g) > 0
                      ? `Commit message (${stagedIn(g)} staged)`
                      : "Stage files to commit"
                  }
                  value={messages[g.repo] ?? ""}
                  onChange={(e) => setMessage(g.repo, e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && stagedIn(g) > 0)
                      commit(g.repo);
                  }}
                />
                <div className="git-commit-actions">
                  <button
                    className="btn btn-accent"
                    disabled={
                      stagedIn(g) === 0 ||
                      !(messages[g.repo] ?? "").trim() ||
                      committing === g.repo
                    }
                    title="Commit staged changes (Cmd+Enter)"
                    onClick={() => commit(g.repo)}
                  >
                    Commit {stagedIn(g) > 0 ? stagedIn(g) : ""}
                  </button>
                  {unstagedIn(g).length > 0 && onStage && (
                    <button
                      className="btn-mini"
                      onClick={() => onStage(g.repo, unstagedIn(g).map((f) => f.path))}
                    >
                      Stage all
                    </button>
                  )}
                  {stagedIn(g) > 0 && onUnstage && (
                    <button
                      className="btn-mini"
                      onClick={() =>
                        onUnstage(
                          g.repo,
                          g.files.filter((f) => f.staged).map((f) => f.path),
                        )
                      }
                    >
                      Unstage all
                    </button>
                  )}
                </div>
              </div>
            )}
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
                {(onStage || onUnstage) && !f.conflicted && (
                  <button
                    className="btn-mini change-stage"
                    title={f.staged ? "Unstage this file" : "Stage this file"}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (f.staged) onUnstage?.(g.repo, [f.path]);
                      else onStage?.(g.repo, [f.path]);
                    }}
                  >
                    {f.staged ? "−" : "+"}
                  </button>
                )}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

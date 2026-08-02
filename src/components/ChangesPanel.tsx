// Session change view: the files git reports as changed, grouped by the
// component they live in. Git is the source of truth — not the raw fs watcher —
// so this list already excludes everything in .gitignore (build output, object
// files, editor temp files) and reflects real staged/unstaged/untracked state.
import { useState, type ReactNode } from "react";
import type { FileChange } from "../ipc";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { Dialog } from "./Dialog";
import { WindowedList } from "./WindowedList";
import { Button } from "./ui";
import { matches, withShortcut } from "../shortcuts";
import { basename } from "../paths";

/** Must match .change-row's CSS height — the windowing spacers are the scrollbar. */
const ROW_H = 26;

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
  /** Throw one file's changes away — restored from HEAD, or deleted when it's
   *  untracked. The panel confirms first; this is called on yes. */
  onDiscard?: (repo: string, file: FileChange) => void;
}

/** Staged / not-yet-staged within one repo group. Conflicted files are neither:
 *  they have to be resolved before they can be committed at all. */
const stagedIn = (g: ChangeGroup) =>
  g.files.filter((f) => f.staged && !f.conflicted).length;
const unstagedIn = (g: ChangeGroup) =>
  g.files.filter((f) => !f.staged && !f.conflicted);

const kindClass = (f: FileChange) =>
  f.conflicted
    ? "conflicted"
    : f.untracked
      ? "untracked"
      : f.staged
        ? "staged"
        : "unstaged";

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
  onDiscard,
}: ChangesPanelProps) {
  /** One message per repo: a project with two components has two working trees
   *  and two commits to write, and sharing one box between them would put the
   *  wrong message on whichever you pressed second. */
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [committing, setCommitting] = useState<string | null>(null);
  const menu = useContextMenu();
  /** The file whose discard is waiting on a yes. Throwing work away is the one
   *  thing in this panel that can't be undone — an untracked file isn't even in
   *  git's reflog — so it asks first, every time. */
  const [discarding, setDiscarding] = useState<{
    repo: string;
    file: FileChange;
  } | null>(null);
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
  /** Everything you can do to one file, in one place. The row already opens the
   *  diff on click and stages on hover; the menu is where the rest of it lives —
   *  including Discard, which has nowhere else it could sensibly go. */
  const rowMenu = (g: ChangeGroup, f: FileChange): MenuItem[] => {
    const items: MenuItem[] = [
      { label: "Open diff", onClick: () => onOpen(f.abs) },
      {
        label: "Copy path",
        onClick: () => void navigator.clipboard.writeText(f.abs),
      },
    ];
    if (!f.conflicted && (onStage || onUnstage))
      items.push(
        { separator: true },
        f.staged
          ? { label: "Unstage", onClick: () => onUnstage?.(g.repo, [f.path]) }
          : { label: "Stage", onClick: () => onStage?.(g.repo, [f.path]) },
      );
    if (onDiscard)
      items.push(
        { separator: true },
        {
          label: f.untracked ? "Delete this file" : "Discard changes",
          danger: true,
          onClick: () => setDiscarding({ repo: g.repo, file: f }),
        },
      );
    return items;
  };

  const total = groups.reduce((n, g) => n + g.files.length, 0);
  // Only files with unsaved live edits — a shared-but-untouched file isn't a
  // change worth listing.
  const collabEdited = (collab ?? []).filter((c) => c.edited);
  const shown = total + collabEdited.length;
  return (
    <div className="side-panel">
      {menu.menu && (
        <ContextMenu
          x={menu.menu.x}
          y={menu.menu.y}
          items={menu.menu.items}
          onClose={menu.close}
        />
      )}
      {discarding && (
        <Dialog
          variant="danger"
          title={`${discarding.file.untracked ? "Delete" : "Discard changes to"} ${basename(discarding.file.path)}?`}
          body={
            discarding.file.untracked
              ? "This file isn't in git yet, so deleting it is the only way to discard it — and nothing can bring it back."
              : "The file goes back to what HEAD has, staged or not. This can't be undone."
          }
          meta={discarding.file.path}
          dismissLabel="Cancel"
          onDismiss={() => setDiscarding(null)}
          actions={[
            {
              label: discarding.file.untracked ? "Delete" : "Discard",
              primary: true,
              onClick: () => {
                onDiscard?.(discarding.repo, discarding.file);
                setDiscarding(null);
              },
            },
          ]}
        />
      )}
      <div className="side-panel-head">
        <span>
          {shown} changed file{shown === 1 ? "" : "s"}
        </span>
        <Button icon title="Refresh" onClick={onRefresh}>
          ↻
        </Button>
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
              <span className="change-dir">
                {c.path.split("/").slice(0, -1).join("/")}
              </span>
              <Button size="sm" className="change-collab-save"
                title="Write these edits to disk (then git tracks them normally)"
                onClick={(e) => {
                  e.stopPropagation();
                  onSaveCollab?.(c.path);
                }}>
                Save
              </Button>
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
                    if (matches(e, "submit") && stagedIn(g) > 0)
                      commit(g.repo);
                  }}
                />
                <div className="git-commit-actions">
                  <Button variant="accent"
                    disabled={
                      stagedIn(g) === 0 ||
                      !(messages[g.repo] ?? "").trim() ||
                      committing === g.repo
                    }
                    title={withShortcut("Commit staged changes", "submit")}
                    onClick={() => commit(g.repo)}>
                    Commit {stagedIn(g) > 0 ? stagedIn(g) : ""}
                  </Button>
                  {unstagedIn(g).length > 0 && onStage && (
                    <Button size="sm"
                      onClick={() =>
                        onStage(
                          g.repo,
                          unstagedIn(g).map((f) => f.path),
                        )
                      }>
                      Stage all
                    </Button>
                  )}
                  {stagedIn(g) > 0 && onUnstage && (
                    <Button size="sm"
                      onClick={() =>
                        onUnstage(
                          g.repo,
                          g.files.filter((f) => f.staged).map((f) => f.path),
                        )
                      }>
                      Unstage all
                    </Button>
                  )}
                </div>
              </div>
            )}
            {/* Windowed: a rebase or generated-file churn can put thousands of
                files here, and only the ones near the viewport need to exist. */}
            <WindowedList
              items={g.files}
              rowHeight={ROW_H}
              renderRow={(f) => (
                <div
                  key={f.path}
                  className="change-row"
                  title={`${f.status.trim() || "??"} ${f.path}`}
                  onClick={() => onOpen(f.abs)}
                  onContextMenu={(e) => menu.open(e, rowMenu(g, f))}
                >
                  <span className={`change-kind change-${kindClass(f)}`}>
                    {badge(f)}
                  </span>
                  <span className="change-name">{basename(f.path)}</span>
                  <span className="change-dir">
                    {f.path.split("/").slice(0, -1).join("/")}
                  </span>
                  {(onStage || onUnstage) && !f.conflicted && (
                    <Button size="sm" className="change-stage"
                      title={f.staged ? "Unstage this file" : "Stage this file"}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (f.staged) onUnstage?.(g.repo, [f.path]);
                        else onStage?.(g.repo, [f.path]);
                      }}>
                      {f.staged ? "−" : "+"}
                    </Button>
                  )}
                </div>
              )}
            />
          </div>
        ))
      )}
    </div>
  );
}

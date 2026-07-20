// A branch opened as a tab: everything an agent left in it, in one place.
// Uncommitted work first (it exists nowhere else), then the commits it has
// that the base branch doesn't, then the cumulative diff. Each commit row
// opens the commit tab — the same one History opens, not a second renderer.
import { useCallback, useEffect, useState } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import * as ipc from "../ipc";
import type { Notify, RelayHandle } from "../types";
import { splitPatch } from "./PrView";
import { GitBranchIcon } from "./icons";

interface BranchViewProps {
  repo: string;
  branch: ipc.BranchWork;
  onOpenCommit: (
    repo: string,
    commit: { hash: string; short: string; subject: string },
  ) => void;
  onOpenTerminal: (cwd: string, label: string) => void;
  onNotice: Notify;
  /** When connected to a relay, a branch can be sent to a teammate for review
   *  — the diff travels with the request, so they needn't have the code. */
  relay?: RelayHandle;
}

type Pane = "uncommitted" | "diff";

export function BranchView({
  repo,
  branch,
  onOpenCommit,
  onOpenTerminal,
  onNotice,
  relay,
}: BranchViewProps) {
  const [commits, setCommits] = useState<ipc.CommitInfo[] | null>(null);
  // Which patch is on screen. Defaults to uncommitted work when there is any,
  // because that's the part that exists nowhere else.
  const [pane, setPane] = useState<Pane>(branch.dirty > 0 ? "uncommitted" : "diff");
  const [patch, setPatch] = useState<ipc.CommitPatch | null>(null);
  const [split, setSplit] = useState(true);
  const [remote, setRemote] = useState("");
  const [askReview, setAskReview] = useState(false);

  const teammates =
    relay && relay.status.role !== "off"
      ? relay.status.members.filter((m) => m.id !== relay.status.self_id)
      : [];

  /** Send this branch's cumulative diff to a teammate as a review request. The
   *  full branch patch (vs base) goes over the encrypted channel, so they can
   *  review a branch they don't have — and a truncated one says so. */
  const sendForReview = async (memberId: string, memberName: string) => {
    setAskReview(false);
    try {
      const p = await ipc.gitBranchPatch(repo, branch.branch, branch.worktree, false);
      await relay!.sendCommand(memberId, "review", {
        title: branch.branch,
        branch: branch.branch,
        insertions: p.insertions,
        deletions: p.deletions,
        truncated: p.truncated,
        patch: p.patch,
      });
      onNotice(`Sent ${branch.branch} to ${memberName} for review.`, "success");
    } catch (err) {
      onNotice(String(err), "error");
    }
  };

  useEffect(() => {
    let live = true;
    void ipc
      .gitRemoteUrl(repo)
      .then((u) => live && setRemote(u))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [repo]);

  // Metadata first (one `git log`, instant); the patch is fetched per pane so
  // the heavy call only runs for the view actually being looked at.
  useEffect(() => {
    let live = true;
    setCommits(null);
    void ipc
      .gitBranchCommits(repo, branch.branch)
      .then((c) => live && setCommits(c))
      .catch((e) => live && onNotice(String(e), "error"));
    return () => {
      live = false;
    };
  }, [repo, branch.branch, onNotice]);

  const loadPatch = useCallback(() => {
    let live = true;
    setPatch(null);
    void ipc
      .gitBranchPatch(repo, branch.branch, branch.worktree, pane === "uncommitted")
      .then((p) => live && setPatch(p))
      .catch((e) => live && onNotice(String(e), "error"));
    return () => {
      live = false;
    };
  }, [repo, branch.branch, branch.worktree, pane, onNotice]);

  useEffect(() => loadPatch(), [loadPatch]);

  const files = patch?.patch ? splitPatch(patch.patch) : [];

  return (
    <div className="ticket-view">
      <div className="ticket-view-head">
        <div className="ticket-view-title">
          <GitBranchIcon size={15} className="ticket-view-mark" />
          <span>{branch.branch}</span>
        </div>
        <div className="ticket-view-meta">
          {branch.dirty > 0 && (
            <span className="loose-dirty">±{branch.dirty} uncommitted</span>
          )}
          {branch.ahead > 0 && <span className="loose-ahead">↑{branch.ahead} unpushed</span>}
          {branch.merged && <span className="loose-chip">merged</span>}
          {branch.upstream_gone && <span className="loose-chip">remote gone</span>}
          {!branch.upstream && !branch.upstream_gone && (
            <span className="loose-chip">local only</span>
          )}
          <span className="ticket-view-chip" title={branch.worktree ?? "no worktree"}>
            {branch.worktree
              ? branch.worktree.split("/").pop()
              : "no worktree"}
          </span>
          <span className="status-spacer" />
          {teammates.length > 0 && (
            <div className="review-send">
              <button
                className="btn"
                title="Send this branch's diff to a teammate for review"
                onClick={() => setAskReview((v) => !v)}
              >
                Request review ▾
              </button>
              {askReview && (
                <div className="cli-menu review-menu" onMouseLeave={() => setAskReview(false)}>
                  {teammates.map((m) => (
                    <button
                      key={m.id}
                      className="cli-menu-item"
                      onClick={() => void sendForReview(m.id, m.name)}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {remote && (
            <>
              <a className="btn" href={`${remote}/tree/${branch.branch}`}>
                Open on remote
              </a>
              {!branch.merged && (
                <a
                  className="btn"
                  href={`${remote}/compare/${branch.branch}?expand=1`}
                  title="Open a pull request for this branch"
                >
                  Open PR
                </a>
              )}
            </>
          )}
          {branch.worktree && !branch.prunable && (
            <button
              className="btn"
              onClick={() => onOpenTerminal(branch.worktree as string, branch.branch)}
            >
              Open terminal here
            </button>
          )}
        </div>
      </div>

      <div className="branch-panes">
        <button
          className={`btn-mini ${pane === "uncommitted" ? "btn-accent" : ""}`}
          onClick={() => setPane("uncommitted")}
        >
          Uncommitted{branch.dirty > 0 ? ` (${branch.dirty})` : ""}
        </button>
        <button
          className={`btn-mini ${pane === "diff" ? "btn-accent" : ""}`}
          onClick={() => setPane("diff")}
        >
          All changes vs base
        </button>
        {patch && files.length > 0 && (
          <>
            <span className="loose-ahead">+{patch.insertions}</span>
            <span className="loose-dirty">−{patch.deletions}</span>
            <span className="git-spacer" />
            <button className="btn-mini" onClick={() => setSplit((v) => !v)}>
              {split ? "Unified" : "Split"}
            </button>
          </>
        )}
      </div>

      <div className="ticket-view-body branch-body">
        {/* Commits are metadata — always listed, no patch cost. Clicking one
            hands off to the commit tab. */}
        {commits && commits.length > 0 && (
          <div className="branch-commits">
            <div className="ticket-state-head">
              Commits not in base
              <span className="badge">{commits.length}</span>
            </div>
            {commits.map((c) => (
              <div
                key={c.hash}
                className="git-commit-row git-commit-row-click"
                title={`${c.hash}\n${c.author} · ${c.date}\n\nClick to open this commit`}
                onClick={() =>
                  onOpenCommit(repo, { hash: c.hash, short: c.short, subject: c.subject })
                }
              >
                <span className="git-commit-hash">{c.short}</span>
                <span className="git-commit-subject">{c.subject}</span>
                <span className="git-commit-meta">{c.date}</span>
              </div>
            ))}
          </div>
        )}

        {!patch ? (
          <div className="tree-empty">Loading diff…</div>
        ) : files.length === 0 ? (
          <div className="tree-empty">
            {pane === "uncommitted"
              ? "No uncommitted changes in this worktree."
              : "No differences from the base branch."}
          </div>
        ) : (
          files.map((f) => (
            <div key={f.path} className="pr-file">
              <div className="pr-file-name">{f.path}</div>
              <DiffView
                data={{
                  hunks: [f.patch],
                  oldFile: { fileName: f.path },
                  newFile: { fileName: f.path },
                }}
                diffViewMode={split ? DiffModeEnum.Split : DiffModeEnum.Unified}
                diffViewHighlight
                diffViewTheme="dark"
                diffViewWrap
                diffViewAddWidget={false}
                diffViewFontSize={12}
              />
            </div>
          ))
        )}
        {patch?.truncated && (
          <div className="tree-empty">
            Diff truncated at 2 MB — use <code>git diff</code> for the whole thing.
          </div>
        )}
      </div>
    </div>
  );
}

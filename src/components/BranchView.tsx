// A branch opened as a tab: everything an agent left in it, in one place.
// Uncommitted work first (it exists nowhere else), then the commits it has
// that the base branch doesn't, then the cumulative diff. Each commit row
// opens the commit tab — the same one History opens, not a second renderer.
import { useDiffData } from "../diffData";
import { useCallback, useEffect, useState } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import * as ipc from "../ipc";
import type { Notify, RelayHandle } from "../types";
import { askDialog, heldBadge } from "../branchSwitch";
import { useBranchSwitch } from "../useBranchSwitch";
import { splitPatch } from "./PrView";
import { GitBranchIcon } from "./icons";
import { raisePrTask, type MicroTaskDef, type RaisePrPayload } from "../microTasks";
import { MicroTaskButton } from "./MicroTaskButton";
import { Button } from "./ui";

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
  /** Launch a one-shot micro-task agent ("Raise PR"). Always offered — with no
   *  agent CLI installed the launcher explains instead of launching, and the
   *  compare-link path below still works regardless. */
  onMicroTask?: (task: MicroTaskDef<RaisePrPayload>, payload: RaisePrPayload, query: string) => void;
}

type Pane = "uncommitted" | "diff";

export function BranchView({
  repo,
  branch,
  onOpenCommit,
  onOpenTerminal,
  onNotice,
  relay,
  onMicroTask,
}: BranchViewProps) {
  // Stable diff `data` identities; see diffData.ts.
  const dataFor = useDiffData();
  const [commits, setCommits] = useState<ipc.CommitInfo[] | null>(null);
  // Which patch is on screen. Defaults to uncommitted work when there is any,
  // because that's the part that exists nowhere else.
  const [pane, setPane] = useState<Pane>(branch.dirty > 0 ? "uncommitted" : "diff");
  const [patch, setPatch] = useState<ipc.CommitPatch | null>(null);
  const [split, setSplit] = useState(true);
  const [remote, setRemote] = useState("");
  const [askReview, setAskReview] = useState(false);
  // Bumped by the "Try again" any failed read offers. A dialog that only says
  // what went wrong is a dead end; this is what makes its way out real.
  const [retry, setRetry] = useState(0);
  const { switchTo, openThere, ask } = useBranchSwitch();

  const teammates =
    relay && relay.status.role !== "off"
      ? relay.status.members.filter((m) => m.id !== relay.status.self_id)
      : [];

  /** Send this branch's cumulative diff to a teammate as a review request. The
   *  full branch patch (vs base) goes over the encrypted channel, so they can
   *  review a branch they don't have — and a truncated one says so. */
  const sendForReview = async (
    memberId: string,
    memberName: string,
  ): Promise<void> => {
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
      const again = await ask(
        askDialog({
          title: `Couldn't send ${branch.branch} to ${memberName}`,
          body: "The diff didn't make it over. Nothing on your side changed — the branch is exactly as it was.",
          detail: String(err),
          choices: [
            { action: "retry", label: "Try again", recommended: true },
            { action: "cancel", label: "Leave it for now" },
          ],
        }),
      );
      if (again === "retry") await sendForReview(memberId, memberName);
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
      .catch(async (e) => {
        if (!live) return;
        const again = await ask(
          askDialog({
            title: `Couldn't read what's on ${branch.branch}`,
            body: "Git wouldn't list this branch's commits. Nothing has changed — this is only what we can show you.",
            detail: String(e),
            choices: [
              { action: "retry", label: "Try again", recommended: true },
              { action: "cancel", label: "Leave it for now" },
            ],
          }),
        );
        if (again === "retry") setRetry((n) => n + 1);
      });
    return () => {
      live = false;
    };
  }, [repo, branch.branch, retry, ask]);

  const loadPatch = useCallback(() => {
    let live = true;
    setPatch(null);
    void ipc
      .gitBranchPatch(repo, branch.branch, branch.worktree, pane === "uncommitted")
      .then((p) => live && setPatch(p))
      .catch(async (e) => {
        if (!live) return;
        const again = await ask(
          askDialog({
            title: "Couldn't read this diff",
            body:
              pane === "uncommitted"
                ? "Git wouldn't show the uncommitted changes here. Nothing has been touched."
                : `Git wouldn't compare ${branch.branch} against the base branch. Nothing has been touched.`,
            detail: String(e),
            choices: [
              { action: "retry", label: "Try again", recommended: true },
              { action: "cancel", label: "Leave it for now" },
            ],
          }),
        );
        if (again === "retry") setRetry((n) => n + 1);
      });
    return () => {
      live = false;
    };
  }, [repo, branch.branch, branch.worktree, pane, retry, ask]);

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
          {/* Where this branch lives, in the words the switch dialog uses —
              the same badge the branch rows carry, so the tab and the list
              can't describe the same state two different ways. */}
          <span
            className="ticket-view-chip"
            title={branch.worktree ?? "Nothing has this branch open right now."}
          >
            {branch.worktree ? heldBadge(branch).label : "not open anywhere"}
          </span>
          <span className="status-spacer" />
          {/* Acting on the branch you are reading about. This whole tab could
              show you a branch and then make you go back to the Git panel to
              do anything with it. Every route below is the one funnel, so a
              branch another workspace is holding asks its question here too. */}
          {branch.current ? (
            <span className="loose-chip">you're on it</span>
          ) : (
            <Button
              title={`Open ${branch.branch} in this project's own checkout`}
              onClick={() =>
                void switchTo(repo, { kind: "branch", branch: branch.branch })
              }>
              Switch to this branch
            </Button>
          )}
          {/* Only for a workspace that is somewhere else and still there:
              pointing the project at its own checkout is a no-op, and at a
              folder that has gone is a lie. */}
          {branch.worktree && !branch.is_main && !branch.prunable && (
            <Button
              title={`Point this project's files at ${branch.worktree}. Nothing moves, nothing is lost.`}
              onClick={() =>
                void openThere(repo, branch.worktree as string, branch.branch)
              }>
              Open it there
            </Button>
          )}
          {!branch.current && (
            <Button
              title="Look around this branch without moving anything. Your next switch puts everything back."
              onClick={() =>
                void switchTo(repo, {
                  kind: "ref",
                  ref: branch.branch,
                  label: branch.branch,
                })
              }>
              Test a snapshot
            </Button>
          )}
          {teammates.length > 0 && (
            <div className="review-send">
              <Button
                title="Send this branch's diff to a teammate for review"
                onClick={() => setAskReview((v) => !v)}>
                Request review ▾
              </Button>
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
          {!branch.merged && onMicroTask && (
            <MicroTaskButton
              task={raisePrTask}
              payload={{
                repo,
                branch: branch.branch,
                worktree: branch.worktree,
                unpushed: !branch.upstream || branch.ahead > 0,
              }}
              title="Have an agent push this branch and open the pull request"
              onLaunch={onMicroTask}
            />
          )}
          {branch.worktree && !branch.prunable && (
            <Button
              onClick={() => onOpenTerminal(branch.worktree as string, branch.branch)}>
              Open terminal here
            </Button>
          )}
        </div>
      </div>

      <div className="branch-panes">
        <Button
          size="sm"
          variant={pane === "uncommitted" ? "accent" : "default"}
          onClick={() => setPane("uncommitted")}
        >
          Uncommitted{branch.dirty > 0 ? ` (${branch.dirty})` : ""}
        </Button>
        <Button
          size="sm"
          variant={pane === "diff" ? "accent" : "default"}
          onClick={() => setPane("diff")}
        >
          All changes vs base
        </Button>
        {patch && files.length > 0 && (
          <>
            <span className="loose-ahead">+{patch.insertions}</span>
            <span className="loose-dirty">−{patch.deletions}</span>
            <span className="git-spacer" />
            <Button size="sm" onClick={() => setSplit((v) => !v)}>
              {split ? "Unified" : "Split"}
            </Button>
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
                data={dataFor(f)}
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

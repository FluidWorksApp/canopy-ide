// A review request received over the relay, opened as a tab. Unlike CommitView
// or BranchView it fetches nothing — the diff travelled over the encrypted
// channel inside the request, so a teammate can review a branch they don't have
// checked out (or a repo they don't have at all). Same diff widget as commits
// and PRs; only the source differs.
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { PatchFileList } from "./PatchFileList";
import { splitPatch } from "./PrView";
import { Button } from "./ui";

/** What a "review" relay command carries — the diff plus enough context to
 *  read it. The patch is capped on the sender's side (see git_branch_patch). */
export interface ReviewPayload {
  title: string;
  branch: string;
  from: string;
  insertions: number;
  deletions: number;
  truncated: boolean;
  patch: string;
}

export function ReviewView({
  review,
  agentBar,
}: {
  review: ReviewPayload;
  /** "Ask an agent to review this" control. */
  agentBar?: ReactNode;
}) {
  const [split, setSplit] = useState(true);
  const files = useMemo(
    () => (review.patch ? splitPatch(review.patch) : []),
    [review.patch],
  );
  return (
    <div className="commit-view">
      <div className="commit-head">
        <div className="commit-subject">{review.title}</div>
        <div className="commit-meta">
          <span>from {review.from}</span>
          <code className="commit-hash" title={review.branch}>
            {review.branch}
          </code>
          <span className="commit-stat commit-add">+{review.insertions}</span>
          <span className="commit-stat commit-del">−{review.deletions}</span>
          <span className="git-spacer" />
          {files.length > 0 && (
            <Button size="sm" onClick={() => setSplit((v) => !v)}>
              {split ? "Unified" : "Split"}
            </Button>
          )}
        </div>
        {agentBar}
      </div>
      <div className="commit-files">
        {files.length === 0 ? (
          <div className="tree-empty">This review request carried no changes.</div>
        ) : (
          <PatchFileList files={files} split={split} />
        )}
        {review.truncated && (
          <div className="tree-empty">
            Diff truncated — this review is larger than 2 MB. Ask for a PR link
            for the whole thing.
          </div>
        )}
      </div>
    </div>
  );
}

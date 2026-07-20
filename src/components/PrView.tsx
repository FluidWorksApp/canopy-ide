// A pull request opened as a tab: description, the full patch, and review
// actions. The patch is rendered by @git-diff-view/react — a unified patch
// can't be re-expanded into whole files, so Monaco's DiffEditor (which needs
// both sides in full) structurally can't render one.
import { useEffect, useState } from "react";
import { useEscape } from "../useEscape";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import * as ipc from "../ipc";
import type { Notify, RelayHandle } from "../types";
import { TeamIcon } from "./icons";
// NB: PR diffs arrive as real patches from `gh pr diff`, so they go straight
// into the renderer. Working-tree diffs (components/DiffView.tsx) have to build
// their patch first — see the note there about Monaco's diff not computing.

interface PrViewProps {
  repo: string;
  pr: ipc.PrInfo;
  onNotice: Notify;
  /** Team relay, when connected: "ask a teammate to review" lives here. */
  relay?: RelayHandle;
}

type Review = "approve" | "request-changes" | "comment";

const REVIEW_LABEL: Record<Review, string> = {
  approve: "Approve",
  "request-changes": "Request changes",
  comment: "Comment",
};

export function PrView({ repo, pr, onNotice, relay }: PrViewProps) {
  const [patch, setPatch] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [split, setSplit] = useState(true);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Review | null>(null);
  useEscape(() => setConfirm(null), confirm != null);
  const [done, setDone] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);

  // Teammates a review request can go to (everyone but us).
  const teammates =
    relay && relay.status.role !== "off"
      ? relay.status.members.filter((m) => m.id !== relay.status.self_id)
      : [];

  /** Send the PR to a teammate over the relay; their Canopy opens it natively
   *  by matching this repo's origin URL against their local checkouts. */
  const requestReview = async (memberId: string, memberName: string) => {
    setAskOpen(false);
    try {
      const remote = await ipc.gitRemoteUrl(repo);
      if (!remote) {
        onNotice("This repo has no shareable origin URL.", "error");
        return;
      }
      await relay!.sendCommand(memberId, "open-pr", { repo: remote, pr });
      onNotice(`Asked ${memberName} to review #${pr.number}.`, "success");
    } catch (err) {
      onNotice(String(err), "error");
    }
  };

  useEffect(() => {
    let live = true;
    setPatch(null);
    setError(null);
    void ipc
      .ghPrDiff(repo, pr.number)
      .then((d) => live && setPatch(d))
      .catch((e) => live && setError(String(e)));
    void ipc
      .ghPrBody(repo, pr.number)
      .then((b) => live && setBody(b))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [repo, pr.number]);

  const submit = async (action: Review) => {
    setBusy(true);
    try {
      const msg = await ipc.ghPrReview(repo, pr.number, action, comment || undefined);
      setDone(msg);
      onNotice(msg);
      setComment("");
    } catch (err) {
      onNotice(String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  // The patch is one blob covering many files; split it per file so each gets
  // its own diff widget with a header.
  const files = patch ? splitPatch(patch) : [];

  return (
    <div className="pr-view">
      <div className="pr-head">
        <div className="pr-title">
          <span className="pr-num">#{pr.number}</span>
          {pr.title}
        </div>
        <div className="pr-sub">
          <span>
            {pr.author} wants to merge <code>{pr.branch}</code> → <code>{pr.base}</code>
          </span>
          <span className="pr-stat pr-add">+{pr.additions}</span>
          <span className="pr-stat pr-del">−{pr.deletions}</span>
          {pr.review_decision && <span className="pr-decision">{pr.review_decision.toLowerCase().replace("_", " ")}</span>}
          <span className="git-spacer" />
          <button className="btn-mini" onClick={() => setSplit((v) => !v)}>
            {split ? "Unified" : "Split"}
          </button>
          <button
            className="btn-mini"
            title="Check this PR out locally (git switches branch)"
            onClick={() =>
              void ipc
                .ghPrCheckout(repo, pr.number)
                .then(onNotice)
                .catch((e) => onNotice(String(e), "error"))
            }
          >
            Checkout
          </button>
          {teammates.length > 0 && (
            <div className="cli-menu-anchor">
              <button
                className="btn-mini"
                title="Ask a teammate on the relay to review — opens the PR in their Canopy"
                onClick={() => setAskOpen((v) => !v)}
              >
                <TeamIcon size={11} /> Request review ▾
              </button>
              {askOpen && (
                <div className="cli-menu" onMouseLeave={() => setAskOpen(false)}>
                  {teammates.map((m) => (
                    <div
                      key={m.id}
                      className="cli-item"
                      onClick={() => void requestReview(m.id, m.name)}
                    >
                      <span>{m.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="pr-body">
        {body.trim() && <pre className="pr-description">{body.trim()}</pre>}

        {error && <div className="pr-error">{error}</div>}
        {!patch && !error && <div className="pr-loading">Loading diff…</div>}

        {files.map((f) => (
          <div key={f.path} className="pr-file">
            <div className="pr-file-head">{f.path}</div>
            <DiffView
              // Only hunks — a patch has no full file content to give it, which
              // is exactly why Monaco's DiffEditor can't render this. fileName
              // drives syntax highlighting via the extension.
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
        ))}
      </div>

      {/* Review is outward-facing: it posts to a real repo under the user's
          identity and other people see it. Always confirm, never one-click. */}
      <div className="pr-review">
        {done ? (
          <div className="pr-done">{done}</div>
        ) : (
          <>
            <textarea
              className="pr-comment"
              rows={2}
              placeholder="Review comment (required for comment / request changes)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="pr-review-actions">
              {(["approve", "request-changes", "comment"] as Review[]).map((a) => (
                <button
                  key={a}
                  className={`btn ${a === "approve" ? "btn-accent" : ""}`}
                  disabled={busy || (a !== "approve" && !comment.trim())}
                  onClick={() => setConfirm(a)}
                >
                  {REVIEW_LABEL[a]}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {confirm && (
        <div className="confirm-backdrop" onClick={() => setConfirm(null)}>
          <div className="confirm" onClick={(e) => e.stopPropagation()}>
            <p>
              {REVIEW_LABEL[confirm]} <strong>#{pr.number} {pr.title}</strong> as{" "}
              {pr.mine ? "yourself" : "yourself"} on GitHub?
            </p>
            <p className="confirm-sub">
              This posts a public review to the repository and notifies its authors.
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn btn-accent"
                onClick={() => {
                  const a = confirm;
                  setConfirm(null);
                  void submit(a);
                }}
              >
                {REVIEW_LABEL[confirm]}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Split a multi-file unified patch into one patch per file. */
export function splitPatch(patch: string): { path: string; patch: string }[] {
  const out: { path: string; patch: string }[] = [];
  const lines = patch.split("\n");
  let current: { path: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) out.push({ path: current.path, patch: current.lines.join("\n") });
      // "diff --git a/x b/x" — take the b/ side so renames show their new name.
      const m = /diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = { path: m?.[2] ?? line.slice(11), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push({ path: current.path, patch: current.lines.join("\n") });
  return out;
}

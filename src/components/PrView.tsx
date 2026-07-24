// A pull request opened as a tab: description, the full patch, and review
// actions. The patch is rendered by @git-diff-view/react — a unified patch
// can't be re-expanded into whole files, so Monaco's DiffEditor (which needs
// both sides in full) structurally can't render one.
import { useEffect, useMemo, useState } from "react";
import { useEscape } from "../useEscape";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import * as ipc from "../ipc";
import { renderMarkdown } from "../markdown";
import type { Notify, RelayHandle } from "../types";
import { AgentLaunchButton } from "./AgentLaunchButton";
import { TeamIcon } from "./icons";
import type { AgentTarget } from "./TicketsPanel";
// NB: PR diffs arrive as real patches from `gh pr diff`, so they go straight
// into the renderer. Working-tree diffs (components/DiffView.tsx) have to build
// their patch first — see the note there about Monaco's diff not computing.

interface PrViewProps {
  repo: string;
  pr: ipc.PrInfo;
  onNotice: Notify;
  /** Team relay, when connected: "ask a teammate to review" lives here. */
  relay?: RelayHandle;
  /** Agent terminals open in this project — the "send it there" targets. */
  agentTargets: AgentTarget[];
  /** Which agent CLIs are on PATH. */
  installed: Record<string, boolean>;
  /** Check the PR's branch out in a worktree and start an agent reviewing it. */
  onStartReview: (agentId: string) => void;
  /** Hand the review to an already-running agent. */
  onSendToAgent: (target: AgentTarget) => void;
  /** Start an agent resolving the PR's merge conflicts (shown when conflicting). */
  onStartResolve: (agentId: string) => void;
  /** Hand conflict resolution to an already-running agent. */
  onSendResolve: (target: AgentTarget) => void;
}

type Review = "approve" | "request-changes" | "comment";

const REVIEW_LABEL: Record<Review, string> = {
  approve: "Approve",
  "request-changes": "Request changes",
  comment: "Comment",
};

type MergeMethod = "squash" | "merge" | "rebase";

const MERGE_LABEL: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

// Rendering a whole multi-file diff at once — every file's DiffView, syntax-
// highlighted, synchronously — is what froze the tab on a big PR (a lockfile
// churn is tens of thousands of lines). So: parse once, collapse by default on
// large PRs, mount each diff only when expanded, and refuse to inline-render an
// absurdly large file.
const AUTO_EXPAND_TOTAL = 500; // whole-PR changed lines under which we open all
const AUTO_EXPAND_FILE = 200; // biggest file we auto-open individually on a big PR
const AUTO_EXPAND_BUDGET = 1200; // total auto-opened lines on a big PR
const HIGHLIGHT_MAX = 800; // syntax-highlight only files at/under this many lines
const RENDER_CAP = 4000; // never inline-render a file bigger than this

interface FilePatch {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
  changed: number;
  binary: boolean;
}

/** Per-file adds/dels straight off the patch text — cheap, one pass. */
function fileStats(patch: string): Omit<FilePatch, "path" | "patch"> {
  let additions = 0;
  let deletions = 0;
  let binary = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
    else if (line.startsWith("Binary files ")) binary = true;
  }
  return { additions, deletions, changed: additions + deletions, binary };
}

/** Compact relative age for an ISO 8601 timestamp (e.g. gh's createdAt). */
const ago = (iso?: string) => {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

/** Full local date & time for an ISO 8601 timestamp — the exact moment raised. */
const absTime = (iso?: string) => {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleString();
};

export function PrView({
  repo,
  pr,
  onNotice,
  relay,
  agentTargets,
  installed,
  onStartReview,
  onSendToAgent,
  onStartResolve,
  onSendResolve,
}: PrViewProps) {
  const [patch, setPatch] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [split, setSplit] = useState(true);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Review | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeConfirm, setMergeConfirm] = useState<MergeMethod | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [closeDelBranch, setCloseDelBranch] = useState(false);
  useEscape(
    () => {
      setConfirm(null);
      setMergeConfirm(null);
      setCloseConfirm(false);
    },
    confirm != null || mergeConfirm != null || closeConfirm,
  );
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

  const merge = async (method: MergeMethod) => {
    setBusy(true);
    try {
      const msg = await ipc.ghPrMerge(repo, pr.number, method);
      setDone(msg);
      onNotice(msg, "success");
    } catch (err) {
      onNotice(String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const close = async (deleteBranch = false) => {
    setBusy(true);
    try {
      const msg = await ipc.ghPrClose(repo, pr.number, deleteBranch);
      setDone(msg);
      onNotice(msg, "success");
    } catch (err) {
      onNotice(String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const ready = async () => {
    setBusy(true);
    try {
      const msg = await ipc.ghPrReady(repo, pr.number);
      onNotice(msg, "success");
    } catch (err) {
      onNotice(String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  // The patch is one blob covering many files; split it per file (once, not on
  // every keystroke) and tag each with its size.
  const files = useMemo<FilePatch[]>(
    () =>
      patch
        ? splitPatch(patch).map((f) => ({ ...f, ...fileStats(f.patch) }))
        : [],
    [patch],
  );
  const totalChanged = useMemo(
    () => files.reduce((n, f) => n + f.changed, 0),
    [files],
  );
  const totalAdd = useMemo(() => files.reduce((n, f) => n + f.additions, 0), [files]);
  const totalDel = useMemo(() => files.reduce((n, f) => n + f.deletions, 0), [files]);

  // The PR body is markdown (headings, tables, code) — render it, don't dump it
  // as raw text. renderMarkdown sanitizes with DOMPurify, which matters: a PR
  // body is authored by whoever opened it, and raw HTML in the webview reaches
  // every Tauri command. Memoised so it isn't re-parsed on each keystroke.
  const bodyHtml = useMemo(() => (body.trim() ? renderMarkdown(body) : ""), [body]);

  // Which files' diffs are actually mounted. Small PRs open everything (it's
  // cheap and you want to read it all); big PRs open only the small, human
  // files up to a budget and leave lockfile-scale churn collapsed, so the tab
  // paints instantly instead of blocking on a highlight of 28k lines.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!files.length) {
      setExpanded(new Set());
      return;
    }
    if (totalChanged <= AUTO_EXPAND_TOTAL) {
      setExpanded(new Set(files.map((f) => f.path)));
      return;
    }
    const open = new Set<string>();
    let budget = AUTO_EXPAND_BUDGET;
    for (const f of files) {
      if (f.binary || f.changed > AUTO_EXPAND_FILE || budget - f.changed < 0) continue;
      open.add(f.path);
      budget -= f.changed;
    }
    setExpanded(open);
  }, [files, totalChanged]);

  const toggleFile = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const allOpen = files.length > 0 && expanded.size === files.length;

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
          {pr.created && (
            <span className="pr-when" title={absTime(pr.created)}>
              opened {ago(pr.created)}
            </span>
          )}
          <span className="pr-stat pr-add">+{pr.additions}</span>
          <span className="pr-stat pr-del">−{pr.deletions}</span>
          {pr.review_decision && <span className="pr-decision">{pr.review_decision.toLowerCase().replace("_", " ")}</span>}
          {pr.checks && (
            <span
              className={`pr-checks ${pr.checks === "PASS" ? "pr-ok" : pr.checks === "FAIL" ? "pr-bad" : "pr-pending"}`}
              title={pr.checks_summary}
            >
              {pr.checks === "PASS" ? "checks passed" : pr.checks === "FAIL" ? "checks failed" : "checks running"}
            </span>
          )}
          {pr.mergeable === "CONFLICTING" && <span className="pr-checks pr-bad">conflicts</span>}
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
          {/* Hand the PR to an agent — the same block the ticket tab uses:
              checks the branch out in a worktree and starts the agent there.
              When the PR conflicts, the same control instead offers to resolve
              the conflicts (merge base in, fix markers, commit, push). */}
          {pr.mergeable === "CONFLICTING" ? (
            <AgentLaunchButton
              variant="mini"
              label="Resolve conflicts"
              agentTargets={agentTargets}
              installed={installed}
              newAgentLabel={`New agent in ${pr.branch}`}
              onStart={onStartResolve}
              onSend={onSendResolve}
            />
          ) : (
            <AgentLaunchButton
              variant="mini"
              label="Review"
              agentTargets={agentTargets}
              installed={installed}
              newAgentLabel={`New agent in ${pr.branch}`}
              onStart={onStartReview}
              onSend={onSendToAgent}
            />
          )}
          {pr.draft && pr.state === "OPEN" && (
            <button
              className="btn-mini"
              title="Take this PR out of draft so it can be reviewed and merged"
              disabled={busy}
              onClick={() => void ready()}
            >
              Mark ready
            </button>
          )}
          {!pr.draft && pr.state === "OPEN" && (
            <div className="cli-menu-anchor">
              <button
                className={`btn-mini ${pr.review_decision === "APPROVED" && pr.mergeable !== "CONFLICTING" && pr.checks !== "FAIL" ? "btn-accent" : ""}`}
                title="Merge this PR on GitHub"
                disabled={busy}
                onClick={() => setMergeOpen((v) => !v)}
              >
                Merge ▾
              </button>
              {mergeOpen && (
                <div className="cli-menu" onMouseLeave={() => setMergeOpen(false)}>
                  {(["squash", "merge", "rebase"] as MergeMethod[]).map((m) => (
                    <div
                      key={m}
                      className="cli-item"
                      onClick={() => {
                        setMergeOpen(false);
                        setMergeConfirm(m);
                      }}
                    >
                      <span>{MERGE_LABEL[m]}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {pr.state === "OPEN" && (
            <button
              className="btn-mini"
              title="Close this PR without merging"
              disabled={busy}
              onClick={() => setCloseConfirm(true)}
            >
              Close
            </button>
          )}
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
        {bodyHtml && (
          <div
            className="markdown-body pr-description"
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        )}

        {error && <div className="pr-error">{error}</div>}
        {!patch && !error && <div className="pr-loading">Loading diff…</div>}

        {files.length > 0 && (
          <div className="pr-files-bar">
            <span>
              {files.length} file{files.length === 1 ? "" : "s"} changed
              <span className="pr-stat pr-add"> +{totalAdd}</span>
              <span className="pr-stat pr-del"> −{totalDel}</span>
            </span>
            {totalChanged > AUTO_EXPAND_TOTAL && (
              <span className="pr-files-note">large diff — files collapsed for speed</span>
            )}
            <span className="git-spacer" />
            <button
              className="btn-mini"
              onClick={() =>
                setExpanded(allOpen ? new Set() : new Set(files.map((f) => f.path)))
              }
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          </div>
        )}

        {files.map((f) => {
          const open = expanded.has(f.path);
          return (
            <div key={f.path} className="pr-file">
              <div className="pr-file-head" onClick={() => toggleFile(f.path)}>
                <span className="pr-file-chevron">{open ? "▾" : "▸"}</span>
                <span className="pr-file-path" title={f.path}>{f.path}</span>
                {f.binary ? (
                  <span className="pr-file-stat">binary</span>
                ) : (
                  <>
                    <span className="pr-file-stat pr-add">+{f.additions}</span>
                    <span className="pr-file-stat pr-del">−{f.deletions}</span>
                  </>
                )}
              </div>
              {open &&
                (f.binary ? (
                  <div className="pr-file-note">Binary file — not shown.</div>
                ) : f.changed > RENDER_CAP ? (
                  <div className="pr-file-note">
                    {f.changed.toLocaleString()} changed lines — too large to render inline.{" "}
                    <a href={`${pr.url}/files`}>Open on GitHub</a>
                  </div>
                ) : (
                  <DiffView
                    // Only hunks — a patch has no full file content to give it,
                    // which is exactly why Monaco's DiffEditor can't render this.
                    // fileName drives syntax highlighting via the extension.
                    // Highlight is the expensive part, so skip it on big files.
                    data={{
                      hunks: [f.patch],
                      oldFile: { fileName: f.path },
                      newFile: { fileName: f.path },
                    }}
                    diffViewMode={split ? DiffModeEnum.Split : DiffModeEnum.Unified}
                    diffViewHighlight={f.changed <= HIGHLIGHT_MAX}
                    diffViewTheme="dark"
                    diffViewWrap
                    diffViewAddWidget={false}
                    diffViewFontSize={12}
                  />
                ))}
            </div>
          );
        })}
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

      {mergeConfirm && (
        <div className="confirm-backdrop" onClick={() => setMergeConfirm(null)}>
          <div className="confirm" onClick={(e) => e.stopPropagation()}>
            <p>
              {MERGE_LABEL[mergeConfirm]} <strong>#{pr.number} {pr.title}</strong> into{" "}
              <code>{pr.base}</code> on GitHub?
            </p>
            <p className="confirm-sub">
              This lands <code>{pr.branch}</code> on <code>{pr.base}</code> in the real
              repository and closes the pull request. It can't be undone here.
            </p>
            {pr.mergeable === "CONFLICTING" && (
              <p className="confirm-warn">
                GitHub reports merge conflicts — this will likely be rejected.
              </p>
            )}
            {pr.checks === "FAIL" && (
              <p className="confirm-warn">Some checks are failing ({pr.checks_summary}).</p>
            )}
            {pr.checks === "PENDING" && (
              <p className="confirm-warn">Checks are still running ({pr.checks_summary}).</p>
            )}
            {pr.review_decision === "CHANGES_REQUESTED" && (
              <p className="confirm-warn">Changes were requested on this PR.</p>
            )}
            <div className="confirm-actions">
              <button className="btn" onClick={() => setMergeConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn btn-accent"
                disabled={busy}
                onClick={() => {
                  const m = mergeConfirm;
                  setMergeConfirm(null);
                  void merge(m);
                }}
              >
                {MERGE_LABEL[mergeConfirm]}
              </button>
            </div>
          </div>
        </div>
      )}

      {closeConfirm && (
        <div className="confirm-backdrop" onClick={() => setCloseConfirm(false)}>
          <div className="confirm" onClick={(e) => e.stopPropagation()}>
            <p>
              Close <strong>#{pr.number} {pr.title}</strong> without merging?
            </p>
            <p className="confirm-sub">
              The pull request closes on GitHub and its author is notified. You can reopen
              it there later{closeDelBranch ? " — but only if the branch still exists" : ""}.
            </p>
            {/* Opt-in to the destructive half: gh pr close --delete-branch drops
                the branch locally and on the remote, so reopening is no longer
                possible. Off by default; a plain close keeps the work. */}
            <label className="confirm-check">
              <input
                type="checkbox"
                checked={closeDelBranch}
                onChange={(e) => setCloseDelBranch(e.target.checked)}
              />
              Also delete the branch <code>{pr.branch}</code> (local + GitHub)
            </label>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setCloseConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn btn-danger-solid"
                disabled={busy}
                onClick={() => {
                  const del = closeDelBranch;
                  setCloseConfirm(false);
                  setCloseDelBranch(false);
                  void close(del);
                }}
              >
                {closeDelBranch ? "Close & delete" : "Close PR"}
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

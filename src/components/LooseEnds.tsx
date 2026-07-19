// "Loose ends": every branch and worktree in the repo, sorted by what you'd
// lose if it vanished. Agents create worktrees faster than anyone tracks them
// and abandon them mid-thought when context runs out; afterwards an orphan is
// indistinguishable from live work at a glance.
//
// The organising question is NOT "merged or not" — it's "does this work exist
// anywhere else". Uncommitted files live only in that directory; unpushed
// commits live only in this clone. Those are the states where deleting loses
// work permanently, so they sort to the top. Merge status decides clutter, and
// clutter sorts last (oldest first — the most-forgotten is the most deletable).
import { useCallback, useEffect, useState } from "react";
import * as ipc from "../ipc";

interface LooseEndsProps {
  repo: string | null;
  onOpenTerminal: (cwd: string, label: string) => void;
  onUseWorktree: (repo: string, path: string, branch: string) => void;
  onNotice: (msg: string) => void;
  /** Ask for a confirmation before something destructive. */
  onConfirm: (text: string, run: () => void) => void;
}

type Bucket = "uncommitted" | "unpushed" | "open" | "cleanable";

const BUCKETS: { id: Bucket; label: string; hint: string }[] = [
  {
    id: "uncommitted",
    label: "Uncommitted work",
    hint: "Changes that exist only in that directory. Deleting loses them.",
  },
  {
    id: "unpushed",
    label: "Unpushed commits",
    hint: "Committed, but only in this clone — nothing on the remote yet.",
  },
  {
    id: "open",
    label: "Pushed, not merged",
    hint: "Safe from loss — still open work.",
  },
  {
    id: "cleanable",
    label: "Safe to clean up",
    hint: "Merged (or its remote branch is gone) with nothing left behind.",
  },
];

function bucketOf(b: ipc.BranchWork): Bucket {
  if (b.dirty > 0) return "uncommitted";
  // No upstream at all means it was never pushed anywhere: ahead is measured
  // against the base branch in that case, so a fresh branch with commits
  // lands here rather than looking clean.
  if (b.ahead > 0 && !b.merged) return "unpushed";
  if (!b.merged && !b.upstream_gone) return "open";
  return "cleanable";
}

const ago = (days: number) =>
  days === 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;

export function LooseEnds({
  repo,
  onOpenTerminal,
  onUseWorktree,
  onNotice,
  onConfirm,
}: LooseEndsProps) {
  const [audit, setAudit] = useState<ipc.WorkAudit | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    if (!repo) return;
    setBusy(true);
    try {
      setAudit(await ipc.gitWorkAudit(repo));
    } catch (err) {
      onNotice(String(err));
    } finally {
      setBusy(false);
    }
  }, [repo, onNotice]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!repo) return <div className="tree-empty">No repository.</div>;
  if (!audit) return <div className="tree-empty">{busy ? "Auditing…" : "—"}</div>;

  const groups = BUCKETS.map((b) => {
    const items = audit.items.filter((x) => bucketOf(x) === b.id);
    // Danger groups newest-first (that's what you were just doing); the
    // cleanup group oldest-first, because the most forgotten is the most
    // deletable and that's the whole point of the view.
    items.sort((x, y) =>
      b.id === "cleanable" ? y.age_days - x.age_days : x.age_days - y.age_days,
    );
    return { ...b, items };
  }).filter((g) => g.items.length > 0);

  const risky = audit.items.filter((b) => {
    const k = bucketOf(b);
    return k === "uncommitted" || k === "unpushed";
  }).length;
  const cleanable = audit.items.filter((b) => bucketOf(b) === "cleanable").length;
  const visible = showAll ? groups : groups.filter((g) => g.id !== "cleanable");

  const removeWorktree = (b: ipc.BranchWork) => {
    if (!repo || !b.worktree) return;
    const warn =
      b.dirty > 0
        ? ` It has ${b.dirty} uncommitted file${b.dirty === 1 ? "" : "s"} that exist nowhere else.`
        : "";
    onConfirm(`Remove the worktree for ${b.branch}?${warn}`, () => {
      void ipc
        .gitWorktreeRemove(repo, b.worktree as string, b.dirty > 0)
        .then((m) => {
          onNotice(m);
          void load();
        })
        .catch((e) => onNotice(String(e)));
    });
  };

  return (
    <div className="git-scroll loose-ends">
      <div className="loose-summary">
        <span>
          <strong>{risky}</strong> hold work that exists nowhere else
        </span>
        <span className="loose-sep">·</span>
        <span>
          <strong>{cleanable}</strong> safe to remove
        </span>
        <span className="git-spacer" />
        <button className="btn-mini" onClick={() => void load()} disabled={busy}>
          {busy ? "…" : "Recheck"}
        </button>
      </div>
      <div className="loose-base">
        Merge status measured against <code>{audit.base}</code>. Squash-merged
        branches can still read as unmerged — their remote being gone is the
        better hint.
        {audit.counts_degraded && " (This git is too old to count commits against the base branch.)"}
      </div>

      {visible.map((g) => (
        <div key={g.id} className="loose-group">
          <div className={`loose-head loose-head-${g.id}`} title={g.hint}>
            {g.label}
            <span className="badge">{g.items.length}</span>
          </div>
          {g.items.map((b) => (
            <div key={b.branch} className="loose-row" title={b.worktree ?? "no worktree"}>
              <div className="loose-main">
                <span className="loose-branch">
                  {b.branch}
                  {b.current && <span className="loose-chip">current</span>}
                  {b.is_main && <span className="loose-chip">main worktree</span>}
                </span>
                <span className="loose-subject">{b.subject}</span>
              </div>
              <div className="loose-meta">
                {b.dirty > 0 && (
                  <span className="loose-dirty" title={`${b.dirty} uncommitted files`}>
                    ±{b.dirty}
                  </span>
                )}
                {b.ahead > 0 && (
                  <span className="loose-ahead" title="commits not on the remote">
                    ↑{b.ahead}
                  </span>
                )}
                {b.upstream_gone && (
                  <span className="loose-chip" title="its remote branch was deleted">
                    remote gone
                  </span>
                )}
                {!b.upstream && !b.upstream_gone && (
                  <span className="loose-chip" title="never pushed anywhere">
                    local only
                  </span>
                )}
                {b.prunable && (
                  <span className="loose-chip loose-chip-warn" title="its directory is missing">
                    dir missing
                  </span>
                )}
                {!b.worktree && !b.prunable && (
                  <span className="loose-chip" title="no worktree checked out">
                    no worktree
                  </span>
                )}
                <span className="loose-age">{ago(b.age_days)}</span>
                <span className="loose-actions">
                  {b.worktree && !b.prunable && (
                    <>
                      <button
                        className="btn-mini"
                        title="Open a terminal in this worktree"
                        onClick={() => onOpenTerminal(b.worktree as string, b.branch)}
                      >
                        Terminal
                      </button>
                      {!b.is_main && (
                        <button
                          className="btn-mini"
                          title="Make this worktree the project's files"
                          onClick={() =>
                            onUseWorktree(repo, b.worktree as string, b.branch)
                          }
                        >
                          Use
                        </button>
                      )}
                    </>
                  )}
                  {b.worktree && !b.is_main && (
                    <button
                      className="btn-mini btn-danger"
                      title="Remove this worktree"
                      onClick={() => removeWorktree(b)}
                    >
                      Remove
                    </button>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
      ))}

      {cleanable > 0 && (
        <button className="btn loose-toggle" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Hide" : `Show ${cleanable} safe to clean up`}
        </button>
      )}
      {visible.length === 0 && !showAll && (
        <div className="tree-empty">Nothing left hanging — every branch is merged and clean.</div>
      )}
    </div>
  );
}

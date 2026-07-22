// An agent opened as a tab: everything the session produced, in one place —
// the branch it works on, its uncommitted changes, the commits it added, and
// the PR raised from that branch. Same split as BranchView: metadata paints
// first (one backend join, no patch bytes), each patch loads per pane, and
// commit rows hand off to the commit tab rather than a second renderer.
import { useEffect, useState } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import * as ipc from "../ipc";
import type { Notify } from "../types";
import { splitPatch } from "./PrView";
import { STATE_META, lastHumanPrompt } from "./AgentsPanel";
import { AgentIcon, GitBranchIcon } from "./icons";

interface AgentWorkspaceViewProps {
  /** Repo the agent's cwd resolved to; null renders the digest-only view. */
  repo: string | null;
  digest: ipc.SessionDigest;
  /** Live terminal hosting this session, when there is one. */
  ptyId?: number;
  onOpenCommit: (
    repo: string,
    commit: { hash: string; short: string; subject: string },
  ) => void;
  onOpenPr: (repo: string, pr: ipc.PrInfo) => void;
  onJumpToPty?: (ptyId: number) => void;
  onOpenTerminal: (cwd: string, label: string) => void;
  onNotice: Notify;
}

type Pane = "uncommitted" | "diff";

export function AgentWorkspaceView({
  repo,
  digest,
  ptyId,
  onOpenCommit,
  onOpenPr,
  onJumpToPty,
  onOpenTerminal,
  onNotice,
}: AgentWorkspaceViewProps) {
  const [ws, setWs] = useState<ipc.AgentWorkspace | null>(null);
  const [wsErr, setWsErr] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane | null>(null);
  const [patch, setPatch] = useState<ipc.CommitPatch | null>(null);
  const [split, setSplit] = useState(true);
  const [remote, setRemote] = useState("");
  // undefined = still looking, null = looked and none.
  const [pr, setPr] = useState<ipc.PrInfo | null | undefined>(undefined);
  const [tick, setTick] = useState(0);

  // The join: digest re-read fresh + branch/workdir/counts/commits. Refetched
  // on Refresh and whenever the panel hands over a newer digest.
  useEffect(() => {
    let live = true;
    setWsErr(null);
    if (!repo) return;
    void ipc
      .agentWorkspace(repo, digest.session_id)
      .then((w) => {
        if (!live) return;
        setWs(w);
        // Default to the pane that has something in it, once, on first load.
        setPane((p) => p ?? (w.dirty > 0 || w.on_base || w.detached ? "uncommitted" : "diff"));
      })
      .catch((e) => live && setWsErr(String(e)));
    return () => {
      live = false;
    };
  }, [repo, digest.session_id, digest.updated, tick]);

  useEffect(() => {
    let live = true;
    if (!repo) return;
    void ipc
      .gitRemoteUrl(repo)
      .then((u) => live && setRemote(u))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [repo]);

  // PR raised from the agent's branch. `gh pr list` only reports open PRs, so
  // a merged/closed one simply drops off — the card says so.
  useEffect(() => {
    let live = true;
    setPr(undefined);
    const branch = ws?.branch;
    if (!repo || !branch || ws?.detached || ws?.on_base) return;
    void ipc
      .ghAvailable()
      .then((ok) => (ok && repo ? ipc.ghPrList(repo) : []))
      .then((prs) => live && setPr(prs.find((p) => p.branch === branch) ?? null))
      .catch(() => live && setPr(null));
    return () => {
      live = false;
    };
  }, [repo, ws?.branch, ws?.detached, ws?.on_base, tick]);

  // The heavy half, per pane, exactly like BranchView: uncommitted diffs run
  // in the agent's own worktree, the cumulative diff against base.
  useEffect(() => {
    let live = true;
    setPatch(null);
    if (!repo || !ws?.branch || !pane) return;
    if (pane === "diff" && (ws.detached || ws.on_base)) return;
    void ipc
      .gitBranchPatch(
        repo,
        ws.branch,
        ws.isolated ? ws.workdir : null,
        pane === "uncommitted",
      )
      .then((p) => live && setPatch(p))
      .catch((e) => live && onNotice(String(e), "error"));
    return () => {
      live = false;
    };
  }, [repo, ws?.branch, ws?.workdir, ws?.isolated, ws?.detached, ws?.on_base, pane, tick, onNotice]);

  const st = ws?.state ? STATE_META[ws.state] : digest.state ? STATE_META[digest.state] : undefined;
  const task = lastHumanPrompt(digest.prompts);
  const touched = ws?.touched?.length ? ws.touched : (digest.files ?? []);
  const branchable = !!ws?.branch && !ws.detached && !ws.on_base;
  const files = patch?.patch ? splitPatch(patch.patch) : [];

  return (
    <div className="ticket-view">
      <div className="ticket-view-head">
        <div className="ticket-view-title">
          {st && <span className={`agent-state-dot ${st.cls}`} title={st.label} />}
          <AgentIcon id={digest.agent ?? "agent"} size={15} className="ticket-view-mark" />
          <span>{digest.agent ?? "agent"}</span>
          {ws?.branch && (
            <span className="agent-branch" title={ws.detached ? "detached HEAD" : `On branch ${ws.branch}`}>
              <GitBranchIcon size={12} /> {ws.branch}
              {ws.detached ? " (detached)" : ""}
            </span>
          )}
        </div>
        {task && <div className="agent-task">{task}</div>}
        <div className="ticket-view-meta">
          {ws && ws.dirty > 0 && <span className="loose-dirty">±{ws.dirty} uncommitted</span>}
          {ws && ws.ahead > 0 && <span className="loose-ahead">↑{ws.ahead} vs base</span>}
          {ws?.merged && <span className="loose-chip">merged</span>}
          {ws?.workdir && (
            <span
              className="ticket-view-chip"
              title={ws.isolated ? `Isolated worktree: ${ws.workdir}` : `Shared checkout: ${ws.workdir}`}
            >
              {ws.isolated ? "isolated worktree" : "shared checkout"} ·{" "}
              {ws.workdir.split("/").pop()}
            </span>
          )}
          <span className="status-spacer" />
          {ptyId != null && onJumpToPty && (
            <button className="btn" onClick={() => onJumpToPty(ptyId)}>
              Go to terminal
            </button>
          )}
          {ws?.workdir && (
            <button
              className="btn"
              onClick={() => onOpenTerminal(ws.workdir as string, ws.branch ?? digest.agent ?? "agent")}
            >
              Open terminal here
            </button>
          )}
          <button className="btn" onClick={() => setTick((t) => t + 1)}>
            Refresh
          </button>
        </div>
      </div>

      {/* States the git join can't paper over, said plainly instead of
          rendered as an empty diff. */}
      {(!repo || wsErr) && (
        <div className="tree-empty">
          {!repo
            ? "This session isn't inside a tracked repository — showing what the agent reported."
            : wsErr}
        </div>
      )}
      {ws?.cwd_missing && (
        <div className="tree-empty">
          The agent's directory ({ws.cwd}) no longer exists — showing what git still knows.
        </div>
      )}
      {ws?.on_base && (
        <div className="tree-empty">
          Working directly on {ws.base} — no branch of its own, showing uncommitted changes only.
        </div>
      )}

      {/* PR raised from this branch, if any. */}
      {repo && branchable && (
        <div className="aw-pr">
          {pr === undefined ? null : pr ? (
            <button className="aw-pr-card" onClick={() => onOpenPr(repo, pr)}>
              <span className="aw-pr-num">#{pr.number}</span>
              <span className="aw-pr-title">{pr.title}</span>
              {pr.draft && <span className="loose-chip">draft</span>}
              {pr.checks && (
                <span
                  className={`loose-chip ${pr.checks === "FAIL" ? "loose-dirty" : ""}`}
                  title={pr.checks_summary}
                >
                  {pr.checks.toLowerCase()}
                </span>
              )}
              <span className="loose-chip">{pr.state.toLowerCase()}</span>
            </button>
          ) : (
            <div className="aw-pr-none">
              No open PR from {ws?.branch}
              {remote && !ws?.merged && (
                <a
                  className="btn"
                  href={`${remote}/compare/${ws?.branch}?expand=1`}
                  title="Open a pull request for this branch"
                >
                  Open PR
                </a>
              )}
            </div>
          )}
        </div>
      )}

      {/* What the agent said it edited — its own report, capped by the hook.
          The diff below is the authoritative list. */}
      {touched.length > 0 && (
        <div className="aw-touched">
          <div className="ticket-state-head">
            Files the agent reported editing
            <span className="badge">{touched.length}</span>
          </div>
          <div className="aw-touched-list">
            {touched.map((f) => (
              <code key={f} className="aw-touched-file" title={f}>
                {f}
              </code>
            ))}
          </div>
        </div>
      )}

      {ws && (
        <div className="branch-panes">
          <button
            className={`btn-mini ${pane === "uncommitted" ? "btn-accent" : ""}`}
            onClick={() => setPane("uncommitted")}
          >
            Uncommitted{ws.dirty > 0 ? ` (${ws.dirty})` : ""}
          </button>
          {branchable && (
            <button
              className={`btn-mini ${pane === "diff" ? "btn-accent" : ""}`}
              onClick={() => setPane("diff")}
            >
              All changes vs base
            </button>
          )}
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
      )}

      <div className="ticket-view-body branch-body">
        {/* Commits are metadata — always listed, no patch cost. */}
        {ws && ws.commits.length > 0 && (
          <div className="branch-commits">
            <div className="ticket-state-head">
              Commits not in base
              <span className="badge">{ws.commits.length}</span>
            </div>
            {ws.commits.map((c) => (
              <div
                key={c.hash}
                className="git-commit-row git-commit-row-click"
                title={`${c.hash}\n${c.author} · ${c.date}\n\nClick to open this commit`}
                onClick={() =>
                  repo &&
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

        {!ws ? (
          !wsErr && repo && <div className="tree-empty">Loading workspace…</div>
        ) : !patch ? (
          pane && <div className="tree-empty">Loading diff…</div>
        ) : files.length === 0 ? (
          <div className="tree-empty">
            {pane === "uncommitted"
              ? "No uncommitted changes in this workspace."
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

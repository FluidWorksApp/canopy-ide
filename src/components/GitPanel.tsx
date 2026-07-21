// Native git management for a project's repos: branch switching, staging,
// commit, sync with the remote, and pull requests. Everything runs through the
// system `git`/`gh` in the Rust core — the same tools the user's terminal uses,
// so hooks, credential helpers and SSH config all behave identically.
import { useCallback, useEffect, useState } from "react";
import * as ipc from "../ipc";
import type { Notify } from "../types";
import { useEscape } from "../useEscape";
import { CheckIcon, FailIcon, RestartIcon } from "./icons";
import { LooseEnds } from "./LooseEnds";

interface GitPanelProps {
  components: { label: string; path: string }[];
  /** Open a file's diff in the main area. */
  onOpenDiff: (repo: string, file: ipc.FileChange) => void;
  /** Open a pull request in the main area. */
  onOpenPr: (repo: string, pr: ipc.PrInfo) => void;
  /** Open a branch's work in the main area. */
  onOpenBranch: (repo: string, branch: ipc.BranchWork) => void;
  /** Open a commit in the main area. */
  onOpenCommit: (
    repo: string,
    commit: { hash: string; short: string; subject: string },
  ) => void;
  /** Open a terminal in a directory (used to work inside a worktree). */
  onOpenTerminal: (cwd: string, label: string) => void;
  /** Worktree currently backing the project's files, if any. */
  activeWorktree: string | null;
  /** Make a worktree the project's working environment. */
  onUseWorktree: (repo: string, path: string, branch: string) => void;
  onNotice: Notify;
}

type Section = "changes" | "branches" | "worktrees" | "loose" | "history" | "prs";

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

export function GitPanel({
  components,
  onOpenDiff,
  onOpenPr,
  onOpenCommit,
  onOpenBranch,
  onOpenTerminal,
  activeWorktree,
  onUseWorktree,
  onNotice,
}: GitPanelProps) {
  const [repos, setRepos] = useState<ipc.RepoInfo[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  const [status, setStatus] = useState<ipc.RepoStatus | null>(null);
  const [branches, setBranches] = useState<ipc.BranchInfo[]>([]);
  const [log, setLog] = useState<ipc.CommitInfo[]>([]);
  const [prs, setPrs] = useState<ipc.PrInfo[]>([]);
  const [worktrees, setWorktrees] = useState<ipc.WorktreeInfo[]>([]);
  const [wtBranch, setWtBranch] = useState("");
  const [hasGh, setHasGh] = useState(false);
  const [section, setSection] = useState<Section>("changes");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [branchFilter, setBranchFilter] = useState("");
  const [confirm, setConfirm] = useState<{ text: string; run: () => void } | null>(null);
  useEscape(() => setConfirm(null), confirm != null);

  const key = components.map((c) => c.path).join("\n");

  // Discover the repos backing this project. Several components often share one
  // repo (monorepo), so this is grouped rather than one entry per component.
  useEffect(() => {
    void ipc
      .gitRepos(components.map((c) => [c.label, c.path] as [string, string]))
      .then((r) => {
        setRepos(r);
        setRepo((cur) => (cur && r.some((x) => x.path === cur) ? cur : (r[0]?.path ?? null)));
      })
      .catch(() => setRepos([]));
    void ipc.ghAvailable().then(setHasGh);
  }, [key]);

  const refresh = useCallback(async () => {
    if (!repo) return;
    await Promise.all([
      ipc.gitRepoStatus(repo).then(setStatus).catch(() => setStatus(null)),
      ipc.gitBranches(repo).then(setBranches).catch(() => setBranches([])),
      ipc.gitLog(repo, 40).then(setLog).catch(() => setLog([])),
    ]);
  }, [repo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep status live against edits made by agents in the terminals.
  useEffect(() => {
    if (!repo) return;
    const sub = ipc.onFsChange(() => void refresh());
    const poll = setInterval(() => void refresh(), 5000);
    return () => {
      clearInterval(poll);
      void sub.then((fn) => fn());
    };
  }, [repo, refresh]);

  const loadPrs = useCallback(async () => {
    if (!repo || !hasGh) return;
    setBusy("prs");
    try {
      setPrs(await ipc.ghPrList(repo));
    } catch (err) {
      onNotice(String(err), "error");
    } finally {
      setBusy(null);
    }
  }, [repo, hasGh, onNotice]);

  useEffect(() => {
    if (section === "prs") void loadPrs();
  }, [section, loadPrs]);

  // Worktrees are loaded on demand, never polled: listing them costs one
  // `git status` per worktree to get dirty counts, and a repo can easily have
  // 20+ agent worktrees — polling that every few seconds would spawn a storm
  // of git processes for a panel nobody is looking at.
  const loadWorktrees = useCallback(async () => {
    if (!repo) return;
    setBusy("worktrees");
    try {
      setWorktrees(await ipc.gitWorktrees(repo));
    } catch (err) {
      onNotice(String(err), "error");
    } finally {
      setBusy(null);
    }
  }, [repo, onNotice]);

  useEffect(() => {
    if (section === "worktrees") void loadWorktrees();
  }, [section, loadWorktrees]);

  /** Run a git action, surface its real output, and refresh. Used for the
   *  heavier, less frequent operations (commit, sync, checkout) where the user
   *  is waiting on the result anyway. */
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      const out = await fn();
      // git's own first line of output — a result, not a fault.
      if (typeof out === "string" && out.trim())
        onNotice(out.trim().split("\n")[0], "success");
      await refresh();
    } catch (err) {
      onNotice(String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  /** Optimistic file action: move the row to where it will land *now*, run the
   *  git command in the background, then reconcile against the real status.
   *  That reconcile doubles as the rollback — a failed stage/discard simply
   *  reappears where it was, with the error surfaced. No busy spinner: the
   *  point is that the click feels instant. `to` is the bucket the file moves
   *  to, or null when it leaves the working tree entirely (discard/untracked). */
  const optimisticFile = (
    path: string,
    to: "staged" | "unstaged" | null,
    fn: () => Promise<unknown>,
  ) => {
    setStatus((prev) => {
      if (!prev) return prev;
      const source = [
        ...prev.conflicted,
        ...prev.staged,
        ...prev.unstaged,
        ...prev.untracked,
      ].find((f) => f.path === path);
      const without = (arr: ipc.FileChange[]) => arr.filter((f) => f.path !== path);
      const next: ipc.RepoStatus = {
        ...prev,
        staged: without(prev.staged),
        unstaged: without(prev.unstaged),
        untracked: without(prev.untracked),
        conflicted: without(prev.conflicted),
      };
      if (source && to === "staged") next.staged = [...next.staged, { ...source, staged: true }];
      if (source && to === "unstaged")
        next.unstaged = [...next.unstaged, { ...source, staged: false }];
      return next;
    });
    void fn()
      .then((out) => {
        // git's own first line of output — a result, not a fault.
      if (typeof out === "string" && out.trim())
        onNotice(out.trim().split("\n")[0], "success");
      })
      .catch((err) => onNotice(String(err), "error"))
      // Reconcile on success (confirm) and failure (revert) alike.
      .finally(() => void refresh());
  };

  if (repos.length === 0) {
    return (
      <div className="side-panel">
        <div className="side-panel-head">
          <span>Git</span>
        </div>
        <div className="tree-empty">
          No git repository in this project's components.
        </div>
      </div>
    );
  }

  const allChanged = status
    ? [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked]
    : [];
  const stagedCount = status?.staged.length ?? 0;

  const fileRow = (f: ipc.FileChange, kind: "staged" | "unstaged" | "untracked" | "conflicted") => (
    <div
      key={`${kind}:${f.path}`}
      className={`git-file git-file-${kind}`}
      title={`${f.status.trim() || "??"} ${f.path}`}
      onClick={() => repo && onOpenDiff(repo, f)}
    >
      <span className="git-file-status">{f.status.trim() || "??"}</span>
      <span className="git-file-name">{f.path.split("/").pop()}</span>
      <span className="git-file-dir">{f.path.split("/").slice(0, -1).join("/")}</span>
      <span className="git-file-actions" onClick={(e) => e.stopPropagation()}>
        {kind === "staged" ? (
          <button
            className="icon-btn"
            title="Unstage"
            onClick={() => repo && optimisticFile(f.path, "unstaged", () => ipc.gitUnstage(repo, [f.path]))}
          >
            −
          </button>
        ) : (
          <>
            {kind !== "untracked" && (
              <button
                className="icon-btn icon-btn-danger"
                title="Discard changes (cannot be undone)"
                onClick={() =>
                  setConfirm({
                    text: `Discard all changes to ${f.path}? This cannot be undone.`,
                    run: () => repo && optimisticFile(f.path, null, () => ipc.gitDiscard(repo, [f.path])),
                  })
                }
              >
                ⨯
              </button>
            )}
            <button
              className="icon-btn"
              title="Stage"
              onClick={() => repo && optimisticFile(f.path, "staged", () => ipc.gitStage(repo, [f.path]))}
            >
              +
            </button>
          </>
        )}
      </span>
    </div>
  );

  return (
    <div className="side-panel git-panel">
      <div className="side-panel-head">
        <span>Git</span>
        <button className="icon-btn" title="Refresh" onClick={() => void refresh()}>
          <RestartIcon size={13} />
        </button>
      </div>

      {/* Repo picker — only when the project actually spans several repos. */}
      {repos.length > 1 && (
        <div className="git-repos">
          {repos.map((r) => (
            <button
              key={r.path}
              className={`git-repo-chip ${r.path === repo ? "git-repo-chip-on" : ""}`}
              title={`${r.path}\ncomponents: ${r.components.join(", ")}`}
              onClick={() => setRepo(r.path)}
            >
              {r.name}
            </button>
          ))}
        </div>
      )}

      {/* Branch + sync */}
      <div className="git-branchbar">
        <button
          className="git-branch"
          title={
            status?.detached
              ? "detached HEAD — checkout a branch to commit"
              : `branch${status?.upstream ? ` · tracking ${status.upstream}` : " · no upstream"}`
          }
          onClick={() => setSection(section === "branches" ? "changes" : "branches")}
        >
          {status?.detached ? "⚠ detached" : `⎇ ${status?.branch ?? "—"}`}
        </button>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="git-counts" title={`${status.ahead} to push · ${status.behind} to pull`}>
            {status.ahead > 0 && <span className="git-ahead">↑{status.ahead}</span>}
            {status.behind > 0 && <span className="git-behind">↓{status.behind}</span>}
          </span>
        )}
        <span className="git-spacer" />
        <button
          className="btn-mini"
          disabled={busy != null}
          title="git fetch --prune"
          onClick={() => repo && void act("fetch", () => ipc.gitFetch(repo))}
        >
          Fetch
        </button>
        <button
          className="btn-mini"
          disabled={busy != null}
          title="git pull --ff-only"
          onClick={() => repo && void act("pull", () => ipc.gitPull(repo))}
        >
          Pull
        </button>
        <button
          className="btn-mini"
          disabled={busy != null || status?.detached}
          title={status?.upstream ? "git push" : "git push --set-upstream origin (no upstream yet)"}
          onClick={() => repo && void act("push", () => ipc.gitPush(repo, !status?.upstream))}
        >
          Push
        </button>
      </div>

      <div className="git-tabs">
        {(["changes", "branches", "worktrees", "loose", "history", "prs"] as Section[]).map((s) => (
          <button
            key={s}
            className={`git-tab ${section === s ? "git-tab-on" : ""}`}
            onClick={() => setSection(s)}
          >
            {s === "changes" && allChanged.length > 0
              ? `Changes (${allChanged.length})`
              : s === "prs"
                ? "PRs"
                : s === "loose"
                  ? "Loose ends"
                  : s === "worktrees" && worktrees.length > 1
                    ? `Worktrees (${worktrees.length})`
                  : s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {busy && <div className="git-busy">{busy}…</div>}

      {section === "changes" && status && (
        <div className="git-scroll">
          {/* Commit box first: it's the thing you came here to do. */}
          <div className="git-commit-box">
            <textarea
              className="git-commit-msg"
              placeholder={stagedCount > 0 ? `Commit message (${stagedCount} staged)` : "Stage files to commit"}
              value={message}
              rows={3}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && stagedCount > 0) {
                  e.preventDefault();
                  void act("commit", async () => {
                    const r = await ipc.gitCommit(repo!, message, false);
                    setMessage("");
                    return r;
                  });
                }
              }}
            />
            <div className="git-commit-actions">
              <button
                className="btn btn-accent"
                disabled={stagedCount === 0 || !message.trim() || busy != null}
                title="Commit staged changes (Cmd+Enter)"
                onClick={() =>
                  void act("commit", async () => {
                    const r = await ipc.gitCommit(repo!, message, false);
                    setMessage("");
                    return r;
                  })
                }
              >
                Commit {stagedCount > 0 ? stagedCount : ""}
              </button>
              {status.unstaged.length + status.untracked.length > 0 && (
                <button
                  className="btn-mini"
                  onClick={() =>
                    repo &&
                    void act("stage all", () =>
                      ipc.gitStage(repo, [
                        ...status.unstaged.map((f) => f.path),
                        ...status.untracked.map((f) => f.path),
                      ]),
                    )
                  }
                >
                  Stage all
                </button>
              )}
            </div>
          </div>

          {status.conflicted.length > 0 && (
            <>
              <div className="git-section-head git-section-conflict">
                Conflicts ({status.conflicted.length}) — resolve before committing
              </div>
              {status.conflicted.map((f) => fileRow(f, "conflicted"))}
            </>
          )}
          {status.staged.length > 0 && (
            <>
              <div className="git-section-head">
                Staged ({status.staged.length})
                <button
                  className="btn-mini"
                  onClick={() =>
                    repo &&
                    void act("unstage all", () =>
                      ipc.gitUnstage(repo, status.staged.map((f) => f.path)),
                    )
                  }
                >
                  Unstage all
                </button>
              </div>
              {status.staged.map((f) => fileRow(f, "staged"))}
            </>
          )}
          {status.unstaged.length > 0 && (
            <>
              <div className="git-section-head">Changes ({status.unstaged.length})</div>
              {status.unstaged.map((f) => fileRow(f, "unstaged"))}
            </>
          )}
          {status.untracked.length > 0 && (
            <>
              <div className="git-section-head">Untracked ({status.untracked.length})</div>
              {status.untracked.map((f) => fileRow(f, "untracked"))}
            </>
          )}
          {allChanged.length === 0 && <div className="tree-empty">Working tree clean.</div>}
        </div>
      )}

      {section === "branches" && (
        <div className="git-scroll">
          <div className="git-branch-new">
            <input
              className="git-branch-input"
              placeholder="Filter or new branch name…"
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
            />
            {branchFilter.trim() && !branches.some((b) => b.name === branchFilter.trim()) && (
              <button
                className="btn-mini"
                onClick={() =>
                  repo &&
                  void act("create branch", async () => {
                    const r = await ipc.gitCheckout(repo, branchFilter.trim(), true);
                    setBranchFilter("");
                    return r;
                  })
                }
              >
                Create
              </button>
            )}
          </div>
          {branches
            .filter((b) => b.name.toLowerCase().includes(branchFilter.toLowerCase()))
            .map((b) => (
              <div
                key={b.name}
                className={`git-branch-row ${b.current ? "git-branch-current" : ""}`}
                title={`${b.subject}${b.upstream ? `\ntracking ${b.upstream}` : ""}`}
                onClick={() =>
                  !b.current &&
                  repo &&
                  void act("checkout", () =>
                    // Checking out a remote branch creates a local tracking one,
                    // which is what git does for `git checkout origin/x` anyway.
                    ipc.gitCheckout(repo, b.remote ? b.name.replace(/^origin\//, "") : b.name, false),
                  )
                }
              >
                <span className="git-branch-mark">{b.current ? "●" : b.remote ? "☁" : "○"}</span>
                <span className="git-branch-name">{b.name}</span>
                <span className="git-branch-subject">{b.subject}</span>
              </div>
            ))}
        </div>
      )}

      {/* Worktrees: one checkout per agent, so several can work the same repo
          on different branches at once. */}
      {section === "worktrees" && (
        <div className="git-scroll">
          <div className="git-branch-new">
            <input
              className="git-branch-input"
              placeholder="New branch for a worktree…"
              value={wtBranch}
              onChange={(e) => setWtBranch(e.target.value)}
            />
            <button
              className="btn-mini"
              disabled={!wtBranch.trim() || busy != null}
              title="Create a worktree alongside the repo, on a new branch"
              onClick={() => {
                if (!repo) return;
                const slug = wtBranch.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
                // Sibling of the repo, named after it — predictable, and never
                // inside the repo itself (which would make it self-tracking).
                const path = `${repo}-wt-${slug}`;
                void act("worktree add", async () => {
                  const r = await ipc.gitWorktreeAdd(repo, path, wtBranch.trim(), true);
                  // Make it readable by the file tree / editor.
                  await ipc.workspaceAdd(path).catch(() => {});
                  setWtBranch("");
                  await loadWorktrees();
                  return r;
                });
              }}
            >
              Create
            </button>
          </div>

          {worktrees.map((w) => (
            <div
              key={w.path}
              className={`git-worktree ${w.prunable ? "git-worktree-gone" : ""} ${
                activeWorktree === w.path ? "git-worktree-active" : ""
              }`}
              title={`${w.path}\n${w.head}${w.locked ? `\nlocked: ${w.locked}` : ""}${
                w.prunable ? `\nprunable: ${w.prunable}` : ""
              }`}
            >
              <div className="git-worktree-top">
                <span className="git-worktree-mark">{w.is_main ? "★" : w.prunable ? "⚠" : "⑂"}</span>
                <span className="git-worktree-branch">
                  {w.branch ?? (w.detached ? `detached @ ${w.head}` : w.head)}
                </span>
                {w.is_main && <span className="git-worktree-tag">main</span>}
                {w.locked && <span className="git-worktree-tag">locked</span>}
                {w.prunable && <span className="git-worktree-tag git-tag-warn">missing</span>}
                {w.dirty > 0 && (
                  <span className="git-worktree-dirty" title={`${w.dirty} uncommitted changes`}>
                    ±{w.dirty}
                  </span>
                )}
              </div>
              <div className="git-worktree-path">{w.path}</div>
              <div className="git-worktree-actions">
                {activeWorktree === w.path ? (
                  <span className="wt-inuse" title="Project files are using this worktree">
                    in use
                  </span>
                ) : (
                  !w.prunable &&
                  !w.bare && (
                    <button
                      className="btn-mini"
                      title="Point this project's files, search and new terminals at this worktree"
                      onClick={() => repo && onUseWorktree(repo, w.path, w.branch ?? w.name)}
                    >
                      Use
                    </button>
                  )
                )}
                <button
                  className="btn-mini"
                  title="Open a terminal in this worktree — run an agent here"
                  onClick={() => onOpenTerminal(w.path, w.branch ?? w.name)}
                >
                  Terminal
                </button>
                {!w.is_main && (
                  <button
                    className="btn-mini"
                    title={
                      w.dirty > 0
                        ? `${w.dirty} uncommitted changes would be lost`
                        : "Remove this worktree"
                    }
                    onClick={() =>
                      setConfirm({
                        text:
                          w.dirty > 0
                            ? `Remove worktree ${w.path}?\n\nIt has ${w.dirty} uncommitted change${
                                w.dirty === 1 ? "" : "s"
                              } that will be lost. This cannot be undone.`
                            : `Remove worktree ${w.path}?`,
                        run: () =>
                          repo &&
                          void act("worktree remove", async () => {
                            const r = await ipc.gitWorktreeRemove(repo, w.path, w.dirty > 0);
                            await ipc.workspaceRemove(w.path).catch(() => {});
                            await loadWorktrees();
                            return r;
                          }),
                      })
                    }
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}

          {worktrees.some((w) => w.prunable) && (
            <div className="git-branch-new">
              <button
                className="btn-mini"
                title="Drop records for worktrees whose directories are gone"
                onClick={() =>
                  repo &&
                  void act("prune", async () => {
                    const r = await ipc.gitWorktreePrune(repo);
                    await loadWorktrees();
                    return r;
                  })
                }
              >
                Prune missing ({worktrees.filter((w) => w.prunable).length})
              </button>
            </div>
          )}
        </div>
      )}

      {section === "loose" && (
        <LooseEnds
          repo={repo}
          onOpenBranch={onOpenBranch}
          onOpenTerminal={onOpenTerminal}
          onUseWorktree={onUseWorktree}
          onNotice={onNotice}
          onConfirm={(text, run) => setConfirm({ text, run })}
        />
      )}

      {section === "history" && (
        <div className="git-scroll">
          {log.map((c) => (
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
          {log.length === 0 && <div className="tree-empty">No commits yet.</div>}
        </div>
      )}

      {section === "prs" && (
        <div className="git-scroll">
          {!hasGh ? (
            <div className="tree-empty">
              Pull requests need the GitHub CLI. Install it with <code>brew install gh</code>, then
              run <code>gh auth login</code> in a terminal.
            </div>
          ) : prs.length === 0 && busy !== "prs" ? (
            <div className="tree-empty">No open pull requests.</div>
          ) : (
            prs.map((pr) => (
              <div
                key={pr.number}
                className="git-pr-row"
                title={`${pr.branch} → ${pr.base}\n${pr.url}`}
                onClick={() => repo && onOpenPr(repo, pr)}
              >
                <span className="git-pr-num">#{pr.number}</span>
                <div className="git-pr-main">
                  <span className="git-pr-title">
                    {pr.draft && <span className="git-pr-draft">draft</span>}
                    {pr.title}
                  </span>
                  <span className="git-pr-refs">
                    <code>{pr.branch}</code> → <code>{pr.base}</code>
                    {pr.created && (
                      <span className="git-pr-age" title={absTime(pr.created)}>
                        · opened {ago(pr.created)}
                      </span>
                    )}
                    {pr.checks === "PASS" && (
                      <span className="git-pr-checks git-pr-ok" title={pr.checks_summary}>
                        · checks passed
                      </span>
                    )}
                    {pr.checks === "FAIL" && (
                      <span className="git-pr-checks git-pr-bad" title={pr.checks_summary}>
                        · checks failed
                      </span>
                    )}
                    {pr.checks === "PENDING" && (
                      <span className="git-pr-checks git-pr-pending" title={pr.checks_summary}>
                        · checks running
                      </span>
                    )}
                    {pr.mergeable === "CONFLICTING" && (
                      <span className="git-pr-checks git-pr-bad">· conflicts</span>
                    )}
                    {pr.review_decision === "APPROVED" &&
                      pr.mergeable !== "CONFLICTING" &&
                      pr.checks !== "FAIL" && (
                        <span className="git-pr-mergeable">· approved, ready to merge</span>
                      )}
                  </span>
                </div>
                <span className="git-pr-meta">
                  {pr.review_decision === "APPROVED" && (
                    <CheckIcon size={11} className="git-pr-approved" />
                  )}
                  {pr.review_decision === "CHANGES_REQUESTED" && (
                    <FailIcon size={11} className="git-pr-changes" />
                  )}
                  <span className="git-pr-author">{pr.mine ? "you" : pr.author}</span>
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Discarding work is unrecoverable — never do it on a single click. */}
      {confirm && (
        <div className="confirm-backdrop" onClick={() => setConfirm(null)}>
          <div className="confirm" onClick={(e) => e.stopPropagation()}>
            <p>{confirm.text}</p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger-solid"
                onClick={() => {
                  confirm.run();
                  setConfirm(null);
                }}
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// An agent opened as a tab: everything the session produced, in one place —
// the branch it works on, its uncommitted changes, the commits it added, and
// the PR raised from that branch. Same split as BranchView: metadata paints
// first (one backend join, no patch bytes), each patch loads per pane, and
// commit rows hand off to the commit tab rather than a second renderer.
import { useEffect, useRef, useState } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import * as ipc from "../ipc";
import type { Notify } from "../types";
import { splitPatch } from "./PrView";
import { STATE_META, lastHumanPrompt } from "./AgentsPanel";
import { AgentIcon, GitBranchIcon, RestartIcon } from "./icons";
import { sessionCost } from "../pricing";

// Compact number formats for the header stats strip — matched to the status
// tray so the same session reads the same everywhere.
const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
const fmtCost = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
/** Tokens Canopy sent the model — fresh input plus both cache legs. */
const sentTokens = (u: ipc.AgentSessionUsage) =>
  u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens;

interface AgentWorkspaceViewProps {
  /** Repo the agent's cwd resolved to; null renders the digest-only view. */
  repo: string | null;
  /** Authoritative agent id, from the live process tree — never a stale digest
   *  a reused PTY might still carry. Drives the header mark and label. */
  agent: string;
  /** The agent's working directory. The git join is driven off this, so a
   *  hookless CLI (codex, agy, …) gets a full workspace. */
  cwd: string;
  /** Hook session id, when a hook CLI wrote a digest — enrichment only. */
  sessionId?: string;
  /** The hook digest, when there is one: last prompt, state, reported files. */
  digest?: ipc.SessionDigest;
  onOpenCommit: (
    repo: string,
    commit: { hash: string; short: string; subject: string },
  ) => void;
  onOpenPr: (repo: string, pr: ipc.PrInfo) => void;
  onOpenTerminal: (cwd: string, label: string) => void;
  onNotice: Notify;
  /** When set, the header shows a close button — the overlay is the single
   *  banner. The standalone agent tab omits it (the tab closes itself). */
  onClose?: () => void;
}

type Pane = "edits" | "uncommitted" | "diff";

// The reported-editing list is a quick-glance strip, not the authoritative diff
// below — so it shows the basename (the full path lives in the tooltip and the
// diff header) and folds everything past this many into a dropdown.
const TOUCHED_LIMIT = 6;
const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const parentDir = (p: string) => p.split("/").filter(Boolean).slice(-2, -1)[0] ?? "";

/** A file-card header: the directory dimmed, the filename emphasized, and an
 *  optional count badge — so a wall of full paths reads as filenames first,
 *  the folder as context. Shared by the edits pane and the diff panes. */
function FileName({ path, count, countTitle }: { path: string; count?: number; countTitle?: string }) {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  return (
    <div className="pr-file-name" title={path}>
      {dir && <span className="pr-file-dir">{dir}</span>}
      <span className="pr-file-base">{base}</span>
      {count != null && (
        <span className="badge" title={countTitle}>
          {count}
        </span>
      )}
    </div>
  );
}

// A journaled edit (old→new fragment) rendered as a single unified diff, so it
// paints with the same DiffView as every other diff in the app. Line numbers
// are nominal (these are fragments, not whole files); a tight common
// prefix/suffix keeps the hunk to the part that actually changed. The `---`/`+++`
// header is required, not decoration: @git-diff-view's parser scans for a `+++`
// line and treats a headerless hunk as an empty diff, so without it the card
// renders blank.
function editToHunk(path: string, old: string | null, next: string | null): string {
  const oldLines = old != null ? old.split("\n") : [];
  const newLines = next != null ? next.split("\n") : [];
  let p = 0;
  while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
  let s = 0;
  while (
    s < oldLines.length - p &&
    s < newLines.length - p &&
    oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]
  )
    s++;
  const ctxPre = oldLines.slice(Math.max(0, p - 2), p).map((l) => ` ${l}`);
  const removed = oldLines.slice(p, oldLines.length - s).map((l) => `-${l}`);
  const added = newLines.slice(p, newLines.length - s).map((l) => `+${l}`);
  const ctxPost = oldLines.slice(oldLines.length - s, oldLines.length - s + 2).map((l) => ` ${l}`);
  const body = [...ctxPre, ...removed, ...added, ...ctxPost].join("\n");
  const oldCount = ctxPre.length + removed.length + ctxPost.length;
  const newCount = ctxPre.length + added.length + ctxPost.length;
  return `--- a/${path}\n+++ b/${path}\n@@ -1,${oldCount} +1,${newCount} @@\n${body}`;
}

export function AgentWorkspaceView({
  repo,
  agent,
  cwd,
  sessionId,
  digest,
  onOpenCommit,
  onOpenPr,
  onOpenTerminal,
  onNotice,
  onClose,
}: AgentWorkspaceViewProps) {
  const [ws, setWs] = useState<ipc.AgentWorkspace | null>(null);
  const [wsErr, setWsErr] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane | null>(null);
  const [patch, setPatch] = useState<ipc.CommitPatch | null>(null);
  const [split, setSplit] = useState(true);
  const [remote, setRemote] = useState("");
  // undefined = still looking, null = looked and none.
  const [pr, setPr] = useState<ipc.PrInfo | null | undefined>(undefined);
  // The per-agent change journal: what THIS agent changed, attributed at hunk
  // granularity even on a shared checkout. Empty for a hookless/pre-journal
  // session, in which case only the tree view below has anything to show.
  const [edits, setEdits] = useState<ipc.AgentEdit[]>([]);
  // Manual refresh: the small icon in the header bumps this to re-read all.
  const [tick, setTick] = useState(0);
  // This agent's token/cost usage, read from its own CLI store (Claude, Codex
  // and omp today) — independent of hooks, so it shows even for a hookless
  // codex. Matched by session id when we have one, else the most recent
  // session in this cwd.
  const [usage, setUsage] = useState<ipc.AgentSessionUsage | null>(null);
  useEffect(() => {
    let live = true;
    void ipc
      .agentUsage()
      .then((rows) => {
        if (!live) return;
        const mine = rows.filter((u) => u.agent === agent && u.supported);
        const byId = sessionId ? mine.find((u) => u.session_id === sessionId) : undefined;
        const inCwd = mine
          .filter((u) => u.cwd && (u.cwd === cwd || cwd.startsWith(u.cwd) || u.cwd.startsWith(cwd)))
          .sort((a, b) => b.updated - a.updated);
        setUsage(byId ?? inCwd[0] ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [agent, cwd, sessionId, digest?.updated, tick]);

  useEffect(() => {
    let live = true;
    setEdits([]);
    if (!sessionId) return;
    void ipc
      .agentEdits(repo, sessionId)
      .then((e) => live && setEdits(e))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [repo, sessionId, digest?.updated, tick]);

  // The join: digest re-read fresh + branch/workdir/counts/commits. Refetched
  // on Refresh and whenever the panel hands over a newer digest.
  useEffect(() => {
    let live = true;
    setWsErr(null);
    if (!repo) return;
    void ipc
      .agentWorkspaceAt(repo, cwd, agent, sessionId)
      .then((w) => {
        if (!live) return;
        setWs(w);
      })
      .catch((e) => live && setWsErr(String(e)));
    return () => {
      live = false;
    };
  }, [repo, cwd, agent, sessionId, digest?.updated, tick]);

  // Open on this agent's own edits when we have them — that's the per-agent
  // view the shared-checkout tree can't give. Otherwise fall back to whichever
  // tree pane has content. Set once, on first load.
  useEffect(() => {
    if (pane) return;
    if (edits.length > 0) setPane("edits");
    else if (ws) setPane(ws.dirty > 0 || ws.on_base || ws.detached ? "uncommitted" : "diff");
  }, [edits, ws, pane]);

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
    // The edits pane is journal-only — no git patch to fetch.
    if (pane === "edits") return;
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

  const st = ws?.state ? STATE_META[ws.state] : digest?.state ? STATE_META[digest.state] : undefined;
  const task = lastHumanPrompt(digest?.prompts);
  const cost = usage ? sessionCost(usage) : null;
  const touched = ws?.touched?.length ? ws.touched : (digest?.files ?? []);
  const branchable = !!ws?.branch && !ws.detached && !ws.on_base;
  const files = patch?.patch ? splitPatch(patch.patch) : [];

  // The set of paths this agent is known to have touched — from its own edit
  // journal and its reported-editing list. Matched by basename too, since a
  // journal path (repo-relative) and a diff path can differ by a worktree
  // prefix.
  const agentPaths = new Set<string>([...edits.map((e) => e.path), ...touched]);
  const agentBasenames = new Set<string>([...agentPaths].map(basename));
  const isAgentFile = (p: string) => agentPaths.has(p) || agentBasenames.has(basename(p));
  // This workspace shows ONLY this agent's work, never the rest of the tree.
  // On an isolated worktree every change in the diff is this agent's by
  // construction; on a shared checkout we can claim only the files it actually
  // journaled or reported — the others belong to whoever else shares the
  // checkout and are deliberately not shown here.
  const isolated = !!ws?.isolated;
  const mine = isolated ? files : files.filter((f) => isAgentFile(f.path));
  // Whether we can attribute at all: an isolated worktree, a journal, or a
  // reported list. Without any of these a shared-checkout diff is an
  // undifferentiated tree we won't pass off as this agent's.
  const canAttribute = isolated || agentPaths.size > 0;

  // Journal edits grouped by file, newest file last, preserving edit order.
  const editsByFile: { path: string; items: ipc.AgentEdit[] }[] = [];
  for (const e of edits) {
    const g = editsByFile.find((x) => x.path === e.path);
    if (g) g.items.push(e);
    else editsByFile.push({ path: e.path, items: [e] });
  }

  // Jump from a reported-editing chip to that file's diff section below. A
  // reported path (relative to the hook's cwd) and a diff path (relative to the
  // repo root) usually match outright; basename is the fallback. A chip with no
  // match in the current pane isn't clickable — which is also how a file the
  // agent touched in another worktree quietly reads as "not in this diff".
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [flashPath, setFlashPath] = useState<string | null>(null);
  const diffTarget = (t: string): string | null =>
    files.find((f) => f.path === t)?.path ??
    files.find((f) => basename(f.path) === basename(t))?.path ??
    null;
  const scrollToFile = (path: string) => {
    const el = fileRefs.current.get(path);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setFlashPath(path);
    window.setTimeout(() => setFlashPath((p) => (p === path ? null : p)), 1100);
  };
  const [showMoreTouched, setShowMoreTouched] = useState(false);

  const renderFile = (f: { path: string; patch: string }) => (
    <div
      key={f.path}
      className={`pr-file ${flashPath === f.path ? "pr-file-flash" : ""}`}
      ref={(el) => {
        if (el) fileRefs.current.set(f.path, el);
        else fileRefs.current.delete(f.path);
      }}
    >
      <FileName path={f.path} />
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
  );

  return (
    <div className="ticket-view">
      {/* One banner for the whole workspace: identity, branch, where it's
          working, and the window controls — no second header repeating the
          agent name below it. The dropped chips (±uncommitted, ↑vs base) were
          whole-checkout/whole-branch counts, not this agent's; the commit list
          and the scoped diff below carry the real numbers. */}
      <div className="ticket-view-head aw-banner">
        <div className="ticket-view-title">
          {st && <span className={`agent-state-dot ${st.cls}`} title={st.label} />}
          <AgentIcon id={agent} size={16} className="ticket-view-mark" />
          <span className="aw-agent">{agent}</span>
          {ws?.branch && (
            <span className="agent-branch" title={ws.detached ? "detached HEAD" : `On branch ${ws.branch}`}>
              <GitBranchIcon size={12} /> {ws.branch}
              {ws.detached ? " (detached)" : ""}
            </span>
          )}
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
          {/* Only for an isolated worktree: that directory isn't a tab anywhere
              else, so a scratch shell pointed at it is the one thing closing
              this overlay can't give you. On a shared checkout it's the repo
              dir you already have shells in — no value, so it's omitted. */}
          {ws?.isolated && ws.workdir && (
            <button
              className="btn"
              title={`Open a shell in the worktree: ${ws.workdir}`}
              onClick={() => onOpenTerminal(ws.workdir as string, ws.branch ?? agent)}
            >
              New shell in worktree
            </button>
          )}
          <button
            className="btn-icon aw-refresh"
            title="Refresh — re-read this agent's changes"
            aria-label="Refresh"
            onClick={() => setTick((t) => t + 1)}
          >
            <RestartIcon size={14} />
          </button>
          {onClose && (
            <button
              className="btn-icon workspace-overlay-close"
              title="Close (Esc)"
              aria-label="Close agent workspace"
              onClick={onClose}
            >
              ✕
            </button>
          )}
        </div>
        {task && <div className="agent-task">{task}</div>}
        {/* What this agent is costing and doing — read from its own CLI store
            (works for a hookless codex too); the state chip only appears when a
            hook reports it. */}
        {(usage || st) && (
          <div className="aw-stats">
            {st && (
              <span className={`aw-stat-state ${st.cls}`} title={`Session state: ${st.label}`}>
                {st.label}
              </span>
            )}
            {usage?.model && (
              <span className="aw-stat aw-stat-model" title="Model">
                {usage.model}
              </span>
            )}
            {usage && sentTokens(usage) > 0 && (
              <>
                <span className="aw-stat" title="Tokens sent (input + cache)">
                  ↑{fmtTokens(sentTokens(usage))}
                </span>
                <span className="aw-stat" title="Tokens received (output)">
                  ↓{fmtTokens(usage.output_tokens)}
                </span>
              </>
            )}
            {cost != null && (
              <span className="aw-stat" title="Cost — estimated unless the CLI reports its own">
                {fmtCost(cost)}
              </span>
            )}
            {usage && usage.turns > 0 && (
              <span className="aw-stat" title="Assistant turns">
                {usage.turns} {usage.turns === 1 ? "turn" : "turns"}
              </span>
            )}
          </div>
        )}
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
          The diff below is the authoritative list. Shown as basename chips
          (full path in the tooltip); clicking one jumps to its diff section.
          Everything past TOUCHED_LIMIT folds into a dropdown so a long session
          doesn't push the diff off-screen. */}
      {touched.length > 0 && (
        <div className="aw-touched">
          <div className="ticket-state-head">
            Files the agent reported editing
            <span className="badge">{touched.length}</span>
          </div>
          <div className="aw-touched-list">
            {touched.slice(0, TOUCHED_LIMIT).map((f) => {
              const target = diffTarget(f);
              return target ? (
                <button
                  key={f}
                  className="aw-touched-file aw-touched-file-link"
                  title={`${f}\n\nJump to this file's diff`}
                  onClick={() => scrollToFile(target)}
                >
                  {basename(f)}
                </button>
              ) : (
                <code key={f} className="aw-touched-file" title={f}>
                  {basename(f)}
                </code>
              );
            })}
            {touched.length > TOUCHED_LIMIT && (
              <div className="aw-touched-more-anchor">
                <button
                  className="aw-touched-file aw-touched-more-btn"
                  onClick={() => setShowMoreTouched((v) => !v)}
                >
                  +{touched.length - TOUCHED_LIMIT} more {showMoreTouched ? "▴" : "▾"}
                </button>
                {showMoreTouched && (
                  <div
                    className="aw-touched-more"
                    onMouseLeave={() => setShowMoreTouched(false)}
                  >
                    {touched.slice(TOUCHED_LIMIT).map((f) => {
                      const target = diffTarget(f);
                      return (
                        <button
                          key={f}
                          className="aw-touched-more-row"
                          title={f}
                          disabled={!target}
                          onClick={() => {
                            if (!target) return;
                            setShowMoreTouched(false);
                            scrollToFile(target);
                          }}
                        >
                          <span className="aw-more-name">{basename(f)}</span>
                          <span className="aw-more-dir">{parentDir(f) || "·"}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {(ws || edits.length > 0) && (
        <div className="branch-panes">
          {edits.length > 0 && (
            <button
              className={`btn-mini ${pane === "edits" ? "btn-accent" : ""}`}
              title="Only the changes this agent made, attributed per hunk — accurate even on a shared checkout"
              onClick={() => setPane("edits")}
            >
              This agent ({edits.length})
            </button>
          )}
          {ws && (
            <button
              className={`btn-mini ${pane === "uncommitted" ? "btn-accent" : ""}`}
              onClick={() => setPane("uncommitted")}
            >
              Uncommitted{ws.dirty > 0 ? ` (${ws.dirty})` : ""}
            </button>
          )}
          {ws && branchable && (
            <button
              className={`btn-mini ${pane === "diff" ? "btn-accent" : ""}`}
              onClick={() => setPane("diff")}
            >
              All changes vs base
            </button>
          )}
          {pane !== "edits" && patch && files.length > 0 && (
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

        {/* This agent's own edits, from the change journal — attributed per
            hunk, so even a file two agents co-edited shows only what THIS one
            did. A superseded edit (a later write replaced it) is kept but
            greyed, because it's still a true record of what the agent did. */}
        {pane === "edits" &&
          (editsByFile.length === 0 ? (
            <div className="tree-empty">No edits recorded for this agent yet.</div>
          ) : (
            editsByFile.map((g) => (
              <div key={g.path} className="pr-file">
                <FileName
                  path={g.path}
                  count={g.items.length}
                  countTitle={`${g.items.length} edit${g.items.length === 1 ? "" : "s"} by this agent`}
                />
                {g.items.map((e, i) => (
                  <div
                    key={i}
                    className={`aw-edit ${e.present ? "" : "aw-edit-superseded"}`}
                    title={
                      e.present
                        ? `${e.tool} · still in the file`
                        : `${e.tool} · superseded by a later change`
                    }
                  >
                    {!e.present && <span className="aw-edit-tag">superseded</span>}
                    <DiffView
                      data={{
                        hunks: [editToHunk(g.path, e.old, e.new)],
                        oldFile: { fileName: g.path },
                        newFile: { fileName: g.path },
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
            ))
          ))}

        {/* Only this agent's own files — never the rest of a shared checkout.
            When none can be attributed, we say so plainly rather than pass the
            whole tree off as this agent's work. */}
        {pane !== "edits" &&
          (!ws ? (
            !wsErr && repo && <div className="tree-empty">Loading workspace…</div>
          ) : !patch ? (
            pane && <div className="tree-empty">Loading diff…</div>
          ) : mine.length === 0 ? (
            <div className="tree-empty">
              No changes by this agent{pane === "uncommitted" ? " yet" : ""}.
              {!canAttribute && (
                <div className="aw-note">
                  It ran on a shared checkout without reporting its edits, so its
                  changes can't be told apart from the rest of the tree. Run it
                  in an isolated worktree, or with a CLI that reports edits, to
                  see them here.
                </div>
              )}
            </div>
          ) : (
            mine.map(renderFile)
          ))}
        {patch?.truncated && pane !== "edits" && (
          <div className="tree-empty">
            Diff truncated at 2 MB — use <code>git diff</code> for the whole thing.
          </div>
        )}
      </div>
    </div>
  );
}

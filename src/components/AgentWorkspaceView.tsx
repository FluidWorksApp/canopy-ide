// An agent opened as a tab: everything the session produced, in one place —
// the branch it works on, its uncommitted changes, the commits it added, and
// the PR raised from that branch. Same split as BranchView: metadata paints
// first (one backend join, no patch bytes), each patch loads per pane, and
// commit rows hand off to the commit tab rather than a second renderer.
import { useEffect, useMemo, useRef, useState } from "react";
import { DiffView, DiffModeEnum, SplitSide } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { createTwoFilesPatch } from "diff";
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
  /** Deliver a message to the agent that owns this workspace — typed into its
   *  live PTY, or resumed first if the session has ended. Absent (or a resolved
   *  `delivered:false`) means the review comments can't be sent, so the compose
   *  UI stays but "Send" reports why. */
  onMessageAgent?: (text: string) => Promise<{ delivered: boolean; note: string }>;
  /** When set, the header shows a close button — the overlay is the single
   *  banner. The standalone agent tab omits it (the tab closes itself). */
  onClose?: () => void;
}

/** A review comment the user attached to a diff line, held as a draft until
 *  they send some or all of them to the agent. Persisted per session so a
 *  half-written review survives closing the workspace. */
interface DraftComment {
  id: string;
  /** Which DiffView the comment is anchored in — the pane plus the file, and
   *  for the journal pane the edit index too, since each edit is its own view
   *  with line numbers that restart at 1. */
  diffKey: string;
  pane: Pane;
  file: string;
  side: "old" | "new";
  line: number;
  /** The code the comment is about, captured at write time for the message. */
  code: string;
  /** True when the line number is a real file line (git panes) rather than a
   *  fragment-relative one (journal edits) — decides whether we cite `file:line`. */
  realLine: boolean;
  body: string;
  selected: boolean;
}

type Pane = "edits" | "uncommitted" | "diff";

// The single-file shape we hand DiffView — one file's hunks plus its name on
// each side, and optionally the full before/after text (which the viewer needs
// to enable line numbers and the expand-context control). Cached by identity so
// a re-render doesn't rebuild the diff.
type DiffViewData = {
  hunks: string[];
  oldFile: { fileName: string; content?: string };
  newFile: { fileName: string; content?: string };
};

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
// prefix/suffix keeps the hunk to the part that actually changed.
//
// The `---`/`+++` header is REQUIRED, verified in a real browser: the React
// DiffView renders rows only from real diff hunks, and a hunk with no file
// header parses to nothing (empty tbody, blank card). Handing it the raw
// old/new as file *content* with empty hunks does NOT work — the core can
// diff content but the React component does not — so we author the hunk.
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

const untrunc = (s: string | null | undefined) =>
  (s ?? "").replace(/\n?…\(truncated\)$/, "");

/** First line index (0-based) where `block` appears contiguously in `lines`, or
 *  -1. Used to place a journal edit at its real position in the current file. */
function locateBlock(lines: string[], block: string[]): number {
  if (!block.length) return -1;
  for (let i = 0; i + block.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < block.length; j++) {
      if (lines[i + j] !== block[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

// Turn a file's journal edits into a real before→after pair, so the "This agent"
// pane reads like a normal file diff — real line numbers, gaps between edits,
// and the expand-context control — instead of a stack of fragments each numbered
// from 1. Each edit's `new` text is located in the current file, then the
// `before` version is reconstructed by swapping every new block back to its old
// one; jsdiff produces the unified diff, and handing the viewer both full
// contents is what enables line numbers + expansion. Returns null when any edit
// can't be placed cleanly (superseded, moved, or overlapping a neighbour), so
// the caller falls back to fragment rendering — still a true record.
function buildFileEdit(
  path: string,
  content: string,
  items: ipc.AgentEdit[],
): { patch: string; before: string } | null {
  const fileLines = content.split("\n");
  // Only edits still present in the file are part of its net change — a
  // superseded edit was overwritten by a later one and would double-count.
  // Anything we can't place (text no longer matches) or that overlaps a kept
  // edit is skipped, not fatal: the reconstruction just needs disjoint blocks,
  // and a partial-but-real diff beats a stack of fragments numbered from 1.
  const placed: { at: number; oldLines: string[]; newLen: number }[] = [];
  for (const e of items) {
    if (!e.present) continue;
    const nt = untrunc(e.new);
    if (!nt) continue;
    const newLines = nt.split("\n");
    const at = locateBlock(fileLines, newLines);
    if (at < 0) continue;
    const ot = untrunc(e.old);
    placed.push({ at, oldLines: ot === "" ? [] : ot.split("\n"), newLen: newLines.length });
  }
  if (!placed.length) return null;
  placed.sort((a, b) => a.at - b.at);
  const kept: typeof placed = [];
  for (const p of placed) {
    const last = kept[kept.length - 1];
    if (last && p.at < last.at + last.newLen) continue; // overlaps the previous — skip
    kept.push(p);
  }
  // Reconstruct `before` by swapping each new block back to its old text,
  // right-to-left so earlier indices stay valid as later blocks change length.
  const beforeLines = fileLines.slice();
  for (let i = kept.length - 1; i >= 0; i--) {
    const p = kept[i];
    beforeLines.splice(p.at, p.newLen, ...p.oldLines);
  }
  const before = beforeLines.join("\n");
  if (before === content) return null; // nothing placeable resolved to a change
  const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, before, content);
  return { patch, before };
}

const sideName = (s: number) => (s === SplitSide.old ? "old" : "new");

// The inline composer the diff viewer drops on a line when you click the "+".
// Deliberately tiny: a textarea, add/cancel, ⌘/Ctrl+Enter to add. It owns only
// its own draft text; the saved comment lives in the workspace's state.
function CommentComposer({
  onAdd,
  onCancel,
}: {
  onAdd: (body: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const commit = () => {
    const b = text.trim();
    if (b) onAdd(b);
    else onCancel();
  };
  return (
    <div className="aw-cc" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        className="aw-cc-input"
        placeholder="Comment for the agent — ⌘⏎ to add"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="aw-cc-actions">
        <button className="btn-mini btn-accent" onClick={commit}>
          Add comment
        </button>
        <button className="btn-mini" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// A saved comment shown inline under its line: the body, a select checkbox (for
// batch send), and remove. Editing is delete-and-re-add — deliberately cheap.
function CommentCard({
  c,
  onToggle,
  onRemove,
}: {
  c: DraftComment;
  onToggle: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="aw-comment" onClick={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        className="aw-comment-sel"
        checked={c.selected}
        onChange={onToggle}
        title="Include when sending to the agent"
      />
      <div className="aw-comment-body">{c.body}</div>
      <button className="btn-icon aw-comment-x" title="Remove comment" onClick={onRemove}>
        ✕
      </button>
    </div>
  );
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
  onMessageAgent,
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

  // Review comments the user is drafting on the diff, to send to the agent.
  // Keyed to the session (falling back to agent+cwd) and mirrored to
  // localStorage, so a half-written review survives closing the workspace.
  const commentsKey = `aw-comments:${sessionId || `${agent}:${cwd}`}`;
  const [comments, setComments] = useState<DraftComment[]>([]);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(commentsKey);
      setComments(raw ? (JSON.parse(raw) as DraftComment[]) : []);
    } catch {
      setComments([]);
    }
  }, [commentsKey]);
  useEffect(() => {
    try {
      if (comments.length) localStorage.setItem(commentsKey, JSON.stringify(comments));
      else localStorage.removeItem(commentsKey);
    } catch {
      // storage full/blocked — the in-memory drafts still work this session.
    }
  }, [comments, commentsKey]);
  const addComment = (c: Omit<DraftComment, "id" | "selected">) =>
    setComments((prev) => [
      ...prev,
      { ...c, id: `${c.diffKey}:${c.side}:${c.line}:${prev.length}:${c.body.length}`, selected: true },
    ]);
  const toggleComment = (id: string) =>
    setComments((prev) => prev.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c)));
  const removeComment = (id: string) => setComments((prev) => prev.filter((c) => c.id !== id));
  const setAllSelected = (v: boolean) =>
    setComments((prev) => prev.map((c) => ({ ...c, selected: v })));
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

  // Current contents of the files the agent edited, so the journal pane can show
  // one real diff per file (real line numbers) instead of numbered-from-1
  // fragments. Read straight off disk — repo-relative journal paths are joined to
  // the repo, absolute ones (scratchpad, memory) used as-is.
  const [fileContents, setFileContents] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let live = true;
    const paths = [...new Set(edits.filter((e) => e.present).map((e) => e.path))];
    if (!paths.length) {
      setFileContents(new Map());
      return;
    }
    const abs = (p: string) => (p.startsWith("/") ? p : repo ? `${repo}/${p}` : p);
    void Promise.all(
      paths.map(async (p) => {
        try {
          return [p, await ipc.fsReadText(abs(p))] as const;
        } catch {
          return [p, null] as const;
        }
      }),
    ).then((pairs) => {
      if (!live) return;
      const m = new Map<string, string>();
      for (const [p, c] of pairs) if (c != null) m.set(p, c);
      setFileContents(m);
    });
    return () => {
      live = false;
    };
  }, [edits, repo]);

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
  // Split once per patch, not per render: a fresh array each render would give
  // every DiffView a new `data` identity, which rebuilds its diff and resets any
  // open comment composer on the next digest poll.
  const files = useMemo(() => (patch?.patch ? splitPatch(patch.patch) : []), [patch?.patch]);

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

  // Comment wiring for a single DiffView: the "+" affordance, the inline
  // composer on a clicked line, and the saved comments shown under their line.
  // `diffKey` scopes comments to this exact view — for the journal pane that
  // includes the edit index, since each edit is its own view with line numbers
  // that restart at 1. Commenting is offered only when we can actually deliver.
  const commentProps = (diffKey: string, file: string, forPane: Pane, realLine: boolean) => {
    const oldFile: Record<number, { data: DraftComment[] }> = {};
    const newFile: Record<number, { data: DraftComment[] }> = {};
    for (const c of comments) {
      if (c.diffKey !== diffKey) continue;
      const bucket = c.side === "old" ? oldFile : newFile;
      (bucket[c.line] ??= { data: [] }).data.push(c);
    }
    return {
      diffViewAddWidget: !!onMessageAgent,
      extendData: { oldFile, newFile },
      renderWidgetLine: ({
        diffFile,
        side,
        lineNumber,
        onClose,
      }: {
        diffFile: {
          getOldPlainLine: (n: number) => { value?: string } | undefined;
          getNewPlainLine: (n: number) => { value?: string } | undefined;
        };
        side: number;
        lineNumber: number;
        onClose: () => void;
      }) => {
        const lo =
          side === SplitSide.old
            ? diffFile.getOldPlainLine(lineNumber)
            : diffFile.getNewPlainLine(lineNumber);
        const code = (lo?.value ?? "").toString();
        return (
          <CommentComposer
            onAdd={(body) => {
              addComment({
                diffKey,
                pane: forPane,
                file,
                side: sideName(side) as "old" | "new",
                line: lineNumber,
                code,
                realLine,
                body,
              });
              onClose();
            }}
            onCancel={onClose}
          />
        );
      },
      renderExtendLine: ({ data }: { data?: DraftComment[] }) => {
        const list = data ?? [];
        if (!list.length) return null;
        return (
          <div className="aw-extend">
            {list.map((c) => (
              <CommentCard
                key={c.id}
                c={c}
                onToggle={() => toggleComment(c.id)}
                onRemove={() => removeComment(c.id)}
              />
            ))}
          </div>
        );
      },
    };
  };

  // The review, formatted for the agent: numbered, each citing where it lands
  // (file:line for git panes, file + the code for journal fragments) and quoting
  // the line so the agent needn't reopen the diff to know what's meant.
  const formatReview = (list: DraftComment[]) => {
    const where = ws?.branch ? ` on ${ws.branch}` : "";
    const out = [`Review comments${where} (${list.length}) from the Canopy workspace:`, ""];
    list.forEach((c, i) => {
      out.push(`${i + 1}. ${c.realLine ? `${c.file}:${c.line}` : c.file}`);
      if (c.code.trim()) out.push(`   \`${c.code.trim()}\``);
      out.push(`   ${c.body.replace(/\n/g, "\n   ")}`, "");
    });
    return out.join("\n").trimEnd();
  };

  const sendComments = async (which: "selected" | "all") => {
    const list = which === "all" ? comments : comments.filter((c) => c.selected);
    if (!list.length || !onMessageAgent || sending) return;
    setSending(true);
    try {
      const res = await onMessageAgent(formatReview(list));
      if (res.delivered) {
        const ids = new Set(list.map((c) => c.id));
        setComments((prev) => prev.filter((c) => !ids.has(c.id)));
        onNotice(
          res.note || `Sent ${list.length} comment${list.length === 1 ? "" : "s"} to ${agent}.`,
          "success",
        );
      } else {
        onNotice(res.note || "Couldn't reach the agent.", "warn");
      }
    } catch (e) {
      onNotice(String(e), "error");
    } finally {
      setSending(false);
    }
  };

  const selectedCount = comments.filter((c) => c.selected).length;

  // A stable `data` object per (view, content): DiffView rebuilds its diff — and
  // drops any open composer — whenever `data` changes identity, so we hand back
  // the same object until the hunk actually changes.
  const dataCache = useRef(new Map<string, { sig: string; data: DiffViewData }>());
  const dataFor = (
    key: string,
    path: string,
    hunk: string,
    before?: string,
    after?: string,
  ): DiffViewData => {
    const sig = `${hunk} ${before?.length ?? -1} ${after?.length ?? -1}`;
    const hit = dataCache.current.get(key);
    if (hit && hit.sig === sig) return hit.data;
    const data: DiffViewData = {
      hunks: [hunk],
      oldFile: { fileName: path, content: before },
      newFile: { fileName: path, content: after },
    };
    dataCache.current.set(key, { sig, data });
    return data;
  };

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
        data={dataFor(`${pane}:${f.path}`, f.path, f.patch)}
        diffViewMode={split ? DiffModeEnum.Split : DiffModeEnum.Unified}
        diffViewHighlight
        diffViewTheme="dark"
        diffViewWrap
        diffViewFontSize={12}
        {...commentProps(`${pane}:${f.path}`, f.path, pane ?? "diff", true)}
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

      {/* The review tray: appears once there are draft comments. Send the
          selected ones, or all of them, to the agent in one message — or clear
          the draft. Hidden entirely when nothing can be delivered. */}
      {onMessageAgent && comments.length > 0 && (
        <div className="aw-review-bar">
          <span className="aw-review-count">
            {comments.length} comment{comments.length === 1 ? "" : "s"}
            {selectedCount !== comments.length ? ` · ${selectedCount} selected` : ""}
          </span>
          <label className="aw-review-all">
            <input
              type="checkbox"
              checked={selectedCount === comments.length}
              ref={(el) => {
                if (el) el.indeterminate = selectedCount > 0 && selectedCount < comments.length;
              }}
              onChange={(e) => setAllSelected(e.target.checked)}
            />
            All
          </label>
          <span className="git-spacer" />
          <button
            className="btn-mini btn-accent"
            disabled={sending || selectedCount === 0}
            onClick={() => sendComments("selected")}
          >
            {sending ? "Sending…" : `Send selected (${selectedCount})`}
          </button>
          <button
            className="btn-mini"
            disabled={sending}
            onClick={() => sendComments("all")}
            title="Send every comment, regardless of selection"
          >
            Send all
          </button>
          <button
            className="btn-mini"
            disabled={sending}
            onClick={() => setComments([])}
            title="Discard all draft comments"
          >
            Clear
          </button>
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
            editsByFile.map((g) => {
              // One real diff for the whole file when every edit can be placed in
              // the current content — real line numbers and gaps between edits,
              // like a normal file diff. Otherwise fall back to per-edit fragments
              // (a superseded or moved edit can't be placed, but is still true).
              const content = fileContents.get(g.path);
              const merged = content != null ? buildFileEdit(g.path, content, g.items) : null;
              return (
                <div key={g.path} className="pr-file">
                  <FileName
                    path={g.path}
                    count={g.items.length}
                    countTitle={`${g.items.length} edit${g.items.length === 1 ? "" : "s"} by this agent`}
                  />
                  {merged && content != null ? (
                    <DiffView
                      data={dataFor(`edits:${g.path}`, g.path, merged.patch, merged.before, content)}
                      diffViewMode={split ? DiffModeEnum.Split : DiffModeEnum.Unified}
                      diffViewHighlight
                      diffViewTheme="dark"
                      diffViewWrap
                      diffViewFontSize={12}
                      {...commentProps(`edits:${g.path}`, g.path, "edits", true)}
                    />
                  ) : (
                    g.items.map((e, i) => (
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
                        {/* A fragment: the edit's own old→new, numbered from 1 —
                            used only when the edit can't be placed in the file. */}
                        <DiffView
                          data={dataFor(
                            `edits:${g.path}:${i}`,
                            g.path,
                            editToHunk(g.path, e.old, e.new),
                          )}
                          diffViewMode={split ? DiffModeEnum.Split : DiffModeEnum.Unified}
                          diffViewHighlight
                          diffViewTheme="dark"
                          diffViewWrap
                          diffViewFontSize={12}
                          {...commentProps(`edits:${g.path}:${i}`, g.path, "edits", false)}
                        />
                      </div>
                    ))
                  )}
                </div>
              );
            })
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

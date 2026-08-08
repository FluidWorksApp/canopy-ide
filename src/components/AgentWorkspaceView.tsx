// An agent opened as a tab: everything the session produced, in one place —
// the branch it works on, its uncommitted changes, the commits it added, and
// the PR raised from that branch. Same split as BranchView: metadata paints
// first (one backend join, no patch bytes), each patch loads per pane, and
// commit rows hand off to the commit tab rather than a second renderer.
import { useEffect, useMemo, useRef, useState } from "react";
import { DiffView, DiffModeEnum, SplitSide } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { createTwoFilesPatch } from "diff";
import { basename } from "../paths";
import { fmtTokens } from "../format";
import * as ipc from "../ipc";
import type { Notify } from "../types";
import { useBranchSwitch } from "../useBranchSwitch";
import { splitPatch } from "./PrView";
import { lastHumanPrompt } from "../agentSessions";
import { ashFor } from "../ash";
import { Mascot } from "./Mascot";
import { AgentRuntime } from "./AgentRuntime";
import { LIFE_META, agentLife } from "../../shared/agentLife";
import { AgentIcon, GitBranchIcon, RestartIcon } from "./icons";
import { sessionCost } from "../pricing";
import {
  addressPrCommentsTask,
  raisePrTask,
  reviewPrTask,
  type CustomMicroTask,
} from "../microTasks";
import {
  BUILT_IN_HEADING,
  CUSTOM_HEADING,
  ONE_OFF_HEADING,
  type TaskChoice,
} from "../taskMenu";
import { Button } from "./ui";
import { format, matches } from "../shortcuts";
import { PROVENANCE_EVENT } from "../provenance";
import { agentGitTrail } from "../agentGitTrail";
import { sizeLimitFor } from "../fileOpen";
import { type IoBudget, rendererIoBudget } from "../ioBudget";

const fmtCost = (n: number) =>
  n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
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
  /** Open a PR this session raised, by number — it may be merged or closed, so
   *  there is no `PrInfo` in hand to pass to `onOpenPr`. */
  onOpenPrNumber?: (repo: string, number: number, url: string) => void;
  onOpenTerminal: (cwd: string, label: string) => void;
  onNotice: Notify;
  /** Deliver a message to the agent that owns this workspace — typed into its
   *  live PTY, or resumed first if the session has ended. Absent (or a resolved
   *  `delivered:false`) means the review comments can't be sent, so the compose
   *  UI stays but "Send" reports why. */
  onMessageAgent?: (
    text: string,
  ) => Promise<{ delivered: boolean; note: string; ptyId?: number | null }>;
  /** Bring the agent's terminal to the front. Called after comments land, so
   *  the review ends where the answer will appear rather than on the diff the
   *  agent is about to change. */
  onFocusAgent?: (ptyId: number) => void;
  /** When set, the header shows a close button — the overlay is the single
   *  banner. The standalone agent tab omits it (the tab closes itself). */
  onClose?: () => void;
  /** Run a one-shot task on what this agent produced: push its branch and open
   *  the PR, review the PR that came out of it, address the comments that PR
   *  came back with, or any task the user saved. Separate from onMessageAgent —
   *  a task is a fresh ephemeral agent, not a message to this one. */
  onRaisePrTask?: (branch: string, worktree: string | null) => void;
  onReviewPrTask?: (pr: ipc.PrInfo) => void;
  onAddressPrCommentsTask?: (pr: ipc.PrInfo) => void;
  onRunSavedTask?: (task: CustomMicroTask, dir: string) => void;
  /** The project's own custom tasks, for the Run task menu. */
  savedTasks?: CustomMicroTask[];
  /** Run a brief typed right here, once, saving nothing. */
  onRunOneOff?: (brief: string, dir: string) => void;
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

const parentDir = (p: string) =>
  p.split("/").filter(Boolean).slice(-2, -1)[0] ?? "";

/** A file-card header: the directory dimmed, the filename emphasized, and an
 *  optional count badge — so a wall of full paths reads as filenames first,
 *  the folder as context. Shared by the edits pane and the diff panes. */
function FileName({
  path,
  count,
  countTitle,
}: {
  path: string;
  count?: number;
  countTitle?: string;
}) {
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
function editToHunk(
  path: string,
  old: string | null,
  next: string | null,
): string {
  const oldLines = old != null ? old.split("\n") : [];
  const newLines = next != null ? next.split("\n") : [];
  let p = 0;
  while (
    p < oldLines.length &&
    p < newLines.length &&
    oldLines[p] === newLines[p]
  )
    p++;
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
  const ctxPost = oldLines
    .slice(oldLines.length - s, oldLines.length - s + 2)
    .map((l) => ` ${l}`);
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
    placed.push({
      at,
      oldLines: ot === "" ? [] : ot.split("\n"),
      newLen: newLines.length,
    });
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

// Cheap deep-equality for polled payloads. The point isn't the comparison, it's
// keeping the old object when nothing changed: a new identity re-renders the
// diff below, and a rebuilt diff drops whatever comment was being written into
// it. Both are small — a session's journal and the files it touched.
export const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export const sameMap = (a: Map<string, string>, b: Map<string, string>) =>
  a.size === b.size && [...b].every(([k, v]) => a.get(k) === v);

/** Reading every journaled file at once made one review tab a filesystem and
 * renderer-memory fan-out. Keep the familiar editor per-file ceiling, then add
 * a much smaller aggregate budget for this derived view: Monaco remains the
 * place to open a large file deliberately. */
export const AGENT_FILE_READ_CONCURRENCY = 3;
export const AGENT_FILE_MAX_BYTES = sizeLimitFor("code");
export const AGENT_FILE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_DIFF_DATA_CACHE = 128;

interface AgentFileReadLimits {
  concurrency: number;
  perFileBytes: number;
  totalBytes: number;
  scope?: string;
  signal?: AbortSignal;
  budget?: IoBudget;
}

interface AgentFileReader {
  stat: (path: string) => Promise<{ is_dir: boolean; size: number }>;
  statMany?: (
    paths: string[],
  ) => Promise<Array<{ path: string; is_dir: boolean; size: number }>>;
  readText: (path: string, maxBytes?: number) => Promise<string>;
}

/** A bounded, supersedable loader split out for a real concurrency test. The
 * native invoke cannot currently be aborted once it starts, but `current`
 * prevents a superseded generation from starting more work or retaining what
 * finishes late. */
export async function loadAgentFileContents(
  paths: string[],
  absolute: (path: string) => string,
  reader: AgentFileReader = {
    stat: ipc.fsStat,
    statMany: ipc.fsStatMany,
    readText: ipc.fsReadText,
  },
  current: () => boolean = () => true,
  limits: AgentFileReadLimits = {
    concurrency: AGENT_FILE_READ_CONCURRENCY,
    perFileBytes: AGENT_FILE_MAX_BYTES,
    totalBytes: AGENT_FILE_TOTAL_BYTES,
  },
): Promise<Map<string, string>> {
  const unique = [...new Set(paths)];
  const out = new Map<string, string>();
  const resolved = new Map(unique.map((path) => [path, absolute(path)]));
  const prefetched = new Map<string, { is_dir: boolean; size: number }>();
  let cursor = 0;
  let reservedBytes = 0;
  const alive = () => current() && !limits.signal?.aborted;

  if (reader.statMany && unique.length > 1 && alive()) {
    try {
      for (const stat of await reader.statMany([...resolved.values()])) {
        prefetched.set(stat.path, stat);
      }
    } catch {
      // Compatibility with an older native core: individual stat calls below
      // retain the same bounded behaviour.
    }
  }

  const worker = async () => {
    while (alive()) {
      const at = cursor++;
      const path = unique[at];
      if (path == null) return;
      const absolutePath = resolved.get(path)!;
      try {
        const stat =
          prefetched.get(absolutePath) ?? (await reader.stat(absolutePath));
        if (!alive()) return;
        if (
          stat.is_dir ||
          stat.size > limits.perFileBytes ||
          reservedBytes + stat.size > limits.totalBytes
        ) {
          continue;
        }
        // Reserve before the await. JavaScript runs this section atomically, so
        // sibling workers cannot all admit themselves against the same budget.
        reservedBytes += stat.size;
        const text = await (limits.budget ?? rendererIoBudget).run(
          {
            scope: limits.scope ?? "agent-workspace",
            bytes: stat.size,
            signal: limits.signal,
          },
          () => reader.readText(absolutePath, limits.perFileBytes),
        );
        if (!alive()) return;
        out.set(path, text);
      } catch {
        // A file can disappear or be mid-write while the journal is settling.
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, limits.concurrency), unique.length) },
      () => worker(),
    ),
  );
  return alive() ? out : new Map();
}

/** The digest as this view hands it to the lifecycle ladder: the workspace
 *  join's fresher copy of each field over the digest the panel opened the tab
 *  with. `store` and `foreign` must ride along — the ladder keys
 *  `digestUsable` on them, and rebuilding the digest without them made a
 *  store-only or foreign-instance row read as a real state instead of
 *  `unknown`. Exported for the test that pins exactly that. */
export const workspaceLifeDigest = (
  ws: Pick<ipc.AgentWorkspace, "state" | "state_via" | "updated"> | null,
  digest?: ipc.SessionDigest,
) => ({
  state: ws?.state ?? digest?.state,
  state_via: ws?.state_via ?? digest?.state_via,
  updated: ws?.updated ?? digest?.updated,
  agent: digest?.agent,
  store: digest?.store,
  foreign: digest?.foreign,
});

// The inline composer the diff viewer drops on a line when you click the "+".
// Deliberately tiny: a textarea, add/cancel, and the submit chord. The saved
// comment lives in the workspace's state — and so does the half-typed one:
// holding the draft here would lose it every time the agent under review
// touched a file and the diff below rebuilt.
export function CommentComposer({
  text,
  onText,
  onAdd,
  onCancel,
}: {
  text: string;
  onText: (v: string) => void;
  onAdd: (body: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Reopened on a restored draft: put the caret where they left off, not
    // in front of their own sentence.
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
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
        placeholder={`Comment for the agent — ${format("submit")} to add`}
        value={text}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (matches(e, "submit")) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="aw-cc-actions">
        <Button size="sm" variant="accent" onClick={commit}>
          Add comment
        </Button>
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
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
      <Button icon className="aw-comment-x"
        title="Remove comment"
        onClick={onRemove}>
        ✕
      </Button>
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
  onOpenPrNumber,
  onOpenTerminal,
  onNotice,
  onMessageAgent,
  onFocusAgent,
  onClose,
  onRaisePrTask,
  onReviewPrTask,
  onAddressPrCommentsTask,
  onRunSavedTask,
  // The project's list, handed down: saving one in the Tasks panel updates the
  // project, which re-renders this, so the menu can't go stale.
  savedTasks = [],
  onRunOneOff,
}: AgentWorkspaceViewProps) {
  const { switchTo, openThere } = useBranchSwitch();
  const [taskMenu, setTaskMenu] = useState(false);
  /** The one-off brief being typed in the Run task menu, or null when that row
   *  is still just a row. */
  const [oneOff, setOneOff] = useState<string | null>(null);
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
      if (comments.length)
        localStorage.setItem(commentsKey, JSON.stringify(comments));
      else localStorage.removeItem(commentsKey);
    } catch {
      // storage full/blocked — the in-memory drafts still work this session.
    }
  }, [comments, commentsKey]);
  // Half-typed comments, by line, held above the diff so a rebuild underneath
  // can't take them. Cleared when the comment is added or the composer
  // cancelled — a draft only outlives the widget, not the decision.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const setDraft = (key: string, v: string) =>
    setDrafts((prev) => ({ ...prev, [key]: v }));
  const dropDraft = (key: string) =>
    setDrafts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  const addComment = (c: Omit<DraftComment, "id" | "selected">) =>
    setComments((prev) => [
      ...prev,
      {
        ...c,
        id: `${c.diffKey}:${c.side}:${c.line}:${prev.length}:${c.body.length}`,
        selected: true,
      },
    ]);
  const toggleComment = (id: string) =>
    setComments((prev) =>
      prev.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c)),
    );
  const removeComment = (id: string) =>
    setComments((prev) => prev.filter((c) => c.id !== id));
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
        const byId = sessionId
          ? mine.find((u) => u.session_id === sessionId)
          : undefined;
        const inCwd = mine
          .filter(
            (u) =>
              u.cwd &&
              (u.cwd === cwd || cwd.startsWith(u.cwd) || u.cwd.startsWith(cwd)),
          )
          .sort((a, b) => b.updated - a.updated);
        setUsage(byId ?? inCwd[0] ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [agent, cwd, sessionId, digest?.updated, tick]);

  // Whose journal this is. Changing session is the one time the old edits must
  // go immediately — a poll for the same session must not, or the diff below
  // unmounts and takes any open comment composer with it.
  useEffect(() => {
    setEdits([]);
  }, [repo, sessionId]);
  useEffect(() => {
    let live = true;
    if (!sessionId) return;
    void ipc
      .agentEdits(repo, sessionId)
      // Replace on arrival, and only when it actually differs: the agent under
      // review writes a file every few seconds, and a fresh array each poll
      // would rebuild every DiffView beneath the review being written.
      .then((e) => live && setEdits((prev) => (sameJson(prev, e) ? prev : e)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [repo, sessionId, digest?.updated, tick]);

  // Current contents of the files the agent edited, so the journal pane can show
  // one real diff per file (real line numbers) instead of numbered-from-1
  // fragments. Read straight off disk — repo-relative journal paths are joined to
  // the repo, absolute ones (scratchpad, memory) used as-is.
  const [fileContents, setFileContents] = useState<Map<string, string>>(
    new Map(),
  );
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const paths = [
      ...new Set(edits.filter((e) => e.present).map((e) => e.path)),
    ];
    if (!paths.length) {
      setFileContents((prev) => (prev.size ? new Map() : prev));
      return;
    }
    const abs = (p: string) =>
      /^(?:[A-Za-z]:[\\/]|\/)/.test(p) ? p : repo ? `${repo}/${p}` : p;
    void loadAgentFileContents(paths, abs, undefined, () => live, {
      concurrency: AGENT_FILE_READ_CONCURRENCY,
      perFileBytes: AGENT_FILE_MAX_BYTES,
      totalBytes: AGENT_FILE_TOTAL_BYTES,
      scope: repo ?? "agent-workspace",
      signal: controller.signal,
    }).then((next) => {
      if (!live) return;
      setFileContents((prev) => (sameMap(prev, next) ? prev : next));
    });
    return () => {
      live = false;
      controller.abort();
    };
  }, [edits, repo]);

  // The join: digest re-read fresh + branch/workdir/counts/commits. Refetched
  // on Refresh, whenever the panel hands over a newer digest, and whenever git
  // says this repo or the agent's worktree moved — so a commit or push made in
  // the agent's terminal updates the trail without anyone pressing Refresh.
  const [gitTick, setGitTick] = useState(0);
  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    const workdir = ws?.workdir;
    const sub = ipc.onGitChange((e) => {
      if (cancelled) return;
      if (e.root === repo || (workdir && e.root === workdir))
        setGitTick((t) => t + 1);
    });
    return () => {
      cancelled = true;
      void sub.then((fn) => fn());
    };
  }, [repo, ws?.workdir]); // eslint-disable-line react-hooks/exhaustive-deps
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
  }, [repo, cwd, agent, sessionId, digest?.updated, tick, gitTick]);

  // Open on this agent's own edits when we have them — that's the per-agent
  // view the shared-checkout tree can't give. Otherwise fall back to whichever
  // tree pane has content. Set once, on first load.
  useEffect(() => {
    if (pane) return;
    if (edits.length > 0) setPane("edits");
    else if (ws)
      setPane(
        ws.dirty > 0 || ws.on_base || ws.detached ? "uncommitted" : "diff",
      );
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

  // Every PR this session actually produced, from Canopy's own record
  // (provenance.rs) rather than from a branch match.
  //
  // The branch lookup below is a live view and stays, because it is what
  // carries checks and review state. But it can only ever answer for the branch
  // the session is on *now*, and only while the PR is open — so it goes blank
  // the moment the work merges, the session moves on, or the worktree is
  // detached (which every PR worktree is, by construction). This list does not:
  // it was written when the PR was raised and needs no network to read.
  const [raised, setRaised] = useState<ipc.ProvenanceEdge[]>([]);
  useEffect(() => {
    let live = true;
    setRaised([]);
    if (!sessionId) return;
    void ipc
      .provenanceForSession(sessionId)
      .then((rows) => live && setRaised(rows))
      .catch(() => {});
    const reread = () => {
      void ipc
        .provenanceForSession(sessionId)
        .then((rows) => live && setRaised(rows))
        .catch(() => {});
    };
    window.addEventListener(PROVENANCE_EVENT, reread);
    return () => {
      live = false;
      window.removeEventListener(PROVENANCE_EVENT, reread);
    };
  }, [sessionId]);

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
      .then(
        (prs) => live && setPr(prs.find((p) => p.branch === branch) ?? null),
      )
      .catch(() => live && setPr(null));
    return () => {
      live = false;
    };
  }, [repo, ws?.branch, ws?.detached, ws?.on_base, tick]);

  // The heavy half, per pane, exactly like BranchView: uncommitted diffs run
  // in the agent's own worktree, the cumulative diff against base.
  // Clearing belongs to the view changing, not to re-reading it: switching pane
  // or branch shows something else, a poll shows the same thing again.
  useEffect(() => {
    setPatch(null);
  }, [pane, ws?.branch, ws?.workdir, ws?.isolated]);
  useEffect(() => {
    let live = true;
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
      .then(
        (p) => live && setPatch((prev) => (prev?.patch === p.patch ? prev : p)),
      )
      .catch((e) => live && onNotice(String(e), "error"));
    return () => {
      live = false;
    };
  }, [
    repo,
    ws?.branch,
    ws?.workdir,
    ws?.isolated,
    ws?.detached,
    ws?.on_base,
    pane,
    tick,
    onNotice,
  ]);

  // One verdict for the whole header. It used to compute two: the chip read
  // the raw recorded state and the clock ran it through the decay function with
  // `cpu: 0` hard-coded, so the same header could show a green "working" chip
  // twelve pixels from a stopped stopwatch and both were doing what they were
  // told.
  const life = agentLife({
    digest: workspaceLifeDigest(ws, digest) as never,
    // No process evidence reaches this view, so a working claim decays on
    // silence alone. That is the conservative half of the rule the Agents panel
    // applies with the process tree to hand: it under-reports a busy agent
    // rather than pulsing green for one that died.
    now: Date.now() / 1000,
  });
  const lifecycle = life.state;
  const st = LIFE_META[lifecycle];
  const task = lastHumanPrompt(digest?.prompts);
  // The working-time clock, preferring the freshly-joined workspace (re-read on
  // every poll) over the digest the panel handed us when the tab opened.
  const timing = {
    active_secs: ws?.active_secs ?? digest?.active_secs,
    run_secs: ws?.run_secs ?? digest?.run_secs,
    updated: ws?.updated ?? digest?.updated,
  };
  const working = lifecycle === "working";
  const cost = usage ? sessionCost(usage) : null;
  const touched = ws?.touched?.length ? ws.touched : (digest?.files ?? []);
  const branchable = !!ws?.branch && !ws.detached && !ws.on_base;
  /** Hand the typed brief to a fresh one-shot agent and put the menu away.
   *  Shared by the Run button and the Enter key so the two can't drift. */
  const runOneOff = () => {
    const brief = oneOff?.trim();
    if (!brief || !onRunOneOff) return;
    setTaskMenu(false);
    setOneOff(null);
    onRunOneOff(brief, ws?.workdir ?? cwd);
  };
  // Split once per patch, not per render: a fresh array each render would give
  // every DiffView a new `data` identity, which rebuilds its diff and resets any
  // open comment composer on the next digest poll.
  const files = useMemo(
    () => (patch?.patch ? splitPatch(patch.patch) : []),
    [patch?.patch],
  );

  // The set of paths this agent is known to have touched — from its own edit
  // journal and its reported-editing list. Matched by basename too, since a
  // journal path (repo-relative) and a diff path can differ by a worktree
  // prefix.
  const agentPaths = new Set<string>([...edits.map((e) => e.path), ...touched]);
  const agentBasenames = new Set<string>([...agentPaths].map(basename));
  const isAgentFile = (p: string) =>
    agentPaths.has(p) || agentBasenames.has(basename(p));
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
  const editsByFile = useMemo(() => {
    const groups: { path: string; items: ipc.AgentEdit[] }[] = [];
    for (const e of edits) {
      const g = groups.find((x) => x.path === e.path);
      if (g) g.items.push(e);
      else groups.push({ path: e.path, items: [e] });
    }
    return groups;
  }, [edits]);

  // The merged whole-file diffs, built once per (edits, contents) change —
  // buildFileEdit splits the entire file per call, too heavy for a render body.
  const mergedEdits = useMemo(() => {
    const m = new Map<string, { patch: string; before: string } | null>();
    for (const g of editsByFile) {
      const content = fileContents.get(g.path);
      if (content != null)
        m.set(g.path, buildFileEdit(g.path, content, g.items));
    }
    return m;
  }, [editsByFile, fileContents]);

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
  const commentProps = (
    diffKey: string,
    file: string,
    forPane: Pane,
    realLine: boolean,
  ) => {
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
        const draftKey = `${diffKey}:${sideName(side)}:${lineNumber}`;
        return (
          <CommentComposer
            text={drafts[draftKey] ?? ""}
            onText={(v) => setDraft(draftKey, v)}
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
              dropDraft(draftKey);
              onClose();
            }}
            onCancel={() => {
              dropDraft(draftKey);
              onClose();
            }}
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
    const out = [
      `Review comments${where} (${list.length}) from the Canopy workspace:`,
      "",
    ];
    list.forEach((c, i) => {
      out.push(`${i + 1}. ${c.realLine ? `${c.file}:${c.line}` : c.file}`);
      if (c.code.trim()) out.push(`   \`${c.code.trim()}\``);
      out.push(`   ${c.body.replace(/\n/g, "\n   ")}`, "");
    });
    return out.join("\n").trimEnd();
  };

  const sendComments = async (which: "selected" | "all") => {
    const list =
      which === "all" ? comments : comments.filter((c) => c.selected);
    if (!list.length || !onMessageAgent || sending) return;
    setSending(true);
    try {
      const res = await onMessageAgent(formatReview(list));
      if (res.delivered) {
        const ids = new Set(list.map((c) => c.id));
        setComments((prev) => prev.filter((c) => !ids.has(c.id)));
        onNotice(
          res.note ||
            `Sent ${list.length} comment${list.length === 1 ? "" : "s"} to ${agent}.`,
          "success",
        );
        // The review is over the moment it's delivered: get out of the way and
        // put the agent that's now acting on it in front. Only on success —
        // a failed send leaves the comments and the workspace where they were.
        onClose?.();
        if (res.ptyId != null) onFocusAgent?.(res.ptyId);
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
  const dataCache = useRef(
    new Map<
      string,
      {
        hunk: string;
        before?: string;
        after?: string;
        data: DiffViewData;
      }
    >(),
  );
  // Only the currently rendered pane owns diff-view data. Keeping prior panes'
  // whole-file before/after strings made switching panes an append-only cache.
  useEffect(() => {
    const live = new Set<string>();
    if (pane === "edits") {
      for (const group of editsByFile) {
        if (mergedEdits.get(group.path) && fileContents.has(group.path)) {
          live.add(`edits:${group.path}`);
        } else {
          group.items.forEach((_, index) => live.add(`edits:${group.path}:${index}`));
        }
      }
    } else if (pane === "uncommitted" || pane === "diff") {
      for (const file of mine) live.add(`${pane}:${file.path}`);
    }
    for (const key of dataCache.current.keys()) {
      if (!live.has(key)) dataCache.current.delete(key);
    }
  }, [pane, editsByFile, mergedEdits, fileContents, mine]);

  const dataFor = (
    key: string,
    path: string,
    hunk: string,
    before?: string,
    after?: string,
  ): DiffViewData => {
    const hit = dataCache.current.get(key);
    // Compare the strings directly. The old signature interpolated the entire
    // hunk into a second retained string and only compared baseline lengths,
    // which both doubled large patches and could return stale equal-size text.
    if (
      hit &&
      hit.hunk === hunk &&
      hit.before === before &&
      hit.after === after
    ) {
      return hit.data;
    }
    const data: DiffViewData = {
      hunks: [hunk],
      oldFile: { fileName: path, content: before },
      newFile: { fileName: path, content: after },
    };
    dataCache.current.set(key, { hunk, before, after, data });
    while (dataCache.current.size > MAX_DIFF_DATA_CACHE) {
      const oldest = dataCache.current.keys().next().value;
      if (oldest == null) break;
      dataCache.current.delete(oldest);
    }
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

  // The built-in half of the Run task menu. Every task is listed whether or not
  // this workspace can run it — one that vanishes when it doesn't apply reads
  // as a missing feature — so an unrunnable one carries the reason instead of a
  // handler. Which is also the answer to "why is Review PR greyed out": the
  // branch hasn't got a PR yet.
  const raiseWhy = pr
    ? `PR #${pr.number} is already open`
    : !ws?.branch
      ? "this workspace has no branch"
      : ws.on_base
        ? `on ${ws.branch}, the base branch`
        : "no repo here";
  const builtInChoices: TaskChoice[] = [
    {
      id: raisePrTask.id,
      label:
        ws?.branch && !ws.on_base && !pr
          ? `Raise PR for ${ws.branch}`
          : raisePrTask.label,
      icon: raisePrTask.icon,
      note: raiseWhy,
      run:
        onRaisePrTask && ws?.branch && !ws.on_base && !pr
          ? () =>
              onRaisePrTask(
                ws.branch as string,
                ws.isolated ? ws.workdir : null,
              )
          : undefined,
    },
    {
      id: reviewPrTask.id,
      label: pr ? `Review PR #${pr.number}` : reviewPrTask.label,
      icon: reviewPrTask.icon,
      note: "no PR from this branch yet",
      run: onReviewPrTask && pr ? () => onReviewPrTask(pr) : undefined,
    },
    {
      id: addressPrCommentsTask.id,
      label: pr
        ? `Address comments on #${pr.number}`
        : addressPrCommentsTask.label,
      icon: addressPrCommentsTask.icon,
      note: "no PR from this branch yet",
      run:
        onAddressPrCommentsTask && pr
          ? () => onAddressPrCommentsTask(pr)
          : undefined,
    },
  ];

  return (
    <div className="ticket-view">
      {/* One banner for the whole workspace: identity, branch, where it's
          working, and the window controls — no second header repeating the
          agent name below it. The dropped chips (±uncommitted, ↑vs base) were
          whole-checkout/whole-branch counts, not this agent's; the commit list
          and the scoped diff below carry the real numbers. The trail strip
          under the stats answers where the work stands on its way out
          (wrote → committed → pushed → PR), with the shared-checkout caveat
          in its tooltips rather than as a silent count. */}
      <div className="ticket-view-head aw-banner">
        <div className="ticket-view-title">
          {st &&
            (() => {
              const look = ashFor(lifecycle);
              return (
                <Mascot
                  state={look.state}
                  tone={look.tone}
                  size={18}
                  className="agent-state-ash"
                  title={st.label}
                />
              );
            })()}
          <AgentIcon id={agent} size={16} className="ticket-view-mark" />
          <span className="aw-agent">{agent}</span>
          {ws?.branch && (
            <span
              className="agent-branch"
              title={
                ws.detached
                  ? `${ws.branch} — the agent is looking at a snapshot of the code, not working on the branch itself.`
                  : `The agent works on ${ws.branch}.`
              }
            >
              <GitBranchIcon size={12} /> {ws.branch}
              {ws.detached ? " · snapshot" : ""}
            </span>
          )}
          {ws?.merged && <span className="loose-chip">merged</span>}
          {ws?.workdir && (
            <span
              className="ticket-view-chip"
              title={
                ws.isolated
                  ? `Isolated worktree: ${ws.workdir}`
                  : `Shared checkout: ${ws.workdir}`
              }
            >
              {ws.isolated ? "isolated worktree" : "shared checkout"} ·{" "}
              {basename(ws.workdir)}
            </span>
          )}
          <span className="status-spacer" />
          {/* Go where this agent worked. The pair the switch dialog talks about
              is right there in the banner — the branch and the directory — and
              until now neither could be acted on: you could read what an agent
              did and still have to go to the Git panel to stand where it did.
              Both routes are the one funnel, so a branch another workspace is
              holding asks its question here too. */}
          {repo && ws?.isolated && ws.workdir && (
            <Button
              title={`Point this project's files, search and new terminals at ${ws.workdir}. Nothing moves, nothing is lost.`}
              onClick={() =>
                void openThere(repo, ws.workdir as string, ws.branch)
              }>
              Open it there
            </Button>
          )}
          {/* On a shared checkout there is no other folder to point at — the
              agent worked here — so the way back to its work is the branch. */}
          {repo && ws?.branch && !ws.isolated && !ws.detached && !ws.on_base && (
            <Button
              title={`Open ${ws.branch} in this project's own checkout`}
              onClick={() =>
                void switchTo(repo, {
                  kind: "branch",
                  branch: ws.branch as string,
                })
              }>
              Switch to this branch
            </Button>
          )}
          {/* Only for an isolated worktree: that directory isn't a tab anywhere
              else, so a scratch shell pointed at it is the one thing closing
              this overlay can't give you. On a shared checkout it's the repo
              dir you already have shells in — no value, so it's omitted. */}
          {ws?.isolated && ws.workdir && (
            <Button
              title={`Open a shell in the worktree: ${ws.workdir}`}
              onClick={() =>
                onOpenTerminal(ws.workdir as string, ws.branch ?? agent)
              }>
              New shell in worktree
            </Button>
          )}
          {/* Hand this agent's output to a fresh one-shot agent: a one-off you
              type here, any task you've saved, or a built-in — raise the PR for
              the branch it built, review the PR that came out of it, address the
              comments that came back. All in this workspace's directory. Both
              groups are always listed, unavailable built-ins included with the
              reason: a menu that hides them just looks empty. */}
          {(onRaisePrTask ||
            onReviewPrTask ||
            onAddressPrCommentsTask ||
            onRunSavedTask ||
            onRunOneOff) && (
            <div className="review-send">
              <Button
                title="Run a one-shot task on this work"
                onClick={() => setTaskMenu((v) => !v)}>
                Run task ▾
              </Button>
              {taskMenu && (
                <div
                  className="cli-menu review-menu"
                  // Don't pull the menu away from someone typing a brief in it.
                  onMouseLeave={() => oneOff == null && setTaskMenu(false)}
                >
                  {onRunOneOff &&
                    (oneOff == null ? (
                      <button
                        className="cli-menu-item"
                        onClick={() => setOneOff("")}
                      >
                        ⚡ One-off task…
                      </button>
                    ) : (
                      /* A brief is a sentence or three, not a search term. The
                         single-line input this replaces was sized for a toolbar
                         flex row, so in the menu it collapsed to its intrinsic
                         width — narrower than its own placeholder, and it
                         scrolled away everything you'd typed the moment the
                         brief got long enough to be worth writing. */
                      <div className="oneoff">
                        <div className="cli-menu-label">{ONE_OFF_HEADING}</div>
                        <textarea
                          autoFocus
                          className="oneoff-input"
                          rows={3}
                          placeholder={`What should this agent do?\nIt runs once in ${
                            ws?.isolated && ws.branch
                              ? ws.branch
                              : "this workspace"
                          }, then closes — nothing is saved.`}
                          value={oneOff}
                          onChange={(e) => setOneOff(e.target.value)}
                          onKeyDown={(e) => {
                            // Enter runs; Shift+Enter is the newline, now that
                            // there are lines to break.
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              if (oneOff.trim()) runOneOff();
                            }
                            if (e.key === "Escape") {
                              e.stopPropagation();
                              setOneOff(null);
                            }
                          }}
                        />
                        <div className="oneoff-actions">
                          <span className="oneoff-hint">
                            <kbd>↵</kbd> run · <kbd>{format("newline")}</kbd> new line ·{" "}
                            <kbd>esc</kbd> cancel
                          </span>
                          <Button variant="accent"
                            disabled={!oneOff.trim()}
                            onClick={runOneOff}>
                            Run
                          </Button>
                        </div>
                      </div>
                    ))}
                  <div className="cli-menu-label">{CUSTOM_HEADING}</div>
                  {savedTasks.length === 0 ? (
                    <button
                      className="cli-menu-item"
                      disabled
                      title="Write one in the Tasks panel"
                    >
                      None saved yet
                    </button>
                  ) : (
                    savedTasks.map((t) => (
                      <button
                        key={t.id}
                        className="cli-menu-item"
                        title={t.brief}
                        disabled={!onRunSavedTask}
                        onClick={() => {
                          setTaskMenu(false);
                          onRunSavedTask?.(t, ws?.workdir ?? cwd);
                        }}
                      >
                        {t.icon || "◆"} {t.label}
                      </button>
                    ))
                  )}
                  <div className="cli-menu-label">{BUILT_IN_HEADING}</div>
                  {builtInChoices.map((c) => (
                    <button
                      key={c.id}
                      className="cli-menu-item"
                      title={c.note}
                      disabled={!c.run}
                      onClick={() => {
                        setTaskMenu(false);
                        c.run?.();
                      }}
                    >
                      {c.icon} {c.label}
                      {!c.run && c.note && (
                        <span className="cli-menu-why">{c.note}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <Button icon className="aw-refresh"
            title="Refresh — re-read this agent's changes"
            aria-label="Refresh"
            onClick={() => setTick((t) => t + 1)}>
            <RestartIcon size={14} />
          </Button>
          {onClose && (
            <Button icon className="workspace-overlay-close"
              title="Close (Esc)"
              aria-label="Close agent workspace"
              onClick={onClose}>
              ✕
            </Button>
          )}
        </div>
        {task && <div className="agent-task">{task}</div>}
        {/* What this agent is costing and doing — read from its own CLI store
            (works for a hookless codex too); the state chip only appears when a
            hook reports it. */}
        {(usage || st) && (
          <div className="aw-stats">
            {st && (
              <span
                className={`aw-stat-state ${st.cls}`}
                title={`Session state: ${st.label}`}
              >
                {st.label}
              </span>
            )}
            {/* Working time, next to what that work cost: how long this run has
                been going and how much the session has done in total. */}
            <AgentRuntime timing={timing} live={working} variant="stat" />
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
              <span
                className="aw-stat"
                title="Cost — estimated unless the CLI reports its own"
              >
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
        {/* The trail: wrote → committed → pushed → PR, each step carrying its
            count in the tooltip. When the branch has commits but no PR, the
            last step is the one-click Raise PR task instead of a grey label. */}
        {repo && ws && (
          <div className="aw-trail" role="status">
            {agentGitTrail({
              dirty: ws.dirty,
              commits: ws.commits.length,
              unpushed: ws.unpushed,
              onBase: ws.on_base,
              merged: ws.merged,
              isolated: ws.isolated,
              touched: ws.touched.length,
              prNumber: pr?.number ?? null,
              raised: raised.map((e) => e.pr_number),
            }).map((s, i) => (
              <span key={s.id} className="aw-trail-seg">
                {i > 0 && <span className="aw-trail-arrow">›</span>}
                {s.id === "pr" &&
                s.state === "pending" &&
                onRaisePrTask &&
                ws.branch &&
                !ws.on_base &&
                !pr &&
                ws.commits.length > 0 ? (
                  <button
                    className="aw-trail-step tr-cta"
                    title={`${s.detail} — run the Raise PR task on ${ws.branch}`}
                    onClick={() =>
                      onRaisePrTask(
                        ws.branch as string,
                        ws.isolated ? ws.workdir : null,
                      )
                    }
                  >
                    {raisePrTask.icon} Raise PR
                  </button>
                ) : (
                  <span
                    className={`aw-trail-step tr-${s.state}`}
                    title={s.detail}
                  >
                    {s.state === "done"
                      ? "✓ "
                      : s.state === "attention"
                        ? "● "
                        : ""}
                    {s.label}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Everything below the banner scrolls as one column, banner pinned —
          without this container the view is as tall as its diff and the
          overlay can't scroll at all. */}
      <div className="ticket-view-scroll">

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
          The agent's directory ({ws.cwd}) no longer exists — showing what git
          still knows.
        </div>
      )}
      {ws?.on_base && (
        <div className="tree-empty">
          Working directly on {ws.base} — no branch of its own, showing
          uncommitted changes only.
        </div>
      )}

      {/* PRs this session is on record as having raised. Rendered whatever the
          worktree's state — a detached PR worktree and a merged branch both
          defeat the live lookup below, and those are exactly the sessions whose
          output you most want to find again. The one already shown as the live
          card is skipped rather than repeated. */}
      {repo && raised.length > 0 && (
        <div className="aw-raised">
          {raised
            .filter((e) => e.pr_number !== pr?.number)
            .map((e) => (
              <button
                key={`${e.pr_number}-${e.session_id}`}
                className="aw-raised-row"
                title={`Raised from ${e.branch}${
                  e.confidence === "declared"
                    ? ""
                    : ` — ${e.confidence} attribution`
                }`}
                onClick={() =>
                  onOpenPrNumber?.(repo, e.pr_number, e.pr_url)
                }
              >
                <span className="aw-pr-num">#{e.pr_number}</span>
                <span className="aw-raised-branch">{e.branch}</span>
                <span className="loose-chip">raised by this session</span>
              </button>
            ))}
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
                  +{touched.length - TOUCHED_LIMIT} more{" "}
                  {showMoreTouched ? "▴" : "▾"}
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
                          <span className="aw-more-dir">
                            {parentDir(f) || "·"}
                          </span>
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
            <Button
              size="sm"
              variant={pane === "edits" ? "accent" : "default"}
              title="Only the changes this agent made, attributed per hunk — accurate even on a shared checkout"
              onClick={() => setPane("edits")}
            >
              This agent ({edits.length})
            </Button>
          )}
          {ws && (
            <Button
              size="sm"
              variant={pane === "uncommitted" ? "accent" : "default"}
              onClick={() => setPane("uncommitted")}
            >
              Uncommitted{ws.dirty > 0 ? ` (${ws.dirty})` : ""}
            </Button>
          )}
          {ws && branchable && (
            <Button
              size="sm"
              variant={pane === "diff" ? "accent" : "default"}
              onClick={() => setPane("diff")}
            >
              All changes vs base
            </Button>
          )}
          {pane !== "edits" && patch && files.length > 0 && (
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
      )}

      {/* The review tray: appears once there are draft comments. Send the
          selected ones, or all of them, to the agent in one message — or clear
          the draft. Hidden entirely when nothing can be delivered. */}
      {onMessageAgent && comments.length > 0 && (
        <div className="aw-review-bar">
          <span className="aw-review-count">
            {comments.length} comment{comments.length === 1 ? "" : "s"}
            {selectedCount !== comments.length
              ? ` · ${selectedCount} selected`
              : ""}
          </span>
          <label className="aw-review-all">
            <input
              type="checkbox"
              checked={selectedCount === comments.length}
              ref={(el) => {
                if (el)
                  el.indeterminate =
                    selectedCount > 0 && selectedCount < comments.length;
              }}
              onChange={(e) => setAllSelected(e.target.checked)}
            />
            All
          </label>
          <span className="git-spacer" />
          <Button size="sm" variant="accent"
            disabled={sending || selectedCount === 0}
            onClick={() => sendComments("selected")}>
            {sending ? "Sending…" : `Send selected (${selectedCount})`}
          </Button>
          <Button size="sm"
            disabled={sending}
            onClick={() => sendComments("all")}
            title="Send every comment, regardless of selection">
            Send all
          </Button>
          <Button size="sm"
            disabled={sending}
            onClick={() => setComments([])}
            title="Discard all draft comments">
            Clear
          </Button>
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
                  onOpenCommit(repo, {
                    hash: c.hash,
                    short: c.short,
                    subject: c.subject,
                  })
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
            <div className="tree-empty">
              No edits recorded for this agent yet.
            </div>
          ) : (
            editsByFile.map((g) => {
              // One real diff for the whole file when every edit can be placed in
              // the current content — real line numbers and gaps between edits,
              // like a normal file diff. Otherwise fall back to per-edit fragments
              // (a superseded or moved edit can't be placed, but is still true).
              const content = fileContents.get(g.path);
              const merged = mergedEdits.get(g.path) ?? null;
              return (
                <div key={g.path} className="pr-file">
                  <FileName
                    path={g.path}
                    count={g.items.length}
                    countTitle={`${g.items.length} edit${g.items.length === 1 ? "" : "s"} by this agent`}
                  />
                  {merged && content != null ? (
                    <DiffView
                      data={dataFor(
                        `edits:${g.path}`,
                        g.path,
                        merged.patch,
                        merged.before,
                        content,
                      )}
                      diffViewMode={
                        split ? DiffModeEnum.Split : DiffModeEnum.Unified
                      }
                      diffViewHighlight
                      diffViewTheme="dark"
                      diffViewWrap
                      diffViewFontSize={12}
                      {...commentProps(
                        `edits:${g.path}`,
                        g.path,
                        "edits",
                        true,
                      )}
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
                        {!e.present && (
                          <span className="aw-edit-tag">superseded</span>
                        )}
                        {/* A fragment: the edit's own old→new, numbered from 1 —
                            used only when the edit can't be placed in the file. */}
                        <DiffView
                          data={dataFor(
                            `edits:${g.path}:${i}`,
                            g.path,
                            editToHunk(g.path, e.old, e.new),
                          )}
                          diffViewMode={
                            split ? DiffModeEnum.Split : DiffModeEnum.Unified
                          }
                          diffViewHighlight
                          diffViewTheme="dark"
                          diffViewWrap
                          diffViewFontSize={12}
                          {...commentProps(
                            `edits:${g.path}:${i}`,
                            g.path,
                            "edits",
                            false,
                          )}
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
          // One loading state, not two. This was "Loading workspace…" and then
          // "Loading diff…" — two one-line messages of different widths
          // replacing each other and then being replaced by the diff, so the
          // pane visibly stepped through three layouts on the way in. It holds
          // a fixed block of space now, so what arrives fills it instead of
          // shoving it around.
          ((!ws && !wsErr && repo) || (ws && !patch && pane) ? (
            <div className="tree-empty aw-loading">Reading this agent's changes…</div>
          ) : !ws || !patch ? null : mine.length === 0 ? (
            <div className="tree-empty">
              No changes by this agent{pane === "uncommitted" ? " yet" : ""}.
              {!canAttribute && (
                <div className="aw-note">
                  It ran on a shared checkout without reporting its edits, so
                  its changes can't be told apart from the rest of the tree. Run
                  it in an isolated worktree, or with a CLI that reports edits,
                  to see them here.
                </div>
              )}
            </div>
          ) : (
            mine.map(renderFile)
          ))}
        {patch?.truncated && pane !== "edits" && (
          <div className="tree-empty">
            Diff truncated at 2 MB — use <code>git diff</code> for the whole
            thing.
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

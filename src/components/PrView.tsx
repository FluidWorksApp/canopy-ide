// A pull request opened as a tab: everything between "opened" and "merged"
// happens here. The patch is rendered by @git-diff-view/react — a unified patch
// can't be re-expanded into whole files, so Monaco's DiffEditor (which needs
// both sides in full) structurally can't render one.
//
// Three things beyond the diff make this the whole PR surface:
//   - the conversation (comments, verdicts, inline threads) beside the
//     description, and each thread anchored on the line it was left on;
//   - a review you compose before you post it — inline comments accumulate
//     locally and go out as ONE review (addPullRequestReview), because
//     `gh pr review` can only post a body;
//   - agent rounds: one-shot agents that address the comments, one round at a
//     time, with the loop's memory in Canopy rather than in the agent.
// Everything outward-facing — posting, resolving, merging — stays a human click.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEscape } from "../useEscape";
import { DiffView, DiffModeEnum, SplitSide } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import * as ipc from "../ipc";
import { renderMarkdown } from "../markdown";
import type { Notify, RelayHandle } from "../types";
import { agentMenuItems } from "../agentMenu";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { AgentsIcon, TeamIcon } from "./icons";
import type { AgentTarget } from "./TicketsPanel";
import {
  addressPrCommentsTask,
  applySuggestionTask,
  draftFindingsTask,
  fixCiTask,
  followUpsTask,
  prArtifactPath,
  reviewMapTask,
  reviewPrTask,
  runItReviewTask,
  selfReviewPrTask,
  type MicroTaskDef,
} from "../microTasks";
import { rowFor, subscribe as subscribeToPrs } from "../prWatchStore";
import {
  actionable,
  fileNote,
  isNit,
  nextMove,
  roleFor,
  threadSuggestion,
  threadsByPath,
  verdicts,
  type NextMove,
} from "../prReview";
import {
  beginRound,
  finishRound,
  isLandable,
  isRoundStale,
  loadLoop,
  markDone,
  markReady,
  newSinceHandled,
  resetLoop,
  roundGate,
  saveLoop,
  type PrLoop,
} from "../prLoop";
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
  /** Launch a one-shot PR micro-task — review it, map it, address the comments
   *  it came back with. Each reports and closes its own terminal. */
  onMicroTask?: <P>(task: MicroTaskDef<P>, payload: P, query: string) => void;
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

/** Safety net only: the cross-project poller is what normally wakes the loop
 *  (see the watcher effect). This covers a PR whose repo nothing is watching —
 *  its project was closed while the tab stayed open — and is deliberately slow,
 *  because a background tab polling GitHub every minute is how a rate limit
 *  gets burned. */
const WATCH_FALLBACK_MS = 5 * 60_000;

interface FilePatch {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
  changed: number;
  binary: boolean;
}

/** An inline comment you've written but not posted. It becomes a thread when the
 *  review is submitted, and vanishes if you drop it — nothing reaches GitHub in
 *  between, which is the whole point of composing a review rather than firing
 *  comments one at a time. */
interface DraftComment {
  id: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  /** Nits are prefixed on submit and never read as blocking. */
  blocking: boolean;
}

/** What a line's extension row is given: the threads that live on it plus any
 *  draft comment aimed at it. */
interface LineData {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  threads: ipc.PrThread[];
  drafts: DraftComment[];
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

const VERDICT_LABEL: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
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
  onMicroTask,
}: PrViewProps) {
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [split, setSplit] = useState(true);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Review | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeConfirm, setMergeConfirm] = useState<MergeMethod | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [closeDelBranch, setCloseDelBranch] = useState(false);

  // The conversation: comments, verdicts, inline threads, per-file viewed state.
  // Its own request, independent of the patch, so it paints while a 28k-line
  // diff is still being parsed.
  const [conv, setConv] = useState<ipc.PrConversation | null>(null);
  const [convError, setConvError] = useState<string | null>(null);
  /** The body read the old way, when the conversation query couldn't be run. */
  const [bodyFallback, setBodyFallback] = useState("");
  const [drafts, setDrafts] = useState<DraftComment[]>([]);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [logs, setLogs] = useState<string | null>(null);
  /** People who could be asked to review — loaded only when that's the move. */
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [map, setMap] = useState<string | null>(null);
  const [deltaOn, setDeltaOn] = useState(false);
  const [deltaPatch, setDeltaPatch] = useState<string | null>(null);
  const [loop, setLoop] = useState<PrLoop>(() => loadLoop(repo, pr.number));

  useEscape(
    () => {
      setConfirm(null);
      setMergeConfirm(null);
      setCloseConfirm(false);
    },
    confirm != null || mergeConfirm != null || closeConfirm,
  );
  const [done, setDone] = useState<string | null>(null);
  // Two dropdowns, both ContextMenu-driven: the agent menu and the overflow.
  // Using the shared menu (rather than another hand-rolled popover) is what
  // lets them carry submenus, hints and a danger row without new markup.
  const agentMenu = useContextMenu();
  const moreMenu = useContextMenu();
  const fileRefs = useRef(new Map<string, HTMLDivElement>());

  // Teammates a review request can go to (everyone but us).
  const teammates =
    relay && relay.status.role !== "off"
      ? relay.status.members.filter((m) => m.id !== relay.status.self_id)
      : [];

  /** Send the PR to a teammate over the relay; their Canopy opens it natively
   *  by matching this repo's origin URL against their local checkouts. */
  const requestReview = async (memberId: string, memberName: string) => {
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

  const refreshConv = useCallback(async () => {
    try {
      const c = await ipc.ghPrConversation(repo, pr.number);
      setConv(c);
      setConvError(null);
      return c;
    } catch (err) {
      setConvError(String(err));
      // The threads need GraphQL, but the description doesn't: if the mutation
      // surface is refused (an old gh, a token without the scope, an Enterprise
      // host), fall back to `gh pr view --json body` so the tab still reads.
      void ipc
        .ghPrBody(repo, pr.number)
        .then((b) => setBodyFallback(b))
        .catch(() => {});
      return null;
    }
  }, [repo, pr.number]);

  useEffect(() => {
    let live = true;
    setPatch(null);
    setError(null);
    setConv(null);
    setBodyFallback("");
    setDrafts([]);
    setDeltaOn(false);
    setDeltaPatch(null);
    setLoop(loadLoop(repo, pr.number));
    void ipc
      .ghPrDiff(repo, pr.number)
      .then((d) => live && setPatch(d))
      .catch((e) => live && setError(String(e)));
    void refreshConv();
    // A map left by an earlier run of the Review map task, if there is one.
    void ipc
      .fsReadText(prArtifactPath(repo, pr.number))
      .then((t) => live && setMap(t.trim() || null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [repo, pr.number, refreshConv]);

  const persist = useCallback((next: PrLoop) => {
    setLoop(saveLoop(next));
    return next;
  }, []);

  // ---- derived state -------------------------------------------------------

  const act = useMemo(() => (conv ? actionable(conv) : null), [conv]);
  const liveChecks = conv?.checks || pr.checks;
  const decision = conv?.review_decision || pr.review_decision;
  const conflicting = (conv?.mergeable || pr.mergeable) === "CONFLICTING";
  const role = roleFor(pr, conv);
  const gate = useMemo(() => roundGate(pr, conv, loop), [pr, conv, loop]);
  const move: NextMove = useMemo(
    () =>
      nextMove(pr, conv, {
        actionable: act?.count ?? 0,
        loopBusy: loop.status === "working",
        autoMerge: conv?.auto_merge,
      }),
    [pr, conv, act, loop.status],
  );

  // ---- the review loop ----------------------------------------------------

  const startRound = useCallback(
    (armed: boolean) => {
      if (!onMicroTask) return;
      if (!gate.ok) {
        // Nothing to address *yet* is not a refusal: arm the loop and the
        // watcher starts round one the moment review comments land. Every other
        // reason (a red build, conflicts, a round already running) is a real
        // no, and says so.
        if (gate.reason === "no comments to address" && pr.state === "OPEN") {
          persist({ ...loop, auto: true });
          onNotice("Armed — a round starts by itself when review comments arrive.");
          return;
        }
        onNotice(gate.reason ?? "Nothing to address right now.");
        return;
      }
      onMicroTask(addressPrCommentsTask, { repo, pr }, "");
      persist({
        ...beginRound(loop, gate.ids, conv?.head_sha ?? ""),
        auto: armed || loop.auto,
      });
      onNotice(
        `Round ${loop.cycle + 1}: an agent is addressing ${gate.ids.length} ${
          gate.ids.length === 1 ? "comment" : "comments"
        }.`,
      );
    },
    [onMicroTask, gate, loop, conv, repo, pr, persist, onNotice],
  );

  /** A round's agent reported in. job_done is broadcast globally with the PR's
   *  own URL (every PR brief passes it), so match on that rather than trying to
   *  hold on to a pty id across a tab that closes itself. */
  useEffect(() => {
    const onAction = (e: Event) => {
      const action = (e as CustomEvent).detail?.action as ipc.AgentAction | undefined;
      if (!action || action.kind !== "job_done") return;
      const mine =
        action.url?.includes(`/pull/${pr.number}`) ||
        action.route?.includes(`-wt-pr-${pr.number}`);
      if (!mine) return;
      // Whatever the round produced, the conversation and the head sha are the
      // evidence — refresh, then decide whether anything was actually pushed.
      void refreshConv().then((c) => {
        setLoop((prev) => {
          if (prev.status !== "working") return prev;
          const round = prev.rounds[prev.rounds.length - 1];
          const pushed = !!c && !!round?.headSha && c.head_sha !== round.headSha;
          const next = finishRound(
            prev,
            action.status === "blocked" ? "blocked" : "done",
            action.summary,
            pushed,
          );
          return saveLoop(c && isLandable(c) && next.status === "waiting" ? markReady(next) : next);
        });
      });
      // A findings/map task reporting in leaves a file behind; pick it up.
      void ipc
        .fsReadText(prArtifactPath(repo, pr.number))
        .then((t) => setMap(t.trim() || null))
        .catch(() => {});
    };
    window.addEventListener("canopy:agent-action", onAction);
    return () => window.removeEventListener("canopy:agent-action", onAction);
  }, [pr.number, repo, refreshConv]);

  // The watcher: while a round is waiting, look for a post-back. The trigger is
  // a comment id we've never handled — `updatedAt` moves on our own pushes too,
  // so time is not a signal and ids are.
  //
  // What *wakes* it is the cross-project poller (prwatch.rs → prWatchStore),
  // which already asks GitHub about this repo on a schedule: when its row's
  // `updatedAt` moves, something happened here worth a conversation refetch.
  // That replaces a per-tab interval — ten open PR tabs used to mean ten timers
  // all polling the same repos. The slow interval below is only a safety net for
  // a PR whose repo the poller isn't watching (its project was closed).
  useEffect(() => {
    // Armed-but-idle counts: that is the whole point of arming it before the
    // first comment exists.
    if (!loop.auto && loop.status !== "waiting" && loop.status !== "ready") return;
    let live = true;
    const tick = async () => {
      if (!live || document.visibilityState !== "visible") return;
      const c = await refreshConv();
      if (!live || !c) return;
      const fresh = newSinceHandled(c, loop);
      if (fresh.length && loop.auto) {
        const g = roundGate(pr, c, loop);
        if (g.ok) {
          onMicroTask?.(addressPrCommentsTask, { repo, pr }, "");
          persist(beginRound(loop, g.ids, c.head_sha));
          onNotice(`Round ${loop.cycle + 1}: ${g.ids.length} new comment(s) came back — agent is on it.`);
          return;
        }
        if (g.reason) persist({ ...loop, status: "blocked", blockedReason: g.reason });
        return;
      }
      if (fresh.length) {
        onNotice(`#${pr.number}: ${fresh.length} new comment(s).`);
      } else if (isLandable(c) && loop.status !== "ready") {
        persist(markReady(loop));
      }
    };
    let lastUpdated = rowFor(repo, pr.number)?.updated ?? "";
    const unsubscribe = subscribeToPrs(() => {
      const row = rowFor(repo, pr.number);
      if (!row || row.updated === lastUpdated) return;
      lastUpdated = row.updated;
      void tick();
    });
    const id = window.setInterval(() => void tick(), WATCH_FALLBACK_MS);
    return () => {
      live = false;
      unsubscribe();
      window.clearInterval(id);
    };
  }, [loop, pr, repo, refreshConv, onMicroTask, persist, onNotice]);

  // Only fetched when it's the move being offered: one API call, and only for
  // the PR where the answer is about to be shown.
  useEffect(() => {
    if (move.id !== "request-review" || candidates !== null) return;
    void ipc
      .ghPrReviewerCandidates(repo)
      .then(setCandidates)
      .catch(() => setCandidates([]));
  }, [move.id, candidates, repo]);

  // A round whose agent vanished (crashed CLI, closed tab, slept machine) is not
  // "running" — say so rather than leaving a spinner forever.
  useEffect(() => {
    if (!isRoundStale(loop)) return;
    persist({
      ...loop,
      status: "blocked",
      blockedReason: "the round's agent stopped reporting — check its terminal",
    });
  }, [loop, persist]);

  // ---- actions ------------------------------------------------------------

  const submit = async (action: Review) => {
    setBusy(true);
    try {
      const threads: ipc.DraftThread[] = drafts.map((d) => ({
        path: d.path,
        line: d.line,
        side: d.side,
        body: d.blocking || isNit(d.body) ? d.body : `Nit: ${d.body}`,
      }));
      // The batched mutation is the only way to post inline comments; fall back
      // to `gh pr review` when there are none, so a body-only review still works
      // on a repo where the GraphQL mutation is refused.
      const msg = conv?.node_id
        ? await ipc.ghPrReviewBatch(repo, conv.node_id, action, comment, threads)
        : await ipc.ghPrReview(repo, pr.number, action, comment || undefined);
      setDone(msg);
      onNotice(msg);
      setComment("");
      setDrafts([]);
      void refreshConv();
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
      persist(markDone(loop));
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
      persist(markDone(loop));
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
      void refreshConv();
    } catch (err) {
      onNotice(String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (label: string, fn: () => Promise<string>) => {
    setBusy(true);
    try {
      onNotice(await fn(), "success");
      void refreshConv();
    } catch (err) {
      onNotice(`${label}: ${String(err)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const setResolved = (threadId: string, resolved: boolean) =>
    void runAction(resolved ? "Resolve" : "Reopen", () =>
      ipc.ghPrThreadResolved(repo, threadId, resolved),
    );

  const sendReply = (threadId: string) => {
    const body = replyText.trim();
    if (!body) return;
    setReplyTo(null);
    setReplyText("");
    void runAction("Reply", () => ipc.ghPrThreadReply(repo, threadId, body));
  };

  const toggleViewed = (path: string, viewed: boolean) => {
    if (!conv?.node_id) return;
    // Optimistic: the checkbox is a reading aid, and a failed write is worth a
    // notice but not a spinner.
    setConv((c) =>
      c ? { ...c, files: c.files.map((f) => (f.path === path ? { ...f, viewed } : f)) } : c,
    );
    void ipc.ghPrFileViewed(repo, conv.node_id, path, viewed).catch((err) => {
      onNotice(String(err), "error");
      void refreshConv();
    });
  };

  const showLogs = () =>
    void runAction("Read the failing logs", async () => {
      const text = await ipc.ghPrFailingLogs(repo, pr.number);
      setLogs(text || "Nothing is failing right now.");
      return "Read the failing checks";
    });

  const toggleDelta = async () => {
    if (deltaOn) {
      setDeltaOn(false);
      return;
    }
    if (!conv?.my_last_review_sha) return;
    setBusy(true);
    try {
      const d = deltaPatch ?? (await ipc.ghPrDiffSince(repo, conv.my_last_review_sha, conv.head_sha));
      setDeltaPatch(d);
      setDeltaOn(true);
    } catch (err) {
      onNotice(`Couldn't diff since your review: ${String(err)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  /** Load the findings a review/self-review task left behind and turn them into
   *  draft comments. They are proposals: nothing is posted until the human
   *  submits the review, and each one can be edited or dropped first. */
  const importFindings = async () => {
    try {
      const raw = await ipc.fsReadText(prArtifactPath(repo, pr.number, "findings"));
      const parsed = JSON.parse(raw) as {
        findings?: { path: string; line: number; side?: string; severity?: string; body: string }[];
      };
      const found = (parsed.findings ?? []).filter((f) => f.path && f.line > 0 && f.body?.trim());
      if (!found.length) {
        onNotice("That findings file has nothing in it.");
        return;
      }
      setDrafts((prev) => [
        ...prev,
        ...found.map((f, i) => ({
          id: `imported-${Date.now()}-${i}`,
          path: f.path,
          line: f.line,
          side: f.side === "LEFT" ? ("LEFT" as const) : ("RIGHT" as const),
          body: f.body.trim(),
          blocking: f.severity !== "nit",
        })),
      ]);
      onNotice(`${found.length} finding(s) staged as draft comments — none posted yet.`);
    } catch {
      onNotice("No findings file yet — run Draft findings or Self-review first.");
    }
  };

  const jumpToFile = (path: string) => {
    setExpanded((prev) => new Set(prev).add(path));
    // Let the diff mount before scrolling to it.
    setTimeout(() => fileRefs.current.get(path)?.scrollIntoView({ block: "start" }), 60);
  };

  const dispatchMove = (m: NextMove, e: React.MouseEvent) => {
    switch (m.id) {
      case "self-review":
        onMicroTask?.(selfReviewPrTask, { repo, pr }, "");
        break;
      case "mark-ready":
        void ready();
        break;
      case "fix-ci":
        onMicroTask?.(fixCiTask, { repo, pr }, "");
        break;
      case "update-branch":
        void runAction("Update branch", () => ipc.ghPrUpdateBranch(repo, pr.number));
        break;
      case "resolve-conflicts":
        onStartResolve("claude");
        break;
      case "address-comments":
        startRound(true);
        break;
      case "review-it":
        onMicroTask?.(draftFindingsTask, { repo, pr }, "");
        break;
      case "request-review":
        // The real event: useContextMenu calls preventDefault on it, so a
        // hand-made {clientX, clientY} threw and the button did nothing.
        moreMenu.open(e, reviewerItems());
        break;
      case "merge":
        setMergeOpen(true);
        break;
      default:
        break;
    }
  };

  // The patch is one blob covering many files; split it per file (once, not on
  // every keystroke) and tag each with its size.
  const activePatch = deltaOn ? deltaPatch : patch;
  const files = useMemo<FilePatch[]>(
    () =>
      activePatch
        ? splitPatch(activePatch).map((f) => ({ ...f, ...fileStats(f.patch) }))
        : [],
    [activePatch],
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
  const bodyText = conv?.body?.trim() ? conv.body : bodyFallback;
  const bodyHtml = useMemo(() => (bodyText.trim() ? renderMarkdown(bodyText) : ""), [bodyText]);
  const mapHtml = useMemo(() => (map ? renderMarkdown(map) : ""), [map]);

  const byPath = useMemo(() => threadsByPath(conv?.threads ?? []), [conv?.threads]);
  const viewedByPath = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const f of conv?.files ?? []) m.set(f.path, f.viewed);
    return m;
  }, [conv?.files]);

  /** Line-anchored payloads for the diff renderer: threads and drafts keyed by
   *  the line they belong to, per file, per side. Built once per conversation
   *  change rather than scanned inside every file card's render. */
  const extendByPath = useMemo(() => {
    const out = new Map<
      string,
      { oldFile: Record<string, { data: LineData }>; newFile: Record<string, { data: LineData }> }
    >();
    const put = (path: string, side: "LEFT" | "RIGHT", line: number, fill: (d: LineData) => void) => {
      if (!line) return;
      let entry = out.get(path);
      if (!entry) {
        entry = { oldFile: {}, newFile: {} };
        out.set(path, entry);
      }
      const bucket = side === "LEFT" ? entry.oldFile : entry.newFile;
      const key = String(line);
      if (!bucket[key])
        bucket[key] = { data: { path, line, side, threads: [], drafts: [] } };
      fill(bucket[key].data);
    };
    for (const t of conv?.threads ?? [])
      put(t.path, t.side === "LEFT" ? "LEFT" : "RIGHT", t.line, (d) => d.threads.push(t));
    for (const d of drafts) put(d.path, d.side, d.line, (x) => x.drafts.push(d));
    return out;
  }, [conv?.threads, drafts]);

  /** Threads GitHub can't place any more (the line is gone) — they'd silently
   *  disappear if the rail didn't list them. */
  const unanchored = useMemo(
    () => (conv?.threads ?? []).filter((t) => !t.line && !t.resolved),
    [conv?.threads],
  );

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

  /** Approved, green, and no conflicts — the one state where Merge is the
   *  obvious next move, and the only one where it wears the accent. */
  const mergeReady = decision === "APPROVED" && !conflicting && liveChecks !== "FAIL";

  const reviewerItems = (): MenuItem[] => {
    const items: MenuItem[] = [];
    // Whoever already reviewed can be asked again — the after-a-push case.
    const past = Array.from(
      new Set((conv?.reviews ?? []).filter((r) => !r.mine).map((r) => r.author)),
    );
    for (const login of past)
      items.push({
        label: `Re-request ${login}`,
        onClick: () => void runAction("Request review", () => ipc.ghPrRequestReview(repo, pr.number, [login])),
      });
    // Everyone else with access. On a PR nobody has looked at yet — which is
    // exactly when you press "Ask for review" — `past` is empty, so without
    // these the menu had nothing in it.
    const asked = new Set(past);
    const others = (candidates ?? []).filter(
      (l) => l !== conv?.viewer && l !== pr.author && !asked.has(l),
    );
    if (others.length) {
      if (items.length) items.push({ separator: true });
      for (const login of others.slice(0, 15))
        items.push({
          label: login,
          onClick: () =>
            void runAction("Request review", () => ipc.ghPrRequestReview(repo, pr.number, [login])),
        });
    } else if (candidates === null) {
      items.push({ label: "Looking up who can review…", disabled: true });
    }
    if (teammates.length > 0)
      items.push({
        label: "Ask a teammate over the relay",
        icon: <TeamIcon size={14} />,
        submenu: teammates.map((m) => ({
          label: m.name,
          onClick: () => void requestReview(m.id, m.name),
        })),
      });
    if (!items.length)
      items.push({ label: "Nobody has reviewed it yet — ask on GitHub", disabled: true });
    return items;
  };

  /** Everything an agent can do with this PR, in one menu: the one-shot tasks
   *  first (they need nothing from you but a click), then handing it to an
   *  agent in a worktree. Built at open time so a newly-started agent is in the
   *  list. When the PR conflicts, resolving them replaces reviewing — there is
   *  no point reviewing a diff git can't even merge. */
  const openAgentMenu = (e: React.MouseEvent) => {
    const items: MenuItem[] = [];
    if (onMicroTask && !conflicting) {
      items.push({ label: "Read it for me", separator: true });
      items.push({
        label: reviewMapTask.label,
        icon: <span className="ctx-glyph">{reviewMapTask.icon}</span>,
        hint: "risk-ranked, nothing posted",
        onClick: () => onMicroTask(reviewMapTask, { repo, pr }, ""),
      });
      items.push({
        label: draftFindingsTask.label,
        icon: <span className="ctx-glyph">{draftFindingsTask.icon}</span>,
        hint: "staged for you to vet",
        onClick: () => onMicroTask(draftFindingsTask, { repo, pr }, ""),
      });
      items.push({
        label: runItReviewTask.label,
        icon: <span className="ctx-glyph">{runItReviewTask.icon}</span>,
        hint: "starts it and takes screenshots",
        onClick: () => onMicroTask(runItReviewTask, { repo, pr }, ""),
      });
      items.push({ label: "Act on it", separator: true });
      items.push({
        label: reviewPrTask.label,
        icon: <span className="ctx-glyph">{reviewPrTask.icon}</span>,
        hint: "posts only what's required",
        onClick: () => onMicroTask(reviewPrTask, { repo, pr }, ""),
      });
      if (pr.state === "OPEN") {
        items.push({
          label: selfReviewPrTask.label,
          icon: <span className="ctx-glyph">{selfReviewPrTask.icon}</span>,
          hint: "private pass, posts nothing",
          onClick: () => onMicroTask(selfReviewPrTask, { repo, pr }, ""),
        });
        items.push({
          label: act?.count
            ? `${addressPrCommentsTask.label} (${act.count})`
            : addressPrCommentsTask.label,
          icon: <span className="ctx-glyph">{addressPrCommentsTask.icon}</span>,
          hint: gate.ok ? "validates each one first" : gate.reason,
          disabled: !gate.ok,
          onClick: () => startRound(false),
        });
        if (liveChecks === "FAIL")
          items.push({
            label: fixCiTask.label,
            icon: <span className="ctx-glyph">{fixCiTask.icon}</span>,
            hint: "reads the failing logs first",
            onClick: () => onMicroTask(fixCiTask, { repo, pr }, ""),
          });
        items.push({
          label: followUpsTask.label,
          icon: <span className="ctx-glyph">{followUpsTask.icon}</span>,
          hint: "out-of-scope comments become issues",
          onClick: () => onMicroTask(followUpsTask, { repo, pr }, ""),
        });
      }
    }
    items.push(
      ...agentMenuItems({
        targets: agentTargets,
        installed,
        newLabel: conflicting
          ? `Resolve conflicts in ${pr.branch}`
          : `Review ${pr.branch} in a worktree`,
        onSend: conflicting ? onSendResolve : onSendToAgent,
        onStart: conflicting ? onStartResolve : onStartReview,
      }),
    );
    agentMenu.open(e, items);
  };

  /** The long tail: real actions, just not ones worth a permanent button. */
  const openMoreMenu = (e: React.MouseEvent) => {
    const items: MenuItem[] = [
      {
        label: "Check out locally",
        hint: "switches branch",
        onClick: () =>
          void ipc
            .ghPrCheckout(repo, pr.number)
            .then(onNotice)
            .catch((err) => onNotice(String(err), "error")),
      },
      {
        label: "Refresh conversation",
        onClick: () => void refreshConv(),
      },
      {
        label: "Open on GitHub",
        onClick: () =>
          void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(pr.url)),
      },
    ];
    if (pr.state === "OPEN") {
      items.push({
        label: "Sync with base branch",
        hint: "gh pr update-branch",
        onClick: () => void runAction("Update branch", () => ipc.ghPrUpdateBranch(repo, pr.number)),
      });
      items.push({ label: "Request review", submenu: reviewerItems() });
      items.push({
        label: conv?.auto_merge ? "Turn auto-merge off" : "Auto-merge when green",
        hint: conv?.auto_merge ? undefined : "GitHub merges it once its own conditions pass",
        onClick: () =>
          void runAction("Auto-merge", () =>
            ipc.ghPrAutoMerge(repo, pr.number, "squash", !conv?.auto_merge),
          ),
      });
    }
    if (loop.status !== "idle")
      items.push({
        label: "Reset the agent loop",
        hint: `${loop.cycle} round(s) recorded`,
        onClick: () => persist(resetLoop(loop)),
      });
    if (pr.state === "OPEN")
      items.push(
        { separator: true },
        {
          label: "Close without merging",
          danger: true,
          disabled: busy,
          onClick: () => setCloseConfirm(true),
        },
      );
    moreMenu.open(e, items);
  };

  // ---- pieces -------------------------------------------------------------

  const threadCard = (t: ipc.PrThread, compact = false) => {
    const suggestion = threadSuggestion(t);
    return (
      <div
        key={t.id}
        className={`pr-thread ${t.resolved ? "is-resolved" : ""} ${t.outdated ? "is-outdated" : ""}`}
      >
        <div className="pr-thread-head">
          <span className="pr-thread-where" onClick={() => jumpToFile(t.path)} title={t.path}>
            {t.path.split("/").pop()}
            {t.line ? `:${t.line}` : ""}
          </span>
          {t.resolved && <span className="pr-thread-tag">resolved</span>}
          {t.outdated && <span className="pr-thread-tag">outdated</span>}
        </div>
        {t.comments.slice(0, compact ? 2 : undefined).map((c) => (
          <div key={c.id} className="pr-comment-row">
            <div className="pr-comment-meta">
              <span className="pr-comment-author">{c.author}</span>
              <span className="pr-comment-when" title={absTime(c.created)}>
                {ago(c.created)}
              </span>
              {isNit(c.body) && <span className="pr-thread-tag">nit</span>}
            </div>
            <div
              className="markdown-body pr-comment-body"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }}
            />
          </div>
        ))}
        {compact && t.comments.length > 2 && (
          <div className="pr-thread-more">+{t.comments.length - 2} more</div>
        )}
        {pr.state === "OPEN" && (
          <div className="pr-thread-actions">
            <button className="btn-mini" onClick={() => setReplyTo(replyTo === t.id ? null : t.id)}>
              Reply
            </button>
            <button className="btn-mini" onClick={() => setResolved(t.id, !t.resolved)}>
              {t.resolved ? "Reopen" : "Resolve"}
            </button>
            {suggestion && onMicroTask && (
              <button
                className="btn-mini"
                title="Apply the suggested change in a worktree, run the tests, and push"
                onClick={() =>
                  onMicroTask(
                    applySuggestionTask,
                    { repo, pr, path: t.path, line: t.line, suggestion, threadId: t.id },
                    "",
                  )
                }
              >
                Apply suggestion
              </button>
            )}
          </div>
        )}
        {replyTo === t.id && (
          <div className="pr-reply">
            <textarea
              className="pr-comment"
              rows={2}
              autoFocus
              placeholder="Reply on this thread — posts to GitHub"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
            />
            <div className="pr-thread-actions">
              <button className="btn-mini" onClick={() => setReplyTo(null)}>
                Cancel
              </button>
              <button
                className="btn-mini btn-accent"
                disabled={!replyText.trim() || busy}
                onClick={() => sendReply(t.id)}
              >
                Post reply
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const draftCard = (d: DraftComment) => (
    <div key={d.id} className="pr-draft">
      <div className="pr-thread-head">
        <span className="pr-thread-where">
          {d.path.split("/").pop()}:{d.line}
        </span>
        <span className={`pr-thread-tag ${d.blocking ? "is-blocking" : ""}`}>
          {d.blocking ? "blocking" : "nit"}
        </span>
        <span className="pr-thread-tag">not posted</span>
      </div>
      <textarea
        className="pr-comment"
        rows={2}
        value={d.body}
        onChange={(e) =>
          setDrafts((prev) => prev.map((x) => (x.id === d.id ? { ...x, body: e.target.value } : x)))
        }
      />
      <div className="pr-thread-actions">
        <button
          className="btn-mini"
          onClick={() =>
            setDrafts((prev) =>
              prev.map((x) => (x.id === d.id ? { ...x, blocking: !x.blocking } : x)),
            )
          }
        >
          {d.blocking ? "Mark as nit" : "Mark blocking"}
        </button>
        <button
          className="btn-mini"
          onClick={() => setDrafts((prev) => prev.filter((x) => x.id !== d.id))}
        >
          Drop
        </button>
      </div>
    </div>
  );

  return (
    <div className="pr-view">
      {agentMenu.menu && (
        <ContextMenu
          x={agentMenu.menu.x}
          y={agentMenu.menu.y}
          items={agentMenu.menu.items}
          onClose={agentMenu.close}
        />
      )}
      {moreMenu.menu && (
        <ContextMenu
          x={moreMenu.menu.x}
          y={moreMenu.menu.y}
          items={moreMenu.menu.items}
          onClose={moreMenu.close}
        />
      )}
      <div className="pr-head">
        {/* Three rows: what this PR is, what you can do about it, and what needs
            to happen next. The actions are three controls that don't multiply —
            everything an agent can do lives behind Agent ▾, everything rare
            behind ⋯ — so shipping another task doesn't add another button. */}
        <div className="pr-titlebar">
          <div className="pr-title">
            <span className="pr-num">#{pr.number}</span>
            {pr.title}
          </div>
          <div className="pr-actions">
            <button
              className="btn-mini"
              title="Hand this PR to an agent — a one-shot task, or an agent in a worktree"
              onClick={openAgentMenu}
            >
              <AgentsIcon size={11} /> Agent ▾
            </button>
            {pr.draft && pr.state === "OPEN" && (
              <button
                className="btn-mini btn-accent"
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
                  className={`btn-mini ${mergeReady ? "btn-accent" : ""}`}
                  title={
                    mergeReady
                      ? "Merge this PR on GitHub"
                      : "Merge this PR on GitHub — it isn't approved and green yet"
                  }
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
            <button className="btn-mini" title="More actions" onClick={openMoreMenu}>
              ⋯
            </button>
          </div>
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
          {(conv?.draft ?? pr.draft) && <span className="pr-decision">draft</span>}
          {decision && (
            <span className="pr-decision">{decision.toLowerCase().replace("_", " ")}</span>
          )}
          {liveChecks && (
            <span
              className={`pr-checks ${liveChecks === "PASS" ? "pr-ok" : liveChecks === "FAIL" ? "pr-bad" : "pr-pending"}`}
              title={pr.checks_summary}
            >
              {liveChecks === "PASS"
                ? "checks passed"
                : liveChecks === "FAIL"
                  ? "checks failed"
                  : "checks running"}
            </span>
          )}
          {conflicting && <span className="pr-checks pr-bad">conflicts</span>}
          {!!act?.count && (
            <span className="pr-checks pr-pending" title="unresolved comments and change requests">
              {act.count} to address
            </span>
          )}
          {conv?.auto_merge && <span className="pr-decision">auto-merge armed</span>}
        </div>
        {/* The next move. A PR is always in one state that implies one action;
            naming it is what makes this tab a place you finish work rather than
            a place you look at a diff. */}
        <div className={`pr-next ${move.urgent ? "is-urgent" : ""}`}>
          <span className="pr-next-label" title={move.hint}>
            {move.label}
          </span>
          {move.action && (
            <button
              className="btn-mini btn-accent"
              disabled={busy}
              title={move.hint}
              onClick={(e) => dispatchMove(move, e)}
            >
              {move.action}
            </button>
          )}
          {loop.status === "waiting" && loop.auto && (
            <span className="pr-next-note">watching for new comments</span>
          )}
          {loop.blockedReason && <span className="pr-next-note">{loop.blockedReason}</span>}
        </div>
      </div>

      <div className="pr-body">
        <div className="pr-overview">
          <div className="pr-overview-main">
            {bodyHtml && (
              <div
                className="markdown-body pr-description"
                dangerouslySetInnerHTML={{ __html: bodyHtml }}
              />
            )}
            {mapHtml && (
              <div className="pr-description pr-map">
                <div className="pr-rail-title">
                  Review map
                  <button
                    className="btn-mini"
                    title="Have an agent read it again"
                    onClick={() => onMicroTask?.(reviewMapTask, { repo, pr }, "")}
                  >
                    Regenerate
                  </button>
                </div>
                <div className="markdown-body" dangerouslySetInnerHTML={{ __html: mapHtml }} />
              </div>
            )}
            {!mapHtml && onMicroTask && (
              <div className="pr-map-cta">
                <button className="btn-mini" onClick={() => onMicroTask(reviewMapTask, { repo, pr }, "")}>
                  {reviewMapTask.icon} Map this change for me
                </button>
                <span className="pr-files-note">risk-ranked, nothing posted</span>
              </div>
            )}
          </div>

          <aside className="pr-rail">
            {convError && <div className="pr-error">{convError}</div>}
            {!conv && !convError && <div className="pr-loading">Loading conversation…</div>}

            {conv && (
              <>
                <div className="pr-rail-section">
                  <div className="pr-rail-title">
                    Conversation
                    <button className="btn-mini" title="Refresh" onClick={() => void refreshConv()}>
                      ↻
                    </button>
                  </div>
                  {verdicts(conv).length === 0 &&
                    conv.comments.length === 0 &&
                    conv.threads.length === 0 && (
                      <div className="pr-rail-empty">No comments yet.</div>
                    )}
                  {verdicts(conv).map((r) => (
                    <div
                      key={r.id}
                      className={`pr-verdict ${r.state === "CHANGES_REQUESTED" ? "is-bad" : r.state === "APPROVED" ? "is-ok" : ""}`}
                    >
                      <div className="pr-comment-meta">
                        <span className="pr-comment-author">{r.author}</span>
                        <span>{VERDICT_LABEL[r.state] ?? r.state.toLowerCase()}</span>
                        <span className="pr-comment-when" title={absTime(r.submitted)}>
                          {ago(r.submitted)}
                        </span>
                      </div>
                      {r.body.trim() && (
                        <div
                          className="markdown-body pr-comment-body"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(r.body) }}
                        />
                      )}
                    </div>
                  ))}
                  {conv.threads.filter((t) => !t.resolved).map((t) => threadCard(t, true))}
                  {conv.comments.map((c) => (
                    <div key={c.id} className="pr-comment-row">
                      <div className="pr-comment-meta">
                        <span className="pr-comment-author">{c.author}</span>
                        <span className="pr-comment-when" title={absTime(c.created)}>
                          {ago(c.created)}
                        </span>
                      </div>
                      <div
                        className="markdown-body pr-comment-body"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }}
                      />
                    </div>
                  ))}
                  {conv.threads.some((t) => t.resolved) && (
                    <div className="pr-rail-empty">
                      {conv.threads.filter((t) => t.resolved).length} resolved thread(s) hidden.
                    </div>
                  )}
                  {unanchored.length > 0 && (
                    <div className="pr-rail-empty">
                      {unanchored.length} thread(s) whose line no longer exists — listed above, not in
                      the diff.
                    </div>
                  )}
                </div>

                <div className="pr-rail-section">
                  <div className="pr-rail-title">
                    Agent rounds
                    {loop.status === "working" && <span className="pr-thread-tag">running</span>}
                  </div>
                  {loop.rounds.length === 0 && (
                    <div className="pr-rail-empty">
                      No rounds yet. A round validates each comment, fixes the cause, replies, and
                      pushes — then waits for you.
                    </div>
                  )}
                  {loop.rounds.map((r) => (
                    <div key={r.n} className="pr-round">
                      <span className="pr-round-n">#{r.n}</span>
                      <span className={`pr-thread-tag ${r.status === "blocked" ? "is-blocking" : ""}`}>
                        {r.status}
                      </span>
                      <span className="pr-round-took">
                        {r.took} comment{r.took === 1 ? "" : "s"}
                      </span>
                      {r.summary && <div className="pr-round-summary">{r.summary}</div>}
                    </div>
                  ))}
                  {pr.state === "OPEN" && role === "author" && (
                    <div className="pr-thread-actions">
                      <button
                        className="btn-mini btn-accent"
                        disabled={busy || loop.status === "working"}
                        title={
                          gate.ok
                            ? "Hand the open comments to an agent"
                            : gate.reason === "no comments to address"
                              ? "Nothing to address yet — arm it and a round starts when comments arrive"
                              : gate.reason
                        }
                        onClick={() => startRound(true)}
                      >
                        {loop.rounds.length
                          ? "Next round"
                          : gate.ok
                            ? "Start loop"
                            : "Watch for comments"}
                      </button>
                      {loop.auto && (
                        <button
                          className="btn-mini"
                          title="Stop starting rounds automatically"
                          onClick={() => persist({ ...loop, auto: false })}
                        >
                          Stop watching
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="pr-rail-section">
                  <div className="pr-rail-title">Checks</div>
                  <div className="pr-rail-row">
                    <span
                      className={`pr-checks ${liveChecks === "PASS" ? "pr-ok" : liveChecks === "FAIL" ? "pr-bad" : "pr-pending"}`}
                    >
                      {liveChecks || "no checks"}
                    </span>
                    {pr.checks_summary && <span className="pr-round-took">{pr.checks_summary}</span>}
                  </div>
                  {liveChecks === "FAIL" && (
                    <div className="pr-thread-actions">
                      <button className="btn-mini" disabled={busy} onClick={showLogs}>
                        Show failing logs
                      </button>
                      {onMicroTask && (
                        <button
                          className="btn-mini"
                          onClick={() => onMicroTask(fixCiTask, { repo, pr }, "")}
                        >
                          Fix CI
                        </button>
                      )}
                    </div>
                  )}
                  {logs && <pre className="pr-logs">{logs}</pre>}
                </div>
              </>
            )}
          </aside>
        </div>

        {error && <div className="pr-error">{error}</div>}
        {!activePatch && !error && <div className="pr-loading">Loading diff…</div>}

        {files.length > 0 && (
          <div className="pr-files-bar">
            <span>
              {files.length} file{files.length === 1 ? "" : "s"} changed
              <span className="pr-stat pr-add"> +{totalAdd}</span>
              <span className="pr-stat pr-del"> −{totalDel}</span>
              {conv && (
                <span className="pr-files-note">
                  {" "}
                  · {conv.files.filter((f) => f.viewed).length}/{conv.files.length} viewed
                </span>
              )}
            </span>
            {totalChanged > AUTO_EXPAND_TOTAL && (
              <span className="pr-files-note">large diff — files collapsed for speed</span>
            )}
            <span className="git-spacer" />
            {/* Re-reviewing means reading what changed since you last looked,
                not the whole PR again. The shas come from your own last review. */}
            {conv?.my_last_review_sha && conv.my_last_review_sha !== conv.head_sha && (
              <button
                className={`btn-mini ${deltaOn ? "btn-accent" : ""}`}
                title="Only the commits pushed since your last review"
                disabled={busy}
                onClick={() => void toggleDelta()}
              >
                {deltaOn ? "Whole PR" : "Since your review"}
              </button>
            )}
            {/* Both diff controls live on the diff, not up in the header: this
                is the bar they act on, and it keeps the header to actions that
                change the PR rather than how you're looking at it. */}
            <button
              className="btn-mini"
              title={split ? "Show one column" : "Show old and new side by side"}
              onClick={() => setSplit((v) => !v)}
            >
              {split ? "Unified" : "Split"}
            </button>
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
          const fileThreads = byPath.get(f.path) ?? [];
          const live = fileThreads.filter((t) => !t.resolved).length;
          const viewed = viewedByPath.get(f.path) ?? false;
          return (
            <div
              key={f.path}
              className={`pr-file ${viewed ? "is-viewed" : ""}`}
              ref={(el) => {
                if (el) fileRefs.current.set(f.path, el);
                else fileRefs.current.delete(f.path);
              }}
            >
              <div className="pr-file-head">
                <span className="pr-file-chevron" onClick={() => toggleFile(f.path)}>
                  {open ? "▾" : "▸"}
                </span>
                <span className="pr-file-path" title={f.path} onClick={() => toggleFile(f.path)}>
                  {f.path}
                </span>
                {live > 0 && (
                  <span className="pr-thread-tag is-blocking" title="unresolved threads on this file">
                    {live} 💬
                  </span>
                )}
                {f.binary ? (
                  <span className="pr-file-stat">binary</span>
                ) : (
                  <>
                    <span className="pr-file-stat pr-add">+{f.additions}</span>
                    <span className="pr-file-stat pr-del">−{f.deletions}</span>
                  </>
                )}
                {conv?.node_id && (
                  <label
                    className="pr-file-viewed"
                    title="Mark as viewed — shared with GitHub's own checkbox"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={viewed}
                      onChange={(e) => toggleViewed(f.path, e.target.checked)}
                    />
                    viewed
                  </label>
                )}
              </div>
              {open &&
                (f.binary ? (
                  <div className="pr-file-note">{fileNote(f.patch) ?? "Binary file — not shown."}</div>
                ) : f.changed > RENDER_CAP ? (
                  <div className="pr-file-note">
                    {f.changed.toLocaleString()} changed lines — too large to render inline.{" "}
                    <a href={`${pr.url}/files`}>Open on GitHub</a>
                  </div>
                ) : (
                  <DiffView<LineData>
                    // Only hunks — a patch has no full file content to give it,
                    // which is exactly why Monaco's diff can't render this.
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
                    // The widget is how you comment on a line: it opens a
                    // composer, and what you write is held locally until the
                    // whole review is submitted.
                    diffViewAddWidget={pr.state === "OPEN"}
                    diffViewFontSize={12}
                    extendData={extendByPath.get(f.path)}
                    renderExtendLine={({ data }) => (
                      <div className="pr-line-extend">
                        {data.threads.map((t) => threadCard(t))}
                        {data.drafts.map(draftCard)}
                      </div>
                    )}
                    renderWidgetLine={({ lineNumber, side, onClose }) => (
                      <LineComposer
                        onCancel={onClose}
                        onAdd={(body, blocking) => {
                          setDrafts((prev) => [
                            ...prev,
                            {
                              id: `${f.path}:${lineNumber}:${Date.now()}`,
                              path: f.path,
                              line: lineNumber,
                              side: side === SplitSide.old ? "LEFT" : "RIGHT",
                              body,
                              blocking,
                            },
                          ]);
                          onClose();
                        }}
                      />
                    )}
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
            {drafts.length > 0 && (
              <div className="pr-drafts">
                <div className="pr-rail-title">
                  {drafts.length} inline comment{drafts.length === 1 ? "" : "s"} — not posted yet
                  <button className="btn-mini" onClick={() => setDrafts([])}>
                    Drop all
                  </button>
                </div>
                {drafts.map(draftCard)}
              </div>
            )}
            <textarea
              className="pr-comment"
              rows={2}
              placeholder="Review comment (required for comment / request changes)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="pr-review-actions">
              {onMicroTask && (
                <button
                  className="btn-mini"
                  title="Stage the findings an agent left as draft comments — nothing is posted"
                  onClick={() => void importFindings()}
                >
                  Stage agent findings
                </button>
              )}
              <span className="git-spacer" />
              {(["approve", "request-changes", "comment"] as Review[]).map((a) => (
                <button
                  key={a}
                  className={`btn ${a === "approve" ? "btn-accent" : ""}`}
                  disabled={
                    busy || (a !== "approve" && !comment.trim() && drafts.length === 0)
                  }
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
              {drafts.length > 0 &&
                ` ${drafts.length} inline comment${drafts.length === 1 ? "" : "s"} go with it.`}
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
            {conflicting && (
              <p className="confirm-warn">
                GitHub reports merge conflicts — this will likely be rejected.
              </p>
            )}
            {liveChecks === "FAIL" && (
              <p className="confirm-warn">Some checks are failing ({pr.checks_summary}).</p>
            )}
            {liveChecks === "PENDING" && (
              <p className="confirm-warn">Checks are still running ({pr.checks_summary}).</p>
            )}
            {decision === "CHANGES_REQUESTED" && (
              <p className="confirm-warn">Changes were requested on this PR.</p>
            )}
            {!!act?.count && (
              <p className="confirm-warn">
                {act.count} comment{act.count === 1 ? "" : "s"} still unaddressed.
              </p>
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

/** The line-level composer the diff opens when you click a line's + button.
 *  Deliberately local state: what you type is a draft until the whole review is
 *  submitted, so nothing here can reach GitHub on its own. */
function LineComposer({
  onAdd,
  onCancel,
}: {
  onAdd: (body: string, blocking: boolean) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [blocking, setBlocking] = useState(true);
  return (
    <div className="pr-line-composer">
      <textarea
        className="pr-comment"
        rows={2}
        autoFocus
        placeholder="Comment on this line — held until you submit the review"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="pr-thread-actions">
        <label className="pr-blocking-check">
          <input
            type="checkbox"
            checked={blocking}
            onChange={(e) => setBlocking(e.target.checked)}
          />
          blocking
        </label>
        <span className="git-spacer" />
        <button className="btn-mini" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn-mini btn-accent"
          disabled={!body.trim()}
          onClick={() => onAdd(body.trim(), blocking)}
        >
          Add
        </button>
      </div>
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

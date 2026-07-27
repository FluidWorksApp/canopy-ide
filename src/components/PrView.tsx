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
import { TaskProgress } from "./TaskProgress";
import type { AgentTarget } from "./TicketsPanel";
import {
  MICRO_TASKS,
  PR_REVIEW_STEPS,
  addressPrCommentsTask,
  applySuggestionTask,
  fixCiTask,
  followUpsTask,
  prArtifactPath,
  prReviewTask,
  runItReviewTask,
  stepsDone,
  type MicroTaskDef,
} from "../microTasks";
import { rowFor, subscribe as subscribeToPrs } from "../prWatchStore";
import { TASK_HISTORY_EVENT, taskRuns, type TaskRun } from "../taskHistory";
import {
  actionable,
  alreadyPosted,
  fabAction,
  type FabActionId,
  fileNote,
  isNit,
  nextMove,
  patchLines,
  resolvePath,
  roleFor,
  snapLine,
  threadSuggestion,
  threadsByPath,
  verdicts,
  type MoveId,
  type NextMove,
} from "../prReview";
import {
  beginRound,
  findingKey,
  finishRound,
  isLandable,
  isRoundStale,
  loadLoop,
  markDone,
  markReady,
  newSinceHandled,
  postedFindings,
  rememberPosted,
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
  /** Staged from a Review task rather than typed by the user. It posts under
   *  their name either way, which is exactly why the tab has to keep saying
   *  which of the two it is right up until they submit it. */
  fromAgent?: boolean;
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
  /** Which files' diffs are mounted. Declared up here, not beside the effect
   *  that seeds it, because staging findings has to open the files they land
   *  in — a draft comment inside a collapsed file is a comment nobody sees. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [logs, setLogs] = useState<string | null>(null);
  /** People who could be asked to review — loaded only when that's the move. */
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [map, setMap] = useState<string | null>(null);
  const [deltaOn, setDeltaOn] = useState(false);
  const [deltaPatch, setDeltaPatch] = useState<string | null>(null);
  const [loop, setLoop] = useState<PrLoop>(() => loadLoop(repo, pr.number));
  /** Tasks running against THIS pull request, read off the run log rather than
   *  remembered locally: a click on a CTA and a launch from the Agent menu both
   *  land there, and it survives the tab being closed and reopened. */
  const [running, setRunning] = useState<TaskRun[]>([]);

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

  /** Findings already turned into drafts, so a second read doesn't stack them —
   *  and a counter, because two findings can differ only in body. Both are per
   *  PR, and both reset with everything else when the tab changes PR. */
  const stagedKeys = useRef<Set<string>>(new Set());
  const stageSeq = useRef(0);

  /** Load the findings the Review task left behind and turn them into draft
   *  comments. They are proposals: nothing is posted until the human submits the
   *  review, and each one can be edited or dropped first.
   *
   *  This runs itself when the task finishes rather than waiting for a button.
   *  A staging step the user has to know to press is a step where work an agent
   *  already did sits in a file nobody opens. */
  const stageFindings = useCallback(async () => {
    // null means "there is no findings artifact", which is not the same as a
    // run that found nothing: one says the task never got there, the other is a
    // clean bill of health, and the rail has to tell them apart.
    let raw: string;
    try {
      raw = await ipc.fsReadText(prArtifactPath(repo, pr.number, "findings"));
    } catch {
      return null;
    }
    let found: {
      path: string;
      line: number;
      side?: string;
      severity?: string;
      body: string;
    }[];
    try {
      const parsed = JSON.parse(raw) as { findings?: typeof found };
      found = (parsed.findings ?? []).filter(
        (f) => f.path && f.line > 0 && f.body?.trim(),
      );
    } catch {
      onNotice(
        "The agent's findings file isn't valid JSON — nothing staged.",
        "error",
      );
      return null;
    }
    // Re-reading the same file (a second run, a re-opened tab) must not stack
    // the same comment twice, so identity is the finding itself, not the read.
    // The ledger is a ref and not the drafts list: dropping a finding you didn't
    // agree with is a decision, and the next read must not undo it. `posted`
    // outlives the tab for the same reason — nothing deletes the findings file
    // when a review is submitted, so on the next mount every comment that is
    // now a live thread on GitHub would be offered back as a fresh draft.
    const key = findingKey;
    const posted = postedFindings(repo, pr.number);
    const fresh = found.filter(
      (f) => !stagedKeys.current.has(key(f)) && !posted.has(key(f)),
    );
    if (!fresh.length) return 0;
    for (const f of fresh) stagedKeys.current.add(key(f));
    // A finding renders inline, at its line — which shows nothing at all if the
    // file is one of the ones a big PR left collapsed. Open the ones we just
    // put a comment in; leave the rest of the fold alone.
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const f of fresh) next.add(f.path);
      return next;
    });
    setDrafts((prev) => [
      ...prev,
      ...fresh.map((f, i) => ({
        id: `finding-${pr.number}-${stageSeq.current++}-${i}`,
        path: f.path,
        line: f.line,
        side: f.side === "LEFT" ? ("LEFT" as const) : ("RIGHT" as const),
        body: f.body.trim(),
        blocking: f.severity !== "nit",
        fromAgent: true,
      })),
    ]);
    return fresh.length;
  }, [repo, pr.number, onNotice]);

  useEffect(() => {
    let live = true;
    setPatch(null);
    setError(null);
    setConv(null);
    setBodyFallback("");
    setDrafts([]);
    setDeltaOn(false);
    setDeltaPatch(null);
    stagedKeys.current = new Set();
    setLoop(loadLoop(repo, pr.number));
    void ipc
      .ghPrDiff(repo, pr.number)
      .then((d) => live && setPatch(d))
      .catch((e) => live && setError(String(e)));
    void refreshConv();
    // What an earlier Review left behind: the map the body renders, and the
    // findings, staged as drafts again so re-opening the tab doesn't lose them.
    void ipc
      .fsReadText(prArtifactPath(repo, pr.number))
      .then((t) => live && setMap(t.trim() || null))
      .catch(() => {});
    void stageFindings();
    return () => {
      live = false;
    };
  }, [repo, pr.number, refreshConv, stageFindings]);

  useEffect(() => {
    const read = () =>
      setRunning(
        taskRuns().filter(
          (r) => r.status === "running" && r.brief.includes(pr.url),
        ),
      );
    read();
    window.addEventListener(TASK_HISTORY_EVENT, read);
    // The log is written by the launcher and by job_done; the event covers both,
    // and the interval only keeps the elapsed counter honest.
    const tick = window.setInterval(read, 1000);
    return () => {
      window.removeEventListener(TASK_HISTORY_EVENT, read);
      window.clearInterval(tick);
    };
  }, [pr.url]);

  /** The Review task's terminal closes itself, so the moment it leaves the
   *  running list is the only signal the tab gets that its two files are on
   *  disk. Pick them up then: the map into the body, the findings into drafts.
   *
   *  `settling` keeps the rail up across the handoff. Reading the two files
   *  takes a moment, and without it the rail vanished the instant the run ended
   *  — a flash of the idle "Review this for me" button before the map appeared,
   *  which reads as the review having failed. It also buys the last milestone
   *  the second of screen time it earned. */
  const [settling, setSettling] = useState(false);
  const reviewWasRunning = useRef(false);
  useEffect(() => {
    const now = running.some((r) => r.taskId === prReviewTask.id);
    const finished = reviewWasRunning.current && !now;
    reviewWasRunning.current = now;
    if (!finished) return;
    setSettling(true);
    const landed = Promise.all([
      ipc
        .fsReadText(prArtifactPath(repo, pr.number))
        .then((t) => {
          const body = t.trim();
          setMap(body || null);
          return !!body;
        })
        .catch(() => false),
      stageFindings().then((n) => {
        if (n)
          onNotice(
            `${n} finding(s) staged as draft comments — none posted yet.`,
          );
        return n;
      }),
    ]);
    let timer = 0;
    void landed.then(([mapLanded, staged]) => {
      // Close the rail off against what actually reached disk, rather than
      // appending "staged" because the run ended. Blind-appending is what put a
      // lone green tick on the last milestone with the first three still blank
      // — a run that had produced nothing claiming it had finished.
      const done: string[] = [];
      if (mapLanded || staged !== null) done.push("read");
      if (mapLanded) done.push("map");
      if (staged !== null) done.push("findings", "staged");
      if (done.length) setSteps((prev) => [...new Set([...prev, ...done])]);
      timer = window.setTimeout(() => setSettling(false), 900);
    });
    return () => window.clearTimeout(timer);
  }, [running, repo, pr.number, stageFindings, onNotice]);

  /** Tasks we've just dispatched, before the launcher has written them to the
   *  run log. An isolated task builds a worktree first, which can take seconds —
   *  and a button that does nothing for seconds is a button that looks broken. */
  const [pending, setPending] = useState<Record<string, number>>({});
  const isRunning = (taskId: string) =>
    running.some((r) => r.taskId === taskId);
  const isBusyTask = (taskId: string) =>
    isRunning(taskId) || pending[taskId] != null;

  /** Milestones the running Review has reported. Polled rather than pushed: the
   *  agent appends to a file (every CLI can, with or without the MCP bridge), so
   *  the tab has to look. Strictly gated on the task actually running — a poll
   *  that outlives what it was watching is a tab that never goes quiet. */
  const [steps, setSteps] = useState<string[]>([]);
  /** What the progress file held when this run started. Until it changes, the
   *  agent hasn't truncated it yet and the contents are the *previous* run's —
   *  showing those would open a fresh review already at four-of-four. */
  const progressBase = useRef<string | null>(null);
  const reviewBusy = isBusyTask(prReviewTask.id);
  useEffect(() => {
    if (!reviewBusy) return;
    let live = true;
    const path = prArtifactPath(repo, pr.number, "progress");
    const read = () =>
      void ipc
        .fsReadText(path)
        .then((t) => {
          if (!live) return;
          if (progressBase.current === null) progressBase.current = t;
          setSteps(
            t === progressBase.current ? [] : stepsDone(t, PR_REVIEW_STEPS),
          );
        })
        .catch(() => {
          // No file yet is the normal first second of a run, not an error.
          if (live && progressBase.current === null) progressBase.current = "";
        });
    read();
    const tick = window.setInterval(read, 1200);
    return () => {
      live = false;
      window.clearInterval(tick);
    };
  }, [reviewBusy, repo, pr.number]);

  /** Every task launch on this tab goes through here. */
  const launch = useCallback(
    <P,>(def: MicroTaskDef<P>, payload: P, query = "") => {
      if (!onMicroTask) return;
      setPending((p) => ({ ...p, [def.id]: Date.now() }));
      // A new run starts the rail empty and re-arms the staleness guard, so the
      // last run's milestones don't flash up before this agent has written one.
      if (def.id === prReviewTask.id) {
        setSteps([]);
        progressBase.current = null;
      }
      onMicroTask(def, payload, query);
      // Review reports its milestones on this page, so pointing at the Running
      // now panel would send you away from the thing that's actually showing.
      onNotice(
        def.id === prReviewTask.id
          ? `${def.label}: an agent is starting — its progress is on this page.`
          : `${def.label}: an agent is starting — watch it under "Running now".`,
      );
    },
    [onMicroTask, onNotice],
  );

  // Clear a pending marker once the run log shows it, or if it never appears
  // (the launcher refused: no CLI installed, worktree failed) so the button
  // comes back rather than sitting disabled forever.
  useEffect(() => {
    const ids = Object.keys(pending);
    if (!ids.length) return;
    const now = Date.now();
    const stale = ids.filter(
      (id) =>
        running.some((r) => r.taskId === id) || now - pending[id] > 30_000,
    );
    if (!stale.length) return;
    setPending((p) => {
      const next = { ...p };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [running, pending]);
  const MOVE_TASK: Partial<Record<MoveId, string>> = {
    "self-review": prReviewTask.id,
    "fix-ci": fixCiTask.id,
    "review-it": prReviewTask.id,
    "address-comments": addressPrCommentsTask.id,
  };
  const moveRunning = (m: NextMove) => {
    const id = MOVE_TASK[m.id];
    return !!id && isBusyTask(id);
  };
  const elapsed = (r: TaskRun) => {
    const s = Math.max(0, Math.round((Date.now() - r.startedAt) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  // Undefined for the seconds between the click and the run log catching up:
  // the rail is already up by then, and a counter that starts at 0s twice is
  // worse than one that starts a moment late.
  const reviewRun = running.find((r) => r.taskId === prReviewTask.id);
  const reviewElapsed = reviewRun ? elapsed(reviewRun) : undefined;

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

  /** The floating button's default action — its own four states, not the next
   *  move bar's list. See fabAction() for why they are deliberately different. */
  const fab = useMemo(
    () => fabAction(pr, conv, { actionable: act?.count ?? 0 }),
    [pr, conv, act?.count],
  );

  /** Moves whose button already exists two controls to the right. Now that the
   *  next move shares the title row, rendering its action as well put Merge
   *  beside Merge — the sentence is still worth saying, the second button is
   *  not. The accent on the real one already marks it as the move. */
  const movesOwnButton = move.id === "merge" || move.id === "mark-ready";

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
          onNotice(
            "Armed — a round starts by itself when review comments arrive.",
          );
          return;
        }
        onNotice(gate.reason ?? "Nothing to address right now.");
        return;
      }
      launch(addressPrCommentsTask, { repo, pr });
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

  /** What the button says while its job runs — the job's own name, so a glance
   *  still tells you which of the four you started. */
  const FAB_BUSY: Record<FabActionId, string> = {
    "resolve-conflicts": "Resolving…",
    review: "Reviewing…",
    address: "Addressing…",
    "fix-ci": "Fixing CI…",
    merge: "Merging…",
  };

  /** Running the floating button's default. Merge is the one that isn't an
   *  agent task — it opens the same method menu the header's Merge does, since
   *  choosing squash vs rebase stays a human decision. */
  const fabBusy =
    (fab?.id === "review" && isBusyTask(prReviewTask.id)) ||
    (fab?.id === "fix-ci" && isBusyTask(fixCiTask.id)) ||
    (fab?.id === "address" && isBusyTask(addressPrCommentsTask.id));
  const runFab = () => {
    switch (fab?.id) {
      case "resolve-conflicts":
        // The one state with no micro-task: a conflict needs a checkout and a
        // judgement per hunk, so it goes to a full agent in a worktree — the
        // same thing the menu offers when the PR conflicts.
        onStartResolve("claude");
        break;
      case "review":
        launch(prReviewTask, { repo, pr });
        break;
      case "address":
        startRound(false);
        break;
      case "fix-ci":
        launch(fixCiTask, { repo, pr });
        break;
      case "merge":
        setMergeOpen(true);
        break;
    }
  };

  /** Drop staged findings the PR already carries as real comments.
   *
   *  The local ledger stops the ones this tab posted, but the findings file on
   *  disk outlives any review submitted before that ledger existed, from another
   *  machine, or after the browser store was cleared — and those came back as
   *  drafts sitting directly under the identical posted thread. The conversation
   *  is the source that always knows, so this runs whenever it refreshes, and
   *  writes the matches to the ledger so the next mount skips the round trip. */
  useEffect(() => {
    const threads = conv?.threads;
    if (!threads?.length || !drafts.length) return;
    const gone = drafts.filter((d) => alreadyPosted(d, threads));
    if (!gone.length) return;
    rememberPosted(repo, pr.number, gone.map(findingKey));
    const drop = new Set(gone.map((d) => d.id));
    setDrafts((prev) => prev.filter((d) => !drop.has(d.id)));
  }, [conv?.threads, drafts, repo, pr.number]);

  /** A round's agent reported in. job_done is broadcast globally with the PR's
   *  own URL (every PR brief passes it), so match on that rather than trying to
   *  hold on to a pty id across a tab that closes itself. */
  useEffect(() => {
    const onAction = (e: Event) => {
      const action = (e as CustomEvent).detail?.action as
        ipc.AgentAction | undefined;
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
          const pushed =
            !!c && !!round?.headSha && c.head_sha !== round.headSha;
          const next = finishRound(
            prev,
            action.status === "blocked" ? "blocked" : "done",
            action.summary,
            pushed,
          );
          return saveLoop(
            c && isLandable(c) && next.status === "waiting"
              ? markReady(next)
              : next,
          );
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
    if (!loop.auto && loop.status !== "waiting" && loop.status !== "ready")
      return;
    let live = true;
    const tick = async () => {
      if (!live || document.visibilityState !== "visible") return;
      const c = await refreshConv();
      if (!live || !c) return;
      const fresh = newSinceHandled(c, loop);
      if (fresh.length && loop.auto) {
        const g = roundGate(pr, c, loop);
        if (g.ok) {
          launch(addressPrCommentsTask, { repo, pr });
          persist(beginRound(loop, g.ids, c.head_sha));
          onNotice(
            `Round ${loop.cycle + 1}: ${g.ids.length} new comment(s) came back — agent is on it.`,
          );
          return;
        }
        if (g.reason)
          persist({ ...loop, status: "blocked", blockedReason: g.reason });
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
        ? await ipc.ghPrReviewBatch(
            repo,
            conv.node_id,
            action,
            comment,
            threads,
          )
        : await ipc.ghPrReview(repo, pr.number, action, comment || undefined);
      setDone(msg);
      onNotice(msg);
      setComment("");
      // Written before the list is cleared, and only after the mutation came
      // back clean: these are on GitHub now, so the findings file must never
      // offer them again.
      rememberPosted(repo, pr.number, drafts.map(findingKey));
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
      c
        ? {
            ...c,
            files: c.files.map((f) => (f.path === path ? { ...f, viewed } : f)),
          }
        : c,
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
      const d =
        deltaPatch ??
        (await ipc.ghPrDiffSince(repo, conv.my_last_review_sha, conv.head_sha));
      setDeltaPatch(d);
      setDeltaOn(true);
    } catch (err) {
      onNotice(`Couldn't diff since your review: ${String(err)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const jumpToFile = (path: string) => {
    setExpanded((prev) => new Set(prev).add(path));
    // Let the diff mount before scrolling to it.
    setTimeout(
      () => fileRefs.current.get(path)?.scrollIntoView({ block: "start" }),
      60,
    );
  };

  /** Go to a staged finding where it lives — the comment itself, not the top of
   *  the file it happens to be in. Scrolling to the file header and leaving you
   *  to find the comment is what made these read as links that go nowhere. */
  const jumpToDraft = (d: DraftComment) => {
    const at = placed.get(d.id);
    if (!at) {
      onNotice(
        `${d.path}:${d.line} isn't in this diff — the comment posts, but there's no line here to show it on.`,
      );
      return;
    }
    setExpanded((prev) => new Set(prev).add(at.path));
    setTimeout(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-draft-id="${CSS.escape(d.id)}"]`,
      );
      (el ?? fileRefs.current.get(at.path))?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
      if (el) {
        el.classList.add("is-flash");
        setTimeout(() => el.classList.remove("is-flash"), 1200);
      }
    }, 80);
  };

  const dispatchMove = (m: NextMove, e: React.MouseEvent) => {
    switch (m.id) {
      case "self-review":
        launch(prReviewTask, { repo, pr });
        break;
      case "mark-ready":
        void ready();
        break;
      case "fix-ci":
        launch(fixCiTask, { repo, pr });
        break;
      case "update-branch":
        void runAction("Update branch", () =>
          ipc.ghPrUpdateBranch(repo, pr.number),
        );
        break;
      case "resolve-conflicts":
        onStartResolve("claude");
        break;
      case "address-comments":
        startRound(true);
        break;
      case "review-it":
        launch(prReviewTask, { repo, pr });
        break;
      case "request-review":
        // The real event: useContextMenu calls preventDefault on it, so a
        // hand-made {clientX, clientY} threw and the button did nothing.
        moreMenu.openUnder(e, reviewerItems());
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
  const totalAdd = useMemo(
    () => files.reduce((n, f) => n + f.additions, 0),
    [files],
  );
  const totalDel = useMemo(
    () => files.reduce((n, f) => n + f.deletions, 0),
    [files],
  );

  // The PR body is markdown (headings, tables, code) — render it, don't dump it
  // as raw text. renderMarkdown sanitizes with DOMPurify, which matters: a PR
  // body is authored by whoever opened it, and raw HTML in the webview reaches
  // every Tauri command. Memoised so it isn't re-parsed on each keystroke.
  const bodyText = conv?.body?.trim() ? conv.body : bodyFallback;
  const bodyHtml = useMemo(
    () => (bodyText.trim() ? renderMarkdown(bodyText) : ""),
    [bodyText],
  );
  const mapHtml = useMemo(() => (map ? renderMarkdown(map) : ""), [map]);

  const byPath = useMemo(
    () => threadsByPath(conv?.threads ?? []),
    [conv?.threads],
  );
  const viewedByPath = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const f of conv?.files ?? []) m.set(f.path, f.viewed);
    return m;
  }, [conv?.files]);

  /** Where each draft actually lands in the rendered diff.
   *
   *  Resolved here and not when the finding is staged, for two reasons: the
   *  findings can be read back before the patch has arrived, and the diff can
   *  change under them (the delta toggle re-renders a different patch). A draft
   *  whose file isn't in this diff at all gets `placed: null` and says so rather
   *  than quietly rendering nowhere. */
  const placed = useMemo(() => {
    const paths = files.map((f) => f.path);
    const lines = new Map<string, ReturnType<typeof patchLines>>();
    const out = new Map<string, { path: string; line: number } | null>();
    for (const d of drafts) {
      const path = resolvePath(d.path, paths);
      if (!path) {
        out.set(d.id, null);
        continue;
      }
      let present = lines.get(path);
      if (!present) {
        present = patchLines(files.find((f) => f.path === path)?.patch ?? "");
        lines.set(path, present);
      }
      const line = snapLine(d.line, present[d.side]);
      out.set(d.id, line == null ? null : { path, line });
    }
    return out;
  }, [drafts, files]);

  /** Findings the diff has no line for — the file isn't in it, or the line the
   *  agent named is nowhere near one it renders. They'd be invisible otherwise:
   *  still posted on submit, but never shown against any code. */
  const unplaced = useMemo(
    () => drafts.filter((d) => !placed.get(d.id)),
    [drafts, placed],
  );

  /** Line-anchored payloads for the diff renderer: threads and drafts keyed by
   *  the line they belong to, per file, per side. Built once per conversation
   *  change rather than scanned inside every file card's render. */
  const extendByPath = useMemo(() => {
    const out = new Map<
      string,
      {
        oldFile: Record<string, { data: LineData }>;
        newFile: Record<string, { data: LineData }>;
      }
    >();
    const put = (
      path: string,
      side: "LEFT" | "RIGHT",
      line: number,
      fill: (d: LineData) => void,
    ) => {
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
      put(t.path, t.side === "LEFT" ? "LEFT" : "RIGHT", t.line, (d) =>
        d.threads.push(t),
      );
    // The resolved location, not the reported one — that's the difference
    // between a comment on the code and a comment nowhere.
    for (const d of drafts) {
      const at = placed.get(d.id);
      if (at) put(at.path, d.side, at.line, (x) => x.drafts.push(d));
    }
    return out;
  }, [conv?.threads, drafts, placed]);

  const blockingDrafts = useMemo(
    () => drafts.filter((d) => d.blocking).length,
    [drafts],
  );

  /** Which button gets the accent. Approve wore it unconditionally, which is
   *  wrong the moment something blocking is staged — the emphasised action was
   *  the one the findings say not to take. With nothing staged there is no
   *  verdict to imply, so it falls back to Approve. */
  const suggestedVerdict: Review =
    drafts.length > 0 && blockingDrafts > 0 ? "request-changes" : "approve";

  /** How many staged findings each file is holding, for the badge on its row. */
  const draftsByPath = useMemo(() => {
    const out = new Map<string, number>();
    for (const d of drafts) out.set(d.path, (out.get(d.path) ?? 0) + 1);
    return out;
  }, [drafts]);

  /** Threads GitHub can't place any more (the line is gone) — they'd silently
   *  disappear if the rail didn't list them. */
  const unanchored = useMemo(
    () => (conv?.threads ?? []).filter((t) => !t.line && !t.resolved),
    [conv?.threads],
  );

  // Seed what's mounted. Small PRs open everything (it's cheap and you want to
  // read it all); big PRs open only the small, human files up to a budget and
  // leave lockfile-scale churn collapsed, so the tab paints instantly instead
  // of blocking on a highlight of 28k lines.
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
      if (f.binary || f.changed > AUTO_EXPAND_FILE || budget - f.changed < 0)
        continue;
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
  const mergeReady =
    decision === "APPROVED" && !conflicting && liveChecks !== "FAIL";

  const reviewerItems = (): MenuItem[] => {
    const items: MenuItem[] = [];
    // Whoever already reviewed can be asked again — the after-a-push case.
    const past = Array.from(
      new Set(
        (conv?.reviews ?? []).filter((r) => !r.mine).map((r) => r.author),
      ),
    );
    for (const login of past)
      items.push({
        label: `Re-request ${login}`,
        onClick: () =>
          void runAction("Request review", () =>
            ipc.ghPrRequestReview(repo, pr.number, [login]),
          ),
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
            void runAction("Request review", () =>
              ipc.ghPrRequestReview(repo, pr.number, [login]),
            ),
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
      items.push({
        label: "Nobody has reviewed it yet — ask on GitHub",
        disabled: true,
      });
    return items;
  };

  /** Everything an agent can do with this PR, in one flat menu: four one-shot
   *  tasks that need nothing from you but a click, then handing it to an agent
   *  in a worktree. Four, because everything read-only collapsed into Review —
   *  mapping the change, finding problems and self-reviewing were one job wearing
   *  three names, and asking which one you wanted was asking you to choose before
   *  the agent had read a line. Built at open time so a newly-started agent is in
   *  the list. When the PR conflicts, resolving them replaces reviewing — there
   *  is no point reviewing a diff git can't even merge. */
  const openAgentMenu = (e: React.MouseEvent) => {
    const items: MenuItem[] = [];
    if (onMicroTask && !conflicting) {
      items.push({
        label: prReviewTask.label,
        icon: <span className="ctx-glyph">{prReviewTask.icon}</span>,
        hint: "stages drafts for you, posts nothing",
        disabled: isBusyTask(prReviewTask.id),
        onClick: () => launch(prReviewTask, { repo, pr }),
      });
      if (pr.state === "OPEN") {
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
            disabled: isBusyTask(fixCiTask.id),
            onClick: () => launch(fixCiTask, { repo, pr }),
          });
      }
      items.push({
        label: runItReviewTask.label,
        icon: <span className="ctx-glyph">{runItReviewTask.icon}</span>,
        hint: "starts it and takes screenshots",
        disabled: isBusyTask(runItReviewTask.id),
        onClick: () => launch(runItReviewTask, { repo, pr }),
      });
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
    // Opened from the floating button, which lives at the bottom of the window:
    // hanging the panel below it would put it off-screen and leave the clamp to
    // drag it back. It grows upward, which is what the ▴ on the caret promises.
    agentMenu.openAbove(e, items);
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
          void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
            openUrl(pr.url),
          ),
      },
    ];
    if (pr.state === "OPEN") {
      items.push({
        label: "Sync with base branch",
        hint: "gh pr update-branch",
        onClick: () =>
          void runAction("Update branch", () =>
            ipc.ghPrUpdateBranch(repo, pr.number),
          ),
      });
      items.push({ label: "Request review", submenu: reviewerItems() });
      // Real, and rare: the tail of comments that are legitimate but out of
      // scope. It earned a place, not a place in the primary list.
      if (onMicroTask)
        items.push({
          label: followUpsTask.label,
          hint: "out-of-scope comments become issues",
          disabled: isBusyTask(followUpsTask.id),
          onClick: () => launch(followUpsTask, { repo, pr }),
        });
      items.push({
        label: conv?.auto_merge
          ? "Turn auto-merge off"
          : "Auto-merge when green",
        hint: conv?.auto_merge
          ? undefined
          : "GitHub merges it once its own conditions pass",
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
    moreMenu.openUnder(e, items);
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
          <span
            className="pr-thread-where"
            onClick={() => jumpToFile(t.path)}
            title={t.path}
          >
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
            <button
              className="btn-mini"
              onClick={() => setReplyTo(replyTo === t.id ? null : t.id)}
            >
              Reply
            </button>
            <button
              className="btn-mini"
              onClick={() => setResolved(t.id, !t.resolved)}
            >
              {t.resolved ? "Reopen" : "Resolve"}
            </button>
            {suggestion && onMicroTask && (
              <button
                className="btn-mini"
                title="Apply the suggested change in a worktree, run the tests, and push"
                onClick={() =>
                  launch(applySuggestionTask, {
                    repo,
                    pr,
                    path: t.path,
                    line: t.line,
                    suggestion,
                    threadId: t.id,
                  })
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

  /** One line of a finding for the manifest: the "Nit: " prefix is already said
   *  by the severity chip beside it, and markdown ticks read as noise at this
   *  size. Trailing ellipsis only when something was actually cut. */
  const gist = (body: string) => {
    const flat = body
      .replace(/^\s*nit:\s*/i, "")
      .replace(/`/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return flat.length > 120 ? `${flat.slice(0, 119).trimEnd()}…` : flat;
  };

  const draftCard = (d: DraftComment) => (
    // The id is the anchor jumpToDraft scrolls to — without it the best the
    // manifest could do was the top of the file.
    <div
      key={d.id}
      className={`pr-draft ${d.fromAgent ? "is-agent-made" : ""}`}
      data-draft-id={d.id}
    >
      <div className="pr-thread-head">
        {/* Sitting inline among human review threads, an agent's finding is
            indistinguishable from a colleague's without this. */}
        {d.fromAgent && (
          <span
            className="agent-byline"
            title="Found by an agent — you haven't posted it"
          >
            <AgentsIcon size={11} /> Agent
          </span>
        )}
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
        // An agent's finding runs to a paragraph or two — states the input, the
        // state, and what goes wrong. Two rows turned every one of them into a
        // scrollbar inside a scrollbar, so the box grows to the text instead.
        rows={Math.min(
          14,
          Math.max(
            3,
            Math.ceil(d.body.length / 84) + d.body.split("\n").length,
          ),
        )}
        value={d.body}
        onChange={(e) =>
          setDrafts((prev) =>
            prev.map((x) =>
              x.id === d.id ? { ...x, body: e.target.value } : x,
            ),
          )
        }
      />
      <div className="pr-thread-actions">
        <button
          className="btn-mini"
          onClick={() =>
            setDrafts((prev) =>
              prev.map((x) =>
                x.id === d.id ? { ...x, blocking: !x.blocking } : x,
              ),
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
          above={agentMenu.menu.above}
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
          {/* The next move, on the title's line and immediately left of Merge.
              A PR is always in one state that implies one action, and that
              action belongs beside the other one you can take here — as its own
              full-width row below, it pushed the diff down to say what the
              empty half of this line had room for. */}
          <div className={`pr-next ${move.urgent ? "is-urgent" : ""}`}>
            <span className="pr-next-label" title={move.hint}>
              {move.label}
            </span>
            {move.action &&
              !movesOwnButton &&
              (moveRunning(move) ? (
                <span className="pr-next-running">
                  <span className="pr-run-dot" /> working on it…
                </span>
              ) : (
                <button
                  className="btn-mini btn-accent"
                  disabled={busy}
                  title={move.hint}
                  onClick={(e) => dispatchMove(move, e)}
                >
                  {move.action}
                </button>
              ))}
            {loop.status === "waiting" && loop.auto && (
              <span className="pr-next-note">watching for new comments</span>
            )}
            {loop.blockedReason && (
              <span className="pr-next-note">{loop.blockedReason}</span>
            )}
          </div>
          <div className="pr-actions">
            {/* Agent used to sit here and now floats bottom-right, where it
                follows you down the diff. Two of it would be one too many. */}
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
                  <div
                    className="cli-menu"
                    onMouseLeave={() => setMergeOpen(false)}
                  >
                    {(["squash", "merge", "rebase"] as MergeMethod[]).map(
                      (m) => (
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
                      ),
                    )}
                  </div>
                )}
              </div>
            )}
            <button
              className="btn-mini pr-more"
              title="More actions"
              onClick={openMoreMenu}
            >
              ⋯
            </button>
          </div>
        </div>
        <div className="pr-sub">
          <span>
            {pr.author} wants to merge <code>{pr.branch}</code> →{" "}
            <code>{pr.base}</code>
          </span>
          {pr.created && (
            <span className="pr-when" title={absTime(pr.created)}>
              opened {ago(pr.created)}
            </span>
          )}
          <span className="pr-stat pr-add">+{pr.additions}</span>
          <span className="pr-stat pr-del">−{pr.deletions}</span>
          {(conv?.draft ?? pr.draft) && (
            <span className="pr-decision">draft</span>
          )}
          {decision && (
            <span className="pr-decision">
              {decision.toLowerCase().replace("_", " ")}
            </span>
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
            <span
              className="pr-checks pr-pending"
              title="unresolved comments and change requests"
            >
              {act.count} to address
            </span>
          )}
          {conv?.auto_merge && (
            <span className="pr-decision">auto-merge armed</span>
          )}
        </div>
        {/* In the header, not the body: the body scrolls, and a progress rail
            you lose the moment you start reading the diff is a progress rail
            for the thirty seconds you were not going to look away anyway. This
            panel is pinned, so the run stays in sight for its whole life. */}
        {(reviewBusy || settling) && (
          <TaskProgress
            steps={PR_REVIEW_STEPS}
            done={steps}
            active={reviewBusy}
            title={reviewBusy ? "Reviewing this change" : "Review finished"}
            elapsed={reviewElapsed}
          />
        )}
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
              <div className="pr-description pr-map is-agent-made">
                {/* Named, not just styled. This is a model's reading of the
                    diff sitting directly under the PR's own description, and
                    the two must never be mistaken for each other. */}
                <div className="pr-rail-title agent-byline">
                  <AgentsIcon size={12} />
                  Review map
                  <span className="agent-byline-note">written by an agent</span>
                  <button
                    className="btn-mini"
                    disabled={reviewBusy}
                    title="Have an agent read it again"
                    onClick={() => launch(prReviewTask, { repo, pr })}
                  >
                    {reviewBusy ? "Reviewing…" : "Review again"}
                  </button>
                </div>
                <div
                  className="markdown-body"
                  dangerouslySetInnerHTML={{ __html: mapHtml }}
                />
                {/* Where the other half of the review went. Without this the
                    findings are a surprise you meet by scrolling: staged, real,
                    and unmentioned by the one card that says a review ran. */}
                {drafts.length > 0 && (
                  <button
                    className={`pr-map-findings ${blockingDrafts > 0 ? "is-blocking" : ""}`}
                    title="Jump to the first one"
                    onClick={() => jumpToDraft(drafts[0])}
                  >
                    <span className="pr-run-dot is-static" />
                    <strong>
                      {drafts.length}{" "}
                      {drafts.length === 1 ? "finding" : "findings"}
                    </strong>{" "}
                    staged as {drafts.length === 1 ? "a draft" : "drafts"}
                    {blockingDrafts > 0 && `, ${blockingDrafts} blocking`}
                    {unplaced.length > 0 && `, ${unplaced.length} off-diff`} —
                    nothing posted
                    <span className="pr-map-findings-go">›</span>
                  </button>
                )}
              </div>
            )}
            {!mapHtml && !reviewBusy && !settling && onMicroTask && (
              <div className="pr-map-cta">
                {/* The one thing this empty state exists to offer, so it wears
                    the primary tier. As a btn-mini it sat at the same weight as
                    "Regenerate" and "Drop" and nobody found it. */}
                <button
                  className="btn-mini btn-accent"
                  onClick={() => launch(prReviewTask, { repo, pr })}
                >
                  {prReviewTask.icon} Review this for me
                </button>
                <span className="pr-files-note">
                  risk-ranked, findings staged as drafts, nothing posted
                </span>
              </div>
            )}
          </div>

          <aside className="pr-rail">
            {convError && <div className="pr-error">{convError}</div>}
            {!conv && !convError && (
              <div className="pr-loading">Loading conversation…</div>
            )}

            {conv && (
              <>
                <div className="pr-rail-section">
                  <div className="pr-rail-title">
                    Conversation
                    <button
                      className="btn-mini"
                      title="Refresh"
                      onClick={() => void refreshConv()}
                    >
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
                        <span>
                          {VERDICT_LABEL[r.state] ?? r.state.toLowerCase()}
                        </span>
                        <span
                          className="pr-comment-when"
                          title={absTime(r.submitted)}
                        >
                          {ago(r.submitted)}
                        </span>
                      </div>
                      {r.body.trim() && (
                        <div
                          className="markdown-body pr-comment-body"
                          dangerouslySetInnerHTML={{
                            __html: renderMarkdown(r.body),
                          }}
                        />
                      )}
                    </div>
                  ))}
                  {conv.threads
                    .filter((t) => !t.resolved)
                    .map((t) => threadCard(t, true))}
                  {conv.comments.map((c) => (
                    <div key={c.id} className="pr-comment-row">
                      <div className="pr-comment-meta">
                        <span className="pr-comment-author">{c.author}</span>
                        <span
                          className="pr-comment-when"
                          title={absTime(c.created)}
                        >
                          {ago(c.created)}
                        </span>
                      </div>
                      <div
                        className="markdown-body pr-comment-body"
                        dangerouslySetInnerHTML={{
                          __html: renderMarkdown(c.body),
                        }}
                      />
                    </div>
                  ))}
                  {conv.threads.some((t) => t.resolved) && (
                    <div className="pr-rail-empty">
                      {conv.threads.filter((t) => t.resolved).length} resolved
                      thread(s) hidden.
                    </div>
                  )}
                  {unanchored.length > 0 && (
                    <div className="pr-rail-empty">
                      {unanchored.length} thread(s) whose line no longer exists
                      — listed above, not in the diff.
                    </div>
                  )}
                </div>

                {(running.length > 0 || Object.keys(pending).length > 0) && (
                  <div className="pr-rail-section pr-rail-running">
                    <div className="pr-rail-title">
                      Running now
                      <span className="pr-thread-tag">
                        {running.length +
                          Object.keys(pending).filter((id) => !isRunning(id))
                            .length}
                      </span>
                    </div>
                    {Object.keys(pending)
                      .filter((id) => !isRunning(id))
                      .map((id) => (
                        <div key={`pending-${id}`} className="pr-run-row">
                          <span className="pr-run-dot" />
                          <span className="pr-run-label">
                            {MICRO_TASKS.find((t) => t.id === id)?.label ?? id}
                          </span>
                          <span className="pr-run-elapsed">starting…</span>
                        </div>
                      ))}
                    {running.map((r) => (
                      <div key={r.id} className="pr-run-row">
                        <span className="pr-run-dot" />
                        <span className="pr-run-label">
                          {r.icon} {r.label}
                        </span>
                        <span className="pr-run-elapsed">{elapsed(r)}</span>
                      </div>
                    ))}
                    <div className="pr-rail-empty">
                      Its terminal is in this project's Tasks panel; it closes
                      itself when done.
                    </div>
                  </div>
                )}

                <div className="pr-rail-section">
                  <div className="pr-rail-title">
                    Agent rounds
                    {loop.status === "working" && (
                      <span className="pr-thread-tag">running</span>
                    )}
                  </div>
                  {loop.rounds.length === 0 && (
                    <div className="pr-rail-empty">
                      No rounds yet. A round validates each comment, fixes the
                      cause, replies, and pushes — then waits for you.
                    </div>
                  )}
                  {loop.rounds.map((r) => (
                    <div key={r.n} className="pr-round">
                      <span className="pr-round-n">#{r.n}</span>
                      <span
                        className={`pr-thread-tag ${r.status === "blocked" ? "is-blocking" : ""}`}
                      >
                        {r.status}
                      </span>
                      <span className="pr-round-took">
                        {r.took} comment{r.took === 1 ? "" : "s"}
                      </span>
                      {r.summary && (
                        <div className="pr-round-summary">{r.summary}</div>
                      )}
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
                    {pr.checks_summary && (
                      <span className="pr-round-took">{pr.checks_summary}</span>
                    )}
                  </div>
                  {liveChecks === "FAIL" && (
                    <div className="pr-thread-actions">
                      <button
                        className="btn-mini"
                        disabled={busy}
                        onClick={showLogs}
                      >
                        Show failing logs
                      </button>
                      {onMicroTask && (
                        <button
                          className="btn-mini"
                          onClick={() => launch(fixCiTask, { repo, pr })}
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
        {!activePatch && !error && (
          <div className="pr-loading">Loading diff…</div>
        )}

        {files.length > 0 && (
          <div className="pr-files-bar">
            <span>
              {files.length} file{files.length === 1 ? "" : "s"} changed
              <span className="pr-stat pr-add"> +{totalAdd}</span>
              <span className="pr-stat pr-del"> −{totalDel}</span>
              {conv && (
                <span className="pr-files-note">
                  {" "}
                  · {conv.files.filter((f) => f.viewed).length}/
                  {conv.files.length} viewed
                </span>
              )}
            </span>
            {totalChanged > AUTO_EXPAND_TOTAL && (
              <span className="pr-files-note">
                large diff — files collapsed for speed
              </span>
            )}
            <span className="git-spacer" />
            {/* Re-reviewing means reading what changed since you last looked,
                not the whole PR again. The shas come from your own last review. */}
            {conv?.my_last_review_sha &&
              conv.my_last_review_sha !== conv.head_sha && (
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
              title={
                split ? "Show one column" : "Show old and new side by side"
              }
              onClick={() => setSplit((v) => !v)}
            >
              {split ? "Unified" : "Split"}
            </button>
            <button
              className="btn-mini"
              onClick={() =>
                setExpanded(
                  allOpen ? new Set() : new Set(files.map((f) => f.path)),
                )
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
                <span
                  className="pr-file-chevron"
                  onClick={() => toggleFile(f.path)}
                >
                  {open ? "▾" : "▸"}
                </span>
                <span
                  className="pr-file-path"
                  title={f.path}
                  onClick={() => toggleFile(f.path)}
                >
                  {f.path}
                </span>
                {live > 0 && (
                  <span
                    className="pr-thread-tag is-blocking"
                    title="unresolved threads on this file"
                  >
                    {live} 💬
                  </span>
                )}
                {/* Staged, not posted. Worth its own mark: it's the only thing
                    on the row that is waiting on a decision from you. */}
                {draftsByPath.get(f.path) && (
                  <span
                    className="pr-thread-tag is-draft"
                    title="staged findings, not posted"
                  >
                    {draftsByPath.get(f.path)} ✎
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
                  <div className="pr-file-note">
                    {fileNote(f.patch) ?? "Binary file — not shown."}
                  </div>
                ) : f.changed > RENDER_CAP ? (
                  <div className="pr-file-note">
                    {f.changed.toLocaleString()} changed lines — too large to
                    render inline.{" "}
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
                    diffViewMode={
                      split ? DiffModeEnum.Split : DiffModeEnum.Unified
                    }
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

        {/* The one control that follows you down the diff.
            A zero-height sticky dock at the bottom of the scroller: it costs no
            layout, can't lengthen the scroll, and rides above the composer
            because the composer is outside this element. The main half is the
            one agent job this PR's state calls for; the caret opens the rest.
            With none of the four applying it is just Agent, because "always
            available" is the point of it. */}
        <div className="pr-fab-dock">
          <div className="pr-fab">
            {fab && (
              <button
                className="pr-fab-main"
                title={`${fab.label} — the agent job this PR's state calls for`}
                disabled={busy || fabBusy}
                onClick={runFab}
              >
                {fabBusy ? (
                  <>
                    {/* Name the job. "working on it…" is what the button says
                        when it has forgotten what you asked it to do. */}
                    <span className="pr-run-dot" /> {FAB_BUSY[fab.id]}
                  </>
                ) : (
                  <>
                    {fab.id === "merge" ? "⑃" : <AgentsIcon size={13} />}{" "}
                    {fab.label}
                  </>
                )}
              </button>
            )}
            <button
              className="pr-fab-more"
              title="Everything an agent can do with this PR"
              onClick={openAgentMenu}
            >
              {fab ? (
                "▴"
              ) : (
                <>
                  <AgentsIcon size={13} /> Agent
                </>
              )}
              {/* One live signal per control. While the main half is already
                  showing a running job, a second pulsing dot on the caret is
                  just two things blinking at you. */}
              {running.length > 0 && !fabBusy && <span className="pr-agent-live" />}
            </button>
          </div>
        </div>
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
                  {drafts.length} inline comment{drafts.length === 1 ? "" : "s"}{" "}
                  — not posted yet
                  <button className="btn-mini" onClick={() => setDrafts([])}>
                    Drop all
                  </button>
                </div>
                {/* A manifest, not a second copy. Each of these is already
                    rendered in full on the line it belongs to, where the code
                    it's about is visible; repeating the whole editable card down
                    here put three textareas in a 220px scroller and made both
                    copies unreadable. One line each, and clicking one takes you
                    to the real thing. */}
                <ul className="pr-draft-list">
                  {drafts.map((d) => {
                    const at = placed.get(d.id);
                    return (
                      <li
                        key={d.id}
                        className={`pr-draft-row ${at ? "" : "is-unplaced"}`}
                      >
                        <button
                          className="pr-draft-jump"
                          title={
                            at
                              ? "Show it on the line it belongs to"
                              : "This line isn't in the diff — it still posts, there's just nothing here to show it against"
                          }
                          onClick={() => jumpToDraft(d)}
                        >
                          <span
                            className={`pr-draft-sev ${d.blocking ? "is-blocking" : ""}`}
                          >
                            {d.blocking ? "blocking" : "nit"}
                          </span>
                          <span className="pr-draft-where">
                            {(at?.path ?? d.path).split("/").pop()}:
                            {at?.line ?? d.line}
                            {!at && " ·  not in this diff"}
                          </span>
                          <span className="pr-draft-gist">{gist(d.body)}</span>
                        </button>
                        <button
                          className="btn-mini"
                          onClick={() =>
                            setDrafts((prev) =>
                              prev.filter((x) => x.id !== d.id),
                            )
                          }
                        >
                          Drop
                        </button>
                      </li>
                    );
                  })}
                </ul>
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
              {/* "How do I post these?" — you don't, separately. Every verdict
                  submits the staged comments with it (see submit()), and a list
                  of drafts sitting above three equal buttons never said so. It
                  says so here, and the verdict the findings imply is the one
                  wearing the accent instead of Approve always wearing it. */}
              {drafts.length > 0 && (
                <span className="pr-verdict-hint">
                  {blockingDrafts > 0
                    ? `${blockingDrafts} blocking`
                    : `${drafts.length} ${drafts.length === 1 ? "nit" : "nits"}, nothing blocking`}
                  {" — whichever verdict you pick posts "}
                  {drafts.length === 1 ? "it" : `all ${drafts.length}`}.
                </span>
              )}
              <span className="git-spacer" />
              {(["approve", "request-changes", "comment"] as Review[]).map(
                (a) => (
                  <button
                    key={a}
                    className={`btn ${a === suggestedVerdict ? "btn-accent" : ""}`}
                    title={
                      a === suggestedVerdict && drafts.length > 0
                        ? "The verdict these findings point at"
                        : undefined
                    }
                    disabled={
                      busy ||
                      (a !== "approve" &&
                        !comment.trim() &&
                        drafts.length === 0)
                    }
                    onClick={() => setConfirm(a)}
                  >
                    {REVIEW_LABEL[a]}
                  </button>
                ),
              )}
            </div>
          </>
        )}
      </div>

      {confirm && (
        <div className="confirm-backdrop" onClick={() => setConfirm(null)}>
          <div className="confirm" onClick={(e) => e.stopPropagation()}>
            <p>
              {REVIEW_LABEL[confirm]}{" "}
              <strong>
                #{pr.number} {pr.title}
              </strong>{" "}
              as {pr.mine ? "yourself" : "yourself"} on GitHub?
            </p>
            <p className="confirm-sub">
              This posts a public review to the repository and notifies its
              authors.
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
              {MERGE_LABEL[mergeConfirm]}{" "}
              <strong>
                #{pr.number} {pr.title}
              </strong>{" "}
              into <code>{pr.base}</code> on GitHub?
            </p>
            <p className="confirm-sub">
              This lands <code>{pr.branch}</code> on <code>{pr.base}</code> in
              the real repository and closes the pull request. It can't be
              undone here.
            </p>
            {conflicting && (
              <p className="confirm-warn">
                GitHub reports merge conflicts — this will likely be rejected.
              </p>
            )}
            {liveChecks === "FAIL" && (
              <p className="confirm-warn">
                Some checks are failing ({pr.checks_summary}).
              </p>
            )}
            {liveChecks === "PENDING" && (
              <p className="confirm-warn">
                Checks are still running ({pr.checks_summary}).
              </p>
            )}
            {decision === "CHANGES_REQUESTED" && (
              <p className="confirm-warn">Changes were requested on this PR.</p>
            )}
            {!!act?.count && (
              <p className="confirm-warn">
                {act.count} comment{act.count === 1 ? "" : "s"} still
                unaddressed.
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
        <div
          className="confirm-backdrop"
          onClick={() => setCloseConfirm(false)}
        >
          <div className="confirm" onClick={(e) => e.stopPropagation()}>
            <p>
              Close{" "}
              <strong>
                #{pr.number} {pr.title}
              </strong>{" "}
              without merging?
            </p>
            <p className="confirm-sub">
              The pull request closes on GitHub and its author is notified. You
              can reopen it there later
              {closeDelBranch ? " — but only if the branch still exists" : ""}.
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
      if (current)
        out.push({ path: current.path, patch: current.lines.join("\n") });
      // "diff --git a/x b/x" — take the b/ side so renames show their new name.
      const m = /diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = { path: m?.[2] ?? line.slice(11), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current)
    out.push({ path: current.path, patch: current.lines.join("\n") });
  return out;
}

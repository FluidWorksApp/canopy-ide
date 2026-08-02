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
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dialog } from "./Dialog";
import { useBranchSwitch } from "../useBranchSwitch";
import { DiffView, DiffModeEnum, SplitSide } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import * as ipc from "../ipc";
import { Markdown } from "./Markdown";
import type { Notify, RelayHandle } from "../types";
import { agentMenuItems } from "../agentMenu";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { AgentsIcon, ChevronIcon, TeamIcon } from "./icons";
import { Skeleton, SkeletonBox, SkeletonText } from "./Skeleton";
import { TaskProgress } from "./TaskProgress";
import type { AgentTarget } from "./TicketsPanel";
import {
  MICRO_TASKS,
  addressPrCommentsTask,
  applySuggestionTask,
  fixCiTask,
  followUpsTask,
  prArtifactPath,
  prProgressPath,
  prReviewTask,
  resolveConflictsTask,
  runItReviewTask,
  stepsDone,
  type MicroTaskDef,
  type TaskStep,
} from "../microTasks";
import { rowFor, subscribe as subscribeToPrs } from "../prWatchStore";
import { TASK_HISTORY_EVENT, taskRuns, type TaskRun } from "../taskHistory";
import { RaisedBy } from "./RaisedBy";
import type { PrAgent } from "../agentForPr";
import { repoLabel } from "../prs";
import {
  actionable,
  alreadyPosted,
  fabAction,
  type FabActionId,
  fileNote,
  isNit,
  livePr as livePrOf,
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
import { Button } from "./ui";
import { basename } from "../paths";
// NB: PR diffs arrive as real patches from `gh pr diff`, so they go straight
// into the renderer. Working-tree diffs (components/DiffView.tsx) have to build
// their patch first — see the note there about Monaco's diff not computing.

/** The tasks that report milestones, and so get the rail rather than a spinner.
 *
 *  It is every agent job this tab can start. That is the point: a one-shot agent
 *  is a black box for as long as it runs, and "Resolving…" says exactly as much
 *  at minute four as it did at second one — which is how a run that had quietly
 *  died looked identical to one that was working. Review had the rail and the
 *  other six had a word and a dot, so the same click told you a different amount
 *  depending on which button you happened to press.
 *
 *  Reduced to what the rail needs: these are `MicroTaskDef`s of six different
 *  payload types, and nothing here builds a payload. */
const RAIL_TASKS: readonly { id: string; label: string; steps: readonly TaskStep[] }[] = (
  [
    prReviewTask,
    resolveConflictsTask,
    fixCiTask,
    addressPrCommentsTask,
    applySuggestionTask,
    runItReviewTask,
    followUpsTask,
  ] as { id: string; label: string; steps?: readonly TaskStep[] }[]
).flatMap((t) => (t.steps ? [{ id: t.id, label: t.label, steps: t.steps }] : []));

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
  /** Resolves to whether an agent actually started — a launch can still fail
   *  after the click (no CLI, a worktree that won't build), and the buttons
   *  this tab lights up have to come back when it does. */
  onMicroTask?: <P>(
    task: MicroTaskDef<P>,
    payload: P,
    query: string,
  ) => Promise<boolean>;
  /** Every session running now: id → its terminal, null for another window.
   *  What turns a recorded edge into "and it is still up". */
  liveSessions?: Map<string, number | null>;
  /** Send a change request back to whoever raised this PR. */
  onSendToRaiser?: (to: PrAgent, text: string) => void;
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

/** The exact shape DiffView's `data` prop wants. It must keep its identity
 *  between renders: the library rebuilds its DiffFile — reparse, rehighlight,
 *  full DOM remount — whenever `data` changes identity. */
type DiffData = {
  hunks: string[];
  oldFile: { fileName: string };
  newFile: { fileName: string };
};

/** Self-ticking elapsed counter, so the tick re-renders this span and not the
 *  whole tab. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const s = Math.max(0, Math.round((now - startedAt) / 1000));
  return <>{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</>;
}

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
  liveSessions,
  onSendToRaiser,
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
  /** What merging or closing it here answered — MERGED or CLOSED. Believed at
   *  once, without waiting for the refresh behind it: the mutation came back
   *  clean, so the toast and the header have to turn over together. */
  const [landed, setLanded] = useState<string | null>(null);

  // The conversation: comments, verdicts, inline threads, per-file viewed state.
  // Its own request, independent of the patch, so it paints while a 28k-line
  // diff is still being parsed.
  const [conv, setConv] = useState<ipc.PrConversation | null>(null);
  /** owner/name for the header. Several projects open means several PR tabs,
   *  and "#843" alone doesn't say which repo's #843. Resolved from the origin
   *  URL once per repo; the folder name stands in until it arrives. */
  const [repoName, setRepoName] = useState(() => repoLabel("", repo));
  const [convError, setConvError] = useState<string | null>(null);
  /** The body read the old way, when the conversation query couldn't be run. */
  const [bodyFallback, setBodyFallback] = useState("");
  const [drafts, setDrafts] = useState<DraftComment[]>([]);
  /** Which files' diffs are mounted. Declared up here, not beside the effect
   *  that seeds it, because staging findings has to open the files they land
   *  in — a draft comment inside a collapsed file is a comment nobody sees. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [logs, setLogs] = useState<string | null>(null);
  /** People who could be asked to review — loaded only when that's the move. */
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [map, setMap] = useState<string | null>(null);
  /** Whether the artifact read has *finished*, as opposed to having found
   *  nothing. `map` alone can't tell the two apart, and the difference decides
   *  whether the idle "Review this for me" button is allowed on screen: shown
   *  during the read it appears for a beat and is then shoved down the page by
   *  the map landing above it. */
  const [mapRead, setMapRead] = useState(false);
  /** What this PR is attached to. Its own request beside the conversation's —
   *  it's context, and context must never hold up the comments. */
  const [links, setLinks] = useState<ipc.PrLinks | null>(null);
  const [deltaOn, setDeltaOn] = useState(false);
  const [deltaPatch, setDeltaPatch] = useState<string | null>(null);
  const [loop, setLoop] = useState<PrLoop>(() => loadLoop(repo, pr.number));
  /** Tasks running against THIS pull request, read off the run log rather than
   *  remembered locally: a click on a CTA and a launch from the Agent menu both
   *  land there, and it survives the tab being closed and reopened. */
  const [running, setRunning] = useState<TaskRun[]>([]);

  const [done, setDone] = useState<string | null>(null);
  // Two dropdowns, both ContextMenu-driven: the agent menu and the overflow.
  // Using the shared menu (rather than another hand-rolled popover) is what
  // lets them carry submenus, hints and a danger row without new markup.
  const agentMenu = useContextMenu();
  const moreMenu = useContextMenu();
  // Anything here that moves a ref goes through the one funnel: it owns the
  // question a refusal really is, and it outlives this tab closing itself.
  const { switchTo } = useBranchSwitch();
  const fileRefs = useRef(new Map<string, HTMLDivElement>());
  // Latest-value refs so the callbacks handed to memoized children can stay
  // identity-stable while still seeing the current props/conversation.
  const noticeRef = useRef(onNotice);
  const nodeIdRef = useRef(conv?.node_id);
  useEffect(() => {
    noticeRef.current = onNotice;
    nodeIdRef.current = conv?.node_id;
  });

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

  useEffect(() => {
    let live = true;
    setRepoName(repoLabel("", repo));
    void ipc
      .gitRemoteUrl(repo)
      .then((url) => live && setRepoName(repoLabel(url, repo)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [repo]);

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
    setMapRead(false);
    setLinks(null);
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
      .catch(() => {})
      .finally(() => live && setMapRead(true));
    // Linked issues and the stack around it. Failure is silent on purpose:
    // this is the one part of the tab that is pure context, and a red error
    // where "nothing is linked" belongs would read as something being broken.
    void ipc
      .ghPrLinks(repo, pr.number, pr.branch, pr.base)
      .then((l) => live && setLinks(l))
      .catch(
        () =>
          live &&
          setLinks({ closes: [], children: [], parents: [], mentions: [] }),
      );
    void stageFindings();
    return () => {
      live = false;
    };
  }, [repo, pr.number, pr.branch, pr.base, refreshConv, stageFindings]);

  useEffect(() => {
    // The log is written by the launcher and by job_done; the event covers
    // both. Bail on an unchanged id set: the event fires on every write, for
    // every open PR tab, and a fresh array here re-renders the whole tab.
    // (The elapsed counters tick on their own — see Elapsed.)
    const read = () =>
      setRunning((prev) => {
        const next = taskRuns().filter(
          (r) => r.status === "running" && r.brief.includes(pr.url),
        );
        return next.length === prev.length &&
          next.every((r, i) => r.id === prev[i].id)
          ? prev
          : next;
      });
    read();
    window.addEventListener(TASK_HISTORY_EVENT, read);
    return () => window.removeEventListener(TASK_HISTORY_EVENT, read);
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

  /** Whichever milestone-reporting task is running owns the rail. Only one can
   *  be: they all take the PR's worktree or its conversation, and two agents
   *  pushing the same branch is the thing the isolation exists to prevent. */
  const railTask = RAIL_TASKS.find((t) => isBusyTask(t.id)) ?? null;
  const reviewBusy = isBusyTask(prReviewTask.id);

  /** Milestones the running task has reported. Polled rather than pushed: the
   *  agent appends to a file (every CLI can, with or without the MCP bridge), so
   *  the tab has to look. Strictly gated on a task actually running — a poll
   *  that outlives what it was watching is a tab that never goes quiet. */
  const [steps, setSteps] = useState<string[]>([]);
  /** What the progress file held when this run started. Until it changes, the
   *  agent hasn't truncated it yet and the contents are the *previous* run's —
   *  showing those would open a fresh run already at four-of-four. */
  const progressBase = useRef<string | null>(null);
  const railId = railTask?.id ?? null;
  const railSteps = railTask?.steps;
  useEffect(() => {
    if (!railId || !railSteps) return;
    let live = true;
    const path = prProgressPath(repo, railId, pr.number);
    const read = () =>
      void ipc
        .fsReadText(path)
        .then((t) => {
          if (!live) return;
          if (progressBase.current === null) progressBase.current = t;
          setSteps(t === progressBase.current ? [] : stepsDone(t, railSteps));
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
  }, [railId, railSteps, repo, pr.number]);

  /** Every task launch on this tab goes through here. */
  const launch = useCallback(
    <P,>(def: MicroTaskDef<P>, payload: P, query = "") => {
      if (!onMicroTask) return;
      setPending((p) => ({ ...p, [def.id]: Date.now() }));
      // A new run starts the rail empty and re-arms the staleness guard, so the
      // last run's milestones don't flash up before this agent has written one.
      if (RAIL_TASKS.some((t) => t.id === def.id)) {
        setSteps([]);
        progressBase.current = null;
      }
      // The launcher says whether an agent actually started. It can refuse
      // after the click — no CLI, a worktree that won't build — and it puts its
      // own error on screen when it does; what it cannot do is take this tab's
      // button out of the busy state it entered on the way in. Left to the 30s
      // sweep below, the pill sat there reading "Resolving…" directly above the
      // toast explaining that nothing was resolving.
      void onMicroTask(def, payload, query).then((started) => {
        if (started) return;
        setPending((p) => {
          if (p[def.id] == null) return p;
          const next = { ...p };
          delete next[def.id];
          return next;
        });
      });
      // Review reports its milestones on this page, so pointing at the Running
      // now panel would send you away from the thing that's actually showing.
      noticeRef.current(
        def.id === prReviewTask.id
          ? `${def.label}: an agent is starting — its progress is on this page.`
          : `${def.label}: an agent is starting — watch it under "Running now".`,
      );
    },
    [onMicroTask],
  );

  // Clear a pending marker once the run log shows it, or if it never appears
  // (the launcher refused: no CLI installed, worktree failed) so the button
  // comes back rather than sitting disabled forever.
  useEffect(() => {
    const ids = Object.keys(pending);
    if (!ids.length) return;
    const sweep = () => {
      const now = Date.now();
      setPending((p) => {
        const stale = Object.keys(p).filter(
          (id) => running.some((r) => r.taskId === id) || now - p[id] > 30_000,
        );
        if (!stale.length) return p;
        const next = { ...p };
        for (const id of stale) delete next[id];
        return next;
      });
    };
    sweep();
    // No 1s render tick to lean on: wake when the oldest marker expires.
    const soonest = Math.max(
      250,
      Math.min(...ids.map((id) => pending[id] + 30_500)) - Date.now(),
    );
    const t = window.setTimeout(sweep, soonest);
    return () => window.clearTimeout(t);
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
  // Undefined for the seconds between the click and the run log catching up:
  // the rail is already up by then, and a counter that starts at 0s twice is
  // worse than one that starts a moment late. Self-ticking, so the second hand
  // re-renders one span rather than the tab.
  const railRun = running.find((r) => r.taskId === railId);
  const railElapsed = railRun ? <Elapsed startedAt={railRun.startedAt} /> : undefined;

  /** Review keeps the rail up for a moment after its agent is gone — see
   *  `settling` — while the tab reads the two files it left behind. Nothing
   *  else has a handoff, so nothing else needs the grace. */
  const rail =
    railTask ?? (settling ? (RAIL_TASKS.find((t) => t.id === prReviewTask.id) ?? null) : null);

  const persist = useCallback((next: PrLoop) => {
    setLoop(saveLoop(next));
    return next;
  }, []);

  // ---- derived state -------------------------------------------------------

  const act = useMemo(() => (conv ? actionable(conv) : null), [conv]);
  const liveChecks = conv?.checks || pr.checks;
  const decision = conv?.review_decision || pr.review_decision;
  const conflicting = (conv?.mergeable || pr.mergeable) === "CONFLICTING";

  /** The PR as it is now, not as the list saw it: everything that decides what
   *  you can still do to it reads this, never the frozen `pr` prop. */
  const livePr = useMemo(
    () => livePrOf(pr, conv, landed),
    [pr, conv, landed],
  );

  const role = roleFor(livePr, conv);
  const gate = useMemo(
    () => roundGate(livePr, conv, loop),
    [livePr, conv, loop],
  );
  const move: NextMove = useMemo(
    () =>
      nextMove(livePr, conv, {
        actionable: act?.count ?? 0,
        loopBusy: loop.status === "working",
        autoMerge: conv?.auto_merge,
      }),
    [livePr, conv, act, loop.status],
  );

  /** The floating button's default action — its own four states, not the next
   *  move bar's list. See fabAction() for why they are deliberately different. */
  const fab = useMemo(
    () => fabAction(livePr, conv, { actionable: act?.count ?? 0 }),
    [livePr, conv, act?.count],
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
        if (gate.reason === "no comments to address" && livePr.state === "OPEN") {
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
    [onMicroTask, gate, loop, conv, repo, pr, livePr, persist, onNotice],
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
    (fab?.id === "address" && isBusyTask(addressPrCommentsTask.id)) ||
    (fab?.id === "resolve-conflicts" && isBusyTask(resolveConflictsTask.id));
  const runFab = () => {
    switch (fab?.id) {
      case "resolve-conflicts":
        launch(resolveConflictsTask, { repo, pr });
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
    // The subscription is unconditional: an open PR tab follows its PR whether
    // or not the review loop is armed. It used to be gated on the loop, which
    // meant a plain tab froze at whatever was true when it opened — a merge
    // from the GitHub page, a teammate's push, a check flipping red all stayed
    // invisible until the tab was closed and reopened. The watcher is already
    // being paid for; the tab's job is to reflect it.
    //
    // Armed-but-idle counts for the loop half: that is the whole point of
    // arming it before the first comment exists.
    const loopArmed =
      loop.auto || loop.status === "waiting" || loop.status === "ready";
    let live = true;
    // A row change that lands while the window is hidden is not dropped — it
    // ticks when the user comes back, which is exactly when the stale page
    // would otherwise be the first thing they read.
    let missed = false;
    const tick = async () => {
      if (!live) return;
      if (document.visibilityState !== "visible") {
        missed = true;
        return;
      }
      missed = false;
      const c = await refreshConv();
      if (!live || !c || !loopArmed) return;
      const fresh = newSinceHandled(c, loop);
      if (fresh.length && loop.auto) {
        const g = roundGate(livePr, c, loop);
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
    const onVisible = () => {
      if (document.visibilityState === "visible" && missed) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    const id = window.setInterval(() => void tick(), WATCH_FALLBACK_MS);
    return () => {
      live = false;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(id);
    };
  }, [loop, pr, livePr, repo, refreshConv, onMicroTask, persist, onNotice]);

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
      // The whole header turns over with the toast: it landed, so Merge, the
      // next move, the agent tasks and the review box all stop offering things
      // you can no longer do. The refresh behind it is confirmation, not the
      // trigger — waiting for a round trip is what left the button armed.
      setLanded("MERGED");
      persist(markDone(loop));
      void refreshConv();
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
      setLanded("CLOSED");
      persist(markDone(loop));
      void refreshConv();
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

  const runAction = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      setBusy(true);
      try {
        noticeRef.current(await fn(), "success");
        void refreshConv();
      } catch (err) {
        noticeRef.current(`${label}: ${String(err)}`, "error");
      } finally {
        setBusy(false);
      }
    },
    [refreshConv],
  );

  const setResolved = useCallback(
    (threadId: string, resolved: boolean) =>
      void runAction(resolved ? "Resolve" : "Reopen", () =>
        ipc.ghPrThreadResolved(repo, threadId, resolved),
      ),
    [runAction, repo],
  );

  const sendReply = useCallback(
    (threadId: string, body: string) =>
      void runAction("Reply", () => ipc.ghPrThreadReply(repo, threadId, body)),
    [runAction, repo],
  );

  const toggleViewed = useCallback(
    (path: string, viewed: boolean) => {
      const nodeId = nodeIdRef.current;
      if (!nodeId) return;
      // Optimistic: the checkbox is a reading aid, and a failed write is worth a
      // notice but not a spinner.
      setConv((c) =>
        c
          ? {
              ...c,
              files: c.files.map((f) =>
                f.path === path ? { ...f, viewed } : f,
              ),
            }
          : c,
      );
      void ipc.ghPrFileViewed(repo, nodeId, path, viewed).catch((err) => {
        noticeRef.current(String(err), "error");
        void refreshConv();
      });
    },
    [repo, refreshConv],
  );

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

  const jumpToFile = useCallback((path: string) => {
    setExpanded((prev) => new Set(prev).add(path));
    // Let the diff mount before scrolling to it.
    setTimeout(
      () => fileRefs.current.get(path)?.scrollIntoView({ block: "start" }),
      60,
    );
  }, []);

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

  const applySuggestion = useCallback(
    (t: ipc.PrThread, suggestion: string) =>
      launch(applySuggestionTask, {
        repo,
        pr,
        path: t.path,
        line: t.line,
        suggestion,
        threadId: t.id,
      }),
    [launch, repo, pr],
  );

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
        launch(resolveConflictsTask, { repo, pr });
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
  // as raw text. <Markdown> sanitizes with DOMPurify and memoises the parse,
  // which matters on both counts: a PR body is authored by whoever opened it
  // and raw HTML in the webview reaches every Tauri command, and this tab
  // re-renders on every keystroke in the review composer.
  const bodyText = conv?.body?.trim() ? conv.body : bodyFallback;
  /** Still in flight, as opposed to genuinely empty. A PR with no description
   *  is a real thing, so "no text yet" can't be the test — this waits for one
   *  of the two sources to have answered. On `convError` the fallback read is
   *  already running and the error is shown in the rail, so the placeholder
   *  stands down rather than shimmering forever over a request that failed. */
  const descLoading = !conv && !convError && !bodyFallback.trim();

  const byPath = useMemo(
    () => threadsByPath(conv?.threads ?? []),
    [conv?.threads],
  );
  const verdictList = useMemo(() => (conv ? verdicts(conv) : []), [conv]);
  const liveThreads = useMemo(
    () => (conv?.threads ?? []).filter((t) => !t.resolved),
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

  const toggleFile = useCallback(
    (path: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      }),
    [],
  );
  const allOpen = files.length > 0 && expanded.size === files.length;

  const onFileRef = useCallback((path: string, el: HTMLDivElement | null) => {
    if (el) fileRefs.current.set(path, el);
    else fileRefs.current.delete(path);
  }, []);

  // A stable `data` object per (path, patch): DiffView rebuilds its DiffFile —
  // reparse, rehighlight, full DOM remount — whenever `data` changes identity.
  const dataCache = useRef(new Map<string, DiffData>());
  const dataFor = (f: FilePatch): DiffData => {
    const hit = dataCache.current.get(f.path);
    if (hit && hit.hunks[0] === f.patch) return hit;
    const data: DiffData = {
      hunks: [f.patch],
      oldFile: { fileName: f.path },
      newFile: { fileName: f.path },
    };
    dataCache.current.set(f.path, data);
    return data;
  };

  const patchDraft = useCallback((id: string, patch: Partial<DraftComment>) => {
    setDrafts((prev) =>
      prev.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    );
  }, []);
  const dropDraft = useCallback((id: string) => {
    setDrafts((prev) => prev.filter((x) => x.id !== id));
  }, []);
  const addDraft = useCallback((d: DraftComment) => {
    setDrafts((prev) => [...prev, d]);
  }, []);

  const prOpen = livePr.state === "OPEN";
  const canSuggest = !!onMicroTask;
  const renderExtendLine = useCallback(
    ({ data }: { data: LineData }) => (
      <div className="pr-line-extend">
        {data.threads.map((t) => (
          <ThreadCard
            key={t.id}
            t={t}
            prOpen={prOpen}
            canSuggest={canSuggest}
            onJump={jumpToFile}
            onResolve={setResolved}
            onReply={sendReply}
            onApplySuggestion={applySuggestion}
          />
        ))}
        {data.drafts.map((d) => (
          <DraftCard key={d.id} d={d} onPatch={patchDraft} onDrop={dropDraft} />
        ))}
      </div>
    ),
    [
      prOpen,
      canSuggest,
      jumpToFile,
      setResolved,
      sendReply,
      applySuggestion,
      patchDraft,
      dropDraft,
    ],
  );

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
    // Conflicting: the only thing worth offering is the resolve. Everything
    // else reads or edits a diff git cannot merge, and would be redone after.
    if (onMicroTask && conflicting) {
      items.push({
        label: resolveConflictsTask.label,
        icon: <span className="ctx-glyph">{resolveConflictsTask.icon}</span>,
        hint: "merges the base in, keeps both sides",
        disabled: isBusyTask(resolveConflictsTask.id),
        onClick: () => launch(resolveConflictsTask, { repo, pr }),
      });
    }
    if (onMicroTask && !conflicting) {
      items.push({
        label: prReviewTask.label,
        icon: <span className="ctx-glyph">{prReviewTask.icon}</span>,
        hint: "stages drafts for you, posts nothing",
        disabled: isBusyTask(prReviewTask.id),
        onClick: () => launch(prReviewTask, { repo, pr }),
      });
      if (livePr.state === "OPEN") {
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
          void switchTo(repo, {
            kind: "pr",
            number: pr.number,
            branch: pr.branch,
          }),
      },
      // The other half of the same wish: look at it without this checkout
      // moving at all. It is also the answer to a PR whose head can't be
      // fetched here — the funnel names that case itself now.
      {
        label: "Open this PR's workspace",
        hint: "a folder of its own — nothing here moves",
        onClick: () =>
          void switchTo(repo, {
            kind: "pr-workspace",
            number: pr.number,
            branch: pr.branch,
          }),
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
    if (livePr.state === "OPEN") {
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
    if (livePr.state === "OPEN")
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
                <Button size="sm" variant="accent"
                  disabled={busy}
                  title={move.hint}
                  onClick={(e) => dispatchMove(move, e)}>
                  {move.action}
                </Button>
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
            {pr.draft && livePr.state === "OPEN" && (
              <Button size="sm" variant="accent"
                title="Take this PR out of draft so it can be reviewed and merged"
                disabled={busy}
                onClick={() => void ready()}>
                Mark ready
              </Button>
            )}
            {!pr.draft && livePr.state === "OPEN" && (
              <div className="cli-menu-anchor">
                <Button
                  size="sm"
                  variant={mergeReady ? "accent" : "default"}
                  title={
                    mergeReady
                      ? "Merge this PR on GitHub"
                      : "Merge this PR on GitHub — it isn't approved and green yet"
                  }
                  disabled={busy}
                  onClick={() => setMergeOpen((v) => !v)}
                >
                  Merge ▾
                </Button>
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
            <Button size="sm" className="pr-more"
              title="More actions"
              onClick={openMoreMenu}>
              ⋯
            </Button>
          </div>
        </div>
        <div className="pr-sub">
          {repoName && (
            <span className="pr-repo" title={repo}>
              {repoName}
            </span>
          )}
          <span>
            {pr.author} wants to merge <code>{pr.branch}</code> →{" "}
            <code>{pr.base}</code>
          </span>
          {pr.created && (
            <span className="pr-when" title={absTime(pr.created)}>
              opened {ago(pr.created)}
            </span>
          )}
          {liveSessions && onSendToRaiser && (
            <RaisedBy
              repo={repo}
              number={pr.number}
              live={liveSessions}
              onSend={onSendToRaiser}
            />
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
        {rail && (
          <TaskProgress
            steps={rail.steps}
            done={steps}
            active={!!railTask}
            title={railTask ? rail.label : `${rail.label} finished`}
            elapsed={railElapsed}
          />
        )}
      </div>

      <div className="pr-body">
        <div className="pr-overview">
          <div className="pr-overview-main">
            {descLoading ? (
              /* Wearing .pr-description itself, so the card that arrives is
                 the card that was already there — same border, same padding,
                 same place on the page. Only the words inside it change. */
              <SkeletonBox
                label="Loading the description"
                className="pr-description"
              >
                <SkeletonText lines={5} />
              </SkeletonBox>
            ) : (
              bodyText.trim() && (
                <Markdown className="pr-description" text={bodyText} />
              )
            )}
            {map && (
              <div className="pr-description pr-map is-agent-made">
                {/* Named, not just styled. This is a model's reading of the
                    diff sitting directly under the PR's own description, and
                    the two must never be mistaken for each other. */}
                <div className="pr-rail-title agent-byline">
                  <AgentsIcon size={12} />
                  Review map
                  <span className="agent-byline-note">written by an agent</span>
                  <Button size="sm"
                    disabled={reviewBusy}
                    title="Have an agent read it again"
                    onClick={() => launch(prReviewTask, { repo, pr })}>
                    {reviewBusy ? "Reviewing…" : "Review again"}
                  </Button>
                </div>
                <Markdown text={map ?? ""} />
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
            {/* Three gates, all of them about this button appearing in the
                place it will stay. `mapRead` and `settling` are the same point
                either side of a review run: an offer to review that shows for a
                frame and is then shoved down the page by the review already on
                disk reads as the tab not knowing what it has.

                `descLoading` is the third, and it's the one the placeholder
                above makes necessary rather than fixes. The artifact is a local
                file read and the description is a network round trip, so this
                would light up under a still-shimmering card and then jump the
                moment the real text — of a length nothing can know in advance —
                landed above it. A skeleton can hold a card's *position*; it
                can't hold its height. So the offer waits for the prose. */}
            {!descLoading &&
              mapRead &&
              !map &&
              !reviewBusy &&
              !settling &&
              onMicroTask && (
                <div className="pr-map-cta">
                  {/* The one thing this empty state exists to offer, so it
                      wears the primary tier. As a btn-mini it sat at the same
                      weight as "Regenerate" and "Drop" and nobody found it. */}
                  <Button size="sm" variant="accent"
                    onClick={() => launch(prReviewTask, { repo, pr })}>
                    {prReviewTask.icon} Review this for me
                  </Button>
                  <span className="pr-files-note">
                    risk-ranked, findings staged as drafts, nothing posted
                  </span>
                </div>
              )}
          </div>

          <aside className="pr-rail">
            {convError && <div className="pr-error">{convError}</div>}
            {/* The rail's own frame, standing in for itself. The three sections
                below are unconditional once the conversation lands, and their
                titles are known before anything is fetched — so they render for
                real and only their contents are stubbed. The rail is then the
                same three cards, the same width, in the same order, before and
                after; what arrives fills them in rather than replacing a line
                of text with a column of boxes. */}
            {!conv && !convError && (
              <>
                <div className="pr-rail-section">
                  <div className="pr-rail-title">Conversation</div>
                  <SkeletonBox label="Loading the conversation">
                    <SkeletonText lines={2} />
                  </SkeletonBox>
                </div>
                <div className="pr-rail-section">
                  <div className="pr-rail-title">Agent rounds</div>
                  <SkeletonBox label="Loading agent rounds">
                    <SkeletonText lines={2} />
                  </SkeletonBox>
                </div>
                <div className="pr-rail-section">
                  <div className="pr-rail-title">Checks</div>
                  <SkeletonBox label="Loading checks" className="cnp-skel-row">
                    <Skeleton w={46} h={14} />
                    <Skeleton w={86} />
                  </SkeletonBox>
                </div>
              </>
            )}

            {conv && (
              <>
                <div className="pr-rail-section">
                  <div className="pr-rail-title">
                    Conversation
                    <Button size="sm"
                      title="Refresh"
                      onClick={() => void refreshConv()}>
                      ↻
                    </Button>
                  </div>
                  {verdictList.length === 0 &&
                    conv.comments.length === 0 &&
                    conv.threads.length === 0 && (
                      <div className="pr-rail-empty">No comments yet.</div>
                    )}
                  {verdictList.map((r) => (
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
                        <Markdown
                          className="pr-comment-body"
                          text={r.body}
                        />
                      )}
                    </div>
                  ))}
                  {liveThreads.map((t) => (
                    <ThreadCard
                      key={t.id}
                      t={t}
                      compact
                      prOpen={prOpen}
                      canSuggest={canSuggest}
                      onJump={jumpToFile}
                      onResolve={setResolved}
                      onReply={sendReply}
                      onApplySuggestion={applySuggestion}
                    />
                  ))}
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
                      <Markdown
                        className="pr-comment-body"
                        text={c.body}
                      />
                    </div>
                  ))}
                  {conv.threads.length > liveThreads.length && (
                    <div className="pr-rail-empty">
                      {conv.threads.length - liveThreads.length} resolved
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
                        <span className="pr-run-elapsed">
                          <Elapsed startedAt={r.startedAt} />
                        </span>
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
                  {livePr.state === "OPEN" && role === "author" && (
                    <div className="pr-thread-actions">
                      <Button size="sm" variant="accent"
                        disabled={busy || loop.status === "working"}
                        title={
                          gate.ok
                            ? "Hand the open comments to an agent"
                            : gate.reason === "no comments to address"
                              ? "Nothing to address yet — arm it and a round starts when comments arrive"
                              : gate.reason
                        }
                        onClick={() => startRound(true)}>
                        {loop.rounds.length
                          ? "Next round"
                          : gate.ok
                            ? "Start loop"
                            : "Watch for comments"}
                      </Button>
                      {loop.auto && (
                        <Button size="sm"
                          title="Stop starting rounds automatically"
                          onClick={() => persist({ ...loop, auto: false })}>
                          Stop watching
                        </Button>
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
                      <Button size="sm"
                        disabled={busy}
                        onClick={showLogs}>
                        Show failing logs
                      </Button>
                      {onMicroTask && (
                        <Button size="sm"
                          onClick={() => launch(fixCiTask, { repo, pr })}>
                          Fix CI
                        </Button>
                      )}
                    </div>
                  )}
                  {logs && <pre className="pr-logs">{logs}</pre>}
                </div>
              </>
            )}

            {/* What this PR is attached to. Last in the rail, and absent
                entirely when there is nothing to say — which is why it needs no
                placeholder of its own. Arriving at the bottom of a column
                displaces nothing above it, so the one card that can't know its
                own size in advance is also the one card whose growth nobody
                feels. */}
            <PrLinkRail links={links} />
          </aside>
        </div>

        {error && <div className="pr-error">{error}</div>}
        {/* The summary bar and a few collapsed file headers — which is exactly
            what a large PR settles into, since those open collapsed anyway. The
            count is a guess and deliberately a small one: three rows that grow
            into ten push the page down once, where ten rows that shrink to
            three would yank it up, and a diff you are already reading must
            never move. */}
        {!activePatch && !error && (
          <SkeletonBox label="Loading the diff" className="pr-diff-skel">
            <div className="pr-files-bar">
              <Skeleton w={132} />
              <span className="git-spacer" />
              <Skeleton w={58} h={22} />
              <Skeleton w={78} h={22} />
            </div>
            {[0, 1, 2].map((i) => (
              <div key={i} className="pr-file">
                <div className="pr-file-head">
                  <Skeleton w={9} h={9} />
                  {/* 13px, not the default 11: the real head is sized by a
                      line of 11px monospace, and a row that grows 2px per file
                      as the diff lands is the shift this is here to prevent. */}
                  <Skeleton w={`${[52, 38, 61][i]}%`} h={13} />
                  <span className="git-spacer" />
                  <Skeleton w={26} h={9} />
                  <Skeleton w={26} h={9} />
                </div>
              </div>
            ))}
          </SkeletonBox>
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
                <Button
                  size="sm"
                  variant={deltaOn ? "accent" : "default"}
                  title="Only the commits pushed since your last review"
                  disabled={busy}
                  onClick={() => void toggleDelta()}
                >
                  {deltaOn ? "Whole PR" : "Since your review"}
                </Button>
              )}
            {/* Both diff controls live on the diff, not up in the header: this
                is the bar they act on, and it keeps the header to actions that
                change the PR rather than how you're looking at it. */}
            <Button size="sm"
              title={
                split ? "Show one column" : "Show old and new side by side"
              }
              onClick={() => setSplit((v) => !v)}>
              {split ? "Unified" : "Split"}
            </Button>
            <Button size="sm"
              onClick={() =>
                setExpanded(
                  allOpen ? new Set() : new Set(files.map((f) => f.path)),
                )
              }>
              {allOpen ? "Collapse all" : "Expand all"}
            </Button>
          </div>
        )}

        {files.map((f) => (
          <PrFileCard
            key={f.path}
            f={f}
            open={expanded.has(f.path)}
            split={split}
            prOpen={prOpen}
            prUrl={pr.url}
            liveCount={
              (byPath.get(f.path) ?? []).filter((t) => !t.resolved).length
            }
            draftCount={draftsByPath.get(f.path) ?? 0}
            viewed={viewedByPath.get(f.path) ?? false}
            canViewed={!!conv?.node_id}
            data={dataFor(f)}
            extendData={extendByPath.get(f.path)}
            onToggle={toggleFile}
            onToggleViewed={toggleViewed}
            onRef={onFileRef}
            renderExtendLine={renderExtendLine}
            onAddDraft={addDraft}
          />
        ))}

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
                <ChevronIcon size={14} className="chevron-up" />
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
                  <Button size="sm" onClick={() => setDrafts([])}>
                    Drop all
                  </Button>
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
                            {basename((at?.path ?? d.path))}:
                            {at?.line ?? d.line}
                            {!at && " ·  not in this diff"}
                          </span>
                          <span className="pr-draft-gist">{gist(d.body)}</span>
                        </button>
                        <Button size="sm"
                          onClick={() =>
                            setDrafts((prev) =>
                              prev.filter((x) => x.id !== d.id),
                            )
                          }>
                          Drop
                        </Button>
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
        <Dialog
          variant="accent"
          title={`${REVIEW_LABEL[confirm]} this pull request as yourself on GitHub?`}
          body={
            <>
              This posts a public review to the repository and notifies its
              authors.
              {drafts.length > 0 &&
                ` ${drafts.length} inline comment${drafts.length === 1 ? "" : "s"} go with it.`}
            </>
          }
          meta={`#${pr.number} ${pr.title}`}
          dismissLabel="Cancel"
          onDismiss={() => setConfirm(null)}
          actions={[
            {
              label: REVIEW_LABEL[confirm],
              primary: true,
              onClick: () => {
                const a = confirm;
                setConfirm(null);
                void submit(a);
              },
            },
          ]}
        />
      )}

      {mergeConfirm && (
        <Dialog
          variant="accent"
          title={`${MERGE_LABEL[mergeConfirm]} this pull request into ${pr.base} on GitHub?`}
          body={
            <>
              This lands <code>{pr.branch}</code> on <code>{pr.base}</code> in
              the real repository and closes the pull request. It can't be undone
              here.
            </>
          }
          meta={`#${pr.number} ${pr.title}`}
          dismissLabel="Cancel"
          onDismiss={() => setMergeConfirm(null)}
          actions={[
            {
              label: MERGE_LABEL[mergeConfirm],
              primary: true,
              disabled: busy,
              onClick: () => {
                const m = mergeConfirm;
                setMergeConfirm(null);
                void merge(m);
              },
            },
          ]}
        >
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
              {act.count} comment{act.count === 1 ? "" : "s"} still unaddressed.
            </p>
          )}
        </Dialog>
      )}

      {closeConfirm && (
        <Dialog
          variant="danger"
          title="Close this pull request without merging?"
          body={
            <>
              The pull request closes on GitHub and its author is notified. You
              can reopen it there later
              {closeDelBranch ? " — but only if the branch still exists" : ""}.
            </>
          }
          meta={`#${pr.number} ${pr.title}`}
          dismissLabel="Cancel"
          onDismiss={() => setCloseConfirm(false)}
          actions={[
            {
              label: closeDelBranch ? "Close & delete" : "Close PR",
              primary: true,
              disabled: busy,
              onClick: () => {
                const del = closeDelBranch;
                setCloseConfirm(false);
                setCloseDelBranch(false);
                void close(del);
              },
            },
          ]}
        >
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
        </Dialog>
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
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="accent"
          disabled={!body.trim()}
          onClick={() => onAdd(body.trim(), blocking)}>
          Add
        </Button>
      </div>
    </div>
  );
}

/** The groups, in the order they earn attention, each with the words that say
 *  what the group *means* rather than what it is.
 *
 *  "Closes" is a promise about what merging does. "Stacked" is a queue —
 *  merging this unblocks the ones behind it, and the one in front has to land
 *  first. "Mentions" is neither; it's context. A single flat list of linked
 *  issues would leave the reader to work all of that out from the titles. */
const LINK_GROUPS: readonly {
  key: keyof ipc.PrLinks;
  title: string;
  hint: string;
}[] = [
  {
    key: "parents",
    title: "Waiting on",
    hint: "This branches off that PR — it has to land first.",
  },
  {
    key: "closes",
    title: "Closes when merged",
    hint: "GitHub will close these the moment this lands.",
  },
  {
    key: "children",
    title: "Stacked on this",
    hint: "These branch off this PR and are waiting on it.",
  },
  {
    key: "mentions",
    title: "Related",
    hint: "Refers to this, or is referred to by it.",
  },
];

/** OPEN / CLOSED / MERGED onto the tints the rest of the tab already uses.
 *
 *  Closed splits in two, because the word means opposite things either side of
 *  it: a closed *issue* is the work finished — often by this very PR — and a
 *  closed *PR* is work abandoned. Painting both in `--danger` would file every
 *  issue this PR successfully closed under the colour of something going
 *  wrong. */
function linkStateClass(l: ipc.PrLink): string {
  if (l.state === "MERGED") return "is-merged";
  if (l.state === "CLOSED") return l.kind === "issue" ? "is-done" : "is-closed";
  return l.draft ? "is-draft" : "is-open";
}

function linkStateLabel(l: ipc.PrLink): string {
  if (l.state === "MERGED") return "merged";
  if (l.state === "CLOSED") return "closed";
  return l.draft ? "draft" : "open";
}

/** Everything this PR is attached to — issues it closes, the stack around it,
 *  and whatever else points at it.
 *
 *  Rows open on github.com rather than in a tab here: an issue has no view in
 *  this app, and a linked PR belongs to whichever project owns it, which may
 *  not be one that's open. Sending you somewhere that can actually show the
 *  thing beats a tab that can't. */
function PrLinkRail({ links }: { links: ipc.PrLinks | null }) {
  const groups = links
    ? LINK_GROUPS.map((g) => ({ ...g, rows: links[g.key] })).filter(
        (g) => g.rows.length > 0,
      )
    : [];
  if (groups.length === 0) return null;
  return (
    <div className="pr-rail-section">
      <div className="pr-rail-title">Linked</div>
      {groups.map((g) => (
        <div key={g.key} className="pr-link-group">
          <div className="pr-link-group-title" title={g.hint}>
            {g.title}
          </div>
          {g.rows.map((l) => (
            <button
              key={l.url}
              className="pr-link-row"
              title={`${l.repo || ""}#${l.number} ${l.title} — open on GitHub`}
              onClick={() =>
                void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
                  openUrl(l.url),
                )
              }
            >
              <span className={`pr-link-dot ${linkStateClass(l)}`} />
              {/* A bare "#12" in a cross-repo row points at this repo's #12,
                  which is a different issue with a different meaning. The
                  prefix is only carried when it changes what the number
                  refers to. */}
              <span className="pr-link-num">
                {l.repo && <span className="pr-link-repo">{l.repo}</span>}#
                {l.number}
              </span>
              <span className="pr-link-title">{l.title}</span>
              <span className={`pr-link-state ${linkStateClass(l)}`}>
                {linkStateLabel(l)}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** One review thread. Reply state is local so typing a reply re-renders this
 *  card alone — these render inside memoized diffs, where state hoisted to the
 *  tab would either go stale or defeat the memo. */
const ThreadCard = memo(function ThreadCard({
  t,
  compact = false,
  prOpen,
  canSuggest,
  onJump,
  onResolve,
  onReply,
  onApplySuggestion,
}: {
  t: ipc.PrThread;
  compact?: boolean;
  prOpen: boolean;
  canSuggest: boolean;
  onJump: (path: string) => void;
  onResolve: (threadId: string, resolved: boolean) => void;
  onReply: (threadId: string, body: string) => void;
  onApplySuggestion: (t: ipc.PrThread, suggestion: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const suggestion = threadSuggestion(t);
  return (
    <div
      className={`pr-thread ${t.resolved ? "is-resolved" : ""} ${t.outdated ? "is-outdated" : ""}`}
    >
      <div className="pr-thread-head">
        <span
          className="pr-thread-where"
          onClick={() => onJump(t.path)}
          title={t.path}
        >
          {basename(t.path)}
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
          <Markdown className="pr-comment-body" text={c.body} />
        </div>
      ))}
      {compact && t.comments.length > 2 && (
        <div className="pr-thread-more">+{t.comments.length - 2} more</div>
      )}
      {prOpen && (
        <div className="pr-thread-actions">
          <Button size="sm" onClick={() => setReplying((v) => !v)}>
            Reply
          </Button>
          <Button size="sm"
            onClick={() => onResolve(t.id, !t.resolved)}>
            {t.resolved ? "Reopen" : "Resolve"}
          </Button>
          {suggestion && canSuggest && (
            <Button size="sm"
              title="Apply the suggested change in a worktree, run the tests, and push"
              onClick={() => onApplySuggestion(t, suggestion)}>
              Apply suggestion
            </Button>
          )}
        </div>
      )}
      {replying && (
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
            <Button size="sm" onClick={() => setReplying(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="accent"
              disabled={!replyText.trim()}
              onClick={() => {
                const body = replyText.trim();
                setReplying(false);
                setReplyText("");
                onReply(t.id, body);
              }}>
              Post reply
            </Button>
          </div>
        </div>
      )}
    </div>
  );
});

/** A draft inline comment (not posted yet), editable in place. */
const DraftCard = memo(function DraftCard({
  d,
  onPatch,
  onDrop,
}: {
  d: DraftComment;
  onPatch: (id: string, patch: Partial<DraftComment>) => void;
  onDrop: (id: string) => void;
}) {
  return (
    // The id is the anchor jumpToDraft scrolls to — without it the best the
    // manifest could do was the top of the file.
    <div
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
          {basename(d.path)}:{d.line}
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
          Math.max(3, Math.ceil(d.body.length / 84) + d.body.split("\n").length),
        )}
        value={d.body}
        onChange={(e) => onPatch(d.id, { body: e.target.value })}
      />
      <div className="pr-thread-actions">
        <Button size="sm"
          onClick={() => onPatch(d.id, { blocking: !d.blocking })}>
          {d.blocking ? "Mark as nit" : "Mark blocking"}
        </Button>
        <Button size="sm" onClick={() => onDrop(d.id)}>
          Drop
        </Button>
      </div>
    </div>
  );
});

/** One file of the diff, memoized. Every prop is either a scalar or kept
 *  identity-stable by the tab, so a keystroke in the review box or a task-log
 *  write no longer re-renders — let alone remounts — every mounted DiffView. */
const PrFileCard = memo(function PrFileCard({
  f,
  open,
  split,
  prOpen,
  prUrl,
  liveCount,
  draftCount,
  viewed,
  canViewed,
  data,
  extendData,
  onToggle,
  onToggleViewed,
  onRef,
  renderExtendLine,
  onAddDraft,
}: {
  f: FilePatch;
  open: boolean;
  split: boolean;
  prOpen: boolean;
  prUrl: string;
  liveCount: number;
  draftCount: number;
  viewed: boolean;
  canViewed: boolean;
  data: DiffData;
  extendData?: {
    oldFile: Record<string, { data: LineData }>;
    newFile: Record<string, { data: LineData }>;
  };
  onToggle: (path: string) => void;
  onToggleViewed: (path: string, viewed: boolean) => void;
  onRef: (path: string, el: HTMLDivElement | null) => void;
  renderExtendLine: (p: { data: LineData }) => ReactNode;
  onAddDraft: (d: DraftComment) => void;
}) {
  return (
    <div
      className={`pr-file ${viewed ? "is-viewed" : ""}`}
      ref={(el) => onRef(f.path, el)}
    >
      <div className="pr-file-head">
        <span className="pr-file-chevron" onClick={() => onToggle(f.path)}>
          {open ? "▾" : "▸"}
        </span>
        <span
          className="pr-file-path"
          title={f.path}
          onClick={() => onToggle(f.path)}
        >
          {f.path}
        </span>
        {liveCount > 0 && (
          <span
            className="pr-thread-tag is-blocking"
            title="unresolved threads on this file"
          >
            {liveCount} 💬
          </span>
        )}
        {/* Staged, not posted. Worth its own mark: it's the only thing on the
            row that is waiting on a decision from you. */}
        {draftCount > 0 && (
          <span
            className="pr-thread-tag is-draft"
            title="staged findings, not posted"
          >
            {draftCount} ✎
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
        {canViewed && (
          <label
            className="pr-file-viewed"
            title="Mark as viewed — shared with GitHub's own checkbox"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={viewed}
              onChange={(e) => onToggleViewed(f.path, e.target.checked)}
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
            {f.changed.toLocaleString()} changed lines — too large to render
            inline. <a href={`${prUrl}/files`}>Open on GitHub</a>
          </div>
        ) : (
          <DiffView<LineData>
            // Only hunks — a patch has no full file content to give it,
            // which is exactly why Monaco's diff can't render this.
            // fileName drives syntax highlighting via the extension.
            // Highlight is the expensive part, so skip it on big files.
            data={data}
            diffViewMode={split ? DiffModeEnum.Split : DiffModeEnum.Unified}
            diffViewHighlight={f.changed <= HIGHLIGHT_MAX}
            diffViewTheme="dark"
            diffViewWrap
            // The widget is how you comment on a line: it opens a
            // composer, and what you write is held locally until the
            // whole review is submitted.
            diffViewAddWidget={prOpen}
            diffViewFontSize={12}
            extendData={extendData}
            renderExtendLine={renderExtendLine}
            renderWidgetLine={({ lineNumber, side, onClose }) => (
              <LineComposer
                onCancel={onClose}
                onAdd={(body, blocking) => {
                  onAddDraft({
                    id: `${f.path}:${lineNumber}:${Date.now()}`,
                    path: f.path,
                    line: lineNumber,
                    side: side === SplitSide.old ? "LEFT" : "RIGHT",
                    body,
                    blocking,
                  });
                  onClose();
                }}
              />
            )}
          />
        ))}
    </div>
  );
});

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

// A small frosted card at the top right of an agent's terminal: where it runs,
// its branch and PR, what it changed, who else is helping, and its task list.
// Shaped after T3 Code's thread details card (an inline card with accordion
// rows), replacing the vertical "Workspace" handle. The full workspace (files,
// diffs, commits) is one row away, so nothing is lost by opening less often.
//
// It only reads: the digest the hook wrote, `git status`, and the PR list. The
// task actions send the agent a message, exactly as typing it would.
import { useEffect, useState, useSyncExternalStore } from "react";
import { runCommitPushPr } from "../commitPushPrIpc";
import * as ipc from "../ipc";
import { offersAutoMerge } from "../prMergeAuto";
import { agentCliFor } from "../projects";
import { prConflictContext, prFixChecksContext } from "../prs";
import { openInOsBrowser } from "../links";
import { activeWorkspace } from "../remoteExecution/workspace";
import {
  completePrompt,
  focusPrompt,
  subAgentPrompt,
  normalizeTasks,
  withRequests,
  summarizeTasks,
  taskHeadline,
  type AgentTask,
} from "../agentTasks";
import { fmtSpan, subagentSpan, useSessionActivity } from "../sessionActivity";
import { liveEnvironments } from "../environments/live";
import { openRemoteFile } from "../environments/remoteFiles";
import { collectAssets, previewAssets, type Asset } from "../agentAssets";
import { AssetPreview } from "./AssetPreview";
import { requestTasksFor, subscribeRequestTasks } from "../requestTasks";
import { AgentIcon, GitBranchIcon, TasksIcon } from "./icons";
import type { Life } from "../../shared/agentLife";

const COLLAPSED_KEY = "canopy:agentCard:collapsed";
const DOCKED_KEY = "canopy:agentCard:docked";
const PR_TTL_MS = 60_000;

const prCache = new Map<string, { at: number; prs: ipc.PrInfo[] }>();
/** `gh` missing or failing is remembered for a while too, so a card does not
 *  re-run it on every branch change. */
const prFailures = new Map<string, number>();
const PR_FAILURE_TTL_MS = 5 * 60_000;

/** PRs per repo, shared by every card and refreshed at most once a minute: the
 *  card mounts and unmounts as tabs change, and `gh` is not free. */
async function prsFor(repo: string): Promise<ipc.PrInfo[]> {
  const hit = prCache.get(repo);
  if (hit && Date.now() - hit.at < PR_TTL_MS) return hit.prs;
  const failedAt = prFailures.get(repo);
  if (failedAt && Date.now() - failedAt < PR_FAILURE_TTL_MS) return [];
  try {
    const prs = await ipc.ghPrList(repo);
    prFailures.delete(repo);
    prCache.set(repo, { at: Date.now(), prs });
    return prs;
  } catch (error) {
    prFailures.set(repo, Date.now());
    throw error;
  }
}

/** Docked is the default: a card floating over the terminal hides its text. */
function readDocked(): boolean {
  try {
    return localStorage.getItem(DOCKED_KEY) !== "0";
  } catch {
    return true;
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

const METHOD_KEY = "canopy.prMergeMethod";
const METHOD_LABEL = {
  squash: "Squash & merge",
  merge: "Merge commit",
  rebase: "Rebase & merge",
} as const;
function readMergeMethod(): "squash" | "merge" | "rebase" {
  try {
    const v = localStorage.getItem(METHOD_KEY);
    if (v === "squash" || v === "merge" || v === "rebase") return v;
  } catch {
    /* default */
  }
  return "squash";
}
const DEFAULT_BRANCHES = new Set(["main", "master", "develop"]);
/** "fix/hub-prefetch-scrcpy" becomes "Fix hub prefetch scrcpy". */
export function titleFromBranch(branch: string): string {
  const text = branch
    .replace(/^[^/]+\//, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return text ? text[0].toUpperCase() + text.slice(1) : branch;
}

export function prStatusLabel(pr: ipc.PrInfo): string {
  const state = pr.state.toUpperCase();
  if (state === "MERGED") return "Merged";
  if (state === "CLOSED") return "Closed";
  if (pr.draft) return "Draft";
  if (pr.checks === "FAIL") return "Checks failing";
  if (pr.mergeable === "CONFLICTING") return "Conflicts";
  if (pr.review_decision === "APPROVED") return "Approved";
  return "Ready";
}

/** Ticks once a second while something is running, so an age keeps counting. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [live]);
  return now;
}

const MAX_PREVIOUS = 30;

/** The agent's sub-agents, as T3 Code's "Lineage": the ones running now with
 *  their age, and the finished ones behind a row that opens. This is the list
 *  Claude Code draws as a block of text inside the terminal ("8 agents"); here
 *  it stays small and out of the way. */
function Lineage({ subagents }: { subagents: readonly ipc.SubagentRun[] }) {
  const [showPrevious, setShowPrevious] = useState(false);
  const running = subagents.filter((s) => s.status === "running");
  const previous = subagents.filter((s) => s.status !== "running");
  const failed = previous.filter((s) => s.status === "failed").length;
  const now = useNow(running.length > 0);
  const [openId, setOpenId] = useState<string | null>(null);
  const row = (s: ipc.SubagentRun) => {
    const span = subagentSpan(s, now);
    const open = openId === s.id;
    return (
      <li key={s.id} className={`agent-card-sub agent-card-sub-${s.status}`}>
        <button
          type="button"
          className="agent-card-sub-btn"
          title={s.description}
          aria-expanded={open}
          onClick={() => setOpenId(open ? null : s.id)}
        >
          <span className="agent-card-sub-dot" aria-hidden="true" />
          <span className="agent-card-sub-name">
            {s.description || "(no description)"}
          </span>
          {span != null && (
            <span className="agent-card-dim agent-card-sub-age">
              {fmtSpan(span)}
            </span>
          )}
        </button>
        {open && (
          <div
            className="agent-card-sub-result"
            role="region"
            aria-label={`${s.description || "Agent"} result`}
          >
            {s.result?.trim()
              ? s.result
              : s.status === "running"
                ? "Still working…"
                : "No text was returned."}
          </div>
        )}
      </li>
    );
  };
  return (
    <div className="agent-card-lineage">
      <div className="agent-card-lineage-head">
        <span>
          Lineage{running.length > 0 ? ` · ${running.length} running` : ""}
        </span>
      </div>
      {running.length > 0 && (
        <ul className="agent-card-subs">{running.map(row)}</ul>
      )}
      {previous.length > 0 && (
        <button
          type="button"
          className="agent-card-row agent-card-btn"
          aria-expanded={showPrevious}
          onClick={() => setShowPrevious((v) => !v)}
        >
          <span>Previous agents</span>
          <span className="agent-card-grow" />
          {failed > 0 && (
            <span className="agent-card-del">{failed} failed</span>
          )}
          <span className="agent-card-dim">{previous.length}</span>
          <span aria-hidden="true">{showPrevious ? "▾" : "▸"}</span>
        </button>
      )}
      {showPrevious && (
        <ul className="agent-card-subs">
          {previous.slice(0, MAX_PREVIOUS).map(row)}
        </ul>
      )}
    </div>
  );
}

interface AgentDetailsCardProps {
  agent: string;
  /** The repository the agent works in, or null when its cwd is in none. */
  repo: string | null;
  cwd: string;
  digest?: ipc.SessionDigest;
  /** TCP ports the agent's terminal is serving; each is a preview in Assets. */
  ports?: number[];
  /** The verdict from shared/agentLife for this agent's terminal, which is what
   *  decides whether a message is safe to send. The raw digest state is not
   *  compared here: it can be stale or unproven. */
  life?: Life;
  onOpenWorkspace: () => void;
  /** Told whether the card is docked beside the terminal (taking its own column)
   *  rather than floating over it, so the terminal can make room. */
  onDockChange?: (docked: boolean) => void;
  /** Open an asset the agent made. Default: in a tab of its own. `system` when
   *  a modifier was held: the person's own app for that file. */
  onOpenAsset?: (path: string, opts: { system: boolean }) => void;
  /** Send this project to another workspace without switching to it. Only offered
   *  while this Mac is the live machine. */
  onSendToWorkspace?: () => void;
  /** The machine this agent runs on, when it is not this window's own: its
   *  branch and changes are read there, and a pull request is not looked up from
   *  this Mac's checkout. */
  machine?: { env: string; name: string };
  /** Settle (put away) or un-settle this agent's tab. `settled` is its current state. */
  settled?: boolean;
  onSettle?: (settle: boolean) => void;
  /** Type a message to this agent (its terminal), as the person would. Resolves
   *  with whether it was delivered and, when not, why. */
  onSendToAgent: (
    text: string,
  ) => Promise<{ delivered: boolean; note: string }> | void;
  /** Say why a send failed. */
  onNotice?: (message: string) => void;
}

export function AgentDetailsCard({
  agent,
  repo,
  cwd,
  digest,
  ports,
  life,
  onOpenWorkspace,
  onDockChange,
  onOpenAsset,
  onSendToWorkspace,
  settled,
  onSettle,
  onSendToAgent,
  onNotice,
  machine: remoteMachine,
}: AgentDetailsCardProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [docked, setDocked] = useState(readDocked);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [hovered, setHovered] = useState<{
    asset: Asset;
    anchor: DOMRect;
  } | null>(null);
  const [branch, setBranch] = useState<string | null>(digest?.branch ?? null);
  const [changed, setChanged] = useState<number | null>(null);
  const [pr, setPr] = useState<ipc.PrInfo | null>(null);
  /** Every PR this agent raised, newest first; shown on hover. */
  const [agentPrs, setAgentPrs] = useState<ipc.PrInfo[]>([]);
  const [prListOpen, setPrListOpen] = useState(false);
  /** The merge action awaiting its confirm click, and whether one is running. */
  const [pending, setPending] = useState<
    null | "squash" | "merge" | "rebase" | "close"
  >(null);
  const [merging, setMerging] = useState(false);
  /** A merge GitHub refused for its branch policy: offered as "merge when checks pass". */
  const [autoOffer, setAutoOffer] = useState<null | {
    repo: string;
    number: number;
    method: "squash" | "merge" | "rebase";
  }>(null);
  const [mergeMenu, setMergeMenu] = useState(false);
  const [method, setMethod] = useState<"squash" | "merge" | "rebase">(
    readMergeMethod,
  );
  /** The "Commit & raise PR" form, and bumped to re-read the branch's PR after one is raised. */
  const [raising, setRaising] = useState<null | {
    title: string;
    busy: boolean;
  }>(null);
  const [prEpoch, setPrEpoch] = useState(0);
  /** Commits on this branch beyond its base, when nothing is left uncommitted. */
  const [ahead, setAhead] = useState(0);

  const dockedNow = docked && !collapsed;
  useEffect(() => {
    onDockChange?.(dockedNow);
    return () => onDockChange?.(false);
  }, [dockedNow, onDockChange]);
  const toggleDock = () => {
    const next = !docked;
    setDocked(next);
    try {
      localStorage.setItem(DOCKED_KEY, next ? "1" : "0");
    } catch {
      /* A remembered state is a convenience. */
    }
  };

  const toggle = (value: boolean) => {
    setCollapsed(value);
    try {
      localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
    } catch {
      /* A remembered state is a convenience. */
    }
  };

  // Branch and uncommitted changes, from the checkout the agent is in.
  useEffect(() => {
    if (collapsed || !cwd) return;
    let stale = false;
    const status = remoteMachine
      ? (liveEnvironments
          .get(remoteMachine.env)
          ?.host.invoke<ipc.GitStatusResult>("git_status", { path: cwd }) ??
        Promise.reject(new Error("not connected")))
      : ipc.gitStatus(cwd);
    status
      .then((s) => {
        if (stale) return;
        setBranch(s.branch ?? digest?.branch ?? null);
        setChanged(s.is_repo ? s.entries.length : null);
      })
      .catch(() => {
        if (!stale) setBranch(digest?.branch ?? null);
      });
    return () => {
      stale = true;
    };
  }, [collapsed, cwd, digest?.branch, digest?.updated, remoteMachine?.env]);

  // The PR for that branch, when `gh` knows one.
  useEffect(() => {
    setPr(null);
    setAgentPrs([]);
    if (collapsed || !repo || !branch || remoteMachine) return;
    let stale = false;
    prsFor(repo)
      .then(async (prs) => {
        // The PRs this session is on record as having produced, plus the one
        // on its current branch.
        let edges: ipc.ProvenanceEdge[] = [];
        try {
          if (digest?.session_id)
            edges = await ipc.provenanceForSession(digest.session_id);
        } catch {
          /* No record: the branch's own PR still shows. */
        }
        if (stale) return;
        const raised = new Set(
          edges
            .filter((e) => e.repo === repo || !e.repo)
            .map((e) => e.pr_number),
        );
        const mine = prs
          .filter((p) => p.branch === branch || raised.has(p.number))
          .sort((a, b) => b.number - a.number);
        setAgentPrs(mine);
        setPr(prs.find((p) => p.branch === branch) ?? mine[0] ?? null);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [collapsed, repo, branch, remoteMachine, digest?.session_id, prEpoch]);

  // A branch with everything committed can still have work with no PR.
  useEffect(() => {
    setAhead(0);
    if (
      collapsed ||
      pr ||
      !cwd ||
      !branch ||
      remoteMachine ||
      DEFAULT_BRANCHES.has(branch) ||
      changed !== 0
    )
      return;
    let stale = false;
    ipc
      .gitPrContext(cwd, "")
      .then((ctx) => {
        if (!stale) setAhead(ctx.commit_count);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [collapsed, pr, cwd, branch, changed, remoteMachine, prEpoch]);

  // The sub-agents, read from the session's transcript, polled faster while the
  // agent is working.
  const activity = useSessionActivity(
    digest?.session_id && !collapsed
      ? {
          agent,
          sessionId: digest.session_id,
          cwd,
          profile: digest.profile ?? null,
          ...(remoteMachine ? { env: remoteMachine.env } : {}),
        }
      : null,
    { fast: life?.state === "working" },
  );
  const subagents = activity?.subagents ?? [];
  // Servers the terminal is running get their own section with a link; the
  // Assets list keeps only the files the agent made.
  const servers = previewAssets(ports);
  const assets = collectAssets(digest?.files, cwd);
  const requests = useSyncExternalStore(subscribeRequestTasks, () =>
    requestTasksFor(digest?.session_id ?? ""),
  );
  // Tasks the person removed from this card (kept per session, on this
  // computer only; the agent's own list is not touched).
  const hideKey = `canopy.hiddenTasks.${digest?.session_id ?? ""}`;
  const [hiddenTasks, setHiddenTasks] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(hideKey) ?? "[]");
      return Array.isArray(raw) ? raw.filter((t) => typeof t === "string") : [];
    } catch {
      return [];
    }
  });
  const hideTask = (text: string) => {
    const next = [...hiddenTasks, text];
    setHiddenTasks(next);
    try {
      localStorage.setItem(hideKey, JSON.stringify(next.slice(-200)));
    } catch {
      /* storage may be unavailable */
    }
  };
  const tasks = withRequests(normalizeTasks(digest?.tasks), requests).filter(
    (t) => !hiddenTasks.includes(t.text),
  );
  const summary = summarizeTasks(tasks);
  const cli = agentCliFor(agent);
  const ws = activeWorkspace();
  const machine = remoteMachine
    ? remoteMachine.name
    : ws
      ? ws.connection.workspaceName
      : "This Mac";
  const helpers = digest?.subagents ?? 0;
  const blocked =
    !!pr &&
    (pr.draft || pr.checks === "FAIL" || pr.mergeable === "CONFLICTING");
  const blockedWhy = !pr
    ? undefined
    : pr.draft
      ? "Mark the PR ready first"
      : pr.checks === "FAIL"
        ? "Checks are failing"
        : pr.mergeable === "CONFLICTING"
          ? "Resolve the conflicts first"
          : undefined;
  const canRaise =
    !pr &&
    !!repo &&
    !remoteMachine &&
    !!branch &&
    !DEFAULT_BRANCHES.has(branch) &&
    ((changed ?? 0) > 0 || ahead > 0);

  if (collapsed) {
    return (
      <button
        type="button"
        className="agent-card-pill"
        onClick={() => toggle(false)}
        aria-label="Show agent details"
        title={
          summary.total
            ? `Tasks ${summary.done}/${summary.total}`
            : "Agent details"
        }
      >
        <AgentIcon id={agent} size={14} />
        {summary.total > 0 && (
          <span className="agent-card-pill-count">
            {summary.done}/{summary.total}
          </span>
        )}
      </button>
    );
  }

  // Typing into an agent that is waiting on a permission or choice menu would
  // answer it, and an ended session would be restarted by the send. So the
  // actions are offered only while the agent is working or idle, per the hook.
  const canAct = life?.state === "working" || life?.state === "idle";
  const actHint = canAct
    ? undefined
    : life?.state === "waiting"
      ? "The agent is waiting for your answer. Answer it first."
      : "The agent isn't running.";
  const act = (task: AgentTask, make: (t: AgentTask) => string) => {
    void Promise.resolve(onSendToAgent(make(task))).then((result) => {
      if (result && !result.delivered)
        onNotice?.(result.note || "The agent did not receive that.");
    });
  };

  return (
    <aside
      className={`agent-card${docked ? " agent-card--docked" : ""}`}
      aria-label="Agent details"
    >
      <header className="agent-card-head">
        <span className="agent-card-title">
          <AgentIcon id={agent} size={15} />
          <span>{cli?.name ?? agent}</span>
        </span>
        <span className="agent-card-machine" title="Where this agent runs">
          {machine}
        </span>
        <button
          type="button"
          className="agent-card-icon-btn"
          onClick={toggleDock}
          aria-label={
            docked
              ? "Float agent details over the terminal"
              : "Dock agent details beside the terminal"
          }
          aria-pressed={docked}
          title={
            docked ? "Float over the terminal" : "Dock beside the terminal"
          }
        >
          ◧
        </button>
        <button
          type="button"
          className="agent-card-icon-btn"
          onClick={() => toggle(true)}
          aria-label="Hide agent details"
          title="Hide"
        >
          ×
        </button>
      </header>

      {servers.length > 0 && (
        <section className="agent-card-servers" aria-label="Running servers">
          <div className="agent-card-label">
            Running <span className="agent-card-dim">{servers.length}</span>
          </div>
          {servers.map((server) => (
            <div key={server.path} className="agent-card-server">
              <span className="agent-card-live" aria-hidden="true" />
              <span className="agent-card-grow agent-card-ellipsis">
                {server.name}
              </span>
              <button
                type="button"
                className="agent-card-server-open"
                title={`Open ${server.path} in the preview (⌘-click: your browser)`}
                aria-label={`Open ${server.name}`}
                onClick={(e) =>
                  onOpenAsset?.(server.path, { system: e.metaKey || e.ctrlKey })
                }
              >
                Open ↗
              </button>
            </div>
          ))}
        </section>
      )}

      {branch && (
        <div className="agent-card-row" title={branch}>
          <GitBranchIcon size={14} />
          <span className="agent-card-grow agent-card-ellipsis">{branch}</span>
        </div>
      )}

      {pr && (
        <div
          className="agent-card-row agent-card-pr-row"
          title={agentPrs.length > 1 ? undefined : pr.title}
          tabIndex={agentPrs.length > 1 ? 0 : undefined}
          onMouseEnter={() => setPrListOpen(true)}
          onMouseLeave={() => setPrListOpen(false)}
          onFocus={() => setPrListOpen(true)}
          onBlur={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            )
              setPrListOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setPrListOpen(false);
          }}
        >
          {prListOpen && agentPrs.length > 1 && (
            <ul
              className="agent-card-prlist"
              aria-label="Pull requests from this agent"
            >
              {agentPrs.map((p) => (
                <li key={p.number}>
                  <button
                    type="button"
                    className="agent-card-prlist-row"
                    onClick={() => openInOsBrowser(p.url)}
                    title={p.title}
                  >
                    <span className="agent-card-pr-num">#{p.number}</span>
                    <span className="agent-card-grow agent-card-ellipsis">
                      {p.title}
                    </span>
                    <span
                      className={`agent-card-chip agent-card-chip-${prStatusLabel(p).toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      {prStatusLabel(p)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <span className="agent-card-pr-num">#{pr.number}</span>
          <span className="agent-card-grow agent-card-ellipsis">
            {pr.title}
          </span>
          <span
            className={`agent-card-chip agent-card-chip-${prStatusLabel(pr).toLowerCase().replace(/\s+/g, "-")}`}
          >
            {prStatusLabel(pr)}
          </span>
          {(pr.checks === "FAIL" || pr.mergeable === "CONFLICTING") && (
            <button
              type="button"
              className="agent-card-fix"
              disabled={!canAct}
              title={
                actHint ??
                (pr.checks === "FAIL"
                  ? "Ask this agent to fix the failing checks"
                  : "Ask this agent to resolve the conflicts")
              }
              onClick={() =>
                void Promise.resolve(
                  onSendToAgent(
                    pr.checks === "FAIL"
                      ? prFixChecksContext(pr)
                      : prConflictContext(pr),
                  ),
                ).then((result) => {
                  if (result && !result.delivered)
                    onNotice?.(
                      result.note || "The agent did not receive that.",
                    );
                })
              }
            >
              {pr.checks === "FAIL" ? "Fix it" : "Resolve"}
            </button>
          )}
        </div>
      )}

      {pr && !!pr.check_runs?.length && (
        <ul className="agent-card-checks" aria-label="Checks not yet passed">
          {pr.check_runs.slice(0, 5).map((c, i) => (
            <li key={`${i}:${c.name}`} className={`agent-card-check-${c.state}`}>
              <span className="agent-card-check-state">{c.state}</span>
              <span className="agent-card-grow agent-card-ellipsis">{c.name}</span>
            </li>
          ))}
          {pr.check_runs.length > 5 && (
            <li>+{pr.check_runs.length - 5} more</li>
          )}
        </ul>
      )}

      {pr && repo && !remoteMachine && pr.state.toUpperCase() === "OPEN" && (
        <div
          className="agent-card-row agent-card-merge"
          role="group"
          aria-label={`Merge pull request #${pr.number}`}
        >
          {autoOffer &&
          autoOffer.repo === repo &&
          autoOffer.number === pr.number &&
          !pending ? (
            <>
              <span className="agent-card-grow agent-card-ellipsis">
                Merge not allowed yet
              </span>
              <button
                type="button"
                className="agent-card-fix"
                disabled={merging}
                autoFocus
                onClick={() => {
                  const offer = autoOffer;
                  setMerging(true);
                  void ipc
                    .ghPrAutoMerge(offer.repo, offer.number, offer.method, true)
                    .then((message) => {
                      prCache.delete(repo);
                      setPrEpoch((n) => n + 1);
                      onNotice?.(message);
                    })
                    .catch((err) => onNotice?.(String(err)))
                    .finally(() => {
                      setMerging(false);
                      setAutoOffer(null);
                    });
                }}
              >
                {merging ? "Working…" : "Merge when checks pass"}
              </button>
              <button
                type="button"
                className="agent-card-fix agent-card-fix-quiet"
                disabled={merging}
                onClick={() => setAutoOffer(null)}
              >
                Dismiss
              </button>
            </>
          ) : pending ? (
            <>
              <span className="agent-card-grow agent-card-ellipsis">
                {pending === "close"
                  ? "Close"
                  : pending === "squash"
                    ? "Squash and merge"
                    : pending === "merge"
                      ? "Merge"
                      : "Rebase and merge"}{" "}
                #{pr.number}?
              </span>
              <button
                type="button"
                className="agent-card-fix"
                disabled={merging}
                autoFocus
                onClick={() => {
                  const method = pending;
                  setMerging(true);
                  const run =
                    method === "close"
                      ? ipc.ghPrClose(repo, pr.number, false)
                      : ipc.ghPrMerge(repo, pr.number, method);
                  void Promise.resolve(run)
                    .then((result) => {
                      prCache.delete(repo);
                      const done = method === "close" ? "CLOSED" : "MERGED";
                      const pendingBg =
                        typeof result === "object" && result?.pending;
                      if (!pendingBg) {
                        setPr((p) => (p ? { ...p, state: done } : p));
                        setAgentPrs((list) =>
                          list.map((x) =>
                            x.number === pr.number ? { ...x, state: done } : x,
                          ),
                        );
                      }
                      onNotice?.(
                        typeof result === "object" && result?.message
                          ? result.message
                          : `#${pr.number} ${method === "close" ? "closed" : "merged"}.`,
                      );
                    })
                    .catch((err) => {
                      if (method !== "close" && offersAutoMerge(err))
                        setAutoOffer({ repo, number: pr.number, method });
                      onNotice?.(String(err));
                    })
                    .finally(() => {
                      setMerging(false);
                      setPending(null);
                    });
                }}
              >
                {merging ? "Working…" : "Confirm"}
              </button>
              <button
                type="button"
                className="agent-card-fix agent-card-fix-quiet"
                disabled={merging}
                onClick={() => setPending(null)}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <span className="agent-card-split">
                <button
                  type="button"
                  className="agent-card-fix agent-card-split-main"
                  disabled={blocked}
                  title={blockedWhy ?? METHOD_LABEL[method]}
                  onClick={() => setPending(method)}
                >
                  {METHOD_LABEL[method]}
                </button>
                <button
                  type="button"
                  className="agent-card-fix agent-card-split-chev"
                  disabled={blocked}
                  aria-label="Choose how to merge"
                  aria-expanded={mergeMenu}
                  onClick={() => setMergeMenu((open) => !open)}
                >
                  ▾
                </button>
                {mergeMenu && (
                  <ul
                    className="agent-card-mergemenu"
                    role="menu"
                    onKeyDown={(e) => e.key === "Escape" && setMergeMenu(false)}
                  >
                    {(["squash", "merge", "rebase"] as const).map((m) => (
                      <li key={m}>
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={m === method}
                          autoFocus={m === method}
                          onClick={() => {
                            setMethod(m);
                            try {
                              localStorage.setItem(METHOD_KEY, m);
                            } catch {
                              /* remembered only as a convenience */
                            }
                            setMergeMenu(false);
                            setPending(m);
                          }}
                        >
                          <span>{m === method ? "✓" : ""}</span>
                          {METHOD_LABEL[m]}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </span>
              <span className="agent-card-grow" />
              <button
                type="button"
                className="agent-card-fix agent-card-fix-quiet agent-card-close"
                onClick={() => setPending("close")}
              >
                Close
              </button>
            </>
          )}
        </div>
      )}

      {canRaise && (
        <div
          className="agent-card-row agent-card-merge"
          role="group"
          aria-label="Raise a pull request"
        >
          {raising ? (
            <>
              <input
                className="agent-card-title-input agent-card-grow"
                aria-label="Pull request title"
                value={raising.title}
                autoFocus
                disabled={raising.busy}
                onChange={(e) =>
                  setRaising({ ...raising, title: e.target.value })
                }
                onKeyDown={(e) => {
                  if (e.key === "Escape") setRaising(null);
                }}
              />
              <button
                type="button"
                className="agent-card-fix"
                disabled={raising.busy || !raising.title.trim()}
                onClick={() => {
                  const title = raising.title.trim();
                  setRaising({ ...raising, busy: true });
                  void runCommitPushPr({
                    repo: cwd || repo!,
                    message: title,
                    title,
                    commit: (changed ?? 0) > 0,
                  })
                    .then((result) => {
                      if (result.skipped.length > 0)
                        onNotice?.(
                          `Left out because they look like secrets: ${result.skipped.join(", ")}`,
                        );
                      onNotice?.(
                        result.prUrl
                          ? `Opened ${result.prUrl}`
                          : result.prExisted
                            ? "A pull request already exists for this branch."
                            : "Committed and pushed.",
                      );
                      prCache.delete(repo!);
                      setPrEpoch((n) => n + 1);
                      setRaising(null);
                    })
                    .catch((err) => {
                      onNotice?.(
                        String(err instanceof Error ? err.message : err),
                      );
                      setRaising((r) => (r ? { ...r, busy: false } : r));
                    });
                }}
              >
                {raising.busy ? "Working…" : "Raise PR"}
              </button>
              <button
                type="button"
                className="agent-card-fix agent-card-fix-quiet"
                disabled={raising.busy}
                onClick={() => setRaising(null)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="agent-card-fix"
              onClick={() =>
                setRaising({ title: titleFromBranch(branch!), busy: false })
              }
            >
              {(changed ?? 0) > 0 ? "Commit & raise PR" : "Raise PR"}
            </button>
          )}
        </div>
      )}

      {(pr || changed !== null) && (
        <div className="agent-card-row">
          <span>Changes</span>
          <span className="agent-card-grow" />
          {pr ? (
            <span className="agent-card-diffstat">
              <span className="agent-card-add">+{pr.additions}</span>{" "}
              <span className="agent-card-del">−{pr.deletions}</span>
            </span>
          ) : (
            <span>{changed} uncommitted</span>
          )}
        </div>
      )}

      {subagents.length > 0 ? (
        <Lineage subagents={subagents} />
      ) : (
        helpers > 0 && (
          <div className="agent-card-row">
            <span>Subagents</span>
            <span className="agent-card-grow" />
            <span>{helpers} finished this turn</span>
          </div>
        )
      )}

      <button
        type="button"
        className="agent-card-row agent-card-btn"
        aria-expanded={tasksOpen}
        onClick={() => setTasksOpen((v) => !v)}
        disabled={summary.total === 0}
      >
        <TasksIcon size={14} />
        <span>Tasks</span>
        <span className="agent-card-grow" />
        <span className="agent-card-dim">{taskHeadline(summary)}</span>
        {summary.total > 0 && (
          <span aria-hidden="true">{tasksOpen ? "▾" : "▸"}</span>
        )}
      </button>

      {summary.total > 0 && (
        <div
          className="agent-card-progress"
          role="progressbar"
          aria-label="Tasks done"
          aria-valuemin={0}
          aria-valuemax={summary.total}
          aria-valuenow={summary.done}
        >
          <i
            className="agent-card-progress-done"
            style={{ width: `${(summary.done / summary.total) * 100}%` }}
          />
          <i
            className="agent-card-progress-run"
            style={{ width: `${(summary.running / summary.total) * 100}%` }}
          />
        </div>
      )}

      {summary.current && !tasksOpen && (
        <div className="agent-card-current" title={summary.current.text}>
          {summary.current.text}
        </div>
      )}

      {tasksOpen && (
        <ul className="agent-card-tasks">
          {tasks.map((task, i) => (
            <li
              key={`${i}:${task.text}`}
              className={`agent-card-task agent-card-task-${task.status}`}
            >
              <span className="agent-card-task-mark" aria-hidden="true">
                {task.status === "completed"
                  ? "✓"
                  : task.status === "running"
                    ? "●"
                    : "○"}
              </span>
              <button
                type="button"
                className="agent-card-task-x"
                title="Remove from list"
                aria-label={`Remove ${task.text}`}
                onClick={() => hideTask(task.text)}
              >
                ×
              </button>
              <span className="agent-card-task-text">
                {task.text}
                {task.fromUser && (
                  <span className="agent-card-task-you">You asked</span>
                )}
              </span>
              {task.status !== "completed" && (
                <span className="agent-card-task-actions">
                  <button
                    type="button"
                    disabled={!canAct}
                    onClick={() => act(task, focusPrompt)}
                    title={actHint ?? "Ask the agent to work on this next"}
                    aria-label={`Focus on ${task.text}`}
                  >
                    Focus
                  </button>
                  <button
                    type="button"
                    disabled={!canAct}
                    onClick={() => act(task, completePrompt)}
                    title={actHint ?? "Ask the agent to finish this now"}
                    aria-label={`Complete ${task.text}`}
                  >
                    Complete
                  </button>
                  <button
                    type="button"
                    disabled={!canAct}
                    onClick={() => act(task, subAgentPrompt)}
                    title={
                      actHint ?? "Ask the agent to run this as a sub agent"
                    }
                    aria-label={`Run ${task.text} as a sub agent`}
                  >
                    Sub agent
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {assets.length > 0 && (
        <>
          <button
            type="button"
            className="agent-card-row agent-card-btn"
            aria-expanded={assetsOpen}
            onClick={() => {
              setAssetsOpen((v) => !v);
              setHovered(null);
            }}
          >
            <span>Assets</span>
            <span className="agent-card-grow" />
            <span className="agent-card-dim">{assets.length} made</span>
            <span aria-hidden="true">{assetsOpen ? "▾" : "▸"}</span>
          </button>
          {assetsOpen && (
            <ul
              className="agent-card-assets"
              onMouseLeave={() => setHovered(null)}
            >
              {assets.map((asset) => (
                <li key={asset.path}>
                  <button
                    type="button"
                    className="agent-card-asset"
                    title={asset.path}
                    onMouseEnter={(e) =>
                      setHovered({
                        asset,
                        anchor: e.currentTarget.getBoundingClientRect(),
                      })
                    }
                    onFocus={(e) =>
                      setHovered({
                        asset,
                        anchor: e.currentTarget.getBoundingClientRect(),
                      })
                    }
                    onBlur={() => setHovered(null)}
                    onClick={(e) => {
                      setHovered(null);
                      // Click: a tab of its own. With a modifier: the person's own app.
                      // A file on another machine opens read-only through that machine; a
                      // running server (a URL) still goes to the preview.
                      if (remoteMachine && !/^https?:\/\//i.test(asset.path)) {
                        openRemoteFile({
                          env: remoteMachine.env,
                          machine: remoteMachine.name,
                          path: asset.path,
                        });
                        return;
                      }
                      onOpenAsset?.(asset.path, {
                        system: e.metaKey || e.ctrlKey,
                      });
                    }}
                  >
                    <span className="agent-card-asset-kind">{asset.kind}</span>
                    <span className="agent-card-asset-name">{asset.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {hovered && assetsOpen && (
            <AssetPreview asset={hovered.asset} anchor={hovered.anchor} />
          )}
        </>
      )}

      {onSettle && (
        <button
          type="button"
          className="agent-card-row agent-card-btn"
          onClick={() => onSettle(!settled)}
        >
          <span>{settled ? "Unsettle" : "Settle"}</span>
          <span className="agent-card-grow" />
          <span className="agent-card-dim">
            {settled ? "Back to the strip" : "Put finished work away"}
          </span>
        </button>
      )}

      {onSendToWorkspace && (
        <button
          type="button"
          className="agent-card-row agent-card-btn"
          onClick={onSendToWorkspace}
        >
          <span>To a workspace</span>
          <span className="agent-card-grow" />
          <span className="agent-card-dim">Send this project</span>
          <span aria-hidden="true">›</span>
        </button>
      )}

      <button
        type="button"
        className="agent-card-row agent-card-btn agent-card-workspace"
        onClick={onOpenWorkspace}
      >
        <span>Workspace</span>
        <span className="agent-card-grow" />
        <span className="agent-card-dim">Files, diffs, commits</span>
        <span aria-hidden="true">›</span>
      </button>
    </aside>
  );
}

// The PR inbox: every open project's pull requests in one list, grouped by what
// they need rather than by which repo they came from — because "what needs me"
// is the question you open this for, and it doesn't respect project boundaries.
//
// It fetches nothing. Rows arrive from the shared watcher (prWatchStore), which
// is driven by one poller in Rust; this component only renders and dispatches.
// Clicking a row opens the PR's own tab — in this project directly, or by asking
// App to switch projects first.
import { useEffect, useMemo, useState } from "react";
import type * as ipc from "../ipc";
import * as ipcApi from "../ipc";
import {
  LANE_LABEL,
  lanes,
  prContextActions,
  prMergeReady,
  rowState,
  since,
  toPrInfo,
  type Lane,
  type PrQuickAction,
} from "../prInbox";
import { refresh } from "../prWatchStore";
import { usePrWatch } from "../usePrWatch";
import { PullRequestIcon } from "./icons";
import { Button, TextInput } from "./ui";
import { basename } from "../paths";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import type { RelayHandle } from "../types";
import { formatDeepLink } from "../deepLinks";
import {
  dashboardGroups,
  indexProbes,
  mergeProbeGroups,
  openAge,
  recommendMergeOrder,
  sessionLabel,
  statsFor,
  type MergePlanStep,
} from "../prDashboard";
import { cached as cachedProvenance, load as loadProvenance, PROVENANCE_EVENT } from "../provenance";
import "./PrsDashboard.css";

interface PrsPanelProps {
  /** This project's repos. The panel shows these and nothing else — a PR queue
   *  that spans projects is a stream to scroll, not a queue to work. */
  localRepos: string[];
  onOpen: (repo: string, pr: ipc.PrInfo) => void;
  /** Repo path → the label to show on the row's second line. */
  projectFor: (repo: string) => string | undefined;
  page?: boolean;
  onOpenAll?: () => void;
  /** Start the agent micro-task the row's state calls for (review, address
   *  comments, fix CI, resolve conflicts). */
  onQuickTask?: (action: PrQuickAction, repo: string, pr: ipc.PrInfo) => void;
  relay?: RelayHandle;
  onNotice?: (message: string, kind?: "info" | "success" | "warn" | "error") => void;
  onOpenChat?: (peer: string, name: string) => void;
}

const PANEL_ROWS = 12;

// A head SHA is the invalidation token. Revisiting the page reuses evidence
// while the commits are unchanged; a push creates a different key and probes
// again. No interval and no second freshness mechanism.
const probeCache = new Map<string, ipc.PrMergePlanProbe>();
const probePending = new Map<string, Promise<ipc.PrMergePlanProbe>>();

function loadProbe(group: ReturnType<typeof mergeProbeGroups>[number]): Promise<ipc.PrMergePlanProbe> {
  const hit = probeCache.get(group.key);
  if (hit) return Promise.resolve(hit);
  const pending = probePending.get(group.key);
  if (pending) return pending;
  const request = ipcApi
    .gitPrMergeProbe(group.repo, group.candidates, true)
    .catch((error) => ({
      repo: group.repo,
      pairs: [],
      unavailable: group.candidates.map((candidate) => candidate.number),
      fetch_error: String(error),
    }))
    .then((probe) => {
      probePending.delete(group.key);
      probeCache.set(group.key, probe);
      // This is a session cache, not history. Keep it bounded while preserving
      // the newest head sets a user is actually moving between.
      while (probeCache.size > 80) probeCache.delete(probeCache.keys().next().value!);
      return probe;
    });
  probePending.set(group.key, request);
  return request;
}

const LANE_TONE: Record<Lane, string> = {
  "needs-you": "is-urgent",
  blocked: "is-bad",
  waiting: "",
  ready: "is-ok",
  draft: "is-dim",
};

export function PrsPanel({ localRepos, onOpen, projectFor, page = false, onOpenAll, onQuickTask, relay, onNotice, onOpenChat }: PrsPanelProps) {
  const { rows, fetchedMs, errors, remaining, nextIn, busy, viewer } = usePrWatch();
  const [mineOnly, setMineOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<Lane>>(new Set());
  const [collapsedDashboard, setCollapsedDashboard] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [probeVersion, setProbeVersion] = useState(0);
  const [, setProvenanceVersion] = useState(0);
  const menu = useContextMenu();

  // This project's, always. There is no cross-project view and no toggle for
  // one: the panel answers "what needs me here", and a list that answers it for
  // somewhere else is noise you have to filter by eye every time you read it.
  const scoped = useMemo(
    () => rows.filter((r) => localRepos.includes(r.repo)),
    [rows, localRepos],
  );
  const shown = useMemo(() => {
    const mine = mineOnly ? scoped.filter((r) => r.mine) : scoped;
    const q = query.trim().toLowerCase();
    const matching = q
      ? mine.filter((r) => `${r.number} ${r.title} ${r.author} ${r.nwo}`.toLowerCase().includes(q))
      : mine;
    return page ? matching : matching.slice(0, PANEL_ROWS);
  }, [scoped, mineOnly, query, page]);
  const groups = useMemo(() => lanes(shown), [shown]);
  const dashboard = useMemo(() => dashboardGroups(shown), [shown]);
  const probeGroups = useMemo(() => (page ? mergeProbeGroups(shown) : []), [page, shown]);
  const probeFingerprint = probeGroups.map((group) => group.key).join("\n");
  const probeIndex = useMemo(
    () => indexProbes(
      probeGroups.flatMap((group) => {
        const probe = probeCache.get(group.key);
        return probe ? [{ repo: group.repo, probe }] : [];
      }),
    ),
    // probeVersion is the explicit completion pulse for the module cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [probeFingerprint, probeVersion],
  );
  const plan = useMemo(() => {
    const out = new Map<string, MergePlanStep>();
    for (const step of recommendMergeOrder(shown, probeIndex)) {
      out.set(`${step.row.repo}\0${step.row.number}`, step);
    }
    return out;
  }, [shown, probeIndex]);
  const totals = useMemo(() => statsFor(shown), [shown]);
  const errorList = Object.entries(errors);
  const hasActiveFilter = mineOnly || query.trim().length > 0;

  useEffect(() => {
    if (!page || !probeGroups.length) return;
    let live = true;
    void Promise.all(probeGroups.map(loadProbe)).then(() => {
      if (live) setProbeVersion((version) => version + 1);
    });
    return () => { live = false; };
  }, [page, probeGroups, probeFingerprint]);

  useEffect(() => {
    if (!page) return;
    const update = () => setProvenanceVersion((version) => version + 1);
    window.addEventListener(PROVENANCE_EVENT, update);
    for (const row of shown) {
      if (cachedProvenance(row.repo, row.number) === undefined) {
        void loadProvenance(row.repo, row.number);
      }
    }
    return () => window.removeEventListener(PROVENANCE_EVENT, update);
  }, [page, shown]);

  const open = (row: ipc.PrRow) => onOpen(row.repo, toPrInfo(row));

  const retarget = async (row: ipc.PrRow, parent: ipc.PrRow) => {
    if (!window.confirm(
      `Stack #${row.number} on #${parent.number}?\n\nThis changes its GitHub base to ${parent.branch}.`,
    )) return;
    try {
      const message = await ipcApi.ghPrRetarget(row.repo, row.number, parent.branch);
      onNotice?.(message, "success");
      refresh();
    } catch (error) {
      onNotice?.(String(error), "error");
    }
  };

  const openMenu = (e: React.MouseEvent, row: ipc.PrRow) => {
    const pr = toPrInfo(row);
    const peers = relay?.status.role === "off"
      ? []
      : (relay?.status.members ?? []).filter((m) => m.id !== relay?.status.self_id);
    const send = async (id: string, name: string) => {
      try {
        const remote = await import("../ipc").then((m) => m.gitRemoteUrl(row.repo));
        if (!remote) throw new Error("This repo has no shareable origin URL.");
        await relay?.sendCommand(id, "open-pr", { repo: remote, pr });
        const link = formatDeepLink({ kind: "pr", number: pr.number, url: pr.url, repo: remote });
        await relay?.sendChat(id, `PR review request\n${link}\n#${pr.number} ${pr.title}`);
        onOpenChat?.(id, name);
        onNotice?.(`Asked ${name} to review #${pr.number}.`, "success");
      } catch (err) {
        onNotice?.(String(err), "error");
      }
    };
    // Merging stays a human click, and GitHub's three methods are not one
    // button: the submenu is the choice, made per PR at the moment it lands.
    const mergePr = async (method: "squash" | "merge" | "rebase") => {
      try {
        const result = await import("../ipc").then((m) => m.ghPrMerge(row.repo, row.number, method));
        onNotice?.(result.message, result.pending ? "info" : "success");
        refresh();
      } catch (err) {
        onNotice?.(String(err), "error");
      }
    };
    const items: MenuItem[] = [
      { label: "Open pull request", onClick: () => open(row) },
      // What the row's state calls for, not a fixed list: conflicts offer
      // resolving, red checks offer fixing, comments offer addressing, an
      // unreviewed PR offers a review — each as an agent task.
      ...prContextActions(row).map((action) => ({
        label: action.label,
        hint: "agent task",
        disabled: !onQuickTask,
        onClick: () => onQuickTask?.(action.id, row.repo, pr),
      })),
      ...(prMergeReady(row)
        ? [
            {
              label: "Merge pull request",
              submenu: [
                { label: "Squash and merge", onClick: () => void mergePr("squash") },
                { label: "Create a merge commit", onClick: () => void mergePr("merge") },
                { label: "Rebase and merge", onClick: () => void mergePr("rebase") },
              ],
            },
          ]
        : []),
      peers.length > 0
        ? {
            label: "Send to",
            submenu: peers.map((m) => ({ label: m.name, onClick: () => void send(m.id, m.name) })),
          }
        : { label: "Send to", disabled: true, hint: "no Relay peers online" },
    ];
    menu.open(e, items);
  };

  return (
    <div className={`${page ? "collection-page" : ""} prs-panel`}>
      {menu.menu && <ContextMenu {...menu.menu} onClose={menu.close} />}
      <div className={page ? "collection-page-head" : "side-panel-head"}>
        {page ? <div><h1>Pull requests</h1><p>{totals.count} open · {totals.ready} ready · {totals.drafts} draft</p></div> : <span>Pull requests</span>}
        {page && (
          <TextInput search width="lg" aria-label="Search pull requests" placeholder="Search pull requests…" value={query} onChange={(e) => setQuery(e.target.value)} />
        )}
        <span className="prs-head-actions">
          {!page && <Button size="sm" variant="ghost" onClick={onOpenAll}>View all</Button>}
          <Button
            size="sm"
            variant={mineOnly ? "accent" : "default"}
            title={mineOnly ? "Show everyone's" : "Show only mine"}
            onClick={() => setMineOnly((v) => !v)}
          >
            mine
          </Button>
          <Button size="sm" title="Check now" disabled={busy} onClick={refresh}>
            ↻
          </Button>
        </span>
      </div>

      {/* Provenance, not news: a list that silently goes stale is worse than no
          list, but nobody needs to read this twice. It stays one dim line, and
          the numbers only a debugger wants live in its tooltip. */}
      <div
        className="prs-meta"
        title={[
          fetchedMs ? `Last checked ${new Date(fetchedMs).toLocaleString()}` : "",
          remaining > 0 ? `${remaining} GraphQL points left this hour` : "",
          viewer ? `Signed in as ${viewer}` : "",
        ]
          .filter(Boolean)
          .join("\n")}
      >
        checked {since(fetchedMs)}
        {nextIn > 0 && ` · next in ${nextIn < 120 ? `${nextIn}s` : `${Math.round(nextIn / 60)}m`}`}
      </div>

      {errorList.length > 0 && (
        <div className="prs-errors">
          {errorList.map(([repo, msg]) => (
            <div key={repo} className="prs-error" title={repo}>
              {basename(repo)}: {msg}
            </div>
          ))}
        </div>
      )}

      {shown.length === 0 && (
        <div className="prs-empty" role="status" aria-live="polite">
          {page && <span className="prs-empty-icon"><PullRequestIcon size={22} /></span>}
          <strong>
            {!fetchedMs
              ? "Checking for pull requests…"
              : hasActiveFilter
                ? "No matching pull requests"
                : "No open pull requests"}
          </strong>
          <span className="prs-empty-copy">
            {!fetchedMs
              ? "This usually takes just a moment."
              : hasActiveFilter
                ? "Try another search or clear the active filters."
                : "When someone opens one for this project, it will appear here."}
          </span>
          {fetchedMs && (
            <span className="prs-empty-actions">
              {hasActiveFilter && (
                <Button size="sm" variant="accent" onClick={() => { setQuery(""); setMineOnly(false); }}>
                  Clear filters
                </Button>
              )}
              <Button size="sm" disabled={busy} onClick={refresh}>Check again</Button>
            </span>
          )}
        </div>
      )}

      {page && shown.length > 0 && (
        <div className="prs-dashboard">
          <div className="prs-dashboard-summary" aria-label="Pull request totals">
            <span><strong>{totals.count}</strong> open</span>
            <span className="is-ready"><strong>{totals.ready}</strong> ready</span>
            <span><strong>{totals.drafts}</strong> drafts</span>
            <span className="is-size"><strong>+{totals.additions}</strong> −{totals.deletions} lines</span>
          </div>

          {dashboard.map((group) => {
            const isCollapsed = collapsedDashboard.has(group.id);
            return (
              <section className="prs-dashboard-group" key={group.id}>
                <button
                  className="prs-dashboard-group-head"
                  onClick={() => setCollapsedDashboard((current) => {
                    const next = new Set(current);
                    if (next.has(group.id)) next.delete(group.id);
                    else next.add(group.id);
                    return next;
                  })}
                  aria-expanded={!isCollapsed}
                >
                  <span className="prs-lane-chevron">{isCollapsed ? "▸" : "▾"}</span>
                  <span><strong>{group.label}</strong><small>{group.stats.count} PRs · {group.stats.ready} ready · +{group.stats.additions} −{group.stats.deletions}</small></span>
                </button>
                {!isCollapsed && (
                  <div className="prs-dashboard-rows">
                    {[...group.rows]
                      .sort((a, b) =>
                        (plan.get(`${a.repo}\0${a.number}`)?.position ?? 999) -
                          (plan.get(`${b.repo}\0${b.number}`)?.position ?? 999) ||
                        a.repo.localeCompare(b.repo) || a.number - b.number,
                      )
                      .map((row) => {
                        const step = plan.get(`${row.repo}\0${row.number}`);
                        const st = rowState(row);
                        const project = projectFor(row.repo);
                        const session = sessionLabel(cachedProvenance(row.repo, row.number));
                        const canRetarget = step?.stackAfter && row.base !== step.stackAfter.branch;
                        return (
                          <article
                            className={`prs-dashboard-row ${step?.conflictsWith.length ? "has-conflict" : ""}`}
                            key={`${row.repo}#${row.number}`}
                            onClick={() => open(row)}
                            onContextMenu={(event) => openMenu(event, row)}
                            title={`${row.nwo} #${row.number} — ${row.title}`}
                          >
                            <span className="prs-dashboard-order" title="Recommended landing order">
                              {step?.position ?? "–"}
                            </span>
                            <div className="prs-dashboard-main">
                              <div className="prs-dashboard-title">
                                <PullRequestIcon size={13} />
                                <span className="prs-row-num">#{row.number}</span>
                                <strong>{row.title}</strong>
                              </div>
                              <div className="prs-dashboard-meta">
                                <span>{project ?? row.nwo}</span>
                                <span>{row.author}</span>
                                <span>{openAge(row.created)}</span>
                                <span title="Authoring agent session">{session}</span>
                                <span>+{row.additions} −{row.deletions}</span>
                              </div>
                            </div>
                            <div className="prs-dashboard-signals">
                              <span className={`prs-dashboard-chip tone-${st.tone}`}>{st.text}</span>
                              <span className={`prs-dashboard-chip ${row.checks === "FAIL" ? "tone-bad" : row.checks === "PASS" ? "tone-ok" : "tone-dim"}`}>
                                {row.checks === "PASS" ? "checks pass" : row.checks === "FAIL" ? "checks failed" : row.checks === "PENDING" ? "checks running" : "checks unknown"}
                              </span>
                              {step?.conflictsWith.length ? (
                                <span className="prs-dashboard-chip tone-bad">repair after #{step.conflictsWith.join(", #")}</span>
                              ) : step?.evidence === "verified" ? (
                                <span className="prs-dashboard-chip tone-ok">sequence verified</span>
                              ) : step?.evidence === "unavailable" ? (
                                <span className="prs-dashboard-chip tone-dim">no pair needed</span>
                              ) : (
                                <span className="prs-dashboard-chip tone-dim">sequence partial</span>
                              )}
                            </div>
                            <div className="prs-dashboard-stack">
                              {step?.stackAfter && (
                                canRetarget ? (
                                  <Button
                                    size="sm"
                                    title={`Retarget to ${step.stackAfter.branch}`}
                                    onClick={(event) => { event.stopPropagation(); void retarget(row, step.stackAfter!); }}
                                  >
                                    Stack on #{step.stackAfter.number}
                                  </Button>
                                ) : (
                                  <span title={`Base: ${row.base}`}>stacked on #{step.stackAfter.number}</span>
                                )
                              )}
                            </div>
                          </article>
                        );
                      })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {!page && groups.map(({ lane, rows: laneRows }) => {
        const isCollapsed = collapsed.has(lane);
        return (
          <div key={lane} className={`prs-lane ${LANE_TONE[lane]}`}>
            <div
              className="prs-lane-head"
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(lane)) next.delete(lane);
                  else next.add(lane);
                  return next;
                })
              }
            >
              <span className="prs-lane-chevron">{isCollapsed ? "▸" : "▾"}</span>
              <span className="prs-lane-name">{LANE_LABEL[lane]}</span>
              <span className="prs-lane-count">{laneRows.length}</span>
            </div>
            {!isCollapsed &&
              laneRows.map((row) => {
                const st = rowState(row);
                const project = projectFor(row.repo);
                return (
                  <div
                    key={`${row.repo}#${row.number}`}
                    className="prs-row"
                    onClick={() => open(row)}
                    onContextMenu={(e) => openMenu(e, row)}
                    title={`${row.nwo} #${row.number} — ${row.title}`}
                  >
                    <PullRequestIcon size={12} />
                    <span className="prs-row-num">#{row.number}</span>
                    <span className="prs-row-title">{row.title}</span>
                    <span className={`prs-row-state tone-${st.tone}`}>{st.text}</span>
                    <div className="prs-row-sub">
                      <span>{project ?? row.nwo}</span>
                      <span>· {row.mine ? "yours" : row.author}</span>
                      {row.threads + row.comments > 0 && (
                        <span title="comments and review threads">
                          · {row.threads + row.comments} 💬
                        </span>
                      )}
                      <span className="prs-row-stat">
                        · +{row.additions} −{row.deletions}
                      </span>
                    </div>
                  </div>
                );
              })}
          </div>
        );
      })}

      {!page && scoped.length > PANEL_ROWS && (
        <button className="research-more" onClick={onOpenAll}>View all {scoped.length} pull requests</button>
      )}

    </div>
  );
}

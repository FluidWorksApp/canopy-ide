// The PR inbox: every open project's pull requests in one list, grouped by what
// they need rather than by which repo they came from — because "what needs me"
// is the question you open this for, and it doesn't respect project boundaries.
//
// It fetches nothing. Rows arrive from the shared watcher (prWatchStore), which
// is driven by one poller in Rust; this component only renders and dispatches.
// Clicking a row opens the PR's own tab — in this project directly, or by asking
// App to switch projects first.
import { useMemo, useState } from "react";
import type * as ipc from "../ipc";
import { LANE_LABEL, lanes, rowState, since, toPrInfo, type Lane } from "../prInbox";
import { refresh } from "../prWatchStore";
import { usePrWatch } from "../usePrWatch";
import { PullRequestIcon } from "./icons";

interface PrsPanelProps {
  /** Repo paths belonging to the project in front, so a row can be opened here
   *  rather than by routing through App. */
  localRepos: string[];
  /** Open a PR that lives in this project. */
  onOpen: (repo: string, pr: ipc.PrInfo) => void;
  /** Open a PR that belongs to another project — App switches, then opens. */
  onOpenElsewhere: (repo: string, pr: ipc.PrInfo) => void;
  /** Project names by repo path, for the row's second line. */
  projectFor: (repo: string) => string | undefined;
}

const LANE_TONE: Record<Lane, string> = {
  "needs-you": "is-urgent",
  blocked: "is-bad",
  waiting: "",
  ready: "is-ok",
  draft: "is-dim",
};

export function PrsPanel({ localRepos, onOpen, onOpenElsewhere, projectFor }: PrsPanelProps) {
  const { rows, fetchedMs, errors, remaining, nextIn, busy, viewer } = usePrWatch();
  const [mineOnly, setMineOnly] = useState(false);
  // Centralized polling, project-level surfacing. One loop asks about every
  // open project (switching projects is then instant and costs nothing), but
  // what you SEE is the project you are in: a single list mixing eight repos is
  // a stream to scroll, not a queue to work. "All" is a deliberate choice, not
  // the default you land in.
  const [allProjects, setAllProjects] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<Lane>>(new Set());

  const mine = useMemo(
    () => rows.filter((r) => localRepos.includes(r.repo)),
    [rows, localRepos],
  );
  const elsewhere = rows.length - mine.length;
  const scoped = allProjects ? rows : mine;
  const shown = useMemo(
    () => (mineOnly ? scoped.filter((r) => r.mine) : scoped),
    [scoped, mineOnly],
  );
  const groups = useMemo(() => lanes(shown), [shown]);
  const errorList = Object.entries(errors);

  const open = (row: ipc.PrRow) => {
    const pr = toPrInfo(row);
    if (localRepos.includes(row.repo)) onOpen(row.repo, pr);
    else onOpenElsewhere(row.repo, pr);
  };

  return (
    <div className="prs-panel">
      <div className="side-panel-head">
        <span>Pull requests</span>
        <span className="prs-head-actions">
          <button
            className={`btn-mini ${allProjects ? "btn-accent" : ""}`}
            title={
              allProjects
                ? "Show only this project's pull requests"
                : "Show every open project's pull requests"
            }
            onClick={() => setAllProjects((v) => !v)}
          >
            {allProjects ? "all projects" : "this project"}
          </button>
          <button
            className={`btn-mini ${mineOnly ? "btn-accent" : ""}`}
            title={mineOnly ? "Show everyone's" : "Show only mine"}
            onClick={() => setMineOnly((v) => !v)}
          >
            mine
          </button>
          <button className="btn-mini" title="Check now" disabled={busy} onClick={refresh}>
            ↻
          </button>
        </span>
      </div>

      {/* One line of provenance: when this was last true, and what the next
          check costs. A list that silently goes stale is worse than no list. */}
      <div className="prs-meta">
        <span title={fetchedMs ? new Date(fetchedMs).toLocaleString() : undefined}>
          checked {since(fetchedMs)}
        </span>
        {nextIn > 0 && <span>· next in {nextIn < 120 ? `${nextIn}s` : `${Math.round(nextIn / 60)}m`}</span>}
        {remaining > 0 && <span title="GraphQL points left this hour">· {remaining} left</span>}
        {viewer && <span>· as {viewer}</span>}
      </div>

      {errorList.length > 0 && (
        <div className="prs-errors">
          {errorList.map(([repo, msg]) => (
            <div key={repo} className="prs-error" title={repo}>
              {repo.split("/").pop()}: {msg}
            </div>
          ))}
        </div>
      )}

      {shown.length === 0 && (
        <div className="prs-empty">
          {!fetchedMs
            ? "Looking for pull requests…"
            : allProjects
              ? "No open pull requests in the projects you have open."
              : "No open pull requests in this project."}
        </div>
      )}

      {groups.map(({ lane, rows: laneRows }) => {
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
              <span>{LANE_LABEL[lane]}</span>
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

      {/* Cross-project urgency is worth knowing about; it just isn't worth
          living in this list. One line, and you opt in. */}
      {!allProjects && elsewhere > 0 && (
        <div className="prs-elsewhere" onClick={() => setAllProjects(true)}>
          {elsewhere} more in other projects — show all
        </div>
      )}
    </div>
  );
}
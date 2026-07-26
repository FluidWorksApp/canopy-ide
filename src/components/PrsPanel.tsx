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
  /** This project's repos. The panel shows these and nothing else — a PR queue
   *  that spans projects is a stream to scroll, not a queue to work. */
  localRepos: string[];
  onOpen: (repo: string, pr: ipc.PrInfo) => void;
  /** Repo path → the label to show on the row's second line. */
  projectFor: (repo: string) => string | undefined;
}

const LANE_TONE: Record<Lane, string> = {
  "needs-you": "is-urgent",
  blocked: "is-bad",
  waiting: "",
  ready: "is-ok",
  draft: "is-dim",
};

export function PrsPanel({ localRepos, onOpen, projectFor }: PrsPanelProps) {
  const { rows, fetchedMs, errors, remaining, nextIn, busy, viewer } = usePrWatch();
  const [mineOnly, setMineOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<Lane>>(new Set());

  // This project's, always. There is no cross-project view and no toggle for
  // one: the panel answers "what needs me here", and a list that answers it for
  // somewhere else is noise you have to filter by eye every time you read it.
  const scoped = useMemo(
    () => rows.filter((r) => localRepos.includes(r.repo)),
    [rows, localRepos],
  );
  const shown = useMemo(
    () => (mineOnly ? scoped.filter((r) => r.mine) : scoped),
    [scoped, mineOnly],
  );
  const groups = useMemo(() => lanes(shown), [shown]);
  const errorList = Object.entries(errors);

  const open = (row: ipc.PrRow) => onOpen(row.repo, toPrInfo(row));

  return (
    <div className="prs-panel">
      <div className="side-panel-head">
        <span>Pull requests</span>
        <span className="prs-head-actions">
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
              {repo.split("/").pop()}: {msg}
            </div>
          ))}
        </div>
      )}

      {shown.length === 0 && (
        <div className="prs-empty">
          {fetchedMs ? "No open pull requests in this project." : "Looking for pull requests…"}
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

    </div>
  );
}
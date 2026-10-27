// The subagents a session spawned, under that session: what each was asked
// to do, whether it is still running, finished or failed, how long it took,
// and the first lines of what it reported back. Live — sessionActivity.ts
// polls the session's transcript fast while anything is running.
//
// Shown in the agent's tab (full) and on the Agents page and side panel
// (compact: a one-line count that opens into the same list).
import { useEffect, useState } from "react";
import type * as ipc from "../ipc";
import { fmtTokens } from "../format";
import { subagentCounts, subagentSpan, fmtSpan, useSessionActivity, type ActivityKey } from "../sessionActivity";
import "./subagents.css";

const STATUS_LABEL: Record<ipc.SubagentRun["status"], string> = {
  running: "running",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [live]);
  return now;
}

export function SubagentList({ subagents }: { subagents: readonly ipc.SubagentRun[] }) {
  const running = subagents.some((s) => s.status === "running");
  const now = useNow(running);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ol className="sa-list" aria-label="Subagents">
      {subagents.map((s) => {
        const span = subagentSpan(s, now);
        const expanded = open === s.id;
        return (
          <li key={s.id} className={`sa-item is-${s.status}`}>
            <span className="sa-branch" aria-hidden>
              └
            </span>
            <div className="sa-body">
              <div className="sa-head">
                <span className={`sa-status is-${s.status}`}>{STATUS_LABEL[s.status]}</span>
                <span className="sa-desc" title={s.description}>
                  {s.description || "(no description)"}
                </span>
                {s.kind && s.kind !== "general-purpose" && <span className="sa-kind">{s.kind}</span>}
                {s.background && <span className="sa-kind" title="Ran in the background while the session kept working">background</span>}
                <span className="sa-spacer" />
                {span != null && <span className="sa-meta">{fmtSpan(span)}</span>}
                {s.tokens != null && <span className="sa-meta">{fmtTokens(s.tokens)} tokens</span>}
                {s.tool_uses != null && (
                  <span className="sa-meta">
                    {s.tool_uses} tool call{s.tool_uses === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              {s.result && (
                <button
                  type="button"
                  className={`sa-result ${expanded ? "is-open" : ""}`}
                  aria-expanded={expanded}
                  title={expanded ? "Show less" : "Show the whole summary"}
                  onClick={() => setOpen(expanded ? null : s.id)}
                >
                  {s.result}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The tree for one session. Renders nothing for a CLI whose transcript
 *  records no subagents, or a session that spawned none. */
export function SubagentTree({
  activityKey,
  live,
  compact,
}: {
  activityKey: ActivityKey | null;
  /** The session is mid-turn: poll fast. */
  live?: boolean;
  /** One summary line that opens into the list (Agents page, side panel). */
  compact?: boolean;
}) {
  const activity = useSessionActivity(activityKey, { fast: live });
  const [open, setOpen] = useState(false);
  const list = activity?.subagents ?? [];
  if (!list.length) return null;
  const counts = subagentCounts(list);
  if (compact) {
    return (
      <div className="sa-tree is-compact" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="sa-toggle"
          aria-expanded={open}
          title={open ? "Hide subagents" : "Show the subagents this session spawned"}
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden>⑃</span> {list.length} subagent{list.length === 1 ? "" : "s"} · {counts}
        </button>
        {open && <SubagentList subagents={list} />}
      </div>
    );
  }
  return (
    <section className="sa-tree" aria-label="Subagents">
      <div className="ticket-state-head">
        Subagents <span className="badge">{list.length}</span>
        <span className="sa-counts">{counts}</span>
      </div>
      <SubagentList subagents={list} />
    </section>
  );
}

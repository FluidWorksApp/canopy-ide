// An issue opened as a tab: the ticket read natively instead of bouncing to
// a browser. Header (id, title, status, priority, assignee) over the
// markdown description, with the start-work actions pinned to the bottom —
// the two things you do with a ticket you're reading are understand it and
// hand it to an agent.
import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import { openUrl } from "@tauri-apps/plugin-opener";
import type * as ipc from "../ipc";
import { TRACKERS } from "../trackers";
import type { AgentTarget } from "./TicketsPanel";

interface TicketViewProps {
  ticket: ipc.TicketInfo;
  /** Which tracker it came from (registry id). */
  source: string;
  /** The worktree already holding this ticket's work, if any. */
  worktree: ipc.WorktreeInfo | undefined;
  /** Agent terminals open in this project — "same terminal" targets. */
  agentTargets: AgentTarget[];
  onStartNew: () => void;
  onSendToAgent: (target: AgentTarget) => void;
}

export function TicketView({
  ticket,
  source,
  worktree,
  agentTargets,
  onStartNew,
  onSendToAgent,
}: TicketViewProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const trackerName = TRACKERS.find((t) => t.id === source)?.name ?? source;

  const html = useMemo(
    () =>
      ticket.body.trim()
        ? marked.parse(ticket.body, { async: false })
        : "<p class='ticket-view-empty'>No description.</p>",
    [ticket.body],
  );

  // Links inside the description belong in the browser, not in this webview
  // (which has nowhere to navigate back from).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a");
      const href = a?.getAttribute("href");
      if (!href?.startsWith("http")) return;
      e.preventDefault();
      void openUrl(href);
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, []);

  return (
    <div className="ticket-view">
      <div className="ticket-view-head">
        <div className="ticket-view-title">
          <span className="ticket-view-id">{ticket.id}</span>
          <span>{ticket.title}</span>
        </div>
        <div className="ticket-view-meta">
          <span className="ticket-view-state">{ticket.state}</span>
          {ticket.priority && <span className="ticket-view-chip">{ticket.priority}</span>}
          <span className={ticket.mine ? "ticket-mine" : ""}>
            {ticket.mine ? "you" : (ticket.assignee ?? "Unassigned")}
          </span>
          {worktree && (
            <span className="ticket-wt" title={worktree.path}>
              ⑂ {worktree.branch}
              {worktree.dirty > 0 ? ` ±${worktree.dirty}` : ""}
            </span>
          )}
          <span className="status-spacer" />
          <button className="btn" onClick={() => void openUrl(ticket.url)}>
            Open in {trackerName}
          </button>
        </div>
      </div>

      <div
        className="ticket-view-body markdown-body"
        ref={bodyRef}
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <div className="ticket-view-actions">
        <button className="btn btn-accent" onClick={onStartNew}>
          ▶ Start work — {worktree ? "new terminal here" : "new worktree"}
        </button>
        {agentTargets.map((t) => (
          <button key={t.tabId} className="btn" onClick={() => onSendToAgent(t)}>
            Send to {t.title}
          </button>
        ))}
        <span className="ticket-view-note">
          Starts an agent in a terminal you can watch. No commit, no PR — that
          stays yours to do.
        </span>
      </div>
    </div>
  );
}

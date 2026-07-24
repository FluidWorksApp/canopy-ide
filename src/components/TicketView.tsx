// An issue opened as a tab: the ticket read natively instead of bouncing to
// a browser. Header (id, title, status, priority, assignee) over the
// markdown description, with the start-work actions pinned to the bottom —
// the two things you do with a ticket you're reading are understand it and
// hand it to an agent.
import { useMemo } from "react";
import { renderMarkdown } from "../markdown";
import { openUrl } from "@tauri-apps/plugin-opener";
import type * as ipc from "../ipc";
import { TRACKERS } from "../trackers";
import { AgentLaunchButton } from "./AgentLaunchButton";
import { TrackerIcon } from "./icons";
import type { AgentTarget } from "./TicketsPanel";

interface TicketViewProps {
  ticket: ipc.TicketInfo;
  /** Which tracker it came from (registry id). */
  source: string;
  /** The worktree already holding this ticket's work, if any. */
  worktree: ipc.WorktreeInfo | undefined;
  /** Agent terminals open in this project — the "send it there" targets. */
  agentTargets: AgentTarget[];
  /** Which agent CLIs are on PATH. */
  installed: Record<string, boolean>;
  /** Start a fresh agent on this ticket in its worktree. */
  onStartNew: (agentId: string) => void;
  onSendToAgent: (target: AgentTarget) => void;
}

export function TicketView({
  ticket,
  source,
  worktree,
  agentTargets,
  installed,
  onStartNew,
  onSendToAgent,
}: TicketViewProps) {
  const trackerName = TRACKERS.find((t) => t.id === source)?.name ?? source;

  const html = useMemo(
    () =>
      ticket.body.trim()
        ? renderMarkdown(ticket.body)
        : "<p class='ticket-view-empty'>No description.</p>",
    [ticket.body],
  );

  // Link clicks are delegated globally (main.tsx), so every surface —
  // issue bodies, commit messages, PR text — behaves identically.

  return (
    <div className="ticket-view">
      <div className="ticket-view-head">
        <div className="ticket-view-title">
          <TrackerIcon id={source} size={15} className="ticket-view-mark" />
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
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <div className="ticket-view-actions">
        {/* One control: the primary action is the obvious thing (your default
            agent, in this ticket's worktree); the caret is where every other
            choice lives — running agents to hand it to, or a different CLI. */}
        <AgentLaunchButton
          label="Start work"
          agentTargets={agentTargets}
          installed={installed}
          newAgentLabel={worktree ? `New agent in ${worktree.branch}` : "New agent in a new worktree"}
          primaryTitle={(cli) =>
            `Start ${cli} (your default) on this ticket${
              worktree ? ` in ${worktree.branch}` : " in a new worktree"
            }`
          }
          onStart={onStartNew}
          onSend={onSendToAgent}
        />
        <span className="ticket-view-note">
          Starts in a terminal you can watch. No commit, no PR — that stays
          yours to do.
        </span>
      </div>
    </div>
  );
}

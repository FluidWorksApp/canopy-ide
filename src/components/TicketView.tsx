// An issue opened as a tab: the ticket read natively instead of bouncing to
// a browser. Header (id, title, status, priority, assignee) over the
// markdown description, with the start-work actions pinned to the bottom —
// the two things you do with a ticket you're reading are understand it and
// hand it to an agent.
import { useMemo, useState } from "react";
import { marked } from "marked";
import { openUrl } from "@tauri-apps/plugin-opener";
import type * as ipc from "../ipc";
import { TRACKERS } from "../trackers";
import { AGENT_CLIS } from "../projects";
import { getSettings } from "../settings";
import { agentMenuItems } from "../agentMenu";
import { ContextMenu, useContextMenu } from "./ContextMenu";
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
  const menu = useContextMenu();
  const [, force] = useState(0);
  // The agent the button will actually start: the preference IF it is
  // installed, else the first CLI that is. Falling back to the registry's
  // first entry meant offering to start Claude on machines where it isn't
  // installed — a button that can only fail, and an implicit endorsement.
  const preferred = getSettings().defaultAgent;
  const installedClis = AGENT_CLIS.filter((c) => installed[c.bin]);
  const preferredCli =
    installedClis.find((c) => c.id === preferred) ?? installedClis[0] ?? AGENT_CLIS[0];
  const trackerName = TRACKERS.find((t) => t.id === source)?.name ?? source;

  const html = useMemo(
    () =>
      ticket.body.trim()
        ? marked.parse(ticket.body, { async: false })
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
        {menu.menu && (
          <ContextMenu
            x={menu.menu.x}
            y={menu.menu.y}
            items={menu.menu.items}
            onClose={menu.close}
          />
        )}
        {/* One control: the primary action is the obvious thing (your default
            agent, in this ticket's worktree); the caret is where every other
            choice lives — running agents to hand it to, or a different CLI. */}
        <span className="split-btn">
          <button
            className="btn btn-accent split-btn-main"
            onClick={() => onStartNew(preferredCli.id)}
            // The agent is named in the tooltip and the caret menu, not in
            // the label: the button is "start work", not an endorsement of
            // one CLI.
            title={`Start ${preferredCli.name} (your default) on this ticket${
              worktree ? ` in ${worktree.branch}` : " in a new worktree"
            }`}
          >
            ▶ Start work
            <span className="split-btn-agent">{preferredCli.name}</span>
          </button>
          <button
            className="btn btn-accent split-btn-caret"
            title="Send to a running agent, or start a different one"
            onClick={(e) => {
              force((n) => n + 1);
              menu.open(
                e,
                agentMenuItems({
                  targets: agentTargets,
                  installed,
                  newLabel: worktree
                    ? `New agent in ${worktree.branch}`
                    : "New agent in a new worktree",
                  onSend: onSendToAgent,
                  onStart: onStartNew,
                }),
              );
            }}
          >
            ▾
          </button>
        </span>
        <span className="ticket-view-note">
          Starts in a terminal you can watch. No commit, no PR — that stays
          yours to do.
        </span>
      </div>
    </div>
  );
}

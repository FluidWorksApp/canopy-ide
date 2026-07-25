// A free-text "ask the agent about this" box paired with the shared
// AgentLaunchButton, so every diff surface (session changes, a working-tree
// file diff, a relay review) can hand its changes to an agent the same way the
// PR and ticket tabs already do. Typing a question is optional: with text it's
// a query, empty it's a plain "review this" handoff — the caller's context
// builder decides what each means.
import { useState } from "react";
import { AgentLaunchButton } from "./AgentLaunchButton";
import type { AgentTarget } from "./TicketsPanel";

interface AgentQueryBarProps {
  /** Agent terminals open in this project — the "send it there" targets. */
  agentTargets: AgentTarget[];
  /** Which agent CLIs are on PATH. */
  installed: Record<string, boolean>;
  /** Label for the new-agent menu row, e.g. "New agent in this project". */
  newAgentLabel: string;
  /** The verb on the dropdown button. */
  label?: string;
  /** Placeholder for the query input. */
  placeholder?: string;
  /** Hand the (trimmed) typed query to a running agent. */
  onSend: (target: AgentTarget, query: string) => void;
  /** Start a fresh agent (the given CLI) with the typed query. */
  onStart: (agentId: string, query: string) => void;
  /** Run it as a one-shot task instead: an agent that does this one job,
   *  reports the outcome and closes itself. The primary action where it's
   *  offered — handing work to a long-lived session stays available beside it,
   *  for work that isn't one-shot. */
  onRunTask?: (query: string) => void;
}

export function AgentQueryBar({
  agentTargets,
  installed,
  newAgentLabel,
  label = "Send to agent",
  placeholder = "Ask an agent about these changes…",
  onSend,
  onStart,
  onRunTask,
}: AgentQueryBarProps) {
  const [query, setQuery] = useState("");
  const take = () => {
    const q = query.trim();
    setQuery("");
    return q;
  };
  return (
    <div className="agent-query-bar">
      <input
        className="agent-query-input"
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onRunTask) onRunTask(take());
        }}
      />
      {onRunTask && (
        <button
          className="btn btn-accent"
          title="Run this as a one-shot task: an agent does it, reports back, and closes itself"
          onClick={() => onRunTask(take())}
        >
          ◆ Run task
        </button>
      )}
      <AgentLaunchButton
        variant="mini"
        label={label}
        agentTargets={agentTargets}
        installed={installed}
        newAgentLabel={newAgentLabel}
        onStart={(id) => onStart(id, take())}
        onSend={(t) => onSend(t, take())}
      />
    </div>
  );
}

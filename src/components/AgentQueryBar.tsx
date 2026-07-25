// A free-text "ask the agent about this" box that runs what you type as a
// one-shot task, so every diff surface (session changes, a working-tree file
// diff, a relay review) hands its changes over the same way. Typing a question
// is optional: with text it's a query, empty it's a plain "review this" handoff
// — the caller's context builder decides what each means.
import { useState } from "react";

interface AgentQueryBarProps {
  /** Placeholder for the query input. */
  placeholder?: string;
  /** Run it as a one-shot task: an agent that does this one job, reports the
   *  outcome and closes itself. */
  onRunTask: (query: string) => void;
}

export function AgentQueryBar({
  placeholder = "Ask an agent about these changes…",
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
          if (e.key === "Enter") onRunTask(take());
        }}
      />
      <button
        className="btn btn-accent"
        title="Run this as a one-shot task: an agent does it, reports back, and closes itself"
        onClick={() => onRunTask(take())}
      >
        ◆ Run task
      </button>
    </div>
  );
}

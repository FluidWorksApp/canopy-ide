// A free-text "ask the agent about this" box that runs what you type as a
// one-shot task, so every diff surface (session changes, a working-tree file
// diff, a relay review) hands its changes over the same way. Typing a question
// is optional: with text it's a query, empty it's a plain "review this" handoff
// — the caller's context builder decides what each means.
import { useState } from "react";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { ChevronIcon } from "./icons";

interface AgentQueryBarProps {
  /** Placeholder for the query input. */
  placeholder?: string;
  /** Run it as a one-shot task: an agent that does this one job, reports the
   *  outcome and closes itself. */
  onRunTask: (query: string) => void;
  /** The tasks that already exist — the ones you saved and the ones Canopy
   *  ships. Built by the caller (ProjectView owns the launcher, see
   *  taskMenu.ts), so this stays a presentation component. Left off when there
   *  is nothing to list, and then there is no caret either: a dropdown that
   *  opens onto nothing is worse than a plain button. */
  tasks?: () => MenuItem[];
}

export function AgentQueryBar({
  placeholder = "Ask an agent about these changes…",
  onRunTask,
  tasks,
}: AgentQueryBarProps) {
  const [query, setQuery] = useState("");
  const menu = useContextMenu();
  const take = () => {
    const q = query.trim();
    setQuery("");
    return q;
  };
  return (
    <div className="agent-query-bar">
      {menu.menu && (
        <ContextMenu
          x={menu.menu.x}
          y={menu.menu.y}
          items={menu.menu.items}
          onClose={menu.close}
        />
      )}
      <input
        className="agent-query-input"
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onRunTask(take());
        }}
      />
      {/* Typing a brief was the only way in, so the tasks you had already
          written were invisible from the one place you were looking at the
          work they were written for. The box still runs what you type; the
          caret lists what exists. */}
      <div className="agent-query-run">
        <button
          className="btn btn-accent"
          title="Run this as a one-shot task: an agent does it, reports back, and closes itself"
          onClick={() => onRunTask(take())}
        >
          ◆ Run task
        </button>
        {tasks && (
          <button
            className="btn btn-accent agent-query-more"
            title="Run a task you've already written, or one Canopy ships"
            onClick={(e) => menu.openUnder(e, tasks())}
          >
            <ChevronIcon size={13} className="chevron-down" />
          </button>
        )}
      </div>
    </div>
  );
}

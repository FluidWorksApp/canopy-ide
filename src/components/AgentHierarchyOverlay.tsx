// A small overlay over the terminal listing the agent hierarchy: the parent,
// this agent, the agents it delegated to, and the CLI's own transcript
// subagents (read only). Clicking an agent switches to its tab; a child offers
// "Back to parent". Pin keeps the list open. The CLI is untouched.
import { useState } from "react";
import { buildAgentHierarchy, flattenAgents, treeForTab, type AgentNode } from "../agentHierarchy";
import { useSessionActivity, type ActivityKey } from "../sessionActivity";
import type { TermSubTab } from "./ProjectView/helpers";
import { SubagentList } from "./SubagentTree";
import "./subagents.css";

export function AgentHierarchyOverlay({
  tabs,
  activeTabId,
  onSelect,
  activityKey = null,
}: {
  tabs: readonly TermSubTab[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
  activityKey?: ActivityKey | null;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const activity = useSessionActivity(activityKey);
  const transcript = activity?.subagents ?? [];
  const tree = treeForTab(buildAgentHierarchy(tabs), activeTabId);
  const nodes = tree ? flattenAgents([tree]) : [];
  if (nodes.length < 2 && !transcript.length) return null;
  const active = nodes.find((n) => n.tabId === activeTabId);
  const parent = active?.parentTabId ? nodes.find((n) => n.tabId === active.parentTabId) : undefined;
  const expanded = open || pinned;
  const count = nodes.length + transcript.length;

  const row = (n: AgentNode) => (
    <li key={n.tabId}>
      <button
        type="button"
        className={`ah-row ${n.tabId === activeTabId ? "is-active" : ""} ${n.exited ? "is-exited" : ""}`}
        style={{ paddingLeft: 6 + n.depth * 12 }}
        aria-current={n.tabId === activeTabId ? "true" : undefined}
        aria-label={`Switch to ${n.title}${n.exited ? " (exited)" : ""}`}
        onClick={() => onSelect(n.tabId)}
      >
        <span className="ah-branch" aria-hidden>{n.depth ? "└" : "●"}</span>
        <span className="ah-title">{n.title}</span>
        <span className="ah-state">{n.exited ? "exited" : "running"}</span>
      </button>
    </li>
  );

  return (
    <div className="ah-overlay" role="region" aria-label="Agent hierarchy">
      <div className="ah-bar">
        <button
          type="button"
          className="ah-pill"
          aria-expanded={expanded}
          title={expanded ? "Hide the agent hierarchy" : "Show the agent hierarchy"}
          onClick={() => setOpen((v) => !v)}
        >
          {count} agent{count === 1 ? "" : "s"}
        </button>
        <button
          type="button"
          className={`ah-pin ${pinned ? "is-pinned" : ""}`}
          aria-pressed={pinned}
          title={pinned ? "Unpin the hierarchy" : "Pin the hierarchy open"}
          onClick={() => setPinned((v) => !v)}
        >
          {pinned ? "Unpin" : "Pin"}
        </button>
      </div>
      {expanded && (
        <div className="ah-panel">
          {parent && (
            <button type="button" className="ah-back" onClick={() => onSelect(parent.tabId)}>
              ← Back to parent: {parent.title}
            </button>
          )}
          {nodes.length > 1 && <ul className="ah-list" aria-label="Agents">{nodes.map(row)}</ul>}
          {transcript.length > 0 && <SubagentList subagents={transcript} />}
        </div>
      )}
    </div>
  );
}

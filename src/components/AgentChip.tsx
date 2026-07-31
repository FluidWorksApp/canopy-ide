// Who is working in a folder, on one row.
//
// Servers says it on a workspace's run line and Git says it on the branch —
// the same question in two panels, so it is one component rather than two
// copies that drift. It names the CLI (never a count on its own): a row that
// says "2 agents" cannot be the thing you click to go and read them.
import { principalAgent, type AgentRef } from "../workspaces";

/** What an agent's lifecycle state means, in the row's own words. */
const AGENT_STATE: Record<AgentRef["state"], string> = {
  working: "working now",
  waiting: "waiting on you",
  idle: "idle",
  ended: "finished",
  unknown: "here",
};

export function AgentChip({
  agents,
  onOpen,
}: {
  agents: AgentRef[];
  /** Bring that agent's terminal to the front. Omitted where the surface has
   *  no way to focus one, and then the chip is just a label. */
  onOpen?: (ptyId: number) => void;
}) {
  const lead = principalAgent(agents);
  if (!lead) return null;
  const clickable = onOpen != null && lead.ptyId != null;
  return (
    <span
      className={`ws-run-agent ws-run-agent-${lead.state}`}
      title={
        `${lead.name} — ${AGENT_STATE[lead.state]}` +
        (agents.length > 1
          ? `\n+${agents.length - 1} more here: ${agents
              .slice(1)
              .map((a) => a.name)
              .join(", ")}`
          : "") +
        (clickable ? "\nClick to open its terminal" : "")
      }
      onClick={(ev) => {
        if (!clickable) return;
        ev.stopPropagation();
        onOpen(lead.ptyId!);
      }}
    >
      <span className="ws-run-agent-dot" />
      {lead.name}
      {agents.length > 1 && `+${agents.length - 1}`}
    </span>
  );
}

// The one "hand this to an agent" control, shared by every surface that starts
// one: the ticket tab's "▶ Start work" split-button and the PR header's
// "Review ▾" dropdown. It owns the two things those surfaces used to each
// re-implement — resolving which CLI the primary action starts, and opening the
// agent menu (running agents to send to, or a fresh CLI in a worktree) — so a
// new caller is a `<AgentLaunchButton>` with a label and two handlers, nothing
// more.
import { useState } from "react";
import { AGENT_CLIS } from "../projects";
import { getSettings } from "../settings";
import { agentMenuItems } from "../agentMenu";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { AgentsIcon } from "./icons";
import type { AgentTarget } from "./TicketsPanel";

interface AgentLaunchButtonProps {
  /** The verb on the button, e.g. "Start work" or "Review". */
  label: string;
  /** Agent terminals open in this project — the "send it there" targets. */
  agentTargets: AgentTarget[];
  /** Which agent CLIs are on PATH. */
  installed: Record<string, boolean>;
  /** Label for the new-agent menu row, e.g. "New agent in feat/x". */
  newAgentLabel: string;
  /** Tooltip for the primary action, given the resolved CLI's name. */
  primaryTitle?: (cliName: string) => string;
  /** Start a fresh agent (the given CLI) on this item, in its worktree. */
  onStart: (agentId: string) => void;
  /** Hand it to an already-running agent instead. */
  onSend: (target: AgentTarget) => void;
  /** "split" — the accent primary + caret used in a footer (ticket tab).
   *  "mini" — a single btn-mini dropdown that sits in a header row of small
   *  buttons (PR header), next to Merge ▾ / Request review ▾. */
  variant?: "split" | "mini";
}

export function AgentLaunchButton({
  label,
  agentTargets,
  installed,
  newAgentLabel,
  primaryTitle,
  onStart,
  onSend,
  variant = "split",
}: AgentLaunchButtonProps) {
  const menu = useContextMenu();
  const [, force] = useState(0);
  // The CLI the primary action starts: the default IF it is installed here,
  // else the first that is. Falling through to the registry's first entry only
  // when nothing is detected keeps the button from silently endorsing one
  // vendor on a machine where it isn't even present.
  const installedClis = AGENT_CLIS.filter((c) => installed[c.bin]);
  const preferredCli =
    installedClis.find((c) => c.id === getSettings().defaultAgent) ??
    installedClis[0] ??
    AGENT_CLIS[0];

  const openMenu = (e: React.MouseEvent) => {
    // ContextMenu items are built once at open; bump a counter so a change in
    // targets/installed since last open is reflected.
    force((n) => n + 1);
    menu.open(
      e,
      agentMenuItems({ targets: agentTargets, installed, newLabel: newAgentLabel, onSend, onStart }),
    );
  };

  return (
    <>
      {menu.menu && (
        <ContextMenu x={menu.menu.x} y={menu.menu.y} items={menu.menu.items} onClose={menu.close} />
      )}
      {variant === "mini" ? (
        <div className="cli-menu-anchor">
          <button
            className="btn-mini"
            title={`Hand this to an agent — a running one, or a fresh ${preferredCli.name} in a worktree`}
            onClick={openMenu}
          >
            <AgentsIcon size={11} /> {label} ▾
          </button>
        </div>
      ) : (
        <span className="split-btn">
          <button
            className="btn btn-accent split-btn-main"
            // The agent is named in the tooltip and the caret menu, not the
            // label: the button is the verb, not an endorsement of one CLI.
            onClick={() => onStart(preferredCli.id)}
            title={primaryTitle?.(preferredCli.name)}
          >
            ▶ {label}
            <span className="split-btn-agent">{preferredCli.name}</span>
          </button>
          <button
            className="btn btn-accent split-btn-caret"
            title="Send to a running agent, or start a different one"
            onClick={openMenu}
          >
            ▾
          </button>
        </span>
      )}
    </>
  );
}

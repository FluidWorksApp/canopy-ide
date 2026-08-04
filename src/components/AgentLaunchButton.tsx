// The one "hand this to an agent" control, shared by every surface that starts
// one: the ticket tab's "▶ Start work" split-button and the PR header's
// "Review ▾" dropdown. It owns the agent menu (running agents to send to, or a
// fresh CLI in a worktree) and either an agent or task primary action.
import { useState } from "react";
import { AGENT_CLIS } from "../projects";
import { getSettings } from "../settings";
import { agentMenuItems } from "../agentMenu";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { AgentsIcon, TasksIcon } from "./icons";
import type { AgentTarget } from "./TicketsPanel";
import { Button } from "./ui";

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
  /** When this surface came from an agent, send back there on the primary click
   *  instead of starting a new agent. The caret still offers every target. */
  primaryTarget?: AgentTarget;
  /** A non-session primary action. Ticket work defaults to a one-shot Task;
   *  the caret still contains every running/new-agent destination. */
  primaryTask?: { title: string; onRun: () => void };
  /** "split" — the accent primary + caret used in a footer (ticket tab).
   *  "mini" — a single btn-mini dropdown that sits in a header row of small
   *  buttons (PR header), next to Merge ▾ / Request review ▾. */
  variant?: "split" | "mini";
  /** Destinations that are not an agent, appended below the agent rows behind
   *  a divider — the preview's "run it as a one-off task". Kept as extra rows
   *  on this control rather than a second button beside it: the question is
   *  who should look at this, and one question wants one control. */
  extras?: MenuItem[];
}

export function AgentLaunchButton({
  label,
  agentTargets,
  installed,
  newAgentLabel,
  primaryTitle,
  onStart,
  onSend,
  primaryTarget,
  primaryTask,
  variant = "split",
  extras,
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
    const agents = agentMenuItems({
      targets: agentTargets,
      installed,
      newLabel: newAgentLabel,
      onSend,
      onStart,
    });
    menu.open(e, extras?.length ? [...agents, { separator: true }, ...extras] : agents);
  };

  return (
    <>
      {menu.menu && (
        <ContextMenu x={menu.menu.x} y={menu.menu.y} items={menu.menu.items} onClose={menu.close} />
      )}
      {variant === "mini" ? (
        <div className="cli-menu-anchor">
          <Button size="sm"
            title={`Hand this to an agent — a running one, or a fresh ${preferredCli.name} in a worktree`}
            onClick={openMenu}>
            <AgentsIcon size={11} /> {label} ▾
          </Button>
        </div>
      ) : (
        <span className="split-btn">
          <Button variant="accent" className="split-btn-main"
            // The agent is named in the tooltip and the caret menu, not the
            // label: the button is the verb, not an endorsement of one CLI.
            onClick={() =>
              primaryTask
                ? primaryTask.onRun()
                : primaryTarget
                  ? onSend(primaryTarget)
                  : onStart(preferredCli.id)
            }
            title={
              primaryTask
                ? primaryTask.title
                : primaryTarget
                ? `Send this back to ${primaryTarget.title}`
                : primaryTitle?.(preferredCli.name)
            }>
            ▶ {label}
            <span className="split-btn-agent">
              {primaryTask ? (
                <>
                  <TasksIcon size={11} /> Task
                </>
              ) : (
                primaryTarget?.title ?? preferredCli.name
              )}
            </span>
          </Button>
          <Button variant="accent" className="split-btn-caret"
            title={
              primaryTask
                ? "Send to a running agent, or start a new one instead"
                : primaryTarget
                ? "Send to another agent, or start a new one"
                : "Send to a running agent, or start a different one"
            }
            onClick={openMenu}>
            ▾
          </Button>
        </span>
      )}
    </>
  );
}

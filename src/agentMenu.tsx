// The "hand this ticket to an agent" menu, built once and used by both the
// Issues panel row and the ticket tab's split button.
//
// Shape: running agents first (the common case — you usually want the agent
// already thinking about this repo), then a single "New agent" row whose
// attached panel carries the full CLI list. Flattening it would bury the
// common case under seven rarely-picked options.
import { AGENT_CLIS } from "./projects";
import { getSettings } from "./settings";
import type { MenuItem } from "./components/ContextMenu";
import type { AgentTarget } from "./components/TicketsPanel";
import { AgentIcon, AgentsIcon } from "./components/icons";

export function agentMenuItems(opts: {
  targets: AgentTarget[];
  installed: Record<string, boolean>;
  /** Label for the new-agent row, e.g. "New agent in feat/x". */
  newLabel: string;
  onSend: (target: AgentTarget) => void;
  onStart: (agentId: string) => void;
}): MenuItem[] {
  const { targets, installed, newLabel, onSend, onStart } = opts;
  const items: MenuItem[] = [];

  if (targets.length > 0) {
    items.push({ label: "Running agents", separator: true });
    for (const t of targets) {
      items.push({
        label: t.title,
        icon: <AgentIcon id={t.agentId} size={14} />,
        hint: t.dir,
        onClick: () => onSend(t),
      });
    }
    items.push({ label: "", separator: true });
  }

  const installedClis = AGENT_CLIS.filter((c) => installed[c.bin]);
  // "default" only means something if that CLI is installed here.
  const preferred =
    (installedClis.find((c) => c.id === getSettings().defaultAgent) ?? installedClis[0])?.id ?? "";
  // Nothing detected on PATH: still list everything rather than an empty
  // panel — detection can lag a fresh install, and the launcher handles
  // installing them.
  const options = installedClis.length > 0 ? installedClis : AGENT_CLIS;

  items.push({
    label: newLabel,
    // The generic agents mark, NOT the default agent's brand: this row opens a
    // list of every CLI, so wearing one vendor's logo misrepresents it (and
    // read as "new Claude agent").
    icon: <AgentsIcon size={14} />,
    submenu: options.map((cli) => ({
      label: cli.name,
      icon: <AgentIcon id={cli.id} size={14} />,
      hint: cli.id === preferred ? "default" : installed[cli.bin] ? undefined : "install",
      onClick: () => onStart(cli.id),
    })),
  });

  return items;
}

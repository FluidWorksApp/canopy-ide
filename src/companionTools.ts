// The tools only the companion gets.
//
// Every coding agent in Canopy holds the `canopy_*` set in agentTools.ts. Those
// are scoped to *a* project, because that is what a coding agent is: born in
// one checkout, working one job against it. `canopy_project` answers about the
// project it is in, and there is no question it could ask about another one.
//
// The companion is the opposite shape. It is asked "which repos have unpushed
// work", "what has been going on this week", "start the banana server" — none
// of which name a project the way a coding agent's questions do, and all of
// which need a view across the workspace. So it gets a second set.
//
// Kept from the coding agents deliberately, not incidentally. A cross-project
// tool in an ordinary session is a way for an agent working on one repo to read
// and act on another, which is the opposite of the isolation the worktree
// discipline exists to provide.
//
// Duplicated from the sidecar's descriptors (bin/canopy_hook.rs) on the same
// terms as agentTools.ts: names must match, because the name is what the
// sidecar gates on.

import { AGENT_TOOL_GROUPS, type AgentToolGroup } from "./agentTools";

export const COMPANION_TOOL_GROUPS: AgentToolGroup[] = [
  {
    id: "workspace",
    label: "Across every project",
    blurb:
      "The view no coding agent has: all of the user's projects at once, open or not.",
    tools: [
      {
        name: "canopy_workspace",
        label: "Workspace",
        note: "Every project — paths, branch, what's running, what's dirty",
      },
      {
        name: "canopy_workspace_git",
        label: "Git across repos",
        note: "Branch, ahead/behind, uncommitted and unpushed, per repo",
      },
      {
        name: "canopy_workspace_agents",
        label: "Every session",
        note: "What each coding agent is doing, in every project",
      },
      {
        name: "canopy_workspace_search",
        label: "Search everything",
        note: "Past conversations, scrollback, notes and research across projects",
      },
    ],
  },
  {
    id: "companion-reach",
    label: "Reaching you",
    blurb: "How the companion puts something in front of you, and asks before acting.",
    tools: [
      {
        name: "canopy_open_project",
        label: "Open a project",
        note: "Bring a project to the front — including one that was closed",
      },
      {
        name: "canopy_confirm",
        label: "Ask first",
        note: "Put a proposed action to you and wait for the answer",
      },
    ],
  },
  {
    id: "companion-memory",
    label: "Its own memory",
    blurb:
      "What the companion has learned about you and your work — kept across projects " +
      "and across restarts, because it belongs to no repo.",
    tools: [
      {
        name: "canopy_recall",
        label: "Recall",
        note: "What it already knows about you and how you work",
      },
      {
        name: "canopy_remember",
        label: "Remember",
        note: "Keep something that will still matter next week",
      },
    ],
  },
];

export const COMPANION_TOOLS: string[] = COMPANION_TOOL_GROUPS.flatMap((g) =>
  g.tools.map((t) => t.name),
);

/** Shared tools that change something the user would have to undo.
 *
 *  Named here because the companion is the one agent that can reach a project
 *  the user is not looking at, so "which of these changes the world" stops
 *  being a philosophical question and becomes the thing the authority setting
 *  is actually about. */
export const MUTATING_TOOLS: string[] = [
  "canopy_start_server",
  "canopy_stop_server",
  "canopy_restart_server",
  "canopy_message_agent",
  "canopy_claim",
  "canopy_notes_write",
  "canopy_research_write",
  "canopy_vault_fill",
  "canopy_vault_read",
  "canopy_browser_click",
  "canopy_browser_type",
  "canopy_browser_eval",
  "canopy_browser_navigate",
];

/** Everything a companion session holds: the shared set plus its own.
 *
 *  The shared ones come along because the companion genuinely needs them — it
 *  answers "what's the type of this" with the same warm language server, and
 *  starts servers through the same RUNS rail. What it does not get is a
 *  narrower scope than a coding agent; what a coding agent does not get is
 *  the workspace-wide half.
 *
 *  Authority is applied by *withholding the tool*, not by asking the agent to
 *  behave. A tool that is absent cannot be called; a rule in a prompt is a rule
 *  the agent can reason its way past, and this is the wrong agent to discover
 *  that on. So:
 *
 *    read     — no mutating tool at all.
 *    confirm  — no mutating tool either, *for now*: the confirm chip that would
 *               put each call to the user (`canopy_confirm`) is not built yet,
 *               and shipping the tools without the gate would mean the setting
 *               said "ask first" while the companion acted freely. Withholding
 *               under-delivers; acting silently would be a lie. When the gate
 *               lands this becomes the set minus nothing, routed through it.
 *    auto     — everything, which is what the user asked for.
 */
export function companionToolNames(
  disabled: string[],
  authority: "read" | "confirm" | "auto",
): string[] {
  const off = new Set(disabled);
  const mutatingAllowed = authority === "auto";
  return [...AGENT_TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.name)), ...COMPANION_TOOLS]
    // The companion's own tools are not in Settings → Agents (that screen is
    // about what coding agents may do), so only the shared ones can be off.
    .filter((name) => COMPANION_TOOLS.includes(name) || !off.has(name))
    .filter((name) => mutatingAllowed || !MUTATING_TOOLS.includes(name));
}

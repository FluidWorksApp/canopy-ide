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
      {
        name: "canopy_workspace_prs",
        label: "Pull requests",
        note: "Open PRs across every repo, optionally narrowed to one project",
      },
      {
        name: "canopy_pr_details",
        label: "PR details",
        note: "Conversation, review threads, reviewers, body and optional diff",
      },
      {
        name: "canopy_pr_action",
        label: "Act on a PR",
        note: "Review, reply, resolve, request review, update, merge or close",
      },
      {
        name: "canopy_start_session",
        label: "Start a session",
        note: "Set a coding agent going on a brief, in any project — including one with nothing running",
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

/** Shared tools that answer "the project I am in" — and are therefore lies for
 *  an agent that is in none.
 *
 *  Withheld rather than discouraged. The brief used to ask the companion not to
 *  call `canopy_project`; it called it anyway, got whichever project the bridge
 *  routed it to, and told the user their other seven projects did not exist.
 *  A tool that cannot answer correctly for this agent should not be in its
 *  list — `canopy_workspace` answers the same question across all of them. */
export const PER_PROJECT_TOOLS: string[] = [
  "canopy_project",
  "canopy_component_files",
];

/** Shared tools that change something the user would have to undo.
 *
 *  Named here because the companion is the one agent that can reach a project
 *  the user is not looking at, so "which of these changes the world" stops
 *  being a philosophical question and becomes the thing the authority setting
 *  is actually about. */
export const MUTATING_TOOLS: string[] = [
  "canopy_start_session",
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
  "canopy_browser_resize",
  "canopy_pr_action",
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
 *    read     — no mutating tool at all. Absent beats instructed.
 *    confirm  — the tools stay, and are gated on the way through instead
 *               (`companion_gate` in canopy_hook.rs). The confirmation happens
 *               whether or not the agent thought to ask, so withholding them
 *               would only mean the companion could not act at all.
 *    auto     — everything, which is what the user asked for.
 */
export function companionToolNames(
  disabled: string[],
  authority: "read" | "confirm" | "auto",
): string[] {
  const off = new Set(disabled);
  const mutatingAllowed = authority !== "read";
  return [...AGENT_TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.name)), ...COMPANION_TOOLS]
    // The companion's own tools are not in Settings → Agents (that screen is
    // about what coding agents may do), so only the shared ones can be off.
    .filter((name) => COMPANION_TOOLS.includes(name) || !off.has(name))
    .filter((name) => mutatingAllowed || !MUTATING_TOOLS.includes(name))
    .filter((name) => !PER_PROJECT_TOOLS.includes(name));
}

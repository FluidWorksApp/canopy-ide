// The canopy_* tools an agent running inside Canopy can call, as the Agents
// settings page lists them.
//
// Duplicated from the sidecar's own descriptors (bin/canopy_hook.rs) on
// purpose: what the agent reads has to be written for a model mid-task, and
// what the user reads has to fit in a row. Names must match — they're the key
// the sidecar filters on — so add a tool in both places or it can't be turned
// off.
//
// canopy_job_done is on by default like everything else, and disabling it here
// only reaches ordinary sessions: inside a micro-task terminal the sidecar
// ignores the disable list for it (env CANOPY_MICRO_TASK), because a stripped
// completion tool would strand the ephemeral tab open forever. canopy_name_task
// is exempted in the same place and for a smaller reason: every micro-task brief
// tells the agent to call it, and a brief naming a tool that isn't there is a
// brief that lies.
export interface AgentToolGroup {
  id: string;
  label: string;
  blurb: string;
  tools: { name: string; label: string; note: string }[];
}

export const AGENT_TOOL_GROUPS: AgentToolGroup[] = [
  {
    id: "context",
    label: "Context",
    blurb: "What the IDE knows: the project, what's running, what you're looking at.",
    tools: [
      { name: "canopy_project", label: "Project", note: "Components, run servers, agents" },
      { name: "canopy_editor_state", label: "Editor state", note: "Open file, caret, selection" },
      { name: "canopy_component_files", label: "File list", note: "Files in a component" },
      { name: "canopy_server_output", label: "Server output", note: "A terminal's recent output" },
      { name: "canopy_resources", label: "Resources", note: "CPU and memory per terminal" },
      { name: "canopy_annotations", label: "Annotations", note: "Feedback you marked on a preview" },
    ],
  },
  {
    id: "code",
    label: "Code intelligence",
    blurb: "Answers from the language server Canopy already keeps warm.",
    tools: [
      { name: "canopy_diagnostics", label: "Diagnostics", note: "Errors and warnings for a file" },
      { name: "canopy_references", label: "References", note: "Every real use of a symbol" },
      { name: "canopy_definition", label: "Definition", note: "Where a symbol comes from" },
      { name: "canopy_hover", label: "Hover", note: "A symbol's type and docs" },
      { name: "canopy_symbols", label: "Symbols", note: "Find a symbol, or outline a file" },
    ],
  },
  {
    id: "run",
    label: "Running things",
    blurb: "Start, stop and wait on the processes in the RUNS rail.",
    tools: [
      { name: "canopy_start_server", label: "Start", note: "Run a configured command" },
      { name: "canopy_stop_server", label: "Stop", note: "Kill a terminal's process tree" },
      { name: "canopy_restart_server", label: "Restart", note: "Relaunch in the same tab" },
      { name: "canopy_wait_for", label: "Wait for", note: "Block until listening, output or quiet" },
    ],
  },
  {
    id: "browser",
    label: "Preview browser",
    blurb: "Drive the embedded preview and see what it shows.",
    tools: [
      { name: "canopy_open_preview", label: "Open preview", note: "Show a local URL" },
      { name: "canopy_browser_navigate", label: "Navigate", note: "Load a page, back, forward" },
      { name: "canopy_browser_resize", label: "Resize", note: "Set or reset the CSS viewport" },
      { name: "canopy_browser_snapshot", label: "Snapshot", note: "The page's elements and text" },
      { name: "canopy_browser_click", label: "Click", note: "Click an element" },
      { name: "canopy_browser_type", label: "Type", note: "Fill an input" },
      { name: "canopy_browser_eval", label: "Eval", note: "Run JavaScript in the page" },
      { name: "canopy_browser_console", label: "Console", note: "The page's console output" },
      { name: "canopy_browser_network", label: "Network", note: "Requests the page made" },
      { name: "canopy_screenshot", label: "Screenshot", note: "A picture of the page" },
    ],
  },
  {
    id: "reach",
    label: "Reaching you",
    blurb: "How an agent shows you something, or asks.",
    tools: [
      { name: "canopy_open_file", label: "Open file", note: "Put a file in front of you" },
      { name: "canopy_show_diff", label: "Show diff", note: "Show a file's change vs HEAD" },
      { name: "canopy_notify", label: "Notify", note: "A notice in the window" },
      { name: "canopy_job_done", label: "Job done", note: "Report a task's outcome" },
      {
        name: "canopy_name_task",
        label: "Name its work",
        note: "Names the run and updates its one-line description",
      },
      { name: "canopy_vault_list", label: "Vault list", note: "Which logins exist — never the passwords" },
      { name: "canopy_vault_fill", label: "Vault fill", note: "Sign in to a page; the agent never sees the password" },
      { name: "canopy_vault_read", label: "Vault read", note: "Plain-text password, for entries you mark readable" },
      { name: "canopy_ask_user", label: "Ask", note: "A question that blocks until you answer" },
      {
        name: "canopy_close_session",
        label: "Close itself",
        note: "Ends its own terminal when you tell it to — never another's",
      },
    ],
  },
  {
    id: "team",
    label: "Other agents and work",
    blurb: "Several agents in one checkout, and the work waiting on you.",
    tools: [
      { name: "canopy_agents", label: "Agents", note: "What the other sessions are doing" },
      { name: "canopy_claim", label: "Claim files", note: "Advisory claim over paths" },
      {
        name: "canopy_message_agent",
        label: "Message agent",
        note: "Type into another session, or into whoever raised a PR",
      },
      {
        name: "canopy_mesh_send",
        label: "Mesh send",
        note: "A kept message with files attached; the target gets a one-line notice",
      },
      {
        name: "canopy_mesh",
        label: "Mesh history",
        note: "Its own sent and received messages, by id",
      },
      { name: "canopy_tickets", label: "Tickets", note: "Issues from connected trackers" },
      { name: "canopy_reviews", label: "Reviews", note: "Relay review requests and open PRs" },
    ],
  },
  {
    id: "notes",
    label: "Scratchpad",
    blurb:
      "The user's own thoughts, ideas and to-dos for this project. An agent reads it to " +
      "avoid noting the same thing twice, and writes to it to park something real that " +
      "isn't the job it was given.",
    tools: [
      { name: "canopy_notes", label: "Read notes", note: "What's already been written down" },
      {
        name: "canopy_notes_write",
        label: "Park a note",
        note: "Capture a side-observation instead of chasing it",
      },
    ],
  },
  {
    id: "research",
    label: "Research",
    blurb:
      "Findings that outlive the session that produced them — scoped to this project, " +
      "and the only place an agent's research is kept.",
    tools: [
      { name: "canopy_research", label: "Read research", note: "What's been investigated already" },
      {
        name: "canopy_research_write",
        label: "Record research",
        note: "Open an entry, add findings, link the PR",
      },
    ],
  },
];

export const ALL_AGENT_TOOLS = AGENT_TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.name));

/** Every tool from Canopy's own sidecar, as one permission rule.
 *
 * For sessions Canopy spawns and nobody is sitting in front of. A permission
 * prompt there has no one to answer it: the agent asks, the ask goes nowhere,
 * and the turn ends by telling a non-engineer to "grant the Canopy MCP tools"
 * in a screen that does not exist. So the whole server is allowed up front.
 *
 * A rule rather than a list, and the distinction is the point. ALL_AGENT_TOOLS
 * is deliberately a subset of what the sidecar serves — agentTools.test.ts says
 * so, and names the device set and canopy_browser_point as the tools with no
 * settings switch — so every list we could write here re-creates the dead end
 * for whatever it left out. That is exactly how the last fix left
 * canopy_wait_for and canopy_restart_server blocked.
 *
 * This is not a widening of authority. What an owned session may do is decided
 * by the tools withheld from it (`disallowedTools`, and the sidecar's own
 * disable list), on the same terms as the companion's — see companionTools.ts.
 * It only stops Canopy asking itself for permission to use itself. */
export const CANOPY_MCP_ALLOWANCE = "mcp__canopy";

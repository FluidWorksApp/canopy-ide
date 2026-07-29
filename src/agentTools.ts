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
// completion tool would strand the ephemeral tab open forever.
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
      { name: "canopy_browser_snapshot", label: "Snapshot", note: "The page's elements and text" },
      { name: "canopy_browser_click", label: "Click", note: "Click an element" },
      { name: "canopy_browser_type", label: "Type", note: "Fill an input" },
      { name: "canopy_browser_eval", label: "Eval", note: "Run JavaScript in the page" },
      { name: "canopy_browser_console", label: "Console", note: "The page's console output" },
      { name: "canopy_browser_network", label: "Network", note: "Requests the page made" },
      { name: "canopy_screenshot", label: "Screenshot", note: "A picture of the page (macOS)" },
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
      { name: "canopy_vault_list", label: "Vault list", note: "Which logins exist — never the passwords" },
      { name: "canopy_vault_fill", label: "Vault fill", note: "Sign in to a page; the agent never sees the password" },
      { name: "canopy_vault_read", label: "Vault read", note: "Plain-text password, for entries you mark readable" },
      { name: "canopy_ask_user", label: "Ask", note: "A question that blocks until you answer" },
    ],
  },
  {
    id: "team",
    label: "Other agents and work",
    blurb: "Several agents in one checkout, and the work waiting on you.",
    tools: [
      { name: "canopy_agents", label: "Agents", note: "What the other sessions are doing" },
      { name: "canopy_claim", label: "Claim files", note: "Advisory claim over paths" },
      { name: "canopy_message_agent", label: "Message agent", note: "Type into another session" },
      { name: "canopy_tickets", label: "Tickets", note: "Issues from connected trackers" },
      { name: "canopy_reviews", label: "Reviews", note: "Relay review requests and open PRs" },
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

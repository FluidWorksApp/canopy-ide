# Harness capability parity matrix: OpenCode, oh-my-pi (omp), Aider

Scope and method (applies to every section below):
- Versions verified locally on 2026-10-26: `opencode --version` gives `1.18.34`. `omp --version` gives `omp/18.4.10`. The image ships a launcher at /usr/local/bin/omp that installs the real package on first run. `aider --version` gives `aider 0.86.2`.
- Newer upstream releases exist. The npm registry `latest` for opencode-ai is 1.19.4, and 1.18.34 was published 2026-09-30. For @oh-my-pi/pi-coding-agent, `latest` is 18.12.6, and 18.4.10 was published 2026-10-02. PyPI aider-chat `latest` is still 0.86.2, uploaded 2026-02-12. Sources: [npm opencode-ai](https://registry.npmjs.org/opencode-ai), [npm omp](https://registry.npmjs.org/@oh-my-pi/pi-coding-agent), [PyPI aider-chat](https://pypi.org/pypi/aider-chat/json).
- Evidence types:
  - "LOCAL-HELP": the installed binary's `--help` output (official).
  - "LOCAL-SRC": the installed omp npm package ships its TypeScript `src/`. Paths are under `~/.local/lib/node_modules/@oh-my-pi/pi-coding-agent/src/`, and the upstream repo is github.com/can1357/oh-my-pi, packages/coding-agent. This is official source.
  - "OMP-DOCS": docs fetched from the `v18.4.10` git tag (official). The tag was confirmed with `git ls-remote`.
  - Aider "LOCAL-SRC" means /opt/canopy/tools/aider/lib/python3.11/site-packages/aider.
  - OpenCode docs come from opencode.ai/docs (official). The site tracks the `dev` branch, so a documented feature may be newer than 1.18.34. Each such case is flagged.
- Permalinks for local citations:
  - omp "LOCAL-SRC `<path>`" maps to `https://github.com/can1357/oh-my-pi/blob/v18.4.10/packages/coding-agent/src/<path>`.
  - omp catalog and auth paths map to `https://github.com/can1357/oh-my-pi/blob/v18.4.10/packages/<pkg>/src/<path>`.
  - Aider "LOCAL-SRC `<file>`" maps to `https://github.com/Aider-AI/aider/blob/v0.86.2/aider/<file>`.
  - LOCAL-HELP is reproducible by running `<bin> --help` at the stated version.
- Headline deltas against Canopy's August 2026 audit (docs/agent-parity.md), each detailed in the numbered section:
  - omp has a native MCP client, configured in `~/.omp/agent/mcp.json` or `.omp/mcp.json` (section 11). The audit's "no native MCP" is wrong, and Canopy can register its MCP server for omp.
  - omp's default tool approval is `yolo` (auto-approve everything), and subagents are forced to yolo (section 5). Canopy should pass `--approval-mode write` or `always-ask`.
  - OpenCode removed bundled Claude Pro/Max OAuth on 2026-03-19 (PR #18186) after Anthropic legal requests. omp 18.4.10 still ships a claude.ai OAuth flow with a Claude Code fingerprint module, which appears to conflict with Anthropic's published policy (section 12).
  - OpenCode (server, SSE, SDK, including json_schema structured output) and omp (`--mode rpc`, `--mode json`, `--system-prompt`, `--tools`, plan mode) both now meet Canopy's Build-runner bar. The audit's "no" is no longer a capability gap (section 1).
  - Stale audit cells:
    - The token tray row says "model only" for OpenCode, although the audit text says cost is captured (section 9).
    - omp extensions can block `tool_call`, so they are more than observability (section 4).
    - omp reads foreign user-level context files only on opt-in (section 10).
    - `chat.message` is not documented on the current OpenCode plugin page (section 4).
  - Aider is unchanged. It is still 0.86.2, the latest on PyPI, with no hooks, no MCP, no sessions, and no structured output.
- Standard field order per CLI: support level; mechanism; programmatic or headless control; version; source; official or reverse-engineered; what Canopy must build itself.

## 1. Headless/structured mode

### Takeaway
OpenCode (HTTP server, SSE, SDK, `run --format json`) and omp (`--mode rpc` JSONL protocol, `--mode json`, `-p`) both have native, fully structured headless surfaces. Either could back a Canopy "Build" runner. Aider has only one-shot `--message` scripting with no structured output. Its Python API is explicitly unsupported.

### Cited Findings
- **OpenCode: native.**
  - `opencode run [message..]` has these flags: `--format default|json` ("raw JSON events"), `-s/--session <id>`, `-c/--continue`, `--fork`, `--agent`, `-m provider/model`, `--variant`, `--attach <url>`, `--auto`, `--title`, `-f` files, and `--command`. Source: LOCAL-HELP 1.18.34, [OpenCode CLI docs](https://opencode.ai/docs/cli/).
  - The docs do not document the JSON event schema for `run --format json`. Source: [OpenCode CLI docs](https://opencode.ai/docs/cli/).
  - `opencode serve` binds to 127.0.0.1 and the docs show port 4096. The installed help says `--port` defaults to 0, meaning random. It also takes `--hostname`, `--mdns`, and `--cors`.
  - The server publishes an OpenAPI 3.1 spec at `GET /doc`.
  - Key endpoints:
    - `POST /session` with `parentID?` and `title?`
    - `POST /session/:id/message` (synchronous prompt)
    - `POST /session/:id/prompt_async` (returns 204)
    - `POST /session/:id/abort`
    - `POST /session/:id/fork` with `messageID?`
    - `POST /session/:id/revert` and `/unrevert`
    - `POST /session/:id/summarize`
    - `POST /session/:id/permissions/:permissionID` with `response` and `remember?`
    - `GET /event` SSE, where the first event is `server.connected`, and `GET /global/event`
  - Basic auth is enabled by `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_USERNAME`. Source: [OpenCode server docs](https://opencode.ai/docs/server/).
  - System prompt:
    - No `--system-prompt` flag exists in `run` (LOCAL-HELP).
    - A custom prompt goes through agent config: `agent.<name>.prompt` (file) or markdown agents in `.opencode/agents/`, selected with `--agent`. Source: [OpenCode agents docs](https://opencode.ai/docs/agents/).
    - `instructions` takes an array of extra instruction files. Source: [OpenCode config docs](https://opencode.ai/docs/config/).
  - Tool allow/deny:
    - The `permission` config uses `allow|ask|deny` per tool, with glob patterns for `bash`.
    - `OPENCODE_PERMISSION` accepts inline JSON.
    - The `tools` boolean map is deprecated since v1.1.1. Sources: [OpenCode permissions docs](https://opencode.ai/docs/permissions/), [OpenCode CLI docs](https://opencode.ai/docs/cli/).
  - Plan mode is the built-in `plan` primary agent. By default it denies edits except to markdown plan files. In the TUI you switch with Tab; headless you pass `--agent plan`.
    - `OPENCODE_EXPERIMENTAL_PLAN_MODE` also exists. Sources: [OpenCode agents docs](https://opencode.ai/docs/agents/), [OpenCode CLI docs](https://opencode.ai/docs/cli/).
  - Resume by ID uses `-s <id>`, and `--fork` can be combined with it. Source: LOCAL-HELP.
  - SDK `client.session.prompt` takes `model {providerID, modelID}`, `parts`, and `noReply`. The `/v2` client supports structured output via `format: {type:"json_schema", schema, retryCount}`, with the result in `result.data.info.structured`. `client.event.subscribe()` returns the SSE stream. The SDK page does not document `system` or `tools` body fields. Source: [OpenCode SDK docs](https://opencode.ai/docs/sdk/).
  - ACP server: `opencode acp`. Source: LOCAL-HELP.
- **omp: native.**
  - Modes:
    - `-p/--print` runs non-interactively.
    - `--mode text|json|rpc|rpc-ui`.
    - `--max-time`.
    - `--no-session` makes the run ephemeral.
    - `-c` continues; `-r/--resume <id-prefix|path>` resumes. Source: LOCAL-HELP 18.4.10.
  - `--mode json` "emits a session header followed by events as JSON lines". Terminal turn failures give a nonzero exit. Source: [OMP cli-reference](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/cli-reference.md).
  - `--mode rpc` is a custom newline-delimited JSON protocol over stdio, not JSON-RPC 2.0.
    - It emits a `ready` frame: `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,...}`.
    - It supports `negotiate_protocol` to v2, which adds chunked `rpc_chunk` frames for objects over 1 MiB.
    - `--no-ui` runs extensions headless. Source: [OMP rpc.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/rpc.md).
  - RPC commands present in source include:
    - Prompting and control: `prompt`, `steer`, `follow_up`, `abort`, `abort_and_prompt`
    - Session: `new_session`, `open_session`, `switch_session`, `branch`, `get_tree`, `get_messages`, `get_messages_page`, `get_entries`, `get_session_stats`, `get_state`, `export_html`, `handoff`, `login`
    - Settings: `compact`, `set_auto_compaction`, `set_model`, `cycle_model`, `set_thinking_level`
    - Subagents: `get_subagents`, `get_subagent_messages`, `steer_subagent`, `cancel_subagent`
    - Host integration: `set_host_tools`, `set_host_uri_schemes`
    - Source: LOCAL-SRC `src/modes/rpc/*.ts` (case labels).
  - Host-tool and host-URI sub-protocols let the embedding host supply its own tools. Source: [OMP rpc.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/rpc.md).
  - System prompt flags: `--system-prompt`, `--system-prompt-template` (Handlebars), `--append-system-prompt`. Tool flags: `--tools=<csv>`, `--no-tools`, `--no-lsp`.
  - Plan mode flags: `--plan=<model>` sets the plan-role model, and `--plan-yolo` forces read-only plan mode, auto-approves the plan, then executes. There is also a `/plan` slash command. Sources: LOCAL-HELP, LOCAL-SRC `src/plan-mode/`.
  - There is also an SDK. Source: [OMP sdk.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/sdk.md).
  - ACP: `omp acp` runs over stdio. Source: LOCAL-HELP.
- **Aider: partial.**
  - Scripting flags: `--message/-m`, `--message-file/-f`, `--yes-always` (the help text uses this name; the docs page says `--yes`), `--no-stream`, `--dry-run`, `--commit`, `--load <file of /commands>`. Sources: LOCAL-HELP 0.86.2, [Aider scripting docs](https://aider.chat/docs/scripting.html).
  - The docs mention no JSON output mode. The Python API (`Coder.create()`, `coder.run()`) "is not officially supported or documented" and "could change in future releases without providing backwards compatibility". Source: [Aider scripting docs](https://aider.chat/docs/scripting.html).
  - System prompt: there is no override flag. `--show-prompts` only prints the prompts. Conventions are injected through `--read`. Source: LOCAL-HELP.
  - Tool allow/deny is not applicable because Aider has no tool-calling agent loop.
  - Plan mode: the nearest equivalents are `/ask` mode and `--chat-mode ask`, plus `--architect` (two-model plan then edit). Source: [Aider commands](https://aider.chat/docs/usage/commands.html).
  - Resume by ID: none. See section 6.
  - `--llm-history-file` logs raw LLM traffic. Source: LOCAL-HELP.

### Inferences
- OpenCode and omp both meet the Build-runner bar: structured events, system prompt (omp natively; OpenCode through an agent definition), tool lists, plan mode, and resume by ID. The August audit's "Build headless runner: no" for both is now a product choice, not a capability gap.
- **What Canopy must build:**
  - OpenCode: an event-schema adapter, because the `run --format json` schema is undocumented. Prefer the server's OpenAPI and SSE (`/doc`) or the SDK over parsing `run` output. Also a per-run synthetic agent that carries the system prompt.
  - omp: an RPC client (JSONL with v2 chunking) and a mapping onto Canopy's normalized events.
  - Aider: the whole structured layer. That means wrapping `--message --yes-always --no-stream` per turn, parsing stdout and git commits for results, and treating it as not Build-eligible. Do not rely on the Python API.

### Gaps
- No published JSON event schema exists for `opencode run --format json`. I did not capture a sample stream because no provider credentials were configured locally.
- I did not run an omp RPC session end to end (no credentials). Command names come from source, not from a live trace.

## 2. Checkpoints / rewind / undo

### Takeaway
All three have native rewind, using different mechanisms. OpenCode reverts both conversation and files through git-based snapshots, and the server exposes revert/unrevert. omp has a branching conversation tree (`/branch` alias `/rewind`, `/tree`, `/fork`) plus a git-based `checkpoint` tool. Aider's `/undo` reverts only the last aider-made git commit.

### Cited Findings
- **OpenCode: native.**
  - `/undo` (`ctrl+x u`) "removes the most recent user message, all later responses, and any file changes". `/redo` (`ctrl+x r`) restores them. The feature "needs to be a Git repository". Source: [OpenCode TUI docs](https://opencode.ai/docs/tui/).
  - The `snapshot` config key is on by default; `false` disables it. Source: [OpenCode config docs](https://opencode.ai/docs/config/).
  - The `opencode debug snapshot` subcommand exists. Source: LOCAL-HELP.
  - Server endpoints: `POST /session/:id/revert` takes `messageID` and `partID?`; `POST /session/:id/unrevert`; `GET /session/:id/diff` takes an optional `messageID`. Source: [OpenCode server docs](https://opencode.ai/docs/server/).
- **omp: native.**
  - `/branch` (alias `rewind`): "Rewind to a previous message, keeping the old path as a branch". Source: LOCAL-SRC `slash-commands/builtin-session.ts:592-596`.
  - `/tree` navigation creates a branch summary of the abandoned path. Source: [OMP compaction.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/compaction.md).
  - The session tree and leaf semantics are part of the JSONL format. Source: [OMP session.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/session.md).
  - The agent-callable `checkpoint` tool is described as "Create a git-based checkpoint to save and restore session state". Source: LOCAL-SRC `tools/checkpoint.ts:57`.
  - RPC exposes `branch`, `get_tree`, and `get_branch_messages`, and extension events `session_before_branch`/`session_branch`/`session_before_tree`/`session_tree`. Sources: LOCAL-SRC rpc, `extensibility/extensions/types.ts`.
- **Aider: native (git-only).**
  - `/undo` means "Undo the last git commit if it was done by aider". `/diff` shows changes since the last message. Source: [Aider commands](https://aider.chat/docs/usage/commands.html).
  - Rewind depends on `--auto-commits`, which defaults to True. `--no-git` and `--no-auto-commits` disable the mechanism. Source: LOCAL-HELP.
  - There is no conversation rewind short of `/clear` or `/reset`. Source: [Aider commands](https://aider.chat/docs/usage/commands.html).

### Inferences
- Canopy can call OpenCode's revert and unrevert over HTTP for a Canopy-driven rewind UI.
- For omp, a branch-aware UI needs the tree from RPC `get_tree`. I could not confirm whether omp's `/branch` also restores files. Treat it as conversation-only unless the `checkpoint` tool was used.
- **What Canopy must build:**
  - omp: file-level restore when rewinding a branch, for example its own git stash or snapshot per turn, unless that is verified.
  - Aider: rewind of conversation state, and protection for non-git or `--no-auto-commits` workspaces.
  - A uniform "restore files to turn N" for all three on shared checkouts, where git-commit-based undo can collide with other agents' edits.

### Gaps
- I did not determine whether omp's `/branch` or `/tree` navigation reverts workspace files. The source points to `tools/checkpoint` with a `CompletedRewindState`, but its semantics were not traced.
- OpenCode's snapshot storage location (a separate git dir under the data path) is not documented on the pages I fetched.

## 3. IDE integration protocol

### Takeaway
None of the three implements a Claude-Code-style IDE protocol (an MCP-over-WebSocket lockfile with selection, diagnostics, and diff tools). OpenCode ships a VS Code-family extension for selection and file references, and both OpenCode and omp implement ACP (Agent Client Protocol) as servers, where the IDE hosts the agent. Aider's only hook is `--watch-files` (AI comments in files).

### Cited Findings
- **OpenCode: partial.**
  - A marketplace extension for VS Code, Cursor, and forks "automatically share[s] your current selection or tab". It inserts `@File#L37-42` references with Cmd+Option+K / Alt+Ctrl+K and launches with Cmd/Ctrl+Esc.
  - The docs mention no diagnostics, and the transport is undocumented. Source: [OpenCode IDE docs](https://opencode.ai/docs/ide/).
  - `opencode acp` starts an ACP server, and the server's TUI-control endpoints (`/tui/append-prompt`, `/tui/submit-prompt`, `/tui/execute-command`, `/tui/show-toast`, `/tui/control/next`) let a host push text into a running TUI. Sources: LOCAL-HELP, [OpenCode server docs](https://opencode.ai/docs/server/).
  - The server also provides `GET /find/symbol`, `GET /lsp`, and the plugin event `lsp.client.diagnostics`, but these come from OpenCode's own LSP clients, not the host IDE's. Sources: [OpenCode server docs](https://opencode.ai/docs/server/), [OpenCode plugins docs](https://opencode.ai/docs/plugins/).
- **omp: partial.**
  - `omp acp` is an ACP server over stdio, with an ACP permission gate. Sources: LOCAL-HELP, LOCAL-SRC `modes/acp/`, `session/acp-permission-gate.ts`.
  - RPC `set_host_tools` and `set_host_uri_schemes` let a host such as Canopy inject its own tools and URI resolvers. That is a generic channel for selection and diagnostics. Source: [OMP rpc.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/rpc.md).
  - omp has built-in LSP tools (`lsp`, disabled with `--no-lsp`). Source: LOCAL-HELP.
- **Aider: none, with a weak substitute.**
  - `--watch-files` watches for AI coding comments. There is no selection, diagnostics, or diff channel. Source: LOCAL-HELP.

### Inferences
- **What Canopy must build:**
  - For all three: selection, diagnostics, and diff-review flows.
  - OpenCode and omp (MCP clients): expose these as MCP tools through Canopy's existing MCP server. That is already Canopy's pattern (`canopy_editor_state`, `canopy_diagnostics`).
  - omp in RPC mode: register them as host tools.
  - Aider: inject context as read-only files (`AIDER_READ`) or `/add` commands typed into the PTY.
  - Diffs: Canopy should compute diffs from its own edit journal or git, not from a harness protocol.

### Gaps
- I did not find the OpenCode VS Code extension's wire protocol (port or env var). Determining it would require reverse-engineering the extension.
- I did not verify whether omp's ACP mode advertises editor-side capabilities such as `fs/read_text_file` from the client.

## 4. Hooks / lifecycle events / plugins / extensions

### Takeaway
OpenCode (JS/TS plugins plus SSE bus) and omp (TS extensions with a `pi.on(...)` event bus, which can block tools) are both native and rich. Aider has no hooks. Its only lifecycle signal is `--notifications-command`.

### Cited Findings
- **OpenCode: native.**
  - Plugin locations: `.opencode/plugins/`, `~/.config/opencode/plugins/`, and npm entries in the `plugin` config array (cached in `~/.cache/opencode/node_modules/`). Install with `opencode plugin <module>`; `--pure` / `OPENCODE_PURE` disables external plugins. Sources: [OpenCode plugins docs](https://opencode.ai/docs/plugins/), LOCAL-HELP.
  - Events:
    - Command and file: `command.executed`, `file.edited`, `file.watcher.updated`
    - Installation and LSP: `installation.updated`, `lsp.client.diagnostics`, `lsp.updated`
    - Message: `message.part.removed`, `message.part.updated`, `message.removed`, `message.updated`
    - Permission: `permission.asked`, `permission.replied`
    - Server: `server.connected`
    - Session: `session.created`, `session.compacted`, `session.deleted`, `session.diff`, `session.error`, `session.idle`, `session.status`, `session.updated`
    - Todo and shell: `todo.updated`, `shell.env`
    - Tool: `tool.execute.before`, `tool.execute.after`
    - TUI: `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`
    - Compaction: `experimental.session.compacting`
    - Source: [OpenCode plugins docs](https://opencode.ai/docs/plugins/).
  - The plugin context is `{project, directory, worktree, client, $}`. Handlers take `(input, output)`. `tool.execute.before` can rewrite `output.args` or throw to block. Source: [OpenCode plugins docs](https://opencode.ai/docs/plugins/).
  - The plugins page and its source (`plugins.mdx` on `dev`) document only the bus events above, plus the hooks shown in examples: `tool.execute.before`, `shell.env`, and `experimental.session.compacting`. Neither `chat.message` (which Canopy's audit relies on) nor a `permission.ask` decision hook appears in that file. They may exist undocumented in the SDK types. Sources: [OpenCode plugins docs](https://opencode.ai/docs/plugins/), [plugins.mdx source](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/plugins.mdx); compare [Canopy audit](../../docs/agent-parity.md).
- **omp: native.**
  - Extensions load from `~/.omp/agent/extensions/` or `-e/--extension` (repeatable). `--hook` is an alias for `--extension`. `--no-extensions` disables discovery. Discovered `.omp/hooks/pre/*.ts` load as extensions. Sources: LOCAL-HELP, [OMP hooks.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/hooks.md).
  - Extension API: `pi.on(event)`, `pi.registerTool`, `pi.registerCommand`, `registerShortcut`, `registerFlag`. `tool_call` can return `{block:true, reason}`, and `session_before_switch` can return `{cancel}`. Source: [OMP extensions.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/extensions.md).
  - Event names:
    - Agent: `agent_start`, `agent_end`, `before_agent_start`
    - Compaction and retry: `auto_compaction_start`, `auto_compaction_end`, `auto_retry_start`, `auto_retry_end`
    - Provider and subagent: `before_provider_request`, `before_subagent_spawn`
    - Input: `context`, `input`
    - Message: `message_start`, `message_update`, `message_end`
    - Session: `session_start`, `session_stop`, `session_shutdown`, `session_before_branch`, `session_branch`, `session_before_compact`, `session_compact`, `session_before_switch`, `session_switch`, `session_before_tree`, `session_tree`
    - Tool: `tool_call`, `tool_result`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `tool_approval_requested`, `tool_approval_resolved`
    - Turn: `turn_start`, `turn_end`
    - User: `user_bash`, `user_python`
    - Source: LOCAL-SRC `extensibility/extensions/types.ts`.
  - Plugin and marketplace system: `omp plugin`, `omp install`, `--plugin-dir`. Source: LOCAL-HELP.
- **Aider: none, with a substitute.**
  - `--notifications` and `--notifications-command COMMAND` exist. The Canopy audit verified in source that the command fires at the main prompt and at y/n confirms. Sources: LOCAL-HELP, [Canopy audit](../../docs/agent-parity.md).
  - There is no plugin, extension, or per-tool hook system; Aider has no tools. Source: LOCAL-HELP.

### Inferences
- Audit delta: re-verify that Canopy's OpenCode plugin still receives `chat.message` on 1.18.34. If it does not, derive UserPromptSubmit from `message.updated` with role `user`.
- omp's `tool_call` blocking plus `tool_approval_requested` gives Canopy a real blocked-state signal. The audit said "observability" only, but blocking is available.
- **What Canopy must build:**
  - Aider: all lifecycle events except "waiting". Per-edit and per-tool events must come from a git or filesystem watcher, and turn boundaries from the notification command.

### Gaps
- I did not verify whether `chat.message` and `permission.ask` still exist as undocumented hooks in OpenCode 1.18.34. That needs a runtime test or a check of `@opencode-ai/plugin` type definitions. If `permission.ask` exists with an allow/deny output, OpenCode also has in-process programmatic permission control (section 5).

## 5. Permission modes and OS sandbox

### Takeaway
None of the three provides an OS-level sandbox. OpenCode (allow/ask/deny per tool and pattern, `--auto`) and omp (`always-ask|write|yolo` tiers plus per-tool overrides) have native permission policy. Important: omp's default is `yolo` (everything auto-approved). Aider only asks y/n confirmations, which `--yes-always` bypasses.

### Cited Findings
- **OpenCode: native policy; no sandbox.**
  - Permission keys: `read`, `edit`, `glob`, `grep`, `bash`, `task`, `todowrite`, `skill`, `lsp`, `question`, `webfetch`, `websearch`, `external_directory`, `doom_loop`. Values are `allow|ask|deny`, and the last matching glob wins.
  - Defaults: most keys are `allow`. `external_directory` and `doom_loop` are `ask`. `*.env` reads are `ask`.
  - Ask replies are `once|always|reject`. Per-agent overrides go under `agent.<name>.permission`. `--auto` approves asks but not explicit denies.
  - The permissions page does not mention an OS sandbox. Source: [OpenCode permissions docs](https://opencode.ai/docs/permissions/).
  - Headless permission reply: `POST /session/:id/permissions/:permissionID`. Source: [OpenCode server docs](https://opencode.ai/docs/server/).
- **omp: native policy; no OS sandbox; permissive default.**
  - Tool tiers are `read|write|exec`. `tools.approvalMode` takes `always-ask|write|yolo`, and **`yolo` is the default**.
  - `--approval-mode` overrides the mode, and `--auto-approve`/`--yolo` force yolo. `tools.approval.<tool>: allow|deny|prompt` applies in every mode.
  - MCP tools are tier `write`. Unknown tools default to `exec`. Sources: [OMP approval-mode.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/approval-mode.md), LOCAL-SRC `tools/settings.ts:312-321`.
  - Subagents are forced to `"tools.approvalMode": "yolo"`. Source: LOCAL-SRC `task/executor.ts:1093`.
  - On sandboxing, the only reference I found says "A host that embeds the agent inside an OS sandbox can grant a path mid-session". In other words, sandboxing is left to the host. Source: LOCAL-SRC `tools/file-write-fallback.ts:4`.
- **Aider: partial.**
  - It asks y/n confirmations before adding files, running shell commands, and similar actions. `--yes-always` auto-confirms, and `--dry-run` prevents writes. There is no sandbox. Source: LOCAL-HELP.

### Inferences
- **What Canopy must build:**
  - For all three: OS sandboxing (bubblewrap, Seatbelt, or a container/VM workspace) if Canopy wants a workspace boundary.
  - omp: Canopy should launch with `--approval-mode write` or `always-ask` (or set `tools.approvalMode`) to avoid silent yolo in shared checkouts.
  - Aider: a permission UI is not possible beyond the y/n prompts. Wrap them through the notification-command signal and PTY input.

### Gaps
- I found no evidence of a sandbox in any of the three, but absence of evidence for OpenCode comes from the docs page only. I did not search the binary for bwrap or Seatbelt.

## 6. Sessions: list, resume, fork, transcript location/format

### Takeaway
OpenCode and omp have native ID-addressable sessions with list, resume, and fork, stored on disk (OpenCode in SQLite per the audit; omp in JSONL). Aider has a single per-directory markdown history with no session identity.

### Cited Findings
- **OpenCode: native.**
  - CLI: `opencode session list` (with `--format table|json` and `-n/--max-count` per the docs), `session delete <id>`, `export [sessionID]` with `--sanitize`, `import <file|share URL>`, `-s <id>`, `-c`, and `--fork`. Sources: LOCAL-HELP, [OpenCode CLI docs](https://opencode.ai/docs/cli/).
  - Server: `GET /session`, `GET /session/:id/children`, `POST /session/:id/fork`. Source: [OpenCode server docs](https://opencode.ai/docs/server/).
  - Paths from `opencode debug paths`: data `~/.local/share/opencode`, config `~/.config/opencode`, state `~/.local/state/opencode`. Source: LOCAL-HELP.
  - `OPENCODE_DB` overrides the database path. Source: [OpenCode CLI docs](https://opencode.ai/docs/cli/).
  - SQLite storage is confirmed natively. `opencode db [query]` opens a sqlite3 shell or runs a query with `--format json|tsv`, and `opencode db path` prints the database path. Source: LOCAL-HELP 1.18.34. The audit names the file `opencode.db`. Source: [Canopy audit](../../docs/agent-parity.md).
- **omp: native.**
  - Path: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`. Blobs live in `~/.omp/agent/blobs/<sha256>`. Subagent sessions are `<parent>/<agentId>.jsonl`.
  - Entry types: `message`, `model_usage`, `model_change`, `compaction`, `branch_summary`, `label`, `title_change`, `mode_change`, and others. The format is versioned v1 to v3. Sources: [OMP session.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/session.md), LOCAL-SRC `session/session-manager.ts`.
  - Flags: `-r/--resume <prefix|path>`, `-c`, `--fork <session>`, `--session-dir`, `--no-session`, `--from-claude`, `--from-codex`, `--export <file.jsonl>` (HTML), and `omp share`. Sources: LOCAL-HELP, [OMP cli-reference](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/cli-reference.md).
  - `--fork` is not printed by `--help` but is parsed in LOCAL-SRC `cli/flag-tables.ts:131`.
  - `PI_CODING_AGENT_DIR` relocates storage, and `--profile` or `OMP_PROFILE` isolates it under `~/.omp/profiles/<name>/agent`. Source: LOCAL-HELP.
  - Live sessions hold an OS lease on their session file. Source: [OMP session.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/session.md).
  - I found no dedicated `omp sessions list` CLI subcommand. Listing happens through the `/resume` picker or RPC (`switch_session`). Source: LOCAL-HELP command list.
- **Aider: partial.**
  - History lives in `.aider.chat.history.md` (`--chat-history-file`) and `.aider.input.history` (`--input-history-file`). `--restore-chat-history` reloads the last chat. `--llm-history-file` holds the raw log. Source: LOCAL-HELP.
  - `/save` and `/load` save and replay file-set commands, not the conversation. Source: [Aider commands](https://aider.chat/docs/usage/commands.html).
  - There are no session IDs, list, or fork.

### Inferences
- **What Canopy must build:**
  - omp: a session lister, by scanning the sessions directory or using its own digests.
  - Aider: session identity entirely, for example a per-tab `--chat-history-file` path that Canopy chooses, restored with `--restore-chat-history`. This is a cheap pseudo-resume that the audit did not list.

### Gaps
- No sessions have been run locally, so I did not inspect the schema. `opencode db "<sql>" --format json` is a supported way to query it rather than reading the file directly.

## 7. Subagents / parallel tasks

### Takeaway
OpenCode (the `task` tool, the `general` and `explore` subagents, and custom markdown agents) and omp (the `task` tool, bundled agents, and RPC subagent control) are native. Aider has none.

### Cited Findings
- **OpenCode: native.**
  - Built-in subagents are `general` (for parallel units of work) and `explore` (read-only). Users invoke them with `@name`, or the model invokes them by description.
  - Child sessions can be navigated with keybinds such as `session_child_first`.
  - Agents can be defined in config or in `.opencode/agents/*.md`, with fields `mode: primary|subagent|all`, `steps`, `hidden`, and `permission.task` globs. Source: [OpenCode agents docs](https://opencode.ai/docs/agents/).
  - Server: `POST /session` with `parentID`, and `GET /session/:id/children`. Source: [OpenCode server docs](https://opencode.ai/docs/server/).
  - The `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` flag exists. Source: [OpenCode CLI docs](https://opencode.ai/docs/cli/).
- **omp: native.**
  - The `task` tool "Launch[es] sub-agents for parallel tasks". `omp agents unpack` exports the bundled agents. Source: LOCAL-HELP.
  - RPC provides `get_subagents`, `get_subagent_messages`, `set_subagent_subscription`, `steer_subagent`, and `cancel_subagent`, and there is a `before_subagent_spawn` event. Sources: [OMP rpc.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/rpc.md), LOCAL-SRC.
  - Subagents run with yolo approval. Source: LOCAL-SRC `task/executor.ts:1093`.
  - `omp worktree` supports worktree isolation. Source: LOCAL-HELP.
- **Aider: none.** Source: LOCAL-HELP; no such feature in [Aider commands](https://aider.chat/docs/usage/commands.html).

### Inferences
- **What Canopy must build:**
  - Aider: parallelism only by running multiple Aider processes in separate worktrees, orchestrated by Canopy.
  - All three: cross-harness orchestration (Canopy mesh).

### Gaps
- I did not verify the maximum concurrency or the defaults for either harness.

## 8. Context compaction / summarize

### Takeaway
All three summarize history natively. OpenCode has `/compact` and auto-compaction with config keys, omp has a highly configurable `compaction.*` system with RPC control, and Aider automatically summarizes chat history with the weak model.

### Cited Findings
- **OpenCode: native.**
  - `/compact` (alias `/summarize`, `ctrl+x c`). Source: [OpenCode TUI docs](https://opencode.ai/docs/tui/).
  - Config: `compaction.auto` (default true), `compaction.prune` (default false), `compaction.reserved`. Source: [OpenCode config docs](https://opencode.ai/docs/config/).
  - Env: `OPENCODE_DISABLE_AUTOCOMPACT`. Source: [OpenCode CLI docs](https://opencode.ai/docs/cli/).
  - API and events: `POST /session/:id/summarize` (providerID, modelID), `session.compacted`, and `experimental.session.compacting`, which can inject context or replace the prompt. Sources: [OpenCode server docs](https://opencode.ai/docs/server/), [OpenCode plugins docs](https://opencode.ai/docs/plugins/).
- **omp: native.**
  - Settings: `compaction.enabled`, `thresholdPercent`, `thresholdTokens`, `reserveTokens`, `keepRecentTokens`, `midTurnEnabled`, `methodOrder`, `asyncEnabled`, `autoContinue`, `remoteEndpoint`, `handoffSaveToDisk`. Source: LOCAL-SRC `session/context-settings.ts`.
  - Strategies include summarization, provider-native streaming compaction, "snapcompact", pruning, and "shake" elision. Branch summaries apply to `/tree`. Source: [OMP compaction.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/compaction.md).
  - Commands: `/compact`, `/handoff`, RPC `compact` and `set_auto_compaction`, and events `session_before_compact` and `auto_compaction_start/end`. Sources: LOCAL-SRC, [OMP rpc.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/rpc.md).
- **Aider: native (automatic).**
  - The `ChatSummary` class summarizes older history once it exceeds `--max-chat-history-tokens`, which defaults to the model's `max_chat_history_tokens`. The weak model does the summarizing. Sources: LOCAL-SRC `history.py`, `main.py:951`, LOCAL-HELP.
  - There is no manual `/compact` command. `/clear` and `/drop` are the manual levers. Source: [Aider commands](https://aider.chat/docs/usage/commands.html).

### Inferences
- **What Canopy must build:**
  - Aider: compaction events and a manual-compact command. Neither exists; Canopy can only offer `/clear`.
  - Others: map their compaction events to a Canopy PreCompact/PostCompact equivalent.

### Gaps
- I did not test Aider's summarization trigger timing.

## 9. Usage, cost and model reporting

### Takeaway
OpenCode and omp persist per-message tokens, cost, and model, and expose CLI and API readouts (`opencode stats`, `omp stats`, `omp usage`, RPC `get_session_stats`). Aider prints tokens and cost in-band only, with no persisted machine-readable usage except the raw `--llm-history-file`.

### Cited Findings
- **OpenCode: native.**
  - `opencode stats` takes `--days`, `--tools`, `--models`, and `--project`. `opencode models --verbose` includes costs. Source: LOCAL-HELP.
  - Session rows carry tokens, cost, and model, which Canopy already reads. Source: [Canopy audit](../../docs/agent-parity.md).
  - Message parts stream over SSE as `message.updated`. Source: [OpenCode plugins docs](https://opencode.ai/docs/plugins/).
- **omp: native.**
  - `omp stats` shows usage statistics. `omp usage` shows "provider usage limits for every authenticated account". Source: LOCAL-HELP.
  - Session JSONL has `model_usage` and `model_change` entries. Source: [OMP session.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/session.md).
  - The audit notes that cost is computed inside usage. Source: [Canopy audit](../../docs/agent-parity.md).
  - RPC: `get_session_stats` and `get_state`. Source: LOCAL-SRC rpc.
- **Aider: partial.**
  - `/tokens` reports context tokens. Cost is printed per message in the terminal. `--llm-history-file` logs raw traffic. Sources: [Aider commands](https://aider.chat/docs/usage/commands.html), LOCAL-HELP.
  - Analytics are opt-in PostHog (`--analytics`, `--analytics-log`, `--analytics-disable`), not a usage API. Source: LOCAL-HELP.

### Inferences
- Audit delta: OpenCode moved to "captured" in the audit text, but the matrix row still says "model only". Update the row.
- **What Canopy must build:**
  - Aider: a usage tray, by parsing the in-band "Tokens: … Cost: …" lines from the PTY or computing from `--llm-history-file` with Canopy's price table. Both are reverse-engineered and fragile.

### Gaps
- I did not inspect Aider's exact cost line format in 0.86.2 source.

## 10. Memory and instruction files

### Takeaway
OpenCode and omp read AGENTS.md and CLAUDE.md natively, and omp has an optional autonomous memory backend. Aider has no auto-loaded instruction file. Conventions must be passed with `--read` or `read:` in `.aider.conf.yml`.

### Cited Findings
- **OpenCode: native.**
  - `/init` creates AGENTS.md. The `instructions` config takes an array of files and globs. Sources: [OpenCode TUI docs](https://opencode.ai/docs/tui/), [OpenCode config docs](https://opencode.ai/docs/config/).
  - It reads `~/.claude/CLAUDE.md` and `.claude/skills` unless `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`, or `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` is set. `OPENCODE_DISABLE_PROJECT_CONFIG` disables project instruction files. Source: [OpenCode CLI docs](https://opencode.ai/docs/cli/).
  - I found no autonomous memory feature on the official pages I fetched.
- **omp: native.**
  - Native files: `~/.omp/agent/AGENTS.md`, the nearest non-empty `.omp/AGENTS.md`, and `RULES.md` (sticky rules). Source: [OMP context-files.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/context-files.md).
  - Foreign providers cover Claude, Codex, Gemini, OpenCode, and GitHub. Their user-level files are opt-in through `enabledProviders`; their project-level files are on by default. Source: [OMP context-files.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/context-files.md).
  - `SYSTEM.md` and `SYSTEM_TEMPLATE.md` customize the system prompt. Source: LOCAL-SRC discovery.
  - Memory: `memory.backend` takes `off` (default), `local`, `hindsight`, `mnemopi`, or `sharpshooter`. The local backend injects a "Memory Guidance" block at session start. There is a `/memory` command and memory tools. Sources: [OMP memory.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/memory.md), LOCAL-SRC `tools/memory-*.ts`.
- **Aider: partial.**
  - `--read FILE` (repeatable) and `/read-only`. Config lives in `.aider.conf.yml` and `.env` (`--env-file`). Source: LOCAL-HELP.
  - There is no AGENTS.md auto-discovery and no memory. Source: LOCAL-HELP; no such flag.

### Inferences
- The audit's claim that omp "reads every context-file convention" is overstated. Foreign user-level files are opt-in, and the Claude project file is read only from `<cwd>/.claude/CLAUDE.md` with no walk-up.
- **What Canopy must build:**
  - Aider: an AGENTS.md/CLAUDE.md bridge, which Canopy already does through `AIDER_READ`.
  - All three: cross-harness persistent memory, if desired.

### Gaps
- I did not verify whether omp reads a root-level `AGENTS.md` (without `.omp/`) by default. The context-files table was only partially read.

## 11. MCP client configuration / server mode

### Takeaway
OpenCode is a native MCP client with CLI management and OAuth. **omp is also a native MCP client.** That contradicts the August audit's "no native MCP". omp reads `.omp/mcp.json` and `~/.omp/agent/mcp.json` and imports other tools' configs. Aider has no MCP. None of the three runs as an MCP server; ACP and HTTP serve that role.

### Cited Findings
- **OpenCode: native client.**
  - `opencode mcp add|list|auth|logout|debug`. Source: LOCAL-HELP.
  - Config is an `mcp` object; remote entries take `type:"remote"`, `url`, and `enabled`. Source: [OpenCode config docs](https://opencode.ai/docs/config/).
  - Runtime endpoints: `GET /mcp` and `POST /mcp` (add). Source: [OpenCode server docs](https://opencode.ai/docs/server/).
- **omp: native client.**
  - Primary files are `.omp/mcp.json` (project) and `~/.omp/agent/mcp.json` (user, profile-scoped). It also reads `.omp/.mcp.json`, root `mcp.json` / `.mcp.json`, and imports Claude Code (`~/.claude.json`, `.claude/mcp.json`), Codex (`config.toml [mcp_servers.*]`), Gemini, OpenCode (`opencode.json` `mcp`), Cursor, Windsurf, VS Code `.vscode/mcp.json`, and plugin-declared servers. Source: [OMP mcp-config.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/mcp-config.md).
  - Implementation includes OAuth flows, Smithery, and transports. There is a `/mcp` slash command. MCP tools get approval tier `write`. Sources: LOCAL-SRC `src/mcp/*`, [OMP approval-mode.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/approval-mode.md).
- **Aider: none.** A grep for "mcp" across Aider 0.86.2 site-packages returns no matches. Source: LOCAL-SRC; [Aider options](https://aider.chat/docs/config/options.html).
- **Server mode: none for all three.** The equivalents are `opencode serve`/`acp` and `omp acp`/`--mode rpc`. Source: LOCAL-HELP.

### Inferences
- **Audit correction (high impact):** Canopy can register its MCP server for omp by writing `~/.omp/agent/mcp.json`. That gives omp full Canopy tools, not just the system-prompt bootstrap, and changes the "MCP auto-setup: no native MCP" cell for omp to "yes". Note that omp may also pick up the server from an existing Claude or Codex config, which risks double registration.
- **What Canopy must build:**
  - Aider: tool access remains impossible. Keep the read-only context bootstrap only.

### Gaps
- I do not know the exact omp version that added MCP. The bundled CHANGELOG starts in 18.1.x (September 2026) and already contains MCP bug fixes (for example `/mcp reload`, `mcp__server__tool` separator handling), so the feature predates 18.1. Source: [omp CHANGELOG](https://github.com/can1357/oh-my-pi/blob/v18.4.10/packages/coding-agent/CHANGELOG.md). The audit's v17.x note may already have been wrong when it was written.

## 12. Auth model and third-party-use policy (incl. any use of Claude/ChatGPT subscriptions)

### Takeaway
All three are bring-your-own-key multi-provider clients. Anthropic's published policy forbids third-party apps from offering Claude.ai login or routing requests through Free/Pro/Max credentials. OpenCode removed its bundled Claude Pro/Max OAuth on 2026-03-19 after "anthropic legal requests". omp, at 18.4.10, still offers `omp login anthropic` (a claude.ai OAuth flow) and an `ANTHROPIC_OAUTH_TOKEN` env var. On my reading, that appears to conflict with Anthropic's policy. ChatGPT-subscription login (OpenAI Codex OAuth) is offered by OpenCode and omp. I found no OpenAI primary-source policy page approving it.

### Cited Findings
- **Anthropic policy:**
  - OAuth "is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  - "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."
  - Developers "may not collect, store, or intermediate Claude.ai credentials or session tokens."
  - Source: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).
- **OpenCode:**
  - Auth: `opencode providers` (alias `auth`) with `list|login [url]|logout`. Credentials can also be set via `PUT /auth/:id`, and OAuth via `/provider/{id}/oauth/*`. Sources: LOCAL-HELP, [OpenCode server docs](https://opencode.ai/docs/server/).
  - PR #18186, "anthropic legal requests", was merged 2026-03-19 by thdxr. It removed the bundled `opencode-anthropic-auth` plugin, the "Claude Pro/Max" login option, the `claude-code-20250219` beta header, and the Anthropic system prompt file. A reviewer noted that third-party plugins can still work. Source: [opencode PR #18186](https://github.com/anomalyco/opencode/pull/18186).
  - ChatGPT Plus/Pro login: secondary sources say OpenCode added Codex OAuth around v1.1.11. Sources: [DevGenius](https://blog.devgenius.io/jump-ship-in-minutes-codex-oauth-now-works-in-opencode-d2708c32f571), [learnopencode](https://learnopencode.com/en/1-start/04h-openai). These are not official.
  - OpenCode also sells its own gateway ("OpenCode Zen/Go"), and omp refers to it via `OPENCODE_API_KEY`. Source: omp LOCAL-HELP.
- **omp:**
  - `omp login [provider]` gives OAuth for providers "e.g. anthropic, openai-codex". `omp token` prints a provider's API key or OAuth token. `ANTHROPIC_OAUTH_TOKEN` "takes precedence over API key". Sources: LOCAL-HELP, LOCAL-SRC `commands/login.ts:14`.
  - The Anthropic flow is declared with `authorize-url "https://claude.ai/oauth/authorize"`. The identity hook calls `/api/claude_cli/bootstrap` and imports `getClaudeCodeVersion` from `providers/claude-code-fingerprint`. Its file header reads "Anthropic (Claude Pro/Max) sign-in residue." Sources: LOCAL-SRC [pi-catalog rules/auth/anthropic.kdl](https://github.com/can1357/oh-my-pi/blob/v18.4.10/packages/catalog/src/compat/rules/auth/anthropic.kdl) and [pi-ai registry/oauth/anthropic.ts](https://github.com/can1357/oh-my-pi/blob/v18.4.10/packages/ai/src/registry/oauth/anthropic.ts). These permalink package paths are inferred from npm package names and were not verified in the repo.
  - Many other providers are supported: `COPILOT_GITHUB_TOKEN`, `CURSOR_ACCESS_TOKEN`, Bedrock, Vertex, and others. There is also an `auth-broker` credential vault and an `auth-gateway`. Source: LOCAL-HELP.
  - `--external-thinking` warns "providers have flagged this request shape as abuse". Source: LOCAL-HELP.
- **Aider:**
  - API keys come from env vars, `--api-key provider=key`, `--set-env`, or `.env`. Model selection runs through litellm. Source: LOCAL-HELP.
  - Aider has no subscription-OAuth login for Claude or ChatGPT in its help text. Source: LOCAL-HELP.

### Inferences
- Canopy should not drive omp with Anthropic subscription OAuth on users' behalf, and should not surface or encourage that path. It falls under "route requests through Free, Pro, or Max plan credentials". The safe options are API keys or a cloud provider. This is a policy interpretation, not legal advice.
- **What Canopy must build:**
  - A per-harness credential UX that steers users to API keys or their own provider credentials.
  - No credential intermediation, since Anthropic forbids collecting or storing Claude.ai tokens.

### Gaps
- I found no official OpenAI statement on third-party harness use of ChatGPT subscriptions.
- One secondary report says Claude subscriptions stopped covering third-party tools from April 4 (2026). Source: [WebSearch summary of Ars Technica syndication](https://chat.macaw.me/community/news.movim.eu/ArsTechnica/urn-uuid-77c8dede-cedc-5ddf-bdc3-a62decbe2d72). This is unverified.

## 13. Model switching

### Takeaway
All three switch models natively, both mid-session and by flag. OpenCode and omp also do it programmatically (API or RPC). Aider does it through slash commands typed into its PTY.

### Cited Findings
- **OpenCode: native.**
  - `-m provider/model` and `--variant` (reasoning effort). Source: LOCAL-HELP.
  - `/models` (`ctrl+x m`) and `ctrl+t` to cycle variants. Source: [OpenCode TUI docs](https://opencode.ai/docs/tui/).
  - Config keys `model` and `small_model`. Source: [OpenCode config docs](https://opencode.ai/docs/config/).
  - Headless: a per-prompt `model: {providerID, modelID}` in the `session.prompt` body. Source: [OpenCode SDK docs](https://opencode.ai/docs/sdk/). Also `/tui/open-models` and `GET /config/providers`. Source: [OpenCode server docs](https://opencode.ai/docs/server/).
  - `opencode models [provider] --refresh` reads from models.dev. Source: LOCAL-HELP.
- **omp: native.**
  - Flags: `--model` (fuzzy matching), role models `--smol/--slow/--plan`, `--models` (the Ctrl+P cycle list), `--thinking`, and `--prewalk`. Source: LOCAL-HELP.
  - `/model` and `/modelpreset`. Source: LOCAL-SRC slash commands.
  - RPC: `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`. Source: LOCAL-SRC rpc.
- **Aider: native (TUI).**
  - `--model`, `--weak-model`, `--editor-model`, `--alias`, `/model`, `/editor-model`, `/weak-model`, `/reasoning-effort`, `/think-tokens`. Sources: LOCAL-HELP, [Aider commands](https://aider.chat/docs/usage/commands.html).

### Inferences
- **What Canopy must build:**
  - Per-harness syntax adapters only. For Aider, type `/model <name>` into the PTY. There is no programmatic channel.

### Gaps
- None material.

## 14. Self-update mechanism (update command, auto-update, pinning, disabling)

### Takeaway
None of the three silently auto-installs by default. All have explicit update commands and version checks that can be disabled. Pinning works through the package manager or a target version (OpenCode `upgrade <ver>`).

### Cited Findings
- **OpenCode: native.**
  - `opencode upgrade [target]` with `-m curl|npm|pnpm|bun|brew|choco|scoop`. Source: LOCAL-HELP.
  - The docs mention `--major` (move to OpenCode 2), which is not in the 1.18.34 help. It is docs-ahead-of-binary. Source: [OpenCode CLI docs](https://opencode.ai/docs/cli/).
  - Config `autoupdate: true|false|"notify"`. Current docs say: "Updates are never installed automatically… Setting autoupdate to true or "notify" keeps the default behavior: you're notified." Source: [OpenCode config source (dev)](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/config.mdx).
  - Env vars `OPENCODE_DISABLE_AUTOUPDATE` and `OPENCODE_ALWAYS_NOTIFY_UPDATE`. Source: [OpenCode CLI docs](https://opencode.ai/docs/cli/).
  - Also `/update` in the TUI and the `installation.updated` plugin event. Sources: [OpenCode config source (dev)](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/config.mdx), [OpenCode plugins docs](https://opencode.ai/docs/plugins/).
- **omp: native.**
  - `omp update` with `--check`, `--force`, `--plugins`, `--canary`, and `--stable`. It uses the installer that owns the active binary (npm, bun, Homebrew `can1357/tap/omp`, or binary download). Sources: LOCAL-SRC `commands/update.ts`, `cli/update-cli.ts`.
  - Startup check: setting `startup.checkUpdate` (default true) only shows a notification banner. `update.channel` takes `stable|canary`. Plugin marketplace auto-update takes `off|notify|auto`. Sources: LOCAL-SRC `modes/settings.ts:1028-1045`, `main.ts:227-235, 690-696`, `extensibility/plugins/marketplace-auto-update.ts`.
- **Aider: native.**
  - `--upgrade/--update` (pip from PyPI), `--just-check-update` (result in the exit code), `--check-update/--no-check-update`, and `--show-release-notes`. Source: LOCAL-HELP.
  - It checks `https://pypi.org/pypi/aider-chat/json`, rate-limited by `~/.aider/caches/versioncheck`, and offers `install_upgrade` interactively. Source: LOCAL-SRC `versioncheck.py`.

### Inferences
- **What Canopy must build:**
  - Pinning policy: launch with `OPENCODE_DISABLE_AUTOUPDATE=1`, omp config `startup.checkUpdate: false`, and aider `--no-check-update`, so that Canopy-validated versions stay stable.
  - Its own update UI that runs the per-harness command.
  - This environment's omp launcher installs a pinned version on first run. That is an example of Canopy-side pinning.

### Gaps
- The "never installed automatically" wording comes from the `dev` docs. I did not confirm that 1.18.34 behaves the same way, since older OpenCode releases did auto-upgrade when `autoupdate: true`.

## 15. Clipboard / copy behaviour in the TUI, OSC 52, remote/SSH copy issues

### Takeaway
omp writes OSC 52 first and then native fallbacks (so it works over SSH). OpenCode does copy-on-select with OSC 52 and has known bugs (skipped native fallback; tmux passthrough wrapping that breaks over SSH). Aider uses pyperclip only, with no OSC 52, so `/copy` fails on headless or SSH hosts without xclip, xsel, or wl-clipboard.

### Cited Findings
- **OpenCode: native, with known issues.**
  - Copy-on-select exists and can be disabled with `OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT`. `OPENCODE_DISABLE_MOUSE` (or `mouse` config) gives back native terminal selection. Sources: [OpenCode CLI docs](https://opencode.ai/docs/cli/), [OpenCode TUI docs](https://opencode.ai/docs/tui/).
  - Issue #11996: after OSC 52 was added, the helper returns once the sequence is written and never falls back to osascript or xclip, so copy breaks where OSC 52 is disabled. Source: [opencode #11996](https://github.com/anomalyco/opencode/issues/11996).
  - Issue #25253: OSC 52 is wrapped in tmux DCS passthrough whenever tmux or screen is detected, which breaks copying over SSH when `allow-passthrough` is off. Source: [opencode #25253](https://github.com/anomalyco/opencode/issues/25253).
  - The 1.18.34 binary contains `pbcopy` and `wl-copy` strings. Source: LOCAL (strings on the binary; reverse-engineered).
- **omp: native.**
  - `copyToClipboard` "Emits OSC 52 first when running in a real terminal (works over SSH/mosh)" as `\x1b]52;c;<b64>\x07`, best-effort. It then uses pbcopy, PowerShell, wl-copy, or xclip. Source: LOCAL-SRC `utils/clipboard.ts:107-142`.
  - There is a `/copy` slash command. Source: LOCAL-SRC slash commands.
- **Aider: partial.**
  - `/copy`, `/copy-context`, and `/paste` all use `pyperclip`. `PyperclipException` is caught and reported. Sources: LOCAL-SRC `commands.py:11, 1299, 1522-1529, 1654`, [Aider commands](https://aider.chat/docs/usage/commands.html).
  - `--copy-paste` mode watches the clipboard (`copypaste.py`). Source: LOCAL-HELP.
  - There is no OSC 52 path in the source. Source: LOCAL-SRC grep.

### Inferences
- Canopy's xterm.js terminal must handle OSC 52 writes (the `ClipboardAddon` or equivalent) for omp and OpenCode copy to reach the host clipboard. Inside remote or VM workspaces, OSC 52 is the only working path.
- **What Canopy must build:**
  - OSC 52 handling in its terminal, ideally with a user-consent policy, and tmux passthrough-aware handling.
  - Aider: a Canopy "copy last assistant message" action that reads Aider's output or `.aider.chat.history.md` instead of `/copy`, which will fail on remote hosts without an X/Wayland clipboard.

### Gaps
- I did not check whether opencode #11996 or #25253 is fixed in 1.18.34. Their status was not retrieved.
- I did not confirm whether Canopy's terminal currently honors OSC 52. That requires a check in the Canopy repo, which is out of scope.

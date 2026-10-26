# Harness capability parity: Amp CLI vs Cursor Agent CLI (as of 2026-10-26)

**Versions examined.**
- **Amp:** `amp` **0.0.1790913650-g48ed1c** (released 2026-10-02), npm `@ampcode/cli`. It installs as a Bun-compiled ELF at `/usr/local/lib/node_modules/@ampcode/cli/bin/amp`.
- **Cursor:** `cursor-agent` **2026.10.01-e373342**, at `/opt/canopy/vendor/cursor/.local/share/cursor-agent/versions/2026.10.01-e373342/`.
  - **VERSION MISMATCH:** the brief pins **2026.10.22-27dcf5f**, but that build is NOT installed locally. Every local Cursor observation below comes from 2026.10.01. The official changelog was checked for 2026.10.02–10.22 deltas (see Gaps).

**Evidence labels used in every bullet.**
- **[DOC]**: official vendor docs or news page (URL given).
- **[CLI]**: official built-in help text from the installed binary (`--help`, `amp plugins show-docs`). This is official but has no URL; the command is named instead.
- **[RE]**: reverse-engineered from strings in the installed bundle (`cursor-agent` minified JS in `index.js`/`7000.index.js`; the `amp` binary). Not a public contract, and it may change without notice.
- **[FORUM]**: community or staff forum post.

Key doc URLs:
- Amp: https://ampcode.com/docs/cli/streaming-json, https://ampcode.com/docs/cli/execute-mode, https://ampcode.com/docs/threads, https://ampcode.com/docs/customize/agents-md, https://ampcode.com/docs/models-and-subagents, https://ampcode.com/docs/tools, https://ampcode.com/docs/plugin-api, https://ampcode.com/terms
- Cursor: https://cursor.com/docs/cli/overview, https://cursor.com/docs/cli/headless, https://cursor.com/docs/cli/reference/output-format, https://cursor.com/docs/cli/reference/permissions, https://cursor.com/docs/cli/reference/configuration, https://cursor.com/docs/cli/reference/slash-commands, https://cursor.com/docs/cli/acp, https://cursor.com/docs/hooks, https://cursor.com/docs/subagents, https://cursor.com/docs/agent/security/run-modes, https://cursor.com/docs/cli/installation, https://cursor.com/docs/cli/changelog

Context: Canopy's August 2026 audit (`docs/agent-parity.md`) recorded the following for Amp:
- plugin-based hooks
- no verified permission-request event
- server-side threads with "no local transcript store"
- token/cost only in `--stream-json`
- model chosen through modes
- not eligible for the Build headless runner

Cursor is absent from that audit. `src/structuredEvents.ts` already parses a `"cursor"` dialect: `system/init`, `assistant`, `tool_call/started`, and `result`.

---

## 1. Headless/structured mode: non-interactive run, streaming JSON events, system-prompt support, tool allow/deny, plan mode, resume-by-id.

### Takeaway
Both CLIs have native non-interactive runs, NDJSON streaming and resume-by-id.
- **Amp's stream** is Claude-Code-compatible, takes JSONL input on stdin and carries usage.
- **Cursor's stream** is a Claude-like but distinct dialect, and adds a native `--plan`/`--mode` flag.
- **Neither** offers a supported per-run system-prompt flag. Amp approximates one with plugins or custom agent modes.
- **Tool allow/deny:** settings or config only on both. Cursor's `--allowed-tools` exists but is hidden and marked "internal only".

### Cited Findings
**Amp (support: native for run/stream/resume; partial for system prompt and tool allow/deny; none for plan mode)**
- **Non-interactive run:**
  - `-x/--execute [message]` runs the prompt (argument or stdin), prints the last assistant message and exits.
  - Redirecting stdout enables execute mode automatically.
  - `-ox/--orb-execute` runs the turn in a remote orb.
  - [CLI] `amp --help`; [DOC] https://ampcode.com/docs/cli/execute-mode
- **Streaming:**
  - `--stream-json` (requires `--execute`) emits "Claude Code-compatible stream JSON".
  - `--stream-json-thinking` adds thinking blocks. This is a non-Claude extension.
  - `--stream-json-input` reads JSONL user messages from stdin (requires both `-x` and `--stream-json`).
  - [CLI] `amp --help`
- **Event shapes** (one JSON object per line):
  - `system/init`: `cwd`, `session_id`, `tools[]`, `mcp_servers[{name,status}]`, optional `agent_mode`, and `subagents[{tool_use_id,description}]`
  - `user`: `message.content` holds `text`/`tool_result`, plus `parent_tool_use_id`, `session_id` and optional `subagent_tool_use_id`
  - `assistant`: `message.content` holds `text`/`tool_use`/`thinking`, plus `stop_reason`, optional `usage`, `parent_tool_use_id` and `session_id`
  - `system/subagent_finished`: `tool_use_id`, `status: completed|failed|cancelled`
  - `system` error subtypes: `error_max_turns|error_during_execution`
  - `result/success`: `duration_ms`, `duration_api_ms?`, `is_error`, `num_turns`, `result`, `session_id`, `usage?`, `permission_denials?`
  - `result` error: `is_error: true`, `error`
  - [DOC] https://ampcode.com/docs/cli/streaming-json
- **Input shape:** `{"type":"user","steer"?:bool,"message":{"role":"user","content":[text|image(base64)]}}`.
  - Messages sent while the agent is busy are queued.
  - `steer:true` asks Amp to handle the message at the next interruption point.
  - Async subagents keep the process alive. "`result` is the only signal that the run is over."
  - [DOC] https://ampcode.com/docs/cli/streaming-json
- **Resume-by-id:**
  - `amp threads continue <T-id|URL> -x "..." --stream-json`
  - `amp threads continue --last`
  - `amp last`
  - `amp threads new` creates an empty thread and prints its URL, so the id can be pre-allocated.
  - [CLI] `amp threads continue --help`, `amp threads new --help`; [DOC] https://ampcode.com/docs/cli/streaming-json
- **System prompt:** no `--system-prompt` flag exists. The alternatives are:
  - `-m/--mode` selects built-in (`low|medium|high|ultra`) or plugin modes that "control the model, system prompt, and tool selection" [CLI] `amp --help`.
  - Plugin `amp.createAgent({extends, instructions, tools, model, reasoningEffort, compactionThresholdTokens})` appends `instructions` to the base prompt [CLI] `amp plugins show-docs`.
  - Plugin `agent.start` handlers can append a hidden message to the user turn (`AgentStartResult.message`) [CLI] `amp plugins show-docs`.
- **Tool allow/deny:**
  - Settings keys `amp.tools.enable` (glob allowlist) and `amp.tools.disable` (with a `builtin:` prefix) [CLI] `amp --help`.
  - `amp.permissions` rules `{tool, action: allow|reject|ask|delegate, matches}` [CLI] `amp permissions add --help`.
  - Per-invocation overrides go through `--settings-file <path>` or `AMP_SETTINGS_FILE` (no per-tool flag).
  - Execute mode refuses unapproved tools with "Rerun with --dangerously-allow-all to bypass". That hidden flag is referenced in error strings but not in `--help` [RE].
- **Plan mode:** no plan/read-only flag in `--help`. Plugin-defined modes with restricted tools are the only route [CLI].
- **Other headless switches:**
  - `--plugin-ready-timeout` (so `agent.start/agent.end` hooks aren't skipped)
  - `--no-archive-after-execute`
  - `--title`
  - `-l/--label`
  - `--timings` [DOC] https://ampcode.com/docs/cli/execute-mode

**Cursor (support: native for run/stream/plan/resume; partial for tool allow/deny; none for system prompt)**
- **Non-interactive run:** `-p/--print` with `--output-format text|json|stream-json` and `--stream-partial-output` [CLI] `cursor-agent --help`.
  - "Without --force, changes are only proposed, not applied" [DOC] https://cursor.com/docs/cli/headless
- **Event shapes:**
  - `system/init`: `apiKeySource`, `cwd`, `session_id`, `model`, `permissionMode`
  - `user`
  - `assistant`: `message.content[{type:"text"}]`, optional `timestamp_ms`/`model_call_id`
  - `tool_call/started|completed`: `call_id`, `tool_call` holding tool-specific objects such as `readToolCall`/`writeToolCall`, and `result.success`
  - `result/success`: `duration_ms`, `duration_api_ms`, `is_error`, `result`, `session_id`, `request_id`
  - Partial-delta de-duplication: append deltas that have `timestamp_ms` but no `model_call_id`; skip the flushes.
  - [DOC] https://cursor.com/docs/cli/reference/output-format
- **Undocumented events in 2026.10.01:**
  - `retry`, `connection` (subtype + `session_id` + `timestamp_ms`)
  - a `resuming` connection event with `checkpoint_turn_count`
  - an optional `usage` object on `result`
  - [RE] `7000.index.js`
- **Plan mode:** `--mode plan|ask`, `--plan`; interactive `/plan`, `/ask`, Shift+Tab [CLI] `cursor-agent --help`; [DOC] https://cursor.com/docs/cli/overview
- **Resume-by-id:**
  - `--resume [chatId]`, `--continue`
  - `cursor-agent ls`, `cursor-agent resume`
  - `cursor-agent create-chat` returns a new empty chat ID for pre-allocation.
  - [CLI] `cursor-agent --help`
- **System prompt:** no flag in public help or docs. The bundle exposes only `CURSOR_RULES`-type context and a hidden option that excludes workspace context (rules, skills, transcripts, notes) [RE]. Treat this as none.
- **Tool allow/deny:**
  - `permissions.allow/deny` tokens `Shell(cmd[:args])`, `Read(glob)`, `Write(glob)`, `WebFetch(domain)`, `Mcp(server:tool)`.
  - These go in `~/.cursor/cli-config.json` or `<project>/.cursor/cli.json`, and deny wins [DOC] https://cursor.com/docs/cli/reference/permissions
  - Hidden `--allowed-tools <tool>`: "Allow only proto ToolCall oneof tool(s) for this session (internal only…)" [RE] `index.js`
- **Other headless switches:**
  - `--force/--yolo`, `--auto-review`, `--sandbox enabled|disabled`, `--approve-mcps`, `--trust`
  - `--workspace`, `--add-dir`, `--plugin-dir`
  - `-w/--worktree [name]`, `--worktree-base`
  - `--api-key`, `-H/--header`, `-e/--endpoint`
  - [CLI] `cursor-agent --help`
- **Canopy's existing `cursor` dialect** handles `system/init`, `assistant` text, `tool_call/started` and `result` [local] `src/structuredEvents.ts`.

### Inferences
- **Amp:** a Build runner is feasible today with `-x --stream-json --stream-json-input` plus `threads continue` for resume.
  - It can reuse the Claude dialect parser almost unchanged, plus handlers for `subagent_finished`, `num_turns` and `permission_denials`.
- **Cursor:** a Build runner is feasible with `-p --output-format stream-json --stream-partial-output --force|--sandbox enabled --trust --approve-mcps`, plus `--resume`.
  - The existing dialect needs `tool_call/completed`, `retry`/`connection`, and the delta de-duplication rule.
- **System prompt, both CLIs:** the IDE must build its own injection.
  - **Amp:** generate a plugin mode or agent (`createAgent({extends:"medium", instructions})` selected via `-m <key>`), or use an `agent.start` plugin that appends context.
  - **Cursor:** inject the prompt into the first user message, or write a temp `.cursor/rules/*.mdc` / `AGENTS.md`.
- **Per-run tool allow/deny:** the IDE must build it.
  - **Amp:** write a temp settings file (`--settings-file`) holding `amp.tools.enable`/`amp.permissions`.
  - **Cursor:** write a project `.cursor/cli.json`, or use `preToolUse` hooks. The hidden `--allowed-tools` is internal, so don't depend on it.
- **Plan mode for Amp:** the IDE must build it as a read-only plugin mode (tools restricted to read/search) or keep its own plan prompt.

### Gaps
- Exit codes are documented for neither CLI.
- Whether `--dangerously-allow-all` is supported as public API for Amp is unconfirmed. It is not in `--help`.
- Cursor's `usage` field on `result` was not observed live because no authenticated run was made.

## 2. Checkpoints / rewind / undo.

### Takeaway
- **Cursor:** native interactive `/rewind` restores conversation and file state ("checkpoints"), plus `/fork`. It is gated by the `rewind` config key, with no headless or programmatic API.
- **Amp:** no documented rewind or checkpoint feature in the current CLI or docs. Treat it as none.

### Cited Findings
- **Cursor `/rewind`:** "Jump back to a previous message" [DOC] https://cursor.com/docs/cli/reference/slash-commands
  - Config `rewind`: "enables `/rewind` to restore an earlier message" [DOC] https://cursor.com/docs/cli/reference/configuration
  - It restores file history too. The bundle has the strings "File history is unavailable for this checkpoint — only the conversation can be restored" and "Rewound conversation only — file history is unavailable for this checkpoint" [RE] `7000.index.js`.
  - Local `~/.cursor/cli-config.json` has `"rewind": true` [local].
- **Cursor stream on reconnect:** emits `connection/resuming` with `checkpoint_turn_count` [RE].
- **Amp:** the threads docs cover handoff and export but not undo, rewind or checkpoints [DOC] https://ampcode.com/docs/threads
  - A binary string search found only "Undo last prompt edit" (prompt text editing), no file revert [RE].
  - The plugin API has no undo/restore methods [CLI] `amp plugins show-docs`.

### Inferences
- **IDE must build:** Canopy's own git-based checkpointing (shadow commits or stash per turn, keyed on Amp `agent.end` and Cursor `stop` hooks) is required for Amp entirely.
  - It is also required for Cursor whenever a headless/programmatic rewind is needed, because `/rewind` is TUI-only.
- **Cursor TUI sessions:** Canopy can leave native `/rewind` enabled.

### Gaps
- Whether Amp's web or TUI client has a message-edit "restore" feature in this build is unconfirmed. Older Amp releases had edit-and-restore; no current doc found.
- Cursor checkpoint storage format is not documented. It is presumably inside the chat `store.db`.

## 3. IDE integration protocol (selection, diagnostics, diffs from a host IDE).

### Takeaway
- **Amp:** native host-IDE link (`--ide`, on by default) through a local WebSocket plus lockfile under `~/.local/share/amp/ide`. It shares the current file, selection and diagnostics, and can edit through the IDE. The wire protocol is unpublished.
- **Cursor:** no reverse "connect to my IDE" channel, but it runs as an ACP server (`agent acp`, hidden from `--help`). There the host IDE is the client and supplies fs/terminal and permission UI.

### Cited Findings
- **Amp flags:** `--ide` (default) / `--no-ide`: "Amp automatically includes your open IDE's file and text selection with every message" [CLI] `amp --help`
- **Amp connection:**
  - Requires the Amp VS Code extension or `amp.nvim`.
  - The CLI then gets "the current file, selected text, and diagnostics" and "can edit files directly through your IDE".
  - Announced 2025-09-30 [DOC] https://ampcode.com/news/cli-vscode-neovim
- **amp.nvim protocol:**
  - Uses a "local WebSocket protocol".
  - Lockfile dir is `~/.local/share/amp/ide` (Linux: `$XDG_DATA_HOME/amp/ide`), overridable via `AMP_DATA_HOME`.
  - Exposes Lua `send_message`/`send_to_prompt` and a `get_diagnostics` tool.
  - [DOC] https://github.com/sourcegraph/amp.nvim
- **Amp binary strings:** reference `JetBrains`, `Zed`, `Neovim`, `ide.jetbrainsExtension`, `editorContextSent`, `openFile` and `visibleFiles` [RE].
- **Cursor ACP:**
  - `agent acp` speaks JSON-RPC 2.0 over stdio.
  - Methods: `initialize`, `authenticate(cursor_login)`, `session/new`, `session/load`, `session/prompt`, `session/cancel`.
  - It sends `session/update` and `session/request_permission` (allow-once/allow-always/reject-once).
  - Extensions: `cursor/ask_question`, `cursor/create_plan`, `cursor/update_todos`, `cursor/task`, `cursor/generate_image`.
  - Modes: agent/plan/ask.
  - Clients: JetBrains, Zed, avante.nvim.
  - Team-dashboard MCP servers are unsupported in ACP.
  - [DOC] https://cursor.com/docs/cli/acp
- **ACP visibility:** marked `{hidden:!0}` in the CLI command tree [RE] `index.js`.
  - Changelog: "ACP: clients that support subagents receive each one as a child session" (v2026.09.15); background shells can wake the agent (v2026.10.08) [DOC] https://cursor.com/docs/cli/changelog

### Inferences
- **Amp, IDE must build:** a Canopy-side emulation of the Amp IDE WebSocket server, by reverse-engineering amp.nvim's Lua source to publish selection/diagnostics/visible files. Otherwise, pass context in prompt text or through Canopy's MCP tools (`canopy_editor_state`, `canopy_diagnostics`).
  - Pass `--no-ide` to avoid conflicts with a user's VS Code.
  - Pinning is risky because the protocol is undocumented.
- **Cursor:** Canopy can act as an ACP client, getting a structured session, permission prompts and diffs via `fs/writeTextFile`. This is a richer integration than the PTY.
  - Selection and diagnostics are not pushed by Cursor. The IDE must supply them as prompt context or through MCP.

### Gaps
- Amp's WebSocket message schema and lockfile JSON fields could not be verified. They are not in public docs, and the amp.nvim `lua/amp` source was not read.
- Whether ACP `session/load` accepts IDs from `--resume` / `ls` is unverified.

## 4. Hooks / lifecycle events / plugins.

### Takeaway
- **Cursor:** native, Claude-style shell hooks (`hooks.json`, about 18 agent events with allow/deny/ask output and exit-code 2 = block) plus plugins.
- **Amp:** native in-process TypeScript plugins (Bun) with 6 events: `session.start`, `agent.start`, `agent.end`, `tool.call` (allow/reject/modify/synthesize), `tool.result`, `changes.prompt`. A thread-state observable now includes `awaiting-approval`.

### Cited Findings
**Amp**
- **Plugin locations:**
  - Plugins are `.ts` files executed with Bun.
  - Locations: `.amp/plugins/*.ts` (project), `~/.config/amp/plugins/*.ts` (system), and global workspace plugins (experimental).
  - Reload with `plugins: reload` [CLI] `amp plugins show-docs`.
- **Event map:** `'session.start' | 'tool.call' | 'tool.result' | 'agent.start' | 'agent.end' | 'changes.prompt'`.
  - `tool.call` returns `{action:'allow'} | {action:'reject-and-continue',message} | {action:'modify',input} | {action:'synthesize',result:{output,exitCode?}} | {action:'error',message}`.
  - `ToolCall` payload: `{toolUseID, tool, input, thread:{id}}`.
  - `ToolResult` payload: `{…, status:'done'|'error'|'cancelled', error?, output?}`.
  - `AgentEndEvent.status`: `done|error|cancelled`.
  - [CLI] `amp plugins show-docs` (doc lastmod 2026-09-01)
- **Thread API:** `ctx.thread.state` is an `Observable<'idle'|'running'|'awaiting-approval'|'error'>`, alongside `messages()`, `append()`, `appendUserMessage({steer})`, `cancel()` and `waitForResponse()` [CLI] `amp plugins show-docs`.
- **Other plugin capabilities:** `registerTool`, `registerCommand`, `registerSkill`, `createWebhook`, `createAgent`, `ctx.ui.confirm/select/input/notify`, and `amp.ai.ask` [CLI].
- **Testing:** `amp plugins exec <plugin> <event> --data <json>` drives a plugin with a synthetic event [CLI] `amp plugins exec --help`.

**Cursor**
- **`hooks.json` locations:** Enterprise `/etc/cursor/hooks.json` (Linux), team dashboard, project `.cursor/hooks.json`, user `~/.cursor/hooks.json`; plugin hooks load last.
- **Schema:** `{version:1, hooks:{<event>:[{command, type:"command"|"prompt", timeout, loop_limit, failClosed, matcher}]}}`.
- **Agent events:**
  - `sessionStart`, `sessionEnd`
  - `preToolUse`, `postToolUse`, `postToolUseFailure`
  - `subagentStart`, `subagentStop`
  - `beforeShellExecution`, `afterShellExecution`
  - `beforeMCPExecution`, `afterMCPExecution`
  - `beforeReadFile`, `afterFileEdit`
  - `beforeSubmitPrompt`, `preCompact`, `stop`
  - `afterAgentResponse`, `afterAgentThought`
  - plus `workspaceOpen` and the Tab hooks
- **Stdin payload:** `conversation_id`, `generation_id`, `hook_event_name`, `workspace_roots`, `transcript_path`, `model`, `cursor_version`, `user_email`.
- **Hook output:** `permission: allow|deny|ask`, `user_message`, `agent_message`, `continue`, `updated_input`, `followup_message`, `additional_context`.
- **Exit codes:** exit 2 blocks the action. Other non-zero codes fail open unless `failClosed`.
- [DOC] https://cursor.com/docs/hooks
- **CLI support:** the docs say little about the CLI explicitly, but the 2026.10.01 bundle contains a hook executor for `preCompact`, `subagentStart` and the full event enum [RE] `index.js`.
  - Changelog: "Hooks: plugin-defined hooks now run" (v2026.08.11); `postToolUse`/`postToolUseFailure` fire for subagents (v2026.10.17) [DOC] https://cursor.com/docs/cli/changelog
- **Plugins:** `cursor-agent plugin marketplace …` and `--plugin-dir <path>` [CLI].

### Inferences
- **Cursor:** maps almost 1:1 onto Canopy's existing Claude `canopy-hook` pipeline. Write `~/.cursor/hooks.json` entries pointing at `canopy-hook` and normalize the camelCase event names.
  - `afterFileEdit` gives shared-checkout file attribution.
  - `beforeShellExecution`/`preToolUse` with `permission:"ask"` could surface a blocked state. Note that "ask isn't enforced for preToolUse".
- **Amp:** the August audit's claim of "no verified permission-request event" is now partly outdated.
  - `thread.state` emitting `awaiting-approval` gives a blocked signal.
  - IDE work: subscribe in the Canopy plugin at `session.start` and forward state changes.
- **Amp file attribution:** derive it from `tool.result` `input` for edit tools. The IDE must still verify tool-argument shapes, as the audit noted.

### Gaps
- Exact Amp built-in edit tool names and argument shapes were not captured: `amp tools list` hung without auth.
- `changes.prompt` payload semantics were not read in detail.

## 5. Permission modes and OS sandbox.

### Takeaway
- **Cursor:** native allowlist / auto-review / run-everything modes plus a real OS sandbox: Seatbelt on macOS, Landlock+seccomp on Linux (shipped as the `cursorsandbox` helper), with network domain policy.
- **Amp:** native permission rules (allow/reject/ask/delegate to an external program) and guarded files, but no OS sandbox for local execution. Isolation comes from remote "orbs".

### Cited Findings
**Amp**
- **Rules:** `amp.permissions` is an ordered list of `{tool, action:"allow"|"reject"|"ask"|"delegate", matches:{cmd:[globs]}, context?:"thread"|"subagent"}`.
  - `delegate --to <program>` hands the decision to an external program.
  - Managed with `amp permissions list|test|edit|add` and `--workspace` scope.
  - [CLI] `amp permissions add --help`, `amp --help`
- **Other keys and defaults:**
  - `amp.dangerouslyAllowAll` disables all prompts.
  - `amp.guardedFiles.allowlist` overrides the built-in guarded-file denylist [CLI] `amp --help`.
  - "By default, Amp does not ask for approval before running tools"; tighter control is pointed at a custom plugin [DOC] https://ampcode.com/docs/tools
  - Conflict: CLI error strings reference a command allowlist and approval requirements in execute mode [RE]. In effect, defaults are permissive interactively, but tools needing approval are refused in `-x` without UI.
- **Isolation:** no local OS-sandbox flag or setting appears in help. Isolation is via `--executor orb` / `-ox` remote machines [CLI] `amp --help`.

**Cursor**
- **Modes:**
  - `approvalMode: allowlist|auto-review|unrestricted` [DOC] https://cursor.com/docs/cli/reference/configuration
  - Flags: `--force/--yolo` (Run Everything), `--auto-review` (server classifier), `--sandbox enabled|disabled` [CLI].
  - Auto-review "is not a security boundary" [DOC] https://cursor.com/docs/agent/security/run-modes
- **Sandbox mechanism:**
  - macOS: Seatbelt (`sandbox-exec`).
  - Linux: Landlock (kernel ≥6.2, Landlock v3, unprivileged userns) plus seccomp, with a Bubblewrap fallback. Without these it falls back to approval prompts.
  - Protected paths include `.git/config`, `.git/hooks`, `.vscode`.
  - Network modes: sandbox.json-only, sandbox.json+defaults (default), or allow-all.
  - The CLI does not ship the AppArmor profile.
  - `sandbox.readBoundary: system|workspace` [DOC] https://cursor.com/docs/agent/security/run-modes
- **Local install:** contains a `cursorsandbox` binary, a hidden `cursor-agent sandbox enable|disable|reset|run` command, and env `CURSOR_SANDBOX_POLICY_DIR` / `CURSOR_FORCED_SHELL_EGRESS_*` [RE].
  - Local config: `"approvalMode":"allowlist"`, `"sandbox":{"mode":"disabled","networkAccess":"user_config_with_defaults"}` [local `~/.cursor/cli-config.json`].
- **Workspace trust:** `--trust` skips the trust prompt; `--approve-mcps` auto-approves MCP [CLI].

### Inferences
- **Cursor:** can be the first non-Codex harness with an OS-backed workspace boundary for Canopy Build, via `--sandbox enabled` on Linux/macOS. Canopy should detect Landlock availability, because Cursor silently falls back to prompting.
- **Amp, IDE must build:** its own OS sandbox (bwrap/Landlock/Seatbelt wrapper around the `amp` process, or Canopy remote VMs) for any boundary guarantee.
  - Use `amp.permissions` with `delegate --to canopy-permission-helper` to route approvals into Canopy UI. The delegate protocol (stdin/exit codes) still needs verification.

### Gaps
- The Amp `delegate` program protocol is not documented in what was fetched; `ampcode.com/docs/tools#permissions` lacked it.
- Windows sandbox for Cursor is not documented.

## 6. Sessions/threads: list, resume, fork, transcript location/format.

### Takeaway
- **Amp:** threads are server-side (ampcode.com, `T-…` IDs). It has list/search/continue/export(JSON)/markdown/import CLI commands, but no fork and no local transcript.
- **Cursor:** sessions are local.
  - SQLite `store.db` per chat at `join(<root>, "chats", md5(resolve(cwd)), <chatId>)`. Unverified whether `<root>` is `~/.cursor` or a separate data dir (`CURSOR_CONFIG_DIR`/`CURSOR_DATA_DIR` both exist). No `chats/` exists locally because no sessions have been run.
  - A JSONL transcript per conversation under `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, also exposed as `transcript_path` in hooks.
  - It has `ls`/`resume`/`--resume` and interactive `/fork`, but no JSON list command.

### Cited Findings
**Amp**
- **Commands:**
  - `amp threads list [--json --limit --offset --include-archived]`, `threads search`
  - `threads continue [ids…|--last]`
  - `threads export <id>` (full JSON), `threads markdown`, `threads raw`
  - `threads rename|archive|delete|label|share|visibility`
  - `threads import codex|claude` (read-only import)
  - [CLI] `amp --help`, `amp threads list --help`
- **Storage:** "Each thread has a URL `https://ampcode.com/threads/T-…`" that opens the same thread on web, CLI and apps. Export is via `.md` URL suffix or More Actions → Export (JSON for creator) [DOC] https://ampcode.com/docs/threads
  - No fork command appears [DOC][CLI].
  - Plugin `ThreadID = T-${string}`; `thread.messages({full:true})` reads the transcript including compacted-away messages [CLI] `amp plugins show-docs`.

**Cursor**
- **Commands:** `cursor-agent ls`, `resume`, `--resume [chatId]`, `--continue`, `create-chat`; slash `/resume`, `/fork` ("Fork the current chat into a new session"), `/rename`, `/copy-conversation-id` [CLI]; [DOC] https://cursor.com/docs/cli/reference/slash-commands
- **Storage paths:**
  - Chats root `join(configDir,"chats")`, with per-workspace dir `md5(resolve(cwd))`, holding `store.db` (SQLite via better_sqlite3) [RE] `3190.index.js`, `7000.index.js`.
  - Transcripts at `${projectDir}/agent-transcripts/<conversationId>/<conversationId>.jsonl` [RE] `7000.index.js`.
  - Hooks receive `transcript_path` ("null if transcripts are disabled") [DOC] https://cursor.com/docs/hooks
  - Subagent transcripts are saved under the parent conversation folder (v2026.10.17) [DOC] https://cursor.com/docs/cli/changelog
- **Session survival:** `cursor-agent persist [list|attach|stop]` survives terminal or SSH disconnects (v2026.08.26) [CLI]; [DOC] changelog.

### Inferences
- **Amp:** session digests and restore must come from the `amp threads export` JSON (network call, auth required) or the plugin `messages()`. There is no offline store.
  - IDE must build: a local cache of exported threads, and its own fork, implemented as "new thread + seeded handoff summary".
- **Cursor:** Canopy can parse the JSONL transcripts for digests.
  - IDE must build: a session list (`ls` is an interactive picker with no `--json`) by scanning `~/.cursor/chats` or `projects/*/agent-transcripts`. This is reverse-engineered and fragile.

### Gaps
- The Cursor JSONL record schema was not observed, because no sessions exist locally.
- Whether Cursor `/fork` is accessible headlessly is unknown.

## 7. Subagents / parallel tasks.

### Takeaway
- **Both:** native subagents.
- **Amp:** Task (sync or async) plus Oracle, Librarian, Read Thread and Painter. Async state is surfaced in stream-json, and plugins can create custom agents and child threads.
- **Cursor:** built-in Explore/Browser, custom `.cursor/agents/*.md` (also reads `.claude/agents`/`.codex/agents`), parallel Task calls, background subagents, and subagent hooks.

### Cited Findings
- **Amp subagent types:**
  - Task carries out work end to end and runs in parallel in isolated contexts. Only the final summary returns. Read Thread summarises other threads [DOC] https://ampcode.com/docs/models-and-subagents
  - Oracle and Librarian are invocable by name; Painter generates images [DOC] https://ampcode.com/docs/tools
- **Amp async Task:**
  - Task `mode:"async"` keeps running past process exit.
  - `init.subagents` and `system/subagent_finished` report status; `parent_tool_use_id`/`subagent_tool_use_id` tag events [DOC] https://ampcode.com/docs/cli/streaming-json
- **Amp plugin control:** `createAgent` with `subagents`/`oracle` model pins; tools `create_thread`, `get_thread_status`, `send_thread_message`, `wait_for_threads`; `parentThreadID()` [CLI] `amp plugins show-docs`.
- **Cursor built-ins and custom agents:**
  - Built-ins are Explore and Browser.
  - Custom agents live in `.cursor/agents/`, `~/.cursor/agents/`, `.claude/agents/`, `.codex/agents/`, with frontmatter `name`, `description`, `model` (inherit), `readonly`, `is_background`.
  - Background output goes to `~/.cursor/subagents/`.
  - Multiple Task calls run in parallel; available in CLI [DOC] https://cursor.com/docs/subagents
- **Cursor config and events:**
  - Config `exploreSubagentModel` [local cli-config].
  - Hooks `subagentStart`/`subagentStop` [DOC] https://cursor.com/docs/hooks
  - ACP child sessions per subagent (v2026.09.15) [DOC] changelog.
- **Cursor worktrees:** `-w/--worktree` creates an isolated worktree under `~/.cursor/worktrees/<repo>/<name>` with `.cursor/worktrees.json` setup scripts [CLI].

### Inferences
- **Native is sufficient** inside each harness. Canopy needs only rendering, using `parent_tool_use_id` (Amp) and `subagentStart/Stop` (Cursor).
- **Cross-harness parallelism stays Canopy-built:** multiple tabs/worktrees, mesh.

### Gaps
- The Cursor stream-json representation of subagent events is not documented.

## 8. Context compaction / summarize / handoff.

### Takeaway
- **Amp:** native auto-compaction (configurable threshold for plugin agents) and native "handoff" (a new thread carrying context), but no explicit compact command found.
- **Cursor:** native `/summarize` (alias `/compress`), auto-summarization, a `preCompact` hook, and `&`-prefix Cloud Agent handoff.

### Cited Findings
- **Amp auto-compaction:**
  - `CreateAgentConfig.compactionThresholdTokens`: "Estimated input-token count at which Amp automatically compacts the thread".
  - After compaction, `messages()` returns "the latest compaction summary … followed by the messages after the compaction cut" [CLI] `amp plugins show-docs`.
  - Binary settings strings: "Automatically compact conversation when context fills", "Precompute the compaction summary in the background" [RE].
  - Context inspection: `amp threads context <id>` (alias analyze-context) [CLI].
- **Amp handoff:** asking the agent to "Handoff and …" starts a new thread with the relevant context [DOC] https://ampcode.com/docs/threads
- **Cursor summarize:**
  - `/summarize` "Summarize the conversation to reduce context. `/compress` is an alias" [DOC] https://cursor.com/docs/cli/reference/slash-commands
  - `preCompact` hook payload includes `conversation_id`, `generation_id`, `model`, `messages_to_compact`, `is_first_compaction`; it may return `user_message` [RE] `index.js`; [DOC] https://cursor.com/docs/hooks
  - "Summarization: the latest request is kept verbatim after summarizing" (v2026.09.22) [DOC] changelog.
- **Cursor cloud handoff:** prefix a message with `&` to hand it to a Cloud Agent [DOC] https://cursor.com/docs/cli/overview

### Inferences
- **Use native compaction for both.**
- **IDE must build (Amp):** a trigger for compaction from the IDE (no command found). Use the "Handoff and …" prompt or a new thread seeded with Canopy's digest.
- **IDE must build (cross-harness):** handoff (Amp↔Cursor↔Claude), e.g. Canopy's `teamMessaging/handoff.ts`, since neither CLI imports other harness sessions. Amp does import Codex/Claude transcripts read-only via `threads import`.

### Gaps
- Whether Amp exposes a manual compact command or settings key in this build is unconfirmed.

## 9. Usage, cost and model reporting.

### Takeaway
- **Amp:** native and programmatic usage.
  - `usage` objects in stream-json
  - `amp threads usage <id> --details` (credits, tokens, model, tool usage per thread)
  - `amp usage --details` (account balance)
  - `amp.showCosts` in the TUI
- **Cursor:** partial.
  - Interactive `/usage` (plan/on-demand) and a model name in `system/init`.
  - The documented stream has no usage; the 2026.10.01 binary attaches optional `usage` to `result`.
  - Hooks payloads carry `model`.

### Cited Findings
- **Amp stream usage:** `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_5m/1h_input_tokens`, `max_tokens`, `service_tier`, on `assistant` and `result` [DOC] https://ampcode.com/docs/cli/streaming-json
- **Amp CLI usage commands:**
  - `amp threads usage <thread> [--details --start --end]`: "Show display cost information… detailed credit, token, model, and tool usage".
  - `amp usage [--details]`: "current Amp usage and credit balance" [CLI].
  - Per-thread cost appears in the More Actions menu [DOC] https://ampcode.com/docs/threads
- **Cursor stream:** `system/init` has `model`; `result` has no documented `usage` [DOC] https://cursor.com/docs/cli/reference/output-format
  - The binary writes `...oe?{usage:oe}:{}` into `result` [RE] `7000.index.js`.
  - Protobuf usage messages contain `total_input_tokens`, `total_output_tokens`, `total_cache_write_tokens`, `total_cache_read_tokens`, `total_cost_cents` [RE].
- **Cursor interactive and models:** `/usage` "Show plan and on-demand usage" [RE]. It is not in the official slash-command list, so it may be gated.
  - `cursor-agent models` / `--list-models` [CLI]; `about --format json`, `status --format json` [CLI].
  - Hooks include `model`, `model_id`, `model_params` [DOC] https://cursor.com/docs/hooks

### Inferences
- **Amp:** the audit's "token/cost/model tray: –" can be upgraded. Poll `amp threads usage <T-id> --details` (thread id via plugin `session.start`) for interactive tabs, and use stream `usage` in Build.
  - Output format is human text unless a JSON flag exists (none seen), so the IDE must parse text or call it per turn.
- **Cursor, IDE must build:** a usage source of its own.
  - Read the model from hooks/`init`.
  - Treat `result.usage` as best-effort and undocumented.
  - Cost needs Canopy's price table or the account `/usage` (no CLI JSON).

### Gaps
- Exact text or JSON output of `amp threads usage` was not observed (needs auth).
- Field names inside Cursor `result.usage` are unverified.

## 10. Memory and instruction files (AGENTS.md, .cursor/rules, etc.).

### Takeaway
- **Both:** native and rich.
- **Amp files:**
  - `AGENTS.md` (fallback `AGENT.md`/`CLAUDE.md`) in cwd and parents up to `$HOME`
  - subtree files loaded on read
  - `~/.config/amp/AGENTS.md`, `~/.config/AGENTS.md`, system `/etc/ampcode/AGENTS.md`
  - `@`-mentions with `globs` front matter
  - skills (including `.claude/skills`)
- **Cursor files:** `.cursor/rules/**/*.mdc`, `AGENTS.md`, `CLAUDE.md`/`CLAUDE.local.md`, `.cursorrules`, `.cursorignore`, plus nested AGENTS.md and team rules.
- **Persistent "memory":** native in neither CLI (Cursor's agent-notes are partial; see Inferences).

### Cited Findings
- **Amp guidance files:**
  - Precedence, subtree inclusion, system paths, `$HOME/.config/amp/AGENTS.md`, `$HOME/.config/AGENTS.md`.
  - Workspace-admin Global AGENTS.md.
  - `AMP_IGNORE_GUIDANCE_FILES` (colon globs; `*` disables).
  - `@` includes with `globs` front matter.
  - [DOC] https://ampcode.com/docs/customize/agents-md
- **Amp skills:** settings `amp.skills.path`, `amp.skills.disableClaudeCodeSkills`, `amp.skills.disableGlobalAgentsSkills`; skill sources include `~/.config/amp/skills/`, `.agents/skills/`, `.claude/skills/` [CLI] `amp --help`.
- **Cursor file watch list:** `[".cursor/rules/**/*.mdc","AGENTS.md","CLAUDE.md","CLAUDE.local.md",".cursorrules",".cursorignore"]` [RE] `index.js`.
  - CLAUDE.md is gated behind a third-party flag (`requiresThirdParty`) [RE].
  - Rule docs: https://cursor.com/docs/rules
  - Nested AGENTS.md and always-apply rules apply on subdirectory edits (v2026.10.22); pattern-scoped team rules (v2026.09.15) [DOC] changelog.
- **Cursor commands and notes:** `cursor-agent generate-rule|rule` [CLI].
  - Bundle references `agent-notes/shared` and `agent-notes/<id>` ("Conversation notes") under the project dir [RE]. These are possibly a memory-like store; undocumented.

### Inferences
- **Canopy can rely on native file loading** for both. Writing a shared `AGENTS.md` covers Amp, Cursor and Codex at once.
- **Cursor:** rules go in `.cursor/rules/*.mdc` when glob scoping is needed.
- **IDE must build:** cross-session "memory" (Canopy notes) for both, since neither has a documented persistent memory API.

### Gaps
- Cursor's CLAUDE.md "third-party" toggle name and default were not verified.
- The purpose of the agent-notes feature is not documented.

## 11. MCP client configuration / server mode.

### Takeaway
- **Both:** native MCP clients.
- **Amp:** `amp.mcpServers` in settings, `amp mcp add|list|remove|doctor|approve|oauth`, per-run `--mcp-config <json|path>`, stored remote servers.
- **Cursor:** `.cursor/mcp.json` / `~/.cursor/mcp.json`, `cursor-agent mcp list|list-tools|login|enable|disable`, `--approve-mcps`.
- **MCP server mode:** neither acts as an MCP server. Cursor's server mode is ACP.

### Cited Findings
- **Amp:**
  - `amp mcp add <name> -- <cmd…>` / `<url>` with `--env`, `--header`, `--workspace`.
  - Writes `amp.mcpServers` in `~/.config/amp/settings.json`.
  - `amp mcp doctor`, `approve` (workspace server), `oauth login|logout|status`, `remote …` [CLI] `amp mcp add --help`, `amp --help`.
  - `--mcp-config` merges JSON for one run [DOC] https://ampcode.com/docs/cli/execute-mode
  - MCP tools reach the model via `tool_search`/`code_exec` deferred modules [CLI] `amp plugins show-docs`.
- **Cursor:**
  - `mcp login <id>` ("configured in .cursor/mcp.json or ~/.cursor/mcp.json"), `list`, `list-tools`, `enable`, `disable` [CLI] `cursor-agent mcp --help`.
  - `--approve-mcps` [CLI]; permission token `Mcp(server:tool)` [DOC] permissions.
  - ACP does not support team-dashboard MCP [DOC] https://cursor.com/docs/cli/acp
  - Docs: https://cursor.com/docs/mcp

### Inferences
- **Amp:** native config suffices. Canopy already registers its MCP server for Amp.
- **Cursor:** add a Canopy entry to `~/.cursor/mcp.json` and pass `--approve-mcps` (or `mcp enable canopy`) in headless runs.
- **MCP server mode, if ever needed:** the IDE must wrap it itself, because neither CLI provides one.

### Gaps
- None material.

## 12. Auth model and third-party-use policy.

### Takeaway
- **Amp:** browser `amp login` (short-lived) or `AMP_API_KEY` access token (`sgamp_…`) for headless use.
  - Multi-account via `amp account list|switch`.
  - Model-provider BYOK and a ChatGPT subscription link.
  - The ToS has no explicit clause on embedding Amp in third-party IDEs; it forbids reselling quotas and credits.
- **Cursor:** `cursor-agent login`, `--api-key`/`CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, Bedrock option.
  - Staff forum guidance: using Cursor via the CLI/SDK inside your own product is supported. Unofficial proxies to private endpoints violate ToS. No reselling or third-party access under your account.

### Cited Findings
- **Amp auth:**
  - `AMP_API_KEY` "Access token for Amp"; `amp login|logout`, `account list|switch` [CLI] `amp --help`.
  - Headless tokens start with `sgamp_`; the CLI rejects the short-lived `amp login` session token in env [DOC] https://ampcode.com/docs/cli/execute-mode
  - `amp config model-providers …`, `add-chatgpt-subscription` [CLI].
- **Amp ToS:**
  - "limited, revocable, non-exclusive, non-transferable, non-sublicensable license"
  - "You may not directly resell resource quotas"
  - "You may not transfer, sell… Credits"
  - No clause on automated or third-party-client use; no effective date shown.
  - [DOC] https://ampcode.com/terms
- **Cursor auth:** `login` (NO_OPEN_BROWSER), `logout`, `status|whoami --format json`, `--api-key`/`CURSOR_API_KEY`, `team`, `bedrock` [CLI]; `CURSOR_AUTH_TOKEN` [DOC] https://cursor.com/docs/cli/acp
- **Cursor policy:**
  - Using Cursor as a backend inside your product is "a supported and intended use of the Cursor SDK".
  - No reselling or third-party access under your account; no training competing models; paid plan plus API key [FORUM] (deanrie, 2026-07-10) https://forum.cursor.com/t/inquiry-regarding-official-api-or-commercial-license-for-using-cursors-engine-as-a-backend-component/165063
  - Staff consider unofficial proxies to private endpoints a ToS violation [FORUM] https://forum.cursor.com/t/does-using-oh-my-pi-s-cursor-provider-or-an-openai-compatible-proxy-to-the-same-endpoints-violate-cursor-s-tos/167778 (via search summary; not opened directly).

- **Cursor ToS (last updated 2026-09-03):**
  - Grants "a limited right to access and use the Service" (§1.1).
  - Forbids "reverse engineer, disassemble, decompile, decode…" (§1.5(i)), "rent, lease, lend, or sell the Service" (§1.5(iii)), building competing models (§1.5(v)), and "harvest, scrape, or extract data from the Service" (§1.5(viii)).
  - Silent on API keys, unofficial clients and embedding in third-party products.
  - [DOC] https://cursor.com/terms-of-service

### Inferences
- **Product decision:** Canopy features built on [RE] Cursor bundle internals carry ToS risk (§1.5(i) bans reverse engineering) as well as stability risk. Examples: hidden `--allowed-tools`, `store.db` layout, `channel:"static"`. Prefer documented surfaces: hooks, ACP, stream-json, `cli-config.json`.
- **Canopy launching the user's own installed CLI** with the user's own login appears to be within both vendors' norms. Low risk: it's the official binary and the user's account.
- **Avoid** proxying either vendor's endpoints directly.
- **IDE must build:** credential UX (detecting login state via `cursor-agent status --format json` / `amp account list`), and never storing tokens itself.

### Gaps
- Amp's Acceptable Use Policy (https://ampcode.com/terms/aup) was not read.
- Cursor's primary ToS does not address CLI embedding. The positive position ("supported and intended") rests on forum staff statements only.

## 13. Model switching / modes.

### Takeaway
- **Amp:** no direct model choice. Users pick a mode: `-m low|medium|high|ultra` or a plugin mode, plus `--features fast|plaid|pro`. Deprecated `smart|deep|rush` still resolve.
- **Cursor:** native model selection.
  - `--model` with bracket params (`'claude-opus-4-8[context=1m,effort=high,fast=false]'`), `/model`, `--list-models`/`models`.
  - Separate execution modes: agent/plan/ask/debug (`/debug`).

### Cited Findings
- **Amp modes:** `-m/--mode` "(low, medium, high, ultra, or a plugin mode…) — controls the model, system prompt, and tool selection"; `--features`, `--fast` [CLI] `amp --help`.
  - `BuiltinAgentMode = 'low'|'medium'|'high'|'ultra'|'smart'|'deep'|'rush'`, where the last three are deprecated and resolve to replacements [CLI] `amp plugins show-docs`.
  - Docs: "Choose a mode based on the task rather than the model name" [DOC] https://ampcode.com/docs/models-and-subagents
- **Cursor models:** `--model <model>` with parameterized overrides; `--list-models` [CLI] `cursor-agent --help`.
  - `/model [filter]`, `/plan`, `/ask`, `/debug`, `/max-mode` [DOC] slash-commands.
  - "`--model` and `/model` run the exact model chosen" (v2026.09.28) [DOC] changelog.
  - Config `model`, `maxMode` [DOC] configuration.

### Inferences
- **Canopy's model chip:** Amp means a mode picker (`low…ultra` plus plugin modes); Cursor means a model list from `cursor-agent models`.
- **Mid-session switching:** both are TUI-only (Amp Ctrl+S/palette per the audit; Cursor `/model`). For headless runs, set per invocation.
- **No IDE build needed** beyond UI.

### Gaps
- The current mode→model mapping for Amp is not documented in fetched pages.

## 14. Self-update mechanism (update command, auto-update, pinning, disabling).

### Takeaway
- **Both:** auto-update by default, with explicit update commands.
- **Amp:**
  - `amp update [--target-version <v>] [--porcelain]` (pinning supported)
  - `amp.updates.mode: "auto"|"warn"|"disabled"`
  - `AMP_SKIP_UPDATE_CHECK=1`
  - runner auto-update toggle
- **Cursor:**
  - `cursor-agent update` / `/update`
  - versioned install dirs (`~/.local/share/cursor-agent/versions/<ver>`)
  - `channel` config (`prod|static|lab|…`, where `static` disables auto-update)
  - hidden `--disable-auto-update`
  - no documented pin-to-version

### Cited Findings
- **Amp update command:** `amp update|up --target-version <version> --porcelain` ("updated <version>" / "no update needed") [CLI] `amp update --help`.
- **Amp settings:**
  - `amp.updates.mode`: "warn" notifies, "disabled" turns off checking, "auto" runs update.
  - `amp.runner.autoUpdate.enabled` (runners update at most every 12 h; `updates.mode: disabled` also disables it).
  - [CLI] `amp --help`
- **Amp env override:** "checking disabled via AMP_SKIP_UPDATE_CHECK environment variable … Manual updates will still work" [RE]. The version check URL is `https://static.ampcode.com/cli/cli-version.txt` [RE].
- **Cursor auto-update:** "Cursor CLI will try to auto-update by default"; manual `agent update` [DOC] https://cursor.com/docs/cli/installation
  - `channel` = "release channel for CLI updates" [DOC] configuration.
- **Cursor bundle detail:**
  - `disableAutoUpdate || "static"===channel || setTimeout(autoUpdate…)`
  - hidden option `--disable-auto-update` ("Disable auto-updates", `hideHelp()`)
  - channel enum `prod|static|lab|prod-stable-internal`
  - [RE] `7000.index.js`, `index.js`
- **Cursor install layout:** local install is `…/cursor-agent/versions/2026.10.01-e373342/` with a `cursor-agent` symlink [local].
  - "Windows: staged updates are no longer blocked by leftover markers" (v2026.10.22) [DOC] changelog.

### Inferences
- **Amp:** Canopy can pin natively. Set `AMP_SKIP_UPDATE_CHECK=1` (or `amp.updates.mode: "disabled"`) in Canopy PTYs and install a version with `amp update --target-version` or the npm `@ampcode/cli@<ver>`.
- **Cursor:** pinning to 2026.10.22-27dcf5f must be IDE-built.
  - Vendor the specific `versions/<ver>` dir (as Canopy already does under `/opt/canopy/vendor/cursor`).
  - Invoke that binary directly.
  - Set `channel: "static"` in a Canopy-controlled `CURSOR_CONFIG_DIR`, or pass hidden `--disable-auto-update`. The hidden flag is fragile.
  - No official "install version X" command exists.

### Gaps
- Confirm `channel: "static"` semantics officially; only bundle logic supports it.
- No official download URL template for a specific Cursor version was found.

## 15. Clipboard / copy behaviour in the TUI, OSC 52, remote/SSH copy issues.

### Takeaway
- **Amp:** native multi-backend clipboard, including OSC 52 write (and OSC 52 query for read), plus pbcopy, wl-copy, xclip, clip.exe and PowerShell. `amp.terminal.copyOnSelect` (default true). Terminal and SSH/tmux detection exists.
- **Cursor 2026.10.01:**
  - `/copy`, `/copy-request-id` and `/copy-conversation-id` use only pbcopy (macOS) or wl-copy/xclip (Linux).
  - It aborts when neither `WAYLAND_DISPLAY` nor `DISPLAY` is set, and emits no OSC 52.
  - So copy fails over SSH, headless or in containers. This is confirmed by user reports.

### Cited Findings
- **Amp:**
  - Setting `amp.terminal.copyOnSelect`: "Automatically copy selection to clipboard" [CLI] `amp --help`.
  - The binary contains `ESC]52;c;` and `]52;p;?` sequences, functions `writeToWlCopy`, `writeToXclip`, `writeToClipExe`, `writeToPowerShell`, `readFromOSC52WithQuery`, `handleOSC52Response`, and the error "No clipboard tool found. Install xclip (X11) or wl-clipboard (Wayland)" [RE].
  - Also `detectSSH`, `detectTmux`, `detectAppleTerminalUnderTmux`, `detectJetBrains` [RE].
  - Over SSH or with `AMP_FORCE_BEL`, notifications become a terminal bell [CLI] `amp --help`.
- **Cursor:** `/copy` "Copy a previous user message to the clipboard"; `/logs` and `/about` also copy [DOC] slash-commands.
  - Implementation: darwin → `pbcopy`; linux → `WAYLAND_DISPLAY ? wl-copy : xclip -selection clipboard`; otherwise "(WAYLAND_DISPLAY and DISPLAY not set). Clipboard not available." [RE] `1623.index.js`.
  - No `]52;` sequence exists anywhere in the bundle [RE].
- **User reports:**
  - "/copy … does not copy… back to the macOS host… does not emit OSC52 and does not provide a configurable clipboard command" [FORUM] https://forum.cursor.com/t/cursor-agent-cli-copy-fails-in-remote-ssh-headless-terminal-should-support-osc52-fallback-or-configurable-clipboard-command/164019
  - Docker case: "Could not copy to clipboard" even with xclip present [FORUM] https://forum.cursor.com/t/cursor-cli-clipboard-fails-in-container-environment-despite-xclip-xel-being-present-can-we-fall-back-to-them/158413
- **No official Amp docs** on OSC 52 behaviour were found; the search returned nothing Amp-specific.

### Inferences
- **Amp:** Canopy's xterm should handle OSC 52 (write, and optionally answer `]52;c;?` queries). Amp's copy then works in remote Canopy VMs without host clipboard tools.
  - Verify which path Amp picks under Canopy's env: SSH detection vs. xclip presence.
- **Cursor, IDE must build:** a copy path that works in remote sessions.
  - Install a fake `xclip`/`wl-copy` shim on PATH in Canopy remote VMs that forwards stdin to Canopy's clipboard bridge (or emits OSC 52).
  - Set `DISPLAY`/`WAYLAND_DISPLAY` so Cursor doesn't bail early.
  - Alternatively, provide Canopy-native "copy last message" from the structured stream or transcript.

### Gaps
- Whether Cursor 2026.10.22 added OSC 52 is unverified (the changelog shows no clipboard entry for 10.02–10.22).
- Amp's exact selection logic (when OSC 52 vs. native tools is used) is not documented.

---

## Summary matrix (support level; Canopy action if not native)

| # | Feature | Amp 0.0.1790913650 | Cursor 2026.10.01 (pin 10.22 unverified) | IDE must build |
|---|---|---|---|---|
| 1 | Headless/stream/resume | native (`-x --stream-json[-input]`, `threads continue`) | native (`-p --output-format stream-json`, `--resume`) | Both: system-prompt injection, per-run tool scoping. Amp: plan mode |
| 1a | System prompt | partial (plugin modes/createAgent) | none | Both: inject via plugin/rules/first message |
| 1b | Tool allow/deny | partial (settings, permissions) | partial (cli.json; hidden `--allowed-tools`) | Both: temp settings/cli.json per run |
| 1c | Plan mode | none (plugin mode only) | native `--plan/--mode` | Amp: read-only plugin mode |
| 2 | Checkpoints/rewind | none | native TUI `/rewind` (files+conversation), no API | Amp: all. Cursor: headless rewind via git snapshots |
| 3 | IDE protocol | native (`--ide`, WS+lockfile, undocumented) | ACP server (`agent acp`, hidden but documented) | Amp: emulate WS or pass context via MCP. Cursor: ACP client |
| 4 | Hooks/plugins | native TS plugins (6 events + state observable) | native hooks.json (about 18 events) + plugins | Normalizers into canopy-hook |
| 5 | Permissions/sandbox | permissions native; OS sandbox none | both native (Seatbelt / Landlock+seccomp) | Amp: OS sandbox wrapper |
| 6 | Sessions | server-side; list/export JSON; no fork | local store.db + JSONL; `/fork`; no JSON list | Amp: local cache, fork. Cursor: list via fs scan |
| 7 | Subagents | native (Task sync/async, Oracle…) | native (Explore/Browser/custom, background) | Rendering only |
| 8 | Compaction/handoff | native auto + "Handoff" prompt | native `/summarize`, preCompact hook, `&` cloud handoff | Cross-harness handoff |
| 9 | Usage/cost/model | native (stream usage, `threads usage`) | partial (model; undocumented result.usage; `/usage`) | Cursor: cost via price table |
| 10 | Instructions | native (AGENTS.md hierarchy, skills) | native (.cursor/rules, AGENTS.md, CLAUDE.md) | Memory layer |
| 11 | MCP | native client; no server mode | native client; no MCP server mode (ACP instead) | Register Canopy MCP; `--approve-mcps` |
| 12 | Auth/policy | login or `AMP_API_KEY`; ToS silent on embedding | login or `CURSOR_API_KEY`; staff: SDK/CLI embedding OK | Login-state UX |
| 13 | Models | modes only (`-m`) | native `--model`, `/model`, `models` | UI only |
| 14 | Self-update | native; pin via `--target-version`; disable via setting/env | native auto; disable via `channel:"static"` or hidden flag; no pin cmd | Cursor: vendor version dir + disable |
| 15 | Clipboard | native incl. OSC 52 | X11/Wayland/pbcopy only; fails over SSH | Cursor: xclip shim / OSC 52 bridge |

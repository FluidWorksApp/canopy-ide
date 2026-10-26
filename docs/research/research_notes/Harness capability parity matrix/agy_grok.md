# Harness capability parity: Google Antigravity CLI (`agy` 1.2.14) and xAI Grok Build CLI (`grok` 1.0.46)

Scope and method (read first):
- Local binaries were checked on 2026-10-26. `agy --version` returned `1.2.14`. `grok --version` returned `grok 1.0.46 (2765805b9442)`. Both `--help` outputs and the subcommand help were captured. `gemini` (Gemini CLI) is **not installed**, so Gemini CLI facts come from web docs only.
- **Version gating, agy.** The web docs at antigravity.google and the changelog that `agy changelog` prints describe agy **1.4.7**, which is newer than the pinned 1.2.14. The changelog prints every version: lines 1–239 are 1.3.0–1.4.7 (newer than the pin), and line 240 onward is 1.2.14 and older. Every agy claim below is labelled either "in 1.2.14" or "newer than pin". Not in 1.2.14: `/compact` (1.3.5), the `auto` mode (1.3.5), and the `lastUserInput` hook field (1.4.7). Local confirmation: `agy --help` (1.2.14) lists `--mode` as `accept-edits, plan` only, with no `auto`. In 1.2.14, verified by reading changelog line numbers against version headers: `AGY_ERROR` with exit code 3 (1.2.6), `--print-timeout` default changed to unlimited (1.2.6), `/model <name> <prompt>` (1.1.27), `excludeDefaultComponents` (1.2.1), `@<subagent>` messaging (1.2.9), and `/teamwork-preview` (present by 1.1.x).
- **grok sources.** The grok 1.0.46 binary embeds a full documentation set, including headless, hooks, sessions, ACP, terminal and memory chapters. `grok wrap --help` says this set ships as `~/.grok/README.md`. It was extracted with `strings`. It is vendor documentation pinned to this exact version, so it is preferred over docs.x.ai wherever the two disagree, and each such disagreement is flagged. Citations of the form "grok 1.0.46 embedded docs" mean this local source. The closest public URL is given alongside.
- Labels: **official** means vendor docs or vendor `--help`. **RE** means reverse-engineered from binary strings, with no official doc. "verified" means checked against the local binary.
- No repository files were modified. The only side effect: running `agy` subcommands created `~/.gemini/{config,antigravity-cli/cache}` in the sandbox home directory.

---

## 1. Headless/structured mode: non-interactive run, streaming JSON events, system-prompt support, tool allow/deny, plan mode, resume-by-id.

### Takeaway
grok is native on every sub-item. It has `-p` with four output formats, one of them a Claude-compatible `streaming-messages-json`. It also has `--system-prompt-override`/`--rules`, `--tools`/`--disallowed-tools`/`--allow`/`--deny`, `--permission-mode plan`, `-r <id>` and `--fork-session`, plus a full bidirectional ACP server (`grok agent stdio`). agy is native for the headless run, stream-json output and input, JSON-schema output and resume-by-id, but it has **no system-prompt flag and no per-run tool allow/deny flag**. Its plan mode is `--mode plan`. Note the policy problem for agy in item 12 before building a headless runner on it.

### Cited Findings
- **agy 1.2.14: partial overall.**
  - Non-interactive run (native): `-p`/`--print`/`--prompt` with `--output-format text|json|stream-json`, `--input-format stream-json` (multi-turn NDJSON on stdin, requires stream-json output), `--json-schema <string|file>` and `--print-timeout`. Programmatic: yes. Official; verified with `agy --help`. — [agy headless docs](https://antigravity.google/docs/cli/headless)
  - JSON envelope: `{conversation_id, status (SUCCESS|ERROR|CANCELED|INTERRUPTED|INVALID|WAITING|RUNNING), response, error, duration_seconds, num_turns, structured_output, json_schema, usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}}`. — [agy headless docs](https://antigravity.google/docs/cli/headless)
  - Stream events: one `{"event":"init", init:{cwd, tools[], permission_mode, model?, agent?}}`, then any number of `{"event":"step_update", step_update:{conversation_id, step_index, state ACTIVE|DONE, step_type user_input|agent_response|tool|checkpoint, tool_name, text_delta, duration_seconds, usage, tool_info{name, parameters, output, error}, subagent_info{subagents[{type_name, role, conversation_id, log_uri, workspace_uris}]}}}`, then one `{"event":"result"}`. In a stream-json input session, `usage`, `num_turns` and `duration_seconds` on each `result` are cumulative. — [agy headless docs](https://antigravity.google/docs/cli/headless)
  - Stdin protocol: `{"event":"user","message":{"content":"..."}}`. Only text blocks are accepted. `control_request`/`control_response` ends the session with exit code 2, so there is **no approval round-trip channel**. Slash commands such as `/model` are rejected in stream mode. — [agy headless docs](https://antigravity.google/docs/cli/headless)
  - System prompt: **none**. 1.2.14 `--help` has no `--system-prompt` or `--append-system-prompt`. The nearest substitutes are `--agent <name>` (custom agents defined in Markdown) and rules files. Verified with `agy --help`.
  - Tool allow/deny: **no per-run flag**. Tools are controlled through `permissions.allow|ask|deny` rules (`command(git)`, `command(regex:...)`, `write_file(src/)`, `mcp(server/tool)`, `read_url(domain)`) in `~/.gemini/antigravity-cli/settings.json`, or through `--dangerously-skip-permissions`. In headless mode, a tool that needs approval is "soft-denied": the run continues and exits 0. — [agy headless docs](https://antigravity.google/docs/cli/headless); [agy permissions](https://antigravity.google/docs/permissions)
  - Plan mode: `--mode plan` (also `accept-edits`), or the `agentMode` setting. Verified with `agy --help` 1.2.14. — [agy CLI reference](https://antigravity.google/docs/cli/reference)
  - Resume-by-id: `--conversation <id>`, `-c/--continue`. The ID comes from `conversation_id` in JSON output. There is no fork-on-resume flag. — [agy headless docs](https://antigravity.google/docs/cli/headless)
  - `--print-timeout` default: 1.2.14 `--help` gives `0s` (wait until the turn completes). This matches the 1.2.6 changelog ("from 5 minutes to unlimited") and the web reference page. Only the web headless page still says `5m`, which is stale. — verified with `agy --help`; [agy CLI reference](https://antigravity.google/docs/cli/reference); [agy headless](https://antigravity.google/docs/cli/headless)
  - Error reporting (in pin, 1.2.6, fixed in 1.2.10): on an agent or model API failure, headless runs print a structured `AGY_ERROR: {...}` JSON line on stderr (canonical status, HTTP or gRPC code, retryability, error ID) and exit with code `3`. JSON error output includes the partial response. Multi-turn stream-json sessions warn and continue. This is useful for a Build runner's error handling. — `agy changelog` output (1.2.6, 1.2.10)
- **grok 1.0.46: native.**
  - Run: `-p/--single`, `--prompt-file`, `--prompt-json` (content blocks). `--output-format plain|json|streaming-json|streaming-messages-json` and `--include-partial-messages`. `--json-schema` (implies json). `--max-turns`, `--cwd`, `--verbatim`. Exit codes 0, 1, 130 (SIGINT) and 143 (SIGTERM). Official; verified with `grok --help`. — [grok headless docs](https://docs.x.ai/build/cli/headless-scripting); grok 1.0.46 embedded docs, "Headless" chapter
  - `json` envelope: `{text, stopReason, sessionId, requestId, num_turns, usage{input_tokens (uncached), cache_read_input_tokens, cache_creation_input_tokens, output_tokens, reasoning_tokens, total_tokens}, modelUsage{<model>{inputTokens, outputTokens, cacheReadInputTokens, modelCalls, costUSD}}, total_cost_usd, total_cost_usd_ticks (1 USD = 1e10)}`, plus `cost_is_partial` and `usage_is_incomplete` flags. — grok 1.0.46 embedded docs
  - `streaming-json`: lines tagged by `type`: `text`, `thought`, `tool_call{toolCallId, title, kind, status, toolName, rawInput, content, locations}`, `tool_call_update`, `usage` (one per model response), `plan`, `available_commands`, `end` (always last; carries spend fields) and `error`. `max_turns_reached` and `auto_compact_*` events may also appear. The format is derived from ACP `session/update`. — grok 1.0.46 embedded docs
  - `streaming-messages-json`: Anthropic Messages `stream-json` wire format: `system/init` (with `session_id`, `model`, `permissionMode`, `tools`, `mcp_servers[].status`), `assistant`, `user` (tool_result), and `result` (with `total_cost_usd`, `usage`, `modelUsage`). It also emits `system/compact_boundary`. It omits `claude_code_version`, `output_style`, `plugins` and `permission_denials`. Like `streaming-json`, it is read-only; approvals require ACP. — grok 1.0.46 embedded docs
  - System prompt: `--system-prompt-override` (aliases `--system-prompt`, `--append-system-prompt`) and `--rules <text>` (appends). On ACP, `session/new` accepts `_meta.rules` and `_meta.systemPromptOverride`. — `grok --help`; grok 1.0.46 embedded docs, ACP section
  - Tool allow/deny: `--tools` and `--disallowed-tools` (headless-only; `--disallowedTools` is accepted), `--allow`/`--deny` rules (e.g. `Bash(git *)`), `--disable-web-search`, `--no-subagents`. — `grok --help`; [grok permissions](https://docs.x.ai/build/features/permissions)
  - Plan mode: `--permission-mode plan`, interactive `/plan`, `--no-plan` to disable. Headless also has `dontAsk`, which silently denies anything not explicitly allowed. — `grok --help`; [grok enterprise](https://docs.x.ai/build/enterprise)
  - Resume: `-r/--resume <id|title>`, `-c`, `-s <uuid>` (sets the ID of a new session) and `--fork-session`. — `grok --help`
  - Bidirectional control: `grok agent stdio` (ACP JSON-RPC: `initialize`, `authenticate`, `session/new|load|prompt`, `session/update` notifications, permission requests, `session/set_config_option`) and `grok agent serve --bind 127.0.0.1:2419 --secret` (WebSocket). — [grok headless/ACP](https://docs.x.ai/build/cli/headless-scripting#acp); grok 1.0.46 embedded docs

### Inferences
- **agy, what the IDE must build:** (a) a system-prompt shim. Canopy prepends its brief to the prompt (as it does for Codex) or ships a Canopy custom agent (`--agent`) Markdown file. (b) A per-run tool policy: write a scoped `permissions` block, or run under an isolated settings root, before each run. (c) Approval UX: none exists in headless mode (soft-deny only), so Canopy must pre-grant rules or use `--dangerously-skip-permissions` plus its own guard. Classification: **partial**, matching how docs/agent-parity.md rates Codex.
- **grok:** native. To get Build parity, Canopy can reuse its Claude stream-json parser on `--output-format streaming-messages-json`, and use ACP (`grok agent stdio`) if it needs interactive approvals. Nothing needs to be built beyond adapter glue.

### Gaps
- Neither CLI's stream was exercised end-to-end, because a model turn requires authentication. The event shapes come from official docs, not from captured output.
- It is unconfirmed whether agy 1.2.14 emits `subagent_info` and `checkpoint` step types exactly as the 1.4.x docs show.

## 2. Checkpoints / rewind / undo.

### Takeaway
agy 1.2.14 has `/rewind` (alias `/undo`), which reverts the conversation **and** workspace files from git-backed snapshot commits, but only interactively. grok 1.0.46 has `/rewind`/`/undo` (and Esc Esc) plus `rewind_points.jsonl` and `--restore-code` on resume. **Whether grok's `/rewind` restores files is contradicted between sources** and needs an empirical test.

### Cited Findings
- **agy 1.2.14: native (interactive only).** `/rewind` (alias `/undo`): "Roll back your conversation history to a previous message". 1.2.x changelog entries describe "`/rewind` conversation reverts and forks" that look up "workspace snapshot" commits, with "step-by-step revert replay" as fallback, and say that diffs over 1 MiB are skipped "during `/rewind` reverts". So files are reverted, in 1.2.14. — [agy CLI reference](https://antigravity.google/docs/cli/reference); `agy changelog` (1.2.x section); official
  - The `/context` panel lists "checkpoints". In agy, "checkpoint" also means the compaction summary step (`step_type: checkpoint` in stream-json). — [agy /context](https://antigravity.google/docs/cli/commands/context)
  - No headless or CLI flag for rewind was found in `--help`. Verified.
- **grok 1.0.46: native for conversation; files disputed.**
  - grok 1.0.46 embedded docs: "`/rewind` (alias `/undo`) rewinds the conversation to an earlier turn... **`/rewind` does not restore files on disk.** Only conversation history is truncated." — grok 1.0.46 embedded docs, Sessions chapter
  - Contradicted by docs.x.ai: "Selecting one restores all files to their state at that point and truncates the conversation to match." — [grok sessions](https://docs.x.ai/build/features/sessions)
  - Per-session `rewind_points.jsonl`. `--restore-code` restores "the original session's repository snapshot when resuming". ACP extension methods `x.ai/rewind/*`. The `hunk_tracker_mode` setting (`agent_only|all_dirty|off`). — `grok --help`; grok 1.0.46 embedded docs; [grok settings reference](https://docs.x.ai/build/settings/reference)

### Inferences
- **agy, what the IDE must build:** a headless or programmatic rewind. Canopy cannot trigger agy's snapshot revert outside the TUI, so it needs its own git-stash or worktree checkpoint per turn for the Build runner. In the terminal, use native `/rewind`.
- **grok, what the IDE must build:** until file restore is confirmed in 1.0.46, Canopy should keep its own file checkpoints. The ACP `x.ai/rewind/*` methods are a possible native route if Canopy drives grok through ACP. Classification: **partial**, pending verification.

### Gaps
- An empirical `/rewind` file-restore test on grok 1.0.46 is needed to decide whether the docs.x.ai text describes a newer version.
- The request and response schema of grok's `x.ai/rewind/*` methods is not documented beyond the method names.

## 3. IDE integration protocol (selection, diagnostics, diffs from a host IDE).

### Takeaway
Neither CLI implements a Claude-Code-style "host IDE pushes selection, diagnostics and diffs into a running CLI" protocol. grok inverts the model: it is an **ACP agent server** that IDEs host, with `x.ai/fs`, `git`, `terminal` and `search` extensions. agy CLI has no IDE channel. Its sibling products (the Antigravity IDE and app) are separate, and agy does **not** inherit Gemini CLI's IDE companion protocol.

### Cited Findings
- **agy 1.2.14: none.** `--help` has no `/ide`, IDE or ACP flag. The binary contains zero `GEMINI_CLI_IDE_*` strings and no `agentclientprotocol`/`session/prompt` strings. An `ideContext` symbol exists, probably shared code from the Antigravity IDE. RE. The only remote-attach feature is Remote Control (`--remote-control`, `agy remote-control start|status|stop`) for following and controlling a session from another device, which is Google-hosted. — verified with `agy --help`; [agy remote control](https://antigravity.google/docs/remote-control)
- **Gemini CLI (for reference): native.** A VS Code companion extension. Discovery uses `GEMINI_CLI_IDE_WORKSPACE_PATH`, `GEMINI_CLI_IDE_SERVER_PORT` and `GEMINI_CLI_IDE_PID`. It sends the 10 most recent files, the cursor and the selection (up to 16 KB), and supports accept/close diff in the IDE. The page carries a banner: "Gemini CLI was replaced by Antigravity CLI on June 18th, 2026" for unpaid tier and Google One users. — [Gemini CLI IDE integration](https://geminicli.com/docs/ide-integration/)
- **grok 1.0.46: partial (inverted model).** `grok agent stdio` and `serve` speak ACP. The listed compatible clients are Zed, Neovim (CodeCompanion, avante.nvim), Emacs (agent-shell) and marimo; "JetBrains: Coming soon". Extension methods: `x.ai/fs/*` (`read_file`, `write_file`, ...), `x.ai/git/*`, `x.ai/git/worktree/*`, `x.ai/search/*`, `x.ai/terminal/*`, `x.ai/session/fork`, `x.ai/rewind/*`, `x.ai/compact_conversation`. Notifications include `x.ai/fs_notify` and `x.ai/session_notification` (diff review, retry, auto-compact). `[features] lsp_tools` / `GROK_LSP_TOOLS=1` exposes an LSP tool. No push channel for host-editor selection or diagnostics is documented. — grok 1.0.46 embedded docs, "Agent mode (ACP) and IDE integration"; [grok headless/ACP](https://docs.x.ai/build/cli/headless-scripting#acp); [grok settings reference](https://docs.x.ai/build/settings/reference)

### Inferences
- **agy, what the IDE must build:** all of it. Canopy's existing MCP tools (`canopy_editor_state`, `canopy_diagnostics`, `canopy_show_diff`), registered in `~/.gemini/config/mcp_config.json`, remain the integration path. That is pull through MCP, not push.
- **grok, what the IDE must build:** selection and diagnostics push, through the same Canopy MCP tools. Alternatively, Canopy could become an ACP client, which gives structured tool-call, diff and permission events, and send editor context in `session/prompt` content. That is a larger change than the terminal-hosted model Canopy uses today.

### Gaps
- Whether grok's ACP `clientCapabilities.fs` lets the host serve unsaved editor buffers (as Zed does) was not verified against 1.0.46.

## 4. Hooks / lifecycle events.

### Takeaway
Both CLIs have native command hooks. agy's file is **not** Claude-shaped: it is keyed by hook name, with events `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation` and `Stop`, and camelCase protojson payloads. **Canopy's parity doc is stale on the agy hooks path.** grok's hooks are Claude/Cursor-compatible, with 16 events, and **grok also loads `~/.claude/settings.json` hooks by default**. On this machine, `grok inspect` shows Canopy's Claude hooks (`canopy-hook --agent claude`) active for grok.

### Cited Findings
- **agy 1.2.14: native.**
  - Locations (official): workspace `.agents/hooks.json`, global **`~/.gemini/config/hooks.json`**, and plugin `hooks.json`. "Hooks in `~/.gemini/antigravity-cli/settings.json` aren't loaded." — [agy hooks](https://antigravity.google/docs/hooks)
  - The embedded 1.0.x changelog says: "Fixed a bug where the `/hooks` command wrote configurations to `~/.gemini/antigravity-cli/hooks.json` instead of the shared `~/.gemini/config/hooks.json`." Both `agy changelog` and the binary's embedded copy place it in the 1.0.8 section. — `agy changelog`; official
  - **Contradicts docs/agent-parity.md**, which says hooks are at `~/.gemini/antigravity-cli/hooks.json`. Canopy's installer writes that path (`src-tauri/src/agents.rs:891` and `:1669-1678`, observed read-only). The 1.2.14 binary still contains the literal string `~/.gemini/antigravity-cli/hooks.json` once, and it is unclear whether that is a legacy read path or only changelog text. — RE
  - Format: `{"<hookName>": {"enabled": true, "PreToolUse": [{"matcher": "run_command", "hooks": [{"type": "command", "command": "...", "timeout": 30}]}], "PreInvocation": [{"type": "command", "command": "..."}]}}`. Tool events are grouped by matcher regex (`*` or empty matches all). Non-tool events take a flat handler list. Only `type: command` is supported (`sh -c`). CWD is the directory of `hooks.json`. The default timeout is 30 s. Hooks are synchronous. — agy 1.2.14 embedded skill doc `agy-customizations/docs/hooks.md` (RE extraction of official text); [agy hooks](https://antigravity.google/docs/hooks)
  - Payload (stdin, camelCase): common fields `conversationId`, `workspacePaths[]`, `transcriptPath` (`<app_data_dir>/brain/<id>/.system_generated/logs/transcript.jsonl`, where app_data_dir is `~/.gemini/antigravity-cli` for the CLI), `artifactDirectoryPath`, `modelName`. `PreToolUse` adds `toolCall{name, args}` and `stepIdx`, and the hook returns `{decision: allow|deny|ask|force_ask, reason, permissionOverrides[], overwrite{}}`. `PostToolUse` adds `stepIdx` and `error`, and returns `{}`. `PreInvocation`/`PostInvocation` add `invocationNum` and `initialNumSteps`, and return `{injectSteps[{userMessage|ephemeralMessage|toolCall}], terminationBehavior: force_continue|terminate}`. `Stop` adds `executionNum`, `terminationReason` (`model_stop|max_steps_exceeded|error`), `error` and `fullyIdle`, and returns `{decision: "continue", reason}`. — [agy hooks](https://antigravity.google/docs/hooks); embedded skill doc
  - `SessionStart` (returns `injectSteps`) is in the official docs, and the 1.2.14 binary contains `hooks_go_proto.(*SessionStartHookArgs)`. The embedded 1.2.14 skill doc lists only the other five events, so 1.2.14 support for `SessionStart` is likely but not confirmed. — RE; [agy hooks](https://antigravity.google/docs/hooks)
  - No `UserPromptSubmit`, `Notification`, `PermissionRequest`, `PreCompact` or `SessionEnd` events. The `lastUserInput` field is newer than the pin (1.4.7). OSC 9 notifications are available through the `notifications` setting (bell plus desktop notification on approval or answer needed, and on turn finish). — [agy CLI reference](https://antigravity.google/docs/cli/reference); `agy changelog`
  - Conflict: a third-party claude-mem guide says agy hooks live in `~/.gemini/settings.json`. That contradicts the official docs and should be treated as a third-party error. — [claude-mem agy setup](https://docs.claude-mem.ai/antigravity-cli/setup); [agy hooks](https://antigravity.google/docs/hooks)
- **grok 1.0.46: native (Claude/Cursor-compatible).**
  - Locations: `~/.grok/hooks/*.json`; `<project>/.grok/hooks/*.json` (requires trust: `/hooks-trust`, `--trust`, stored in `~/.grok/trusted_folders.toml`); `[hooks]` in `~/.grok/config.toml`; `managed_config.toml` and `requirements.toml`; plugins; **and, scanned by default, `~/.claude/settings.json` (and `settings.local.json`), `<project>/.claude/settings.json`, `~/.cursor/hooks.json` and `.cursor/hooks.json`**. Disable these with `[compat.claude] hooks = false` or `GROK_CLAUDE_HOOKS_ENABLED=0` (Cursor has equivalents). — grok 1.0.46 embedded docs, Hooks chapter; [grok hooks](https://docs.x.ai/build/features/hooks)
  - Events: `SessionStart`, `SessionEnd`, `UserPromptSubmit` (can block), `PreToolUse` (allow, deny, ask, defer, `updatedInput`, `additionalContext`), `PostToolUse` (can replace output), `PostToolUseFailure`, `PermissionDenied`, `Stop` and `SubagentStop` (can block the stop), `StopFailure`, `StopCancelled`, `Notification` (`idle_prompt`, `permission_prompt`, `task_complete`, ...), `SubagentStart`, `PreCompact`, `PostCompact`. Types are `command` and `http`. The default timeout is 5 s (600 s for Stop, SubagentStop and PostToolUse). Hooks fail open; exit 2 means deny. — grok 1.0.46 embedded docs
  - Payload: `hookEventName` (snake_case value, e.g. `pre_tool_use`) and `hook_event_name` (Claude PascalCase value), `sessionId`, `cwd`, `workspaceRoot`, `timestamp`, `permissionMode`, `promptId`, `toolName`, `toolInput`, `toolUseId`. Stop events add `lastAssistantMessage` and `stopHookActive`. Environment variables: `GROK_HOOK_EVENT`, `GROK_HOOK_NAME`, `GROK_SESSION_ID`, `GROK_WORKSPACE_ROOT`, `CLAUDE_PROJECT_DIR`. Matchers map Claude tool names (`Bash` matches `run_terminal_command`, `Edit|Write` match `search_replace`, `Task` matches `spawn_subagent`). — grok 1.0.46 embedded docs
  - Empirical (verified): `grok inspect --json`, run in this repository, lists five hooks from `/home/agent/.claude` with target `'/usr/local/bin/canopy-hook' --agent claude`, `vendor: "claude"`, `compatibilityStatus: "enabled"`, for `session_start`, `user_prompt_submit`, `post_tool_use`, `stop` and `session_end`. It also loads 17 permission rules from `~/.claude/settings.json`.

### Inferences
- **agy:** native. Canopy should **move its installer to `~/.gemini/config/hooks.json`**, or write both paths until the old one is confirmed, and add `SessionStart` and `PreToolUse` (the documented interception point). Payloads lack a `session_id`, `cwd` and `hook_event_name` in Claude's spelling, so the existing camelCase normalizer stays necessary. agy has no prompt-submit event, so prompt digests must come from the transcript.
- **grok:** native. The urgent action is not building anything. Today grok fires Canopy's **Claude** hooks with `--agent claude`, so grok tabs will be misattributed as Claude in event stamping and digests. Canopy should either set `[compat.claude] hooks = false` and install `~/.grok/hooks/canopy.json` with `--agent grok`, or make `canopy-hook` detect grok, for example from the `GROK_SESSION_ID` environment variable or the snake_case `hookEventName`. The same compatibility scan also imports Claude permission rules into grok.

### Gaps
- It is not confirmed whether agy 1.2.14 still reads `~/.gemini/antigravity-cli/hooks.json`. This needs an authenticated test: install a hook in each path and run `/hooks` or a turn.
- It is not confirmed whether agy 1.2.14 fires `SessionStart`. The proto is present but the embedded doc omits it.

## 5. Permission modes and OS sandbox.

### Takeaway
Both CLIs are native. agy has presets, `allow|ask|deny` rules, and an OS terminal sandbox (Linux namespaces, macOS Seatbelt) that sandboxes **shell commands only**. grok has the modes `default|acceptEdits|auto|dontAsk|bypassPermissions|plan`, rules, and Landlock/Seatbelt **process-wide** sandbox profiles. On Linux it can also use bubblewrap for read-deny and seccomp for network.

### Cited Findings
- **agy 1.2.14: native.**
  - Modes: `--mode accept-edits|plan` (and the `agentMode` setting). `auto` is newer than the pin (1.3.5). `toolPermission` presets: `request-review` (default), `proceed-in-sandbox`, `always-proceed`, `strict`. `--dangerously-skip-permissions`. `allowNonWorkspaceAccess`. — verified with `agy --help`; [agy CLI reference](https://antigravity.google/docs/cli/reference)
  - Rules: `permissions.allow|ask|deny` with resources `read_file()`, `write_file()`, `read_url()`, `execute_url()`, `command(prefix|regex:...)` and `mcp(server/tool)`. Precedence is Deny > Ask > Allow. Project overrides live in `~/.gemini/config/projects/`. Deprecated `unsandboxed` rules are warned about. — [agy permissions](https://antigravity.google/docs/permissions); `agy changelog` 1.0.12
  - Sandbox: `--sandbox` or `enableTerminalSandbox: true`. Linux uses kernel namespaces (filesystem, process, network). macOS uses `sandbox-exec` (SBPL). The network is off by default, and `read_url` domains are added to an allowlist. The agent can request to run a command unsandboxed (prompted). `sandboxProxy` sets a proxy. — [agy sandbox](https://antigravity.google/docs/sandbox)
- **grok 1.0.46: native.**
  - Modes: `--permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions|plan`, `--always-approve` (alias `--yolo`), and `[ui] permission_mode = ask|auto|always-approve` (user-level only). Deny rules and PreToolUse hooks still apply under always-approve. `disable_bypass_permissions_mode` can be set in root-owned `/etc/grok/requirements.toml`. — `grok --help`; [grok permissions](https://docs.x.ai/build/features/permissions); [grok enterprise](https://docs.x.ai/build/enterprise)
  - Rules: `[permission] allow|deny|ask = ["Bash(git *)", "Edit(**/*.rs)", "MCPTool(server__*)"]`, or a verbose `rules = [{action, tool, pattern}]` form. Evaluation order is deny > ask > allow. Rules are also read from Claude `settings.json` (see item 4). — [grok settings reference](https://docs.x.ai/build/settings/reference)
  - Sandbox: `--sandbox <profile>`, `GROK_SANDBOX`, or `[sandbox] profile`. Built-in profiles are `off` (default), `workspace`, `devbox`, `read-only` and `strict`. Custom profiles go in `~/.grok/sandbox.toml` or `.grok/sandbox.toml` (`extends`, `restrict_network`, `read_only`, `read_write`, `deny` globs). It uses Landlock on Linux (kernel 5.13+) and Seatbelt on macOS. Linux read-deny needs `bubblewrap`. The child network is blocked only on Linux. Leader mode is refused when a sandbox is active. — [grok sandbox](https://docs.x.ai/build/features/sandbox); [grok settings reference](https://docs.x.ai/build/settings/reference); grok 1.0.46 embedded docs

### Inferences
- Both are native. Canopy only needs to pass the flags and map its permission UI to them. For agy, the sandbox covers terminal commands, not the agent's own file tools, so Canopy's "OS-backed workspace boundary" claim for agy should be qualified. grok's sandbox applies to the whole agent process. Canopy should be aware that grok inherits Claude permission rules unless `[compat.claude]` is turned off.

### Gaps
- agy on Linux hosts that block unprivileged user namespaces (common in containers): the 1.4.4 docs describe a fallback, but 1.2.14 behaviour is not confirmed.

## 6. Sessions: list, resume, fork, transcript location/format.

### Takeaway
grok is native and scriptable: `grok sessions list|search|delete`, `--resume` by ID or title, `--fork-session`, and `grok export`, with documented JSONL storage. agy resumes and forks natively, but listing exists only in the TUI. Storage is SQLite with protobuf blobs plus a readable `transcript.jsonl`.

### Cited Findings
- **agy 1.2.14: partial.**
  - Resume: `--conversation <id>`, `-c` (resolved through `~/.gemini/antigravity-cli/cache/last_conversations.json`). — [agy resume](https://antigravity.google/docs/cli/commands/resume); verified with `agy --help`
  - List: only the interactive `/resume` picker (with `pickerGrouping`). No `agy sessions` subcommand. Verified with `agy --help`.
  - Fork: `/fork` (alias `/branch`), interactive. It forks the conversation, not the git checkout. — [agy conversations](https://antigravity.google/docs/cli/conversations)
  - Storage: `~/.gemini/antigravity-cli/conversations/<uuid>.db` (SQLite, protobuf) and `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl` (also `transcript_full.jsonl`). The 1.2.x changelog fixed `ERROR` steps missing from `transcript.jsonl`. — [agy hooks payload paths](https://antigravity.google/docs/hooks); binary strings (RE); docs/agent-parity.md; `agy changelog`
- **grok 1.0.46: native.**
  - CLI: `grok sessions list|search <q>|delete <id>`, `grok export <id> [file] [--clipboard]` (Markdown), `grok trace <id> --local`, `-r/--resume <id|title>`, `-c`, `--fork-session`, `-s <uuid>`. TUI commands: `/fork [--worktree]`, `/rename`, `/share`. — `grok --help`; [grok sessions](https://docs.x.ai/build/features/sessions)
  - Layout: `~/.grok/sessions/<url-encoded-cwd>/<session-id>/` containing `summary.json` (title, model, timestamps, parent session), `updates.jsonl` (ACP session-update stream; authoritative), `chat_history.jsonl`, `system_prompt.txt`, `prompt_context.json`, `tool_definitions.json`, `plan.json`, `rewind_points.jsonl`, `signals.json` (token and turn counters), `feedback.jsonl`, `compaction_checkpoints/` and `subagents/`. Session IDs are UUIDv7. A SQLite FTS5 index is used only for search. — grok 1.0.46 embedded docs, Sessions chapter
  - Internal inconsistency: a "File Locations" table in the same embedded docs labels `sessions/` as "Session transcripts (SQLite)". The detailed chapter says JSONL is the source of truth. — grok 1.0.46 embedded docs

### Inferences
- **agy, what the IDE must build:** a session lister and digest from `brain/*/…/transcript.jsonl` plus `conversations/*.db` metadata, which Canopy already does (`stores.rs`). Headless fork is not exposed, so Canopy must build it (for example copy-on-resume) if needed.
- **grok:** native. Canopy can shell out to `grok sessions list` and `grok export`, or parse `summary.json` and `updates.jsonl` directly, and add a resume registry entry `grok --resume <id>`.

### Gaps
- No `--json` flag is shown for `grok sessions list` in 1.0.46 help. A machine-readable listing format is unconfirmed.

## 7. Subagents / parallel tasks.

### Takeaway
Both CLIs are native. agy has `invoke_subagent`, custom agents, background tasks and subagent worktrees, plus the `/agents` panel. grok has a `spawn_subagent` tool (general-purpose, explore, plan, custom), background runs, worktree isolation, `--agents <json>` and Rhai workflows. Nesting depth is 1.

### Cited Findings
- **agy 1.2.14: native.** `--agent`, `agy agents`, `/agents`, and an `invoke_subagent` tool. Custom agents are defined in Markdown (`agents.json`, an `agents` list in frontmatter). Subagent worktrees live under `.system_generated/worktrees` and, by the 1.2.x fixes, an app-data `worktrees/` directory. A `manage_subagents` tool provides `list` and `kill`, and `send_message` messages a subagent. Stream-json exposes `subagent_info`. `@<subagent> <message>` messaging (1.2.9) and `/teamwork-preview` (present by 1.1.x) are both in the pin. — verified with `agy --help`; `agy changelog` 1.1.x–1.2.x; binary tool descriptions (RE); [agy headless](https://antigravity.google/docs/cli/headless)
- **grok 1.0.46: native.** `spawn_subagent{prompt, description, run_in_background (default true), isolation none|worktree, resume_from, cwd}`, retrieved with `get_command_or_subagent_output`. Built-in types are `general-purpose`, `explore` and `plan`; custom types go in `.grok/agents/` or `~/.grok/agents/`. `--agents <JSON>`, `--no-subagents`, `[subagents] enabled|toggle|models`. Maximum depth is 1. `SubagentStart`/`SubagentStop` hooks. `grok dashboard` shows every session. `/workflow` uses Rhai files. `-w/--worktree` and `grok worktree ...` handle worktrees. — [grok subagents](https://docs.x.ai/build/features/subagents); grok 1.0.46 embedded docs; `grok --help`

### Inferences
- Both are native. Canopy only needs to surface them: attribute child sessions using stream `subagent_info` (agy) or `SubagentStart`/`SubagentStop` hooks and `summary.json` parent links (grok). Canopy's own mesh or worktree orchestration is still needed for cross-harness parallelism.

### Gaps
- agy hooks have no subagent lifecycle events, so Canopy cannot attribute child turns in agy without parsing the transcript.

## 8. Context compaction / summarize.

### Takeaway
grok has native manual and automatic compaction, with a configurable threshold, `PreCompact`/`PostCompact` hooks and an ACP method. agy 1.2.14 has **automatic compaction only**. Manual `/compact` arrived in 1.3.5.

### Cited Findings
- **agy 1.2.14: partial.** Automatic compaction into "checkpoint summaries", visible in `/context` and as `step_type: checkpoint` in stream-json. `/compact` was "Added" in 1.3.5 (changelog line 126, in the newer-than-pin range). — [agy /context](https://antigravity.google/docs/cli/commands/context); `agy changelog`
- **grok 1.0.46: native.** `/compact [instructions]`, automatic compaction at `[session] auto_compact_threshold_percent` (default 85), driven by `context_window`. `PreCompact`/`PostCompact` hooks (matcher `manual|auto`), the ACP method `x.ai/compact_conversation`, the `compaction_checkpoints/` directory, and `system/compact_boundary` in `streaming-messages-json`. — [grok sessions](https://docs.x.ai/build/features/sessions); [grok settings reference](https://docs.x.ai/build/settings/reference); grok 1.0.46 embedded docs

### Inferences
- **agy, what the IDE must build:** a manual "compact now" control. For 1.2.14, Canopy can only start a new conversation seeded with its own summary (a Canopy session digest), or upgrade the pin to 1.3.5 or later. agy has no compaction hook, so Canopy has to detect it from `checkpoint` steps.
- **grok:** native. Wire `PreCompact`/`PostCompact` into the event stream.

### Gaps
- None material.

## 9. Usage, cost and model reporting.

### Takeaway
grok is native and the most complete: per-turn tokens and USD cost through `grok usage <id>` (JSON), the json and stream spend fields, and `/usage` billing. agy reports tokens and model, but **no cost**. Token counts appear in headless JSON and stream output; interactively it shows quota through `/usage`.

### Cited Findings
- **agy 1.2.14: partial.** Headless `usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}` per step and per result. `init.model` appears only when it is overridden. Hook payloads carry `modelName` (which may be `"auto"`). `/usage` (alias `/quota`) shows quota buckets and has no headless JSON. `/credits` covers AI credits. No USD cost field in any documented output. docs/agent-parity.md: "No confirmed persisted token usage". — [agy headless](https://antigravity.google/docs/cli/headless); [agy /usage](https://antigravity.google/docs/cli/commands/usage); [agy hooks](https://antigravity.google/docs/hooks)
- **grok 1.0.46: native.** `grok usage <session-id> [turn]` returns JSON `{sessionId, updatedAt, session, turns}`, with `costUsdTicks` at 1e10 per USD. Headless `usage`, `modelUsage`, `total_cost_usd` and `total_cost_usd_ticks`; cost is omitted when partial and is "stamped for API-key traffic today; pool/OAuth paths often omit it". `signals.json` holds per-session counters. `/session-info` and `/context` exist. The model appears in `summary.json`, in `system/init` and on every assistant frame. — grok 1.0.46 embedded docs; verified with `grok usage --help`

### Inferences
- **agy, what the IDE must build:** cost. Canopy needs a price table keyed by agy model slug, applied to the token counts. In terminal mode, Canopy also needs a token source, because tokens are only reported headless, unless the transcript carries usage (unverified).
- **grok:** native. Poll `grok usage <id>` for the status tray. Expect missing cost on OAuth (SuperGrok) sessions.

### Gaps
- Whether agy's `transcript.jsonl` contains per-step usage was not verified.

## 10. Memory and instruction files.

### Takeaway
Both CLIs are native. agy reads `AGENTS.md`/`GEMINI.md` hierarchically, plus `.agents/rules/*.md` with frontmatter triggers, and shares the global `~/.gemini/GEMINI.md` with Gemini CLI. grok reads `AGENTS.md`, `CLAUDE.md`, `.grok/rules`, `.claude/rules` and `.cursor/rules`, and has opt-in cross-session memory.

### Cited Findings
- **agy 1.2.14: native.** Workspace: `AGENTS.md`/`GEMINI.md` and `.agents/{AGENTS,GEMINI}.md` in any directory, walking up to the workspace root. `.agents/rules/*.md` require YAML `trigger: always_on|model_decision|glob|manual`. Global: `~/.gemini/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.gemini/config/{AGENTS,GEMINI}.md`, `~/.gemini/config/rules/*.md` and `~/.gemini/antigravity-cli/rules/*.md`. Rules have a 20,000-token budget (1.2.x changelog). `/learn` (persist corrections as rules or skills) is listed in the current docs; its version is unverified. No `CLAUDE.md` support is documented. — [agy rules](https://antigravity.google/docs/rules); `agy changelog`
- **Gemini CLI relationship:** "Both CLI platforms use identical workspace context rules": `GEMINI.md`/`AGENTS.md` and the global `~/.gemini/GEMINI.md`. Skills moved from `~/.gemini/skills/` and `.gemini/skills/` to `~/.gemini/antigravity-cli/skills/` and `.agents/skills/`. `agy plugin import gemini` converts Gemini extensions. First launch offers to migrate tokens into the OS keyring. — [agy Gemini CLI migration](https://antigravity.google/docs/cli/gcli-migration)
  - Minor conflict: the customization guide embedded in the 1.2.14 binary places global skills at `~/.gemini/config/skills/`. — RE; [agy Gemini CLI migration](https://antigravity.google/docs/cli/gcli-migration)
- **grok 1.0.46: native.** It reads `AGENTS.md`, `Agents.md`, `AGENT.md`, `CLAUDE.md`, `Claude.md` and `CLAUDE.local.md` from the git root down to the cwd, plus `~/.grok/` global files, `.grok/rules/*.md`, `.claude/rules/` and `.cursor/rules/`. Gitignored files are skipped and there is no size cap. Memory is experimental and off by default (`[memory] enabled`, `GROK_MEMORY=1`, `--experimental-memory`/`--no-memory`). It is stored in `~/.grok/memory/`, or `~/.grok/memory-v2/{topics,observations}` when v2 is on. Commands: `/remember`, `/memory`, `/flush`, `/dream`, `grok memory clear [--workspace|--global|--all]`. `grok inspect` lists the loaded rules. — [grok AGENTS.md](https://docs.x.ai/build/features/project-rules); grok 1.0.46 embedded docs, Memory chapter; `grok memory --help`

### Inferences
- Both are native. Canopy's bootstrap reaches both through MCP `instructions` (item 11). Neither CLI needs Canopy-built memory. Canopy's shared-context injection for agy can only use `PreInvocation`/`SessionStart` `injectSteps`; for grok, use a `SessionStart` hook (stdout is ignored for passive events) or `--rules`/`_meta.rules`.

### Gaps
- It is unclear whether grok's passive `SessionStart` hook can inject context. The docs say stdout is ignored, which suggests not.

## 11. MCP client configuration / server mode.

### Takeaway
Both are native MCP clients with `mcp add/list/remove/enable/disable` CLIs. **Canopy's agy MCP path is correct** (`~/.gemini/config/mcp_config.json`). Neither CLI runs *as* an MCP server. grok instead serves ACP (`grok agent stdio|serve`).

### Cited Findings
- **agy 1.2.14: native client.** Global `~/.gemini/config/mcp_config.json`, workspace `.agents/mcp_config.json`, and plugin `plugins/<name>/mcp_config.json` (namespaced as `<plugin>_<server>`). Schema: `{"mcpServers": {"x": {"command", "args", "env"}}}` or `{"serverUrl": ...}` (remote). The legacy keys `url`/`httpUrl` were replaced. JSONC comments and trailing commas are tolerated (1.2.x). `agy mcp add [--env K=V] [--header "K: V"] [--type stdio|http] <name> <cmd|url> [args]`. MCP OAuth is supported. — [agy MCP](https://antigravity.google/docs/mcp); [agy Gemini CLI migration](https://antigravity.google/docs/cli/gcli-migration); verified with `agy mcp add --help`; `agy changelog`
  - Gemini CLI kept servers inline in `~/.gemini/settings.json`. agy does not read that location for MCP. — [agy Gemini CLI migration](https://antigravity.google/docs/cli/gcli-migration)
  - Server mode: none (RE: no ACP or MCP server subcommand in `--help`).
- **grok 1.0.46: native client.** `grok mcp add|list|remove|enable|disable|doctor`, with `-t stdio|http|sse`, `-s user|project`, `-e`, `-H`. TOML lives in `[mcp_servers.<name>]` in `~/.grok/config.toml` or `.grok/config.toml` (walking up to the git root), with fields `command`, `args`, `env`, `cwd` or `url`, `headers`, `bearer_token_env_var`, plus `enabled`, `startup_timeout_sec` and `tool_timeout_sec`. `${VAR}` and `{{session_id}}` are expanded. OAuth tokens go in `~/.grok/mcp_credentials.json`. **It also loads `~/.claude.json`, `.cursor/mcp.json` and `.mcp.json`** at lower priority. Tools are exposed as `<server>__<tool>` through `search_tool`/`use_tool`. ACP `session/new` accepts `mcpServers` per session. — [grok MCP](https://docs.x.ai/build/features/mcp-servers); verified with `grok mcp add --help`; grok 1.0.46 embedded docs
  - Server mode: ACP agent (`grok agent stdio`, `serve`, `headless` relay, `leader`), not an MCP server. — `grok agent --help`

### Inferences
- Both are native. For grok, Canopy should register `mcp_servers.canopy` in `~/.grok/config.toml` (or pass `mcpServers` on ACP `session/new`). Because grok also reads `~/.claude.json`, a Claude-registered Canopy MCP server may already appear in grok, possibly twice if it is also registered natively. Canopy should dedupe, or disable the scan with `[compat.claude] mcps = false`.

### Gaps
- On this machine, `grok inspect --json` showed `mcpServers: []`, so a Canopy MCP entry in `~/.claude.json` was not observed here and the import behaviour was not demonstrated empirically.

## 12. Auth model and third-party-use policy.

### Takeaway
**Most consequential finding: Google's agy FAQ says that wrapping `agy` inside third-party applications is not supported under consumer plans.** It also says third-party access to Antigravity is a ToS violation that can lead to suspension. A Canopy agy host or headless runner on a consumer Google login is therefore policy-exposed; the recommended path is a Gemini API key or Gemini Enterprise. grok officially documents IDE hosting over ACP. No xAI restriction on third-party harnesses was found, but none was found confirming it is allowed either.

### Cited Findings
- **agy 1.2.14:**
  - Auth: browser OAuth into the OS keyring (consumer Google account or Business/Google Cloud SSO/WIF). `GEMINI_API_KEY` only works together with `"modelProvider": "gemini"` in settings. ADC via `AGY_ADC_AUTH=true` (plus `GOOGLE_CLOUD_QUOTA_PROJECT` and `GOOGLE_CLOUD_LOCATION`), or `enableAdc` in `~/.gemini/config/config.json`. Headless runs use cached credentials and fail with "authentication required" when none are present. The binary also contains `AGY_LLM_GATEWAY_URL/_API_KEY/_HEADERS` (RE, undocumented). — [agy install/auth](https://antigravity.google/docs/install); [agy headless](https://antigravity.google/docs/cli/headless)
  - Policy (official): "Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service... can result in suspension or termination of your account. To use a third-party coding agent with Gemini, we recommend using a Gemini Enterprise or Google AI Studio API key." Also: "Antigravity CLI headless mode (`agy -p`) is intended for direct scripting and CI workflows. **Wrapping `agy` inside third-party coding agents or applications**, or automating account rotation, **is not supported under consumer plans.**" — [agy FAQ](https://antigravity.google/docs/faq)
  - Enforcement reports (user-reported, unverified): bans after using OpenClaw, OpenCode, or Claude Code through Antigravity OAuth proxies, and slow appeals. — [Google AI forum thread](https://discuss.ai.google.dev/t/got-banned-from-antigravity-for-using-opencode-submitted-appeal-but-still-locked-out/131169); [Google AI forum thread](https://discuss.ai.google.dev/t/account-restricted-without-warning-google-ai-ultra-oauth-via-openclaw/122778?page=3)
- **grok 1.0.46:**
  - Auth: `grok login` (browser OAuth), `--oauth`, `--device-auth` (device code for SSH or headless), `XAI_API_KEY`, per-model `api_key`/`env_key`. Resolution order is `model.api_key` > `model.env_key` > session token > `XAI_API_KEY`. Credentials go in `~/.grok/auth.json`. Enterprise options: `disable_api_key_auth`, `force_login_team_uuid`, `GROK_AUTH_PROVIDER_COMMAND` (RE). ACP `authenticate` uses `methodId` `xai.api_key` or `cached_token`. — [grok enterprise](https://docs.x.ai/build/enterprise); [grok headless/ACP](https://docs.x.ai/build/cli/headless-scripting); `grok login --help`
  - Policy: ACP is documented for "IDEs, SDKs, eval harnesses, and custom apps", with Zed, Neovim and Emacs listed as supported clients. — grok 1.0.46 embedded docs; [grok headless/ACP](https://docs.x.ai/build/cli/headless-scripting#acp)
  - Access tier: third-party reports conflict (SuperGrok Heavy only, versus SuperGrok and X Premium+ early beta). — [aiweekly](https://aiweekly.co/alerts/xai-launches-grok-build-cli-coding-agent); [Verdent guide](https://www.verdent.ai/zh-CN/guides/grok-build-install)

### Inferences
- **agy, what the IDE must do:** treat the policy as a product constraint, not an implementation gap. Two levels:
  - Hosting the real `agy` binary interactively in a PTY, where the user drives it, is arguably "direct use", but the FAQ's "wrapping agy inside third-party applications" wording plausibly covers it.
  - A Canopy **headless Build runner** on consumer OAuth is squarely in the unsupported zone.
  - Recommendation: gate any agy headless or automation feature behind a Gemini API key (`modelProvider: gemini`), ADC, or an Enterprise login, and show a warning for consumer accounts.
- **grok:** ACP hosting is the vendor-intended integration, so Canopy can rely on it. Prefer `XAI_API_KEY` for headless runs, because cost reporting is complete on that path.

### Gaps
- No official xAI statement was found on using a SuperGrok/OAuth login from third-party hosts beyond the ACP client list.
- The exact Antigravity ToS clause text at antigravity.google/terms was not fetched; the FAQ is the cited source.

## 13. Model switching.

### Takeaway
Both CLIs are native. agy uses `--model`/`--effort`, `/model [name]` (which persists as the default) and `agy models`. grok uses `-m`/`--effort`, `/model <name>` (`/m`), `Ctrl+M`, `grok models`, and ACP `session/set_config_option` for live programmatic switching.

### Cited Findings
- **agy 1.2.14: native.** `--model <slug>` and `--effort low|medium|high|max` (per model) are in 1.2.14 help. `agy models` lists slugs. `/model <name>` switches and saves the default; `/model` opens a picker. The setting `model` is saved by label. Headless runs fail loudly on an unknown model. `/model <name> <prompt>` (a one-shot switch, then back to the saved model) is in the pin (added 1.1.27, fixed 1.2.6). Stream-json rejects `/model`. — verified with `agy --help`; [agy headless](https://antigravity.google/docs/cli/headless); `agy changelog`
- **grok 1.0.46: native.** `-m/--model`, `--reasoning-effort/--effort` (`none` through `max`), `/model <name>` (alias `/m`), `Ctrl+M` picker, `/effort`, `grok models`, `[models] default|allowed_models|hidden_models`, `GROK_DEFAULT_MODEL`, and BYOK `[model.<id>]` with `api_backend` `chat_completions|responses|messages`. ACP `session/set_config_option` with `configId` `model` or `reasoning_effort` emits `config_option_update`. — `grok --help`; [grok settings reference](https://docs.x.ai/build/settings/reference); grok 1.0.46 embedded docs

### Inferences
- Both are native. Canopy's switcher can type `/model <name>` into the PTY for both CLIs, or use ACP `set_config_option` for grok. Nothing needs to be built beyond a per-agent model list from `agy models` and `grok models`.

### Gaps
- None material.

## 14. Self-update mechanism (update command, auto-update, pinning, disabling).

### Takeaway
Both CLIs auto-update in the background by default, which **breaks version pinning unless Canopy disables it**. agy: `agy update`, and `AGY_CLI_DISABLE_AUTO_UPDATE=true` (present in the 1.2.14 binary). grok: `grok update [--check --json --version X --alpha|--stable]`, plus `GROK_DISABLE_AUTOUPDATER=1`, `--no-auto-update` or `[cli] auto_update = false`.

### Cited Findings
- **agy 1.2.14: native.** `agy update` ("Update CLI"; `--help` prints no flags, so there is **no documented version-pinning flag**). A background self-updater uses a 15-minute TTL marker `last_check.timestamp` and an advisory lock `update.lock` in `~/.gemini/antigravity-cli/updater/`, and installs to `~/.local/bin/` (or `%LOCALAPPDATA%\agy\bin` on Windows). Disable with `export AGY_CLI_DISABLE_AUTO_UPDATE=true`; the string is present in the 1.2.14 binary (RE confirmation). `agy changelog` prints release notes, and in this environment it printed notes up to 1.4.7, so it fetches remotely. — [agy troubleshooting](https://antigravity.google/docs/cli/troubleshooting); verified with `agy update --help`
- **grok 1.0.46: native.** `grok update` with `--check`, `--json`, `--force-reinstall`, `--version <V>` (pin or downgrade), `--alpha` and `--stable`. `[cli] channel = stable|alpha|enterprise`. Suppression: `--no-auto-update` (per session; hidden from `--help` but accepted, verified), `GROK_DISABLE_AUTOUPDATER=1` (per process), automatic when stderr is not a TTY, and `[cli] auto_update = false` (persistent, pinnable in `requirements.toml`). The version cache is in `~/.grok/version.json`. The stdio agent skips background updates unless it runs from `$GROK_HOME/bin/grok`. npm install is `npm install -g @xai-official/grok`. Plugins auto-update separately (`plugin_auto_update = false`). — verified with `grok update --help`; grok 1.0.46 embedded docs, "Update Check Suppression"; [grok enterprise](https://docs.x.ai/build/enterprise); [grok settings reference](https://docs.x.ai/build/settings/reference)

### Inferences
- **agy, what the IDE must build:** pinning. With no `--version` flag, Canopy must keep its own vendored binary (as `/usr/local/bin/agy` is here, owned by root) and export `AGY_CLI_DISABLE_AUTO_UPDATE=true` in every PTY it spawns.
- **grok:** native. Export `GROK_DISABLE_AUTOUPDATER=1` in Canopy PTYs. Here grok is a symlink into `/opt/canopy/vendor/grok`, so Canopy already vendors it. Use `grok update --version 1.0.46` to restore the pin if needed.

### Gaps
- Whether agy's updater will overwrite a root-owned `/usr/local/bin/agy`, or only `~/.local/bin`, was not tested.

## 15. Clipboard / copy behaviour in the TUI, OSC 52, remote/SSH copy issues.

### Takeaway
grok is native and thoroughly documented: native, tmux and OSC 52 routes, a `/doctor` report, the `GROK_CLIPBOARD_NO_OSC52` kill switch, a fallback file at `~/.grok/last-copy.txt`, and `grok wrap` for SSH or containers. agy has `/copy [n|btw]` and `copyOnSelect`. Its binary includes an OSC 52 clipboard writer with support detection (RE), and the docs only cover iTerm2 and tmux OSC 52 settings.

### Cited Findings
- **agy 1.2.14: partial (documented) / native (RE).** `/copy`, `/copy <n>`, `/copy btw`. `copyOnSelect` (default true; alt-screen mouse selection copies; when off, terminal-native selection works in the artifact viewer). `altScreenMode default|always|never`. Docs advise enabling iTerm2 "Applications in terminal may access clipboard (enabling OSC 52 write channels)" and `set -s set-clipboard on` in tmux, and say image paste over SSH fails. — [agy CLI reference](https://antigravity.google/docs/cli/reference); [agy troubleshooting](https://antigravity.google/docs/cli/troubleshooting); `agy changelog`
  - RE: the binary links `aymanbagabas/go-osc52` and `atotto/clipboard`, and has `store.OSC52Clipboard.WriteAll`, `store.detectOSC52Support` and `ansi.SetSystemClipboard`. It also has the env var `AGY_CLI_FORCE_OSC` (purpose undocumented, probably forces OSC output). — binary strings, no official doc
- **grok 1.0.46: native.** Up to three routes: native (`arboard`), the tmux buffer, and OSC 52 for Linux, tmux, SSH and displayless containers. `/doctor` and `grok doctor --json` report `clipboard{nativeRoute, osc52Route, osc52Capability, tmuxRoute, wrapSink, delivery}`; verified locally. `GROK_CLIPBOARD_NO_OSC52=1` disables OSC 52, and `GROK_CLIPBOARD_NO_DATA_CONTROL=1` covers Wayland. Over SSH with an unknown terminal, delivery is marked "not verified" and the text is saved to `~/.grok/last-copy.txt` (`GROK_COPY_FILE`). `grok wrap <cmd>` (experimental) intercepts OSC 52 in a local PTY, and `grok doctor fix ssh-wrap` sets that up. `[ui] keep_text_selection`, `/copy [N]`, `grok export --clipboard`. — [grok terminal support](https://docs.x.ai/build/cli/terminal-support); grok 1.0.46 embedded docs, Terminal chapter; verified with `grok doctor --json` and `grok wrap --help`

### Inferences
- For both, Canopy's job is to **handle OSC 52 in its xterm** (base64 payload on `ESC ] 52 ; c ; … BEL/ST`) and write it to the host clipboard. That covers remote and SSH Canopy workspaces for both CLIs.
  - grok: Canopy could set `GROK_CLIPBOARD_NO_OSC52=1` only if its terminal cannot handle OSC 52, which would avoid raw payload text appearing.
  - agy: in alt-screen mode, mouse capture means Canopy's own selection may not work. Recommend `copyOnSelect` stays on, with OSC 52 handled.
  - If Canopy's terminal lacks OSC 52 support, it must build that. This is a Canopy-side gap, not a harness one.

### Gaps
- agy's OSC 52 detection heuristics, and what `AGY_CLI_FORCE_OSC` controls, are undocumented. Testing in Canopy's xterm over a remote workspace is required.

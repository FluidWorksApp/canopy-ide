# Claude Code (v2.1.310): native capability parity matrix for Canopy

Scope note: findings are pinned to the locally installed `claude` 2.1.310 (`claude --version` prints `2.1.310 (Claude Code)`). Local CLI output was captured on 2026-10-26 with `claude --help` and `claude <subcommand> --help`, and is cited below as "[local --help]". Web sources are the official docs at code.claude.com/docs, fetched on the same day. "Official" means Anthropic docs or CLI help. "RE" means community reverse-engineering. Version numbers come from the docs' own "requires vX" notes. Unless marked otherwise, every feature below exists in 2.1.310.

Each section starts with a one-line matrix row in its Takeaway: **Support** / **Programmatic** / **Official vs RE**. The "IDE must build" item, which is mandatory, is always the first bullet under Inferences.

---

## 1. Headless/structured mode: non-interactive run, streaming JSON events, system-prompt flag, tool allow/deny, plan-mode flag, resume-by-id, input streaming

### Takeaway
**Support: native (full). Programmatic: yes, this is the primary programmatic surface. Official.** `claude -p` covers every sub-item: `--output-format text|json|stream-json`, `--input-format stream-json`, `--system-prompt` and `--append-system-prompt`, `--allowedTools`, `--disallowedTools` and `--tools`, `--permission-mode plan`, `--resume <id>` and `--session-id <uuid>`, `--json-schema`, and `--max-budget-usd`. The Agent SDK (TS and Python) wraps the same binary.

### Cited Findings
- `-p/--print` runs non-interactively. `--output-format` accepts `text` (default), `json` (a single result) or `stream-json` (realtime streaming), and works only with `--print`. — [local --help]
- `--input-format stream-json` gives "realtime streaming input" (print mode only). `--replay-user-messages` re-emits stdin user messages on stdout as an acknowledgment. `--include-partial-messages` adds partial message chunks. `--include-hook-events` adds hook lifecycle events to the stream. `--forward-subagent-text` forwards subagent text and thinking blocks with `parent_tool_use_id` set. — [local --help]
- System prompt: `--system-prompt <prompt>` replaces the prompt and `--append-system-prompt <prompt>` appends to it. The `-file` variants are named in the `--bare` help text. `--system-prompt-snapshot on|off` records the prompt once per conversation and reuses it verbatim on resume until compaction. On is the default except under `--bare`. — [local --help]
- Replacing the system prompt with `--system-prompt` also drops the git status snapshot. — [headless docs](https://code.claude.com/docs/en/headless)
- Tool control: `--allowedTools` and `--disallowedTools` take permission-rule syntax, for example `"Bash(git *) Edit"`. `--tools` restricts the built-in tool set (`""` means none, `"default"` means the default set, or names such as `"Bash,Edit,Read"`). — [local --help]
- In `Bash(git diff *)`, the trailing ` *` is a prefix match, and the space before `*` matters. — [headless docs](https://code.claude.com/docs/en/headless)
- Plan mode is selected with `--permission-mode plan`. The choices are `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk` and `plan`. — [local --help]
- From v2.1.302, a `claude -p` run with no mode set starts in Manual mode, so any call that needs approval is denied unless a `PermissionRequest` hook or `--permission-prompt-tool` approves it. — [headless docs](https://code.claude.com/docs/en/headless)
- `--permission-prompts host|none` (v2.1.259+): `none` auto-denies anything that would prompt and removes `AskUserQuestion`. With stream-json, denials arrive as `permission_denied` system messages, and the result lists them in `permission_denials`. — [headless docs](https://code.claude.com/docs/en/headless); [local --help]
- Resume: `--resume <session-id|name>`, `--continue`, `--fork-session`, and `--session-id <uuid>` to preassign an ID. `--resume` also accepts an absolute `.jsonl` transcript path. A session ID resolves from any directory on the machine. — [local --help]; [headless docs](https://code.claude.com/docs/en/headless)
- JSON result: `--output-format json` returns `result`, `session_id`, usage, `total_cost_usd`, and a per-model cost breakdown. With `--json-schema`, the validated object is in `structured_output`, which is absent if the run fails to produce one. — [headless docs](https://code.claude.com/docs/en/headless)
- Stream events: the stream emits a `system/init` event (model, tools, `mcp_servers`, `mcp_server_errors`, `plugins`, `plugin_errors`, and a `capabilities` array for feature detection, such as `interrupt_receipt_v1`), then `assistant`, `user` and `stream_event` messages (`.event.delta.type == "text_delta"`), `system/api_retry` (with `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error` category), `system/plugin_install`, and `hook_started`/`hook_progress`/`hook_response`. The last line is a `result` message. — [headless docs](https://code.claude.com/docs/en/headless)
- Exit codes: 0 on success and non-zero on failure. SIGTERM gives exit 143 and leaves the turn unfinished. SIGINT or the SDK's `interrupt()` ends the turn cleanly. Piped stdin is capped at 10 MB. — [headless docs](https://code.claude.com/docs/en/headless)
- `--bare` skips auto-discovery of hooks, plugins, CLAUDE.md, MCP, auto memory and keychain, and uses only `ANTHROPIC_API_KEY` or `apiKeyHelper` for auth (no OAuth). The docs recommend it for SDK/scripted calls and say it "will become the default for `-p` in a future release". — [headless docs](https://code.claude.com/docs/en/headless); [local --help]
- Without `--bare`, `-p` runs project hooks and connects `.mcp.json` servers even in untrusted folders, with no trust dialog. — [headless docs](https://code.claude.com/docs/en/headless)
- Other headless flags: `--max-budget-usd`, `--fallback-model`, `--no-session-persistence`, `--prompt-suggestions`, `--strict-mcp-config`, `--settings <file-or-json>` and `--setting-sources`. — [local --help]

### Inferences
- **IDE must build:** nothing for the core loop. Canopy should drive `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages` (or the TS Agent SDK) and parse NDJSON. It still needs: (a) its own approval UI, wired through `--permission-prompt-tool` (an MCP tool Canopy hosts) or a `PermissionRequest` hook, because Manual is the `-p` default from 2.1.302; (b) feature detection from `system/init.capabilities` rather than version strings; (c) a decision on `--bare`. Bare gives reproducibility but drops the user's CLAUDE.md, hooks and subscription OAuth, which conflicts with subscription users (see section 12).
- The pinned version is 2.1.310, and several behaviours (Manual default, `--permission-prompts`) arrived in 2.1.25x–2.1.30x. Canopy should therefore enforce a minimum version.

### Gaps
- I did not fetch the exact stream-json input message envelope for this version. The SDK convention is `{"type":"user","message":{"role":"user","content":[...]}}`. The full `SDKMessage` TypeScript union, including the exact `result` fields (`subtype`, `num_turns`, `duration_ms`, `modelUsage`), is in the TS SDK reference and was not fetched. Verify against [agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript).
- The `--permission-prompt-tool` flag is referenced in the docs but does not appear in the local `--help` excerpt I captured. Its exact payload contract was not retrieved.

---

## 2. Checkpoints / rewind / undo: interactive and programmatic, what is covered (files, conversation, bash side effects), retention

### Takeaway
**Support: native for file edits and conversation. Partial for Bash and subagent side effects. Programmatic: yes for files only, via the SDK's `rewindFiles()` or the hidden CLI flag `--rewind-files`. Conversation rewind is interactive only. Official.**

### Cited Findings
- Each user prompt that starts a turn creates a checkpoint. File snapshots are kept for the 100 most recent checkpoints in a session. Checkpoints persist with the conversation, so `/rewind` works after resume. — [checkpointing](https://code.claude.com/docs/en/checkpointing)
- Retention: snapshots are deleted in the retention sweep about 30 days after the session last saved one. `cleanupPeriodDays` controls this. If snapshots are gone, a rewind fails with "No files were restored". — [checkpointing](https://code.claude.com/docs/en/checkpointing)
- Interactive: `/rewind`, or Esc Esc on an empty prompt, opens a menu with Restore code and conversation, Restore conversation, Restore code, Summarize from here, Summarize up to here, and Never mind. — [checkpointing](https://code.claude.com/docs/en/checkpointing)
- Bash: a file changed only by Bash is not tracked. Bash changes to a file are undone only if Claude had already edited that file with its file tools. — [checkpointing](https://code.claude.com/docs/en/checkpointing)
- Subagents: subagent edits are usually not captured. The exception is a foreground forked skill (`context: fork`). External edits and edits from concurrent sessions are not tracked. Symlinks and hard links are skipped with a "Restored the code, but skipped N files" warning. Messages sent mid-turn get no checkpoint of their own. — [checkpointing](https://code.claude.com/docs/en/checkpointing)
- SDK: `enableFileCheckpointing: true` (TS) or `enable_file_checkpointing=True` (Python), plus `extraArgs: {"replay-user-messages": null}`, makes each user message's `uuid` a checkpoint ID. `rewindFiles(uuid)` / `rewind_files(uuid)` restores files only, not the conversation. It tracks Write, Edit and NotebookEdit only. `RewindFilesResult.skippedLinks` exists from v2.1.216. — [SDK file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)
- CLI equivalent: `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true claude -p --resume <session-id> --rewind-files <checkpoint-uuid>`. The flag is not in `--help`. It prints `Files rewound to state at message <uuid>`. Directory create, move and delete are not undone. — [SDK file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)
- `--fork-session` and `/branch` copy a conversation into a new session ID, which is the docs' recommended way to branch rather than rewind. — [sessions](https://code.claude.com/docs/en/sessions)

### Inferences
- **IDE must build:** (a) **Conversation rewind for headless sessions.** No documented headless "truncate conversation to message X" exists. Canopy can approximate it by forking (`--resume <id> --fork-session`) and re-sending from a chosen prompt, or by keeping its own message-level branching. (b) **Bash, subagent and external side-effect undo.** Use a git-based shadow snapshot per turn, for example `git stash create` or a hidden worktree ref, taken in a `UserPromptSubmit` or `PreToolUse(Bash)` hook. (c) A checkpoint timeline UI keyed on the `uuid` values of replayed user messages, calling `--rewind-files` or SDK `rewindFiles`. (d) Its own retention policy if 30 days or 100 checkpoints is too short.

### Gaps
- No documented way to list available checkpoints for a session programmatically. Canopy has to record the UUIDs itself from the stream.
- I found no documented headless equivalent of "Summarize from here / up to here".

---

## 3. IDE integration protocol: lock files, transport, diagnostics, selection, diff viewer, open file

### Takeaway
**Support: native in the CLI as a client. The protocol is semi-documented: transport, lock file and auth are official, while the full RPC tool set is reverse-engineered. Programmatic: yes, any editor that writes the lock file and serves the MCP-over-WebSocket server gets the integration. Official for transport and lock files; RE for tool schemas.**

### Cited Findings
- The VS Code extension runs a local MCP server named `ide` that the CLI auto-connects to. Through it the CLI opens diffs in the native diff viewer, reads the selection for @-mentions, and executes Jupyter cells. The server is hidden from `/mcp`. — [VS Code docs](https://code.claude.com/docs/en/vs-code)
- Transport: binds `127.0.0.1` on a random port in 10000–65535 (not configurable), over unencrypted `ws://`. — [VS Code docs](https://code.claude.com/docs/en/vs-code)
- Lock file: each activation writes a fresh random auth token to `~/.claude/ide/<port>.lock`, or to `$CLAUDE_CONFIG_DIR/ide/` when that is set, with mode `0600` in a `0700` directory. The CLI must send the token as the `X-Claude-Code-Ide-Authorization` header. — [VS Code docs](https://code.claude.com/docs/en/vs-code)
- Selection and open-file context: while connected, the CLI attaches the current selection and active file path to every prompt and shows `⧉ Selected N lines from <file>`. A `Read` deny rule suppresses this for matching files. — [VS Code docs](https://code.claude.com/docs/en/vs-code)
- Tools: the server hosts "a dozen tools", but the model sees only two: `mcp__ide__getDiagnostics`, which returns Problems-panel diagnostics optionally scoped to a file, and `mcp__ide__executeCode`, which runs Python in the Jupyter kernel. The rest are internal RPC (opening diffs, reading selections, saving files). — [VS Code docs](https://code.claude.com/docs/en/vs-code)
- Connecting: in an integrated terminal the CLI connects automatically. From an external terminal, run `/ide`. The `--ide` flag auto-connects on startup if exactly one valid IDE is available. `--bare` skips the automatic IDE connection unless `--ide` is passed. — [VS Code docs](https://code.claude.com/docs/en/vs-code); [local --help]; [headless docs](https://code.claude.com/docs/en/headless)
- Auto-installing the extension can be disabled with `autoInstallIdeExtension: false` or `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1`. — [VS Code docs](https://code.claude.com/docs/en/vs-code)
- RE, lock file body: `{pid, workspaceFolders, ideName, transport: "ws", authToken}`. Messages are JSON-RPC 2.0 MCP (`initialize`, `tools/list`, `tools/call`). — [Zed patch (RE)](https://data.gpo.zugaina.org/bentoo/app-editors/zed/files/0002-claude-code-ide-integration.patch); [Sublime plugin (RE)](https://glama.ai/mcp/servers/Cognisant-llc/sublime-claude-code)
- RE, MCP protocol version: sources conflict. One gives `2024-11-05` ([Zed patch](https://data.gpo.zugaina.org/bentoo/app-editors/zed/files/0002-claude-code-ide-integration.patch)) and another `2025-03-26` ([Sublime plugin](https://glama.ai/mcp/servers/Cognisant-llc/sublime-claude-code)).
- RE, tool set: the official extension registers 12 tools, including `openDiff`, `openFile`, `close_tab`, `closeAllDiffTabs`, `getDiagnostics`, `getOpenEditors` and `getWorkspaceFolders`. `openDiff` blocks until the user accepts or rejects. — [codepointer analysis (RE)](https://codepointer.substack.com/p/claude-code-cli-bridging-terminal); [tomevault (RE)](https://tomevault.io/tome/firish/claude_code_vs)
- RE, known gap: in acceptEdits mode the CLI writes files directly, with no `openDiff`/`openFile` signal to the IDE. An open feature request asks for push-style edit notifications. — [claudeissues mirror (RE)](https://claudeissues.com/issue/52360-feature-request-mcp-protocol-needs-push-style-edit-notifications-for-ide-integra)
- Third-party editors (Zed, Sublime, Obsidian, Nova) already implement this lock-file protocol. — [glama Sublime](https://glama.ai/mcp/servers/Cognisant-llc/sublime-claude-code); [Nova extension](https://extensions.panic.com/extensions/ca.okapi/ca.okapi.claudecode-nova)

### Inferences
- **IDE must build:** for terminal-hosted `claude` sessions, a lock-file plus WebSocket MCP server exposing at least `getDiagnostics`, `openDiff` (blocking accept/reject), `openFile`, `getOpenEditors`, `getWorkspaceFolders`, the selection tools and `close_tab`. That gives native diff review and selection context. Because the tool schemas are reverse-engineered and change without notice, wrap the server behind a version-gated adapter. For headless (`-p` / SDK) sessions the IDE protocol is not needed. Canopy can expose diagnostics, open-file and selection as its own MCP tools via `--mcp-config` (the repo already has `canopy_diagnostics`, `canopy_open_file` and `canopy_show_diff`). For edits made under acceptEdits, Canopy must derive diffs itself from `PostToolUse` hook payloads or file watching.
- I found no `~/.claude/ide` integration code in the Canopy repo (grep found none), so this would be new work.

### Gaps
- No official schema for the internal RPC tools (`openDiff` parameters and return values, selection-changed notifications such as `selection_changed`, `at_mentioned`). Treat all of it as RE and unstable.
- The MCP protocol version the 2.1.310 CLI negotiates is unresolved (see the conflict above).

---

## 4. Hooks / lifecycle events: event list, payloads, blocking decisions, context injection

### Takeaway
**Support: native and very rich (33 events). Programmatic: yes. Hooks come from settings files, `--settings <json>`, plugins, skill or agent frontmatter, or SDK callbacks, and `--include-hook-events` streams them. Official.**

### Cited Findings
- The 33 events are: `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `SessionEnd`. — [hooks](https://code.claude.com/docs/en/hooks)
- Common input fields (stdin JSON, or the POST body for HTTP hooks): `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort.level`, `hook_event_name`, and `agent_id`/`agent_type` inside subagents. Tool events add `tool_name`, `tool_input` and `tool_use_id`. Model-switch events add `from_model`/`to_model`. — [hooks](https://code.claude.com/docs/en/hooks)
- Exit codes: 0 means success, and stdout is parsed as JSON if it is a single object. 2 is a blocking error, with stderr as the reason, and it blocks even if the JSON says allow. Other codes are non-blocking unless `onFailure: "block"` is set (v2.1.295+). — [hooks](https://code.claude.com/docs/en/hooks)
- Events that can block: `PreToolUse`, `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `SubagentStop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `ConfigChange`, `PostToolBatch`, `PreCompact`, `PreModelSwitch`, `Elicitation`, `ElicitationResult`, `WorktreeCreate` and `WorktreeRemove`. `PermissionRequest` denies through `decision.behavior` instead. — [hooks](https://code.claude.com/docs/en/hooks)
- JSON output: `continue`, `stopReason`, `systemMessage`, `terminalSequence`, and a top-level `decision: "block"` with `reason`. `hookSpecificOutput` can carry `permissionDecision` (`allow|deny|ask|defer`), `permissionDecisionReason`, `updatedInput`, `updatedToolOutput` (PostToolUse), `retry` (PermissionDenied), `additionalContext`, and `SessionStart` extras (`initialUserMessage`, `watchPaths`, `sessionTitle`, `reloadSkills`). — [hooks](https://code.claude.com/docs/en/hooks)
- Context injection: `additionalContext` is accepted on `SessionStart`, `SubagentStart`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `SubagentStop` and `PostModelSwitch`. It is wrapped in a system reminder, and strings over 10,000 characters spill to a file. — [hooks](https://code.claude.com/docs/en/hooks)
- Handler types are `command` (with an `args` exec form, `async`, `asyncRewake`, `shell`), `http` (`url`, `headers`, `allowedEnvVars`), `mcp_tool` (`server`, `tool`, `input`), `prompt`, and `agent` (experimental). The `if` field takes permission-rule syntax. Default timeouts: 600 s for command, http and mcp_tool; 30 s for prompt; 60 s for agent; 30 s on `UserPromptSubmit` and the model-switch events; and a 1.5 s shared budget for `SessionEnd`. — [hooks](https://code.claude.com/docs/en/hooks)
- Hooks load from `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed policy, plugin `hooks/hooks.json`, and skill or subagent frontmatter. `disableAllHooks` and `allowManagedHooksOnly` also exist. — [hooks](https://code.claude.com/docs/en/hooks)
- `--include-hook-events` puts every hook lifecycle event in the stream-json output. — [local --help]

### Inferences
- **IDE must build:** nothing structural. Canopy should inject its hooks per session with `--settings '<json>'`, which avoids editing the user's files, and prefer `type: "http"` hooks pointing at a Canopy localhost endpoint over shell scripts. Use `PreToolUse` and `PermissionRequest` for approvals, `PostToolUse` for diff capture, `Notification` and `Stop` for status, and `SessionStart` with the `compact` source to re-inject context. The repo's existing `src-tauri/src/bin/canopy_hook.rs` suggests this pattern is already partly in use.
- Caveat: `--bare` skips settings-defined and plugin hooks. If Canopy uses `--bare`, it must pass hooks through `--settings` (the bare help says to provide context explicitly via `--settings`) or through SDK callbacks.

### Gaps
- Per-event payload schemas beyond the common fields were truncated in my fetch (the page is 282 KB). The full per-event inputs are at https://code.claude.com/docs/en/hooks.md.

---

## 5. Permission modes and OS sandbox

### Takeaway
**Support: native. Six permission modes plus an opt-in OS sandbox for shell commands (Seatbelt on macOS, bubblewrap on Linux and WSL2, none on native Windows). Programmatic: yes, through `--permission-mode`, `--allowedTools`/`--disallowedTools`, `--permission-prompts`, `--permission-prompt-tool`, `--settings` with `sandbox.*`, and `--restricted`. Official.**

### Cited Findings
- Modes: `acceptEdits`, `auto` (a classifier reviews actions), `bypassPermissions`, `manual` (alias `default`), `dontAsk` (deny anything that would prompt), and `plan`. — [local --help]; [sub-agents](https://code.claude.com/docs/en/sub-agents)
- `--dangerously-skip-permissions` and `--allow-dangerously-skip-permissions` exist. `--restricted` removes the code-running tools (Bash, PowerShell and the others) and WebFetch unless `--tools` names them, ignores user, project and local settings, confines the file tools to the working directories, and refuses `bypassPermissions`. — [local --help]
- A `-p` run starts in Manual mode by default (v2.1.302+). `dontAsk` still allows read-only commands and allow-rule matches. `acceptEdits` auto-approves file writes and `mkdir`/`touch`/`mv`/`cp`. — [headless docs](https://code.claude.com/docs/en/headless)
- The sandbox covers Bash, PowerShell and Monitor commands and their child processes only. The file tools, WebFetch, MCP, hooks and LSP are not sandboxed. It is off by default and enabled with `/sandbox` or `sandbox.enabled: true`. — [sandboxing](https://code.claude.com/docs/en/sandboxing)
- Platforms: macOS uses Seatbelt. Linux and WSL2 use `bwrap` plus `socat`. Native Windows has no sandbox. The sandbox is built on the open-source `@anthropic-ai/sandbox-runtime`. — [sandboxing](https://code.claude.com/docs/en/sandboxing)
- Sandbox keys: `sandbox.enabled`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands`, `failIfUnavailable`, `excludedCommands`, `filesystem.allowWrite`/`denyWrite`/`allowRead`/`denyRead`/`disabled`, `network.allowedDomains`/`deniedDomains`, `credentials.files`/`envVars`, and the experimental `network.tlsTerminate`. — [sandboxing](https://code.claude.com/docs/en/sandboxing)
- Defaults: writes are allowed in the cwd, temp and added dirs. Reads cover most of the machine. Network goes through an allowlist proxy that starts empty. The proxy does not inspect TLS. — [sandboxing](https://code.claude.com/docs/en/sandboxing)
- A failed sandboxed command may be retried with `dangerouslyDisableSandbox`. The approver depends on mode: none in bypass, a prompt in Manual and acceptEdits, the classifier in auto, and denial in dontAsk. — [sandboxing](https://code.claude.com/docs/en/sandboxing)

### Inferences
- **IDE must build:** (a) a permission-prompt UI and transport, either an MCP `--permission-prompt-tool` served by Canopy or a `PermissionRequest` http hook, since headless has no TUI to answer prompts; (b) a mode switcher mapped onto `--permission-mode` at launch, plus a stream-json control message mid-session if supported (see Gaps); (c) a sandbox for native Windows and for non-shell tools (file tools, MCP), if Canopy wants that guarantee. Canopy's remote VM workspaces may already be its isolation boundary.

### Gaps
- I did not verify whether a mid-session permission-mode change is possible over stream-json input. The SDK has `setPermissionMode()`, but the underlying control-message format was not fetched.
- I did not fetch the full `permission-modes` page (auto-mode classifier details, eligibility).

---

## 6. Sessions: list, resume, fork, transcript location and format

### Takeaway
**Support: native. Programmatic: resume and fork by ID or path are full. Listing is partial: `claude agents --json` lists only active sessions, and there is no documented CLI to list all past sessions. The transcript format is explicitly internal and unstable. Official.**

### Cited Findings
- Entry points: `claude --continue`, `--resume` (picker), `--resume <name|id|transcript-path>`, `--from-pr <n>`, and `/resume`. Sessions created with `-p` or the SDK are left out of the picker and of `--continue`, but can still be resumed by ID. — [sessions](https://code.claude.com/docs/en/sessions)
- Fork: `/branch [name]`, or `--continue`/`--resume` with `--fork-session`. Either gives a new session ID and leaves the original intact. Resuming the same session in two terminals without forking interleaves both into one transcript. — [sessions](https://code.claude.com/docs/en/sessions)
- Transcripts are stored at `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is the cwd with non-alphanumerics replaced by `-`. Names over 200 characters are truncated and given a hash suffix. Each line is a JSON message, tool-use or metadata entry, and "the entry format is internal to Claude Code and changes between versions". — [sessions](https://code.claude.com/docs/en/sessions)
- Subagent transcripts are stored at `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`. — [sub-agents](https://code.claude.com/docs/en/sub-agents)
- Storage controls: `CLAUDE_CONFIG_DIR`; `CLAUDE_CODE_PROJECT_DIR_NAME` (v2.1.234+, requires `CLAUDE_CONFIG_DIR`, and is intended for embedding hosts); `cleanupPeriodDays` (30-day default); `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC`; `CLAUDE_CODE_SKIP_PROMPT_HISTORY`; and `--no-session-persistence`. — [sessions](https://code.claude.com/docs/en/sessions)
- Naming: `-n/--name`, `/rename`, and an auto-generated title from a Haiku-class model. Direct `-p` runs get no generated title. — [sessions](https://code.claude.com/docs/en/sessions)
- `claude agents --json` prints active sessions, interactive and background, as a JSON array without needing a TTY. `--all` adds completed background sessions. Background sessions are managed with `--bg`, `attach`, `logs`, `stop`, `rm` and `respawn`. — [local --help]
- `claude purge [path] [--all] [--dry-run]` deletes a project's transcripts, tasks, file history and config entry. — [local --help]
- The docs recommend `/export`, `-p --output-format json`, hook `transcript_path`, or the Agent SDK over parsing JSONL. — [sessions](https://code.claude.com/docs/en/sessions)
- `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` makes a resume continue an interrupted turn. — [headless docs](https://code.claude.com/docs/en/headless)

### Inferences
- **IDE must build:** (a) a session index (ID, title, cwd, model, cost, last activity) captured from `system/init` and `result` events at runtime. The docs advise against parsing JSONL, and no CLI lists historic sessions. As a fallback, read `~/.claude/projects/*/` directly, with a tolerant parser. (b) Per-workspace isolation, by setting `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_PROJECT_DIR_NAME` per Canopy workspace if it wants transcripts out of `~/.claude`. Note that this also isolates credentials (section 12). (c) Its own retention if 30 days is too short.

### Gaps
- Whether the TS SDK in 2.1.310 has `listSessions`/`getSessionMessages`-style helpers was not verified in this session.

---

## 7. Subagents / parallel tasks

### Takeaway
**Support: native. Programmatic: yes. Definitions come from `--agents <json|file>`, `.claude/agents/*.md` or `--agent <name>`. Subagent messages stream with `parent_tool_use_id`, and background sessions are available through `--bg` and `claude agents`. Agent teams are experimental. Official.**

### Cited Findings
- Definition precedence: managed, then `--agents` JSON, then `.claude/agents/`, then `~/.claude/agents/`, then plugin `agents/`. In `-p` mode `--agents` also accepts a file path (v2.1.281+). — [sub-agents](https://code.claude.com/docs/en/sub-agents)
- Frontmatter fields: `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `memory`, `hooks`, `background`, `isolation: worktree`, `effort`, `color`, `mcpServers`, `initialPrompt`, `omitClaudeMd`, and others. — [sub-agents](https://code.claude.com/docs/en/sub-agents)
- The Agent tool was renamed from Task in v2.1.63, and `Task(...)` remains an alias. Built-in agents are Explore, Plan, general-purpose, statusline-setup and claude-code-guide. — [sub-agents](https://code.claude.com/docs/en/sub-agents)
- Concurrency: 20 concurrent subagents by default (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, v2.1.217+). Nesting goes 3 levels deep (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`). By default, subagents spawned from the main conversation run in the background, and `CLAUDE_CODE_FORK_SUBAGENT=0` lets Claude wait for them. — [sub-agents](https://code.claude.com/docs/en/sub-agents)
- Model resolution: the per-call model, then frontmatter, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main model. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` overrides all of them. — [sub-agents](https://code.claude.com/docs/en/sub-agents)
- Streaming: subagent messages carry `parent_tool_use_id`. `--forward-subagent-text` includes their text and thinking. Forwarding works at every nesting depth from v2.1.219. — [headless docs](https://code.claude.com/docs/en/headless)
- A headless `-p` run waits for background subagents before exiting. Idle background work has a 10-minute cap (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). — [headless docs](https://code.claude.com/docs/en/headless)
- Agent teams need `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and use roughly 7x more tokens when teammates run in plan mode. — [costs](https://code.claude.com/docs/en/costs)
- `-w/--worktree [name]` creates a git worktree per session, and `--tmux` pairs it with a tmux session. — [local --help]

### Inferences
- **IDE must build:** (a) a subagent tree view built from the `parent_tool_use_id` linkage in stream-json, plus optional reads of `subagents/agent-*.jsonl`; (b) a cross-harness orchestrator, if Canopy wants parallel tasks across different harnesses, since native subagents stay inside one Claude session; (c) its own per-task undo, because subagent edits are not covered by checkpoints (section 2).

### Gaps
- Agent-teams wire behaviour (teammate messaging, `TeammateIdle`) was not researched in depth.

---

## 8. Context compaction / summarize

### Takeaway
**Support: native, with automatic and manual compaction. Programmatic: partial. You can tune or disable auto-compaction at launch (`--autocompact`, settings, env), send `/compact [instructions]` as a prompt in `-p`, and observe it through the `PreCompact`/`PostCompact` hooks. Partial summarize ("from here" / "up to here") is interactive only. Official.**

### Cited Findings
- Auto-compaction runs as the context approaches its limit. `/compact [instructions]` compacts with a chosen focus. `/autocompact <tokens>` and `--autocompact <auto|tokens>` (100k–1M) set the trigger window. Idle compaction also exists (`idleCompaction` setting). — [context window](https://code.claude.com/docs/en/context-window); [local --help]
- After compaction: the system prompt still applies. Root CLAUDE.md, unscoped rules and auto memory are re-injected from disk. Up to 5 recently modified files are re-read. Skill bodies are re-injected (capped at 5k tokens per skill and 25k in total). `SessionStart` hooks with the `compact` matcher run again. Path-scoped rules and nested CLAUDE.md files reload on demand. — [context window](https://code.claude.com/docs/en/context-window)
- Partial summarize: the `/rewind` menu offers "Summarize from here" and "Summarize up to here", with optional guidance text. — [checkpointing](https://code.claude.com/docs/en/checkpointing)
- `PreCompact` (blockable, matcher `manual|auto`) and `PostCompact` hooks exist. `InstructionsLoaded` has a `compact` reason. — [hooks](https://code.claude.com/docs/en/hooks)
- Subagents support `autoCompactWindow` in frontmatter. — [sub-agents](https://code.claude.com/docs/en/sub-agents)
- A resumed compacted session opens at a "Conversation compacted" row, and only the summary plus the unsummarized messages are loaded. — [sessions](https://code.claude.com/docs/en/sessions)
- `/context` shows a live breakdown of context usage. — [context window](https://code.claude.com/docs/en/context-window)

### Inferences
- **IDE must build:** (a) a context meter, from status-line JSON (`context_window.used_percentage`) or from usage in `assistant`/`result` events; (b) a "compact now" button that sends `/compact <focus>` as a user message in the stream; (c) partial summarize for headless sessions, if wanted. It is not natively scriptable, so Canopy could fork plus re-prompt or skip the feature.

### Gaps
- The exact env var to fully disable auto-compaction (historically `DISABLE_AUTO_COMPACT` / `DISABLE_COMPACT`) and the stream-json `compact_boundary` system message were not confirmed in pages fetched for 2.1.310. See [model-config: auto-compact window](https://code.claude.com/docs/en/model-config.md#set-the-auto-compact-window) and the env-vars page.

---

## 9. Usage, cost and model reporting (where to read tokens/cost/model, live and after)

### Takeaway
**Support: native. Programmatic: yes, from several sources: the stream-json `result` (`total_cost_usd`, usage, per-model breakdown), live `assistant` message usage, the status-line stdin JSON (model, cost, context window, rate limits), and OpenTelemetry. Cost figures are client-side list-price estimates. Official.**

### Cited Findings
- `--output-format json` gives `total_cost_usd` and a per-model cost breakdown. On `--continue`/`--resume` the figure is the whole conversation's total. Both are "client-side estimates". — [headless docs](https://code.claude.com/docs/en/headless)
- `system/init` reports the model, tools, MCP servers and plugins. — [headless docs](https://code.claude.com/docs/en/headless)
- The status-line command receives JSON on stdin with `model.id` and `model.display_name`, `cost.total_cost_usd`, `cost.total_duration_ms`, `cost.total_api_duration_ms`, lines added and removed, `context_window.total_input_tokens`/`total_output_tokens`/`context_window_size`/`used_percentage`/`remaining_percentage`/`current_usage`, `exceeds_200k_tokens`, `effort.level`, `thinking.enabled`, `fast_mode`, `rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage`, `resets_at`), `rate_limits.spend_limit.*` (v2.1.251+/v2.1.284+), `prompt_cache` (v2.1.251+), `session_id`, `session_name`, `transcript_path`, `version`, `workspace.*`, `pr.*` and `worktree.*`. — [statusline](https://code.claude.com/docs/en/statusline)
- `/usage` has a Session block for API users (total cost, durations, per-model input, output, cache read and cache write tokens), plus plan usage bars and an attribution breakdown for subscribers. — [costs](https://code.claude.com/docs/en/costs)
- `modelPricing` is a managed setting (v2.1.242+) that applies contracted rates. — [costs](https://code.claude.com/docs/en/costs)
- OpenTelemetry export works on every setup and streams per-user token and cost metrics in near real time. — [costs](https://code.claude.com/docs/en/costs)
- `--max-budget-usd` caps spend in `-p` mode. — [local --help]
- The VS Code extension shows the session's cost and tokens when plan limits don't apply. — [VS Code docs](https://code.claude.com/docs/en/vs-code)

### Inferences
- **IDE must build:** aggregation and persistence across sessions and harnesses (a usage ledger), because native totals reset per session or on `/clear` and only cover this machine. For interactive or terminal sessions where Canopy doesn't own stdout, install a Canopy `statusLine` command through `--settings` that forwards the stdin JSON to Canopy. That is the only live channel there. Subscription-plan rate-limit percentages are only available through the status-line `rate_limits.*` fields.

### Gaps
- The exact OTel metric names (e.g. `claude_code.cost.usage`, `claude_code.token.usage`) were not fetched. See [monitoring-usage](https://code.claude.com/docs/en/monitoring-usage).

---

## 10. Memory and instruction files

### Takeaway
**Support: native. Programmatic: yes. Files are plain markdown on disk, and launch flags control loading (`--bare`, `--setting-sources`, `--add-dir` plus `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`, `--append-system-prompt`). Official.**

### Cited Findings
- Locations: managed (`/Library/Application Support/ClaudeCode/CLAUDE.md` on macOS, `/etc/claude-code/CLAUDE.md` on Linux, `C:\Program Files\ClaudeCode\CLAUDE.md` on Windows, or `claudeMd` in managed settings), user `~/.claude/CLAUDE.md`, project `./CLAUDE.md` or `./.claude/CLAUDE.md`, and local `./CLAUDE.local.md`. — [memory](https://code.claude.com/docs/en/memory)
- Ancestors of the cwd load at launch and are concatenated from the root down. Subdirectory CLAUDE.md files load lazily when Claude touches files there. `@path` imports resolve relative to the importing file, up to 4 hops, and imports external to the project need approval. — [memory](https://code.claude.com/docs/en/memory)
- `.claude/rules/*.md` files are discovered recursively and can be path-scoped with `paths:` frontmatter. User-level rules live in `~/.claude/rules/`. `claudeMdExcludes` takes globs and merges across layers. — [memory](https://code.claude.com/docs/en/memory)
- AGENTS.md is read when no CLAUDE.md or CLAUDE.local.md exists in the cwd or its ancestors (v2.1.277+). It is configurable through the "Project instructions" setting. — [memory](https://code.claude.com/docs/en/memory)
- Auto memory lives at `~/.claude/projects/<project>/memory/` (`MEMORY.md`), with the project derived from the git repo, so all worktrees share it. The first 200 lines or 25 KB load each session. It is toggled with `autoMemoryEnabled` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and `autoMemoryDirectory` relocates it. — [memory](https://code.claude.com/docs/en/memory)
- `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` together with `--add-dir` loads CLAUDE.md and rules from the added directories. — [memory](https://code.claude.com/docs/en/memory)
- `--bare` skips CLAUDE.md auto-discovery and auto memory. — [local --help]

### Inferences
- **IDE must build:** only a cross-harness instruction layer, if Canopy wants one source of truth (for example generating CLAUDE.md, AGENTS.md and the Codex equivalents from Canopy settings), plus a UI to view and edit memory files. Native AGENTS.md support (2.1.277+) cuts down the duplication. For per-session IDE context, use `--append-system-prompt` rather than writing files into the user's repo.

### Gaps
- None material for this checklist.

---

## 11. MCP client configuration (and whether it can act as MCP server)

### Takeaway
**Support: native as a client (stdio, http, sse, ws; scopes local, project and user; OAuth). It can also act as an MCP server (`claude mcp serve`, stdio), which exposes Claude Code's own tools, not the agent loop. Programmatic: yes, through `--mcp-config <json|file>`, `--strict-mcp-config` and `claude mcp add|add-json|list|get|remove`. Official.**

### Cited Findings
- Scopes: `local` (default) is stored in `~/.claude.json` under the project path. `project` is `.mcp.json` at the repo root and needs approval in interactive mode, but is auto-loaded under `-p` and the SDK. `user` is stored in `~/.claude.json`. Precedence runs local, project, user, plugin, then claude.ai connectors, and `managedMcpServers` (v2.1.259+) ranks highest. Entries are not merged across scopes. — [mcp](https://code.claude.com/docs/en/mcp)
- Transports: `http` (alias `streamable-http`), `sse` (deprecated, with automatic fallback from http on v2.1.265+), `stdio`, and `ws` (JSON config only). — [mcp](https://code.claude.com/docs/en/mcp)
- `.mcp.json` expands `${VAR}` and `${VAR:-default}`. Credential variables such as `ANTHROPIC_API_KEY` read as empty in remote `url` and `headers`. — [mcp](https://code.claude.com/docs/en/mcp)
- Limits: `MCP_TIMEOUT` (startup), `MCP_TOOL_TIMEOUT`, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, and `MAX_MCP_OUTPUT_TOKENS` (default 25k). — [mcp](https://code.claude.com/docs/en/mcp)
- Auth: OAuth via `/mcp` or `claude mcp login`, plus `headersHelper`. — [mcp](https://code.claude.com/docs/en/mcp)
- `--mcp-config` in `-p` mode waits up to `MCP_TIMEOUT` (30 s) for pending servers (v2.1.221+). Invalid entries are reported in `system/init.mcp_server_errors` (v2.1.219+). — [headless docs](https://code.claude.com/docs/en/headless)
- `claude mcp serve` is a stdio MCP server that "only exposes Claude Code's tools to your MCP client, so your own client is responsible for implementing user confirmation". Background Bash results include `backgroundOutputPath` (v2.1.295+). — [mcp](https://code.claude.com/docs/en/mcp)
- The `claude mcp` subcommands are `add`, `add-json`, `add-from-claude-desktop`, `get`, `list`, `login`, `logout`, `remove`, `reset-project-choices` and `serve`. — [local --help]

### Inferences
- **IDE must build:** nothing for the client side. Inject Canopy's MCP server per session with `--mcp-config '{"mcpServers":{"canopy":{...}}}'` instead of writing `.mcp.json`. `claude mcp serve` is not a way to drive the agent, because it exposes tools only, with no model loop. Use `-p` stream-json or the SDK for that. A unified MCP config editor across harnesses would be Canopy-built.

### Gaps
- I did not fetch the `managed-mcp.json` details or the tool search and deferral settings.

---

## 12. Auth model and third-party-use policy (subscription vs API key; may another app drive it?)

### Takeaway
**Support: native. Auth can come from a subscription (OAuth), an API key, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, cloud providers or a gateway. Programmatic: yes, through env vars and `claude auth status --json`. Policy (official): another app may run the unmodified `claude` binary as long as each end user signs in with their own subscription, API key or cloud credential. The app may not offer Claude.ai login itself, route requests through Free/Pro/Max credentials on users' behalf, or collect or intermediate Claude.ai tokens.**

### Cited Findings
- Credential precedence: cloud provider env (`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY`), then `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY` (always used in `-p`), then `apiKeyHelper`, then `CLAUDE_CODE_OAUTH_TOKEN`, then Anthropic profile or federation credentials, then subscription OAuth from `/login`. A gateway session outranks all of them. — [authentication](https://code.claude.com/docs/en/authentication)
- Credential storage: macOS Keychain, with a fallback to `~/.claude/.credentials.json` (0600). Linux and Windows use `.credentials.json`. `CLAUDE_CONFIG_DIR` relocates it. — [authentication](https://code.claude.com/docs/en/authentication)
- `claude setup-token` mints a one-year subscription OAuth token for `CLAUDE_CODE_OAUTH_TOKEN`. It can only make model requests. `--bare` does not read it. — [authentication](https://code.claude.com/docs/en/authentication)
- `claude auth login [--claudeai|--console|--sso|--email]`, `claude auth logout`, and `claude auth status [--json|--text]` (JSON is the default). — [local --help]
- Policy: "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans... Developers building products... including those using the Agent SDK, should use API key authentication... Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users... developers may not collect, store, or intermediate Claude.ai credentials or session tokens." — [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- Exception: the policy does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code". — [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- Conditions for running Claude Code in products: the binary must be unmodified, no built-in auth method may be removed or disabled, the vendor must not pay for, resell or intermediate usage, each end user authenticates with their own credentials, and the "Claude Code" name and logo may not appear in the product's own branding. — [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- Pro and Max usage limits "assume ordinary, individual usage of Claude Code and the Agent SDK". — [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- `--bare` reads only `ANTHROPIC_API_KEY` or `apiKeyHelper` and never OAuth or the keychain. — [local --help]

### Inferences
- **IDE must build:** (a) an auth status panel based on `claude auth status --json`; (b) a flow that launches `claude auth login` (or `/login`) in a terminal so sign-in "complete[s] through Anthropic's own flow". Canopy must never capture, store or proxy the OAuth token; (c) per-user credential handling for remote VMs. Each user's VM should run its own login, and Canopy should not copy `.credentials.json` between users. Copying `.credentials.json`, or brokering `CLAUDE_CODE_OAUTH_TOKEN` on a user's behalf, is a legal risk area to review with counsel.
- Reading of the policy, uncertain: Canopy driving the user's own locally installed, unmodified `claude` with the user's own login appears to fall under the allowed "end user signs in to the unmodified binary" case. Using the Agent SDK inside Canopy with subscription OAuth looks closer to the prohibited pattern. Flag this for legal review.

### Gaps
- No explicit statement on whether an IDE that spawns `claude -p` with the user's own OAuth login counts as "routing requests through... plan credentials on behalf of their users". This is the key ambiguity.

---

## 13. Model switching (per run and mid-session)

### Takeaway
**Support: native. Programmatic: yes per run (`--model`, `ANTHROPIC_MODEL`, settings `model`, `--fallback-model`, `--effort`). Mid-session switching works by sending `/model <name>` as a prompt in `-p`, which applies to the current session only. Official.**

### Cited Findings
- Priority: `/model` mid-session, then `--model`, then `ANTHROPIC_MODEL`, then settings `model`, then `ANTHROPIC_DEFAULT_MODEL` (v2.1.236+). — [model-config](https://code.claude.com/docs/en/model-config)
- Aliases: `default`, `best`, `fable`, `opus`, `sonnet`, `haiku`, `sonnet[1m]`, `opus[1m]` and `opusplan`. On the Anthropic API, `opus` resolves to Opus 5.5, `sonnet` to Sonnet 5.5, `haiku` to Haiku 5.5 and `fable` to Fable 5.1. Pin with full IDs or `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`. — [model-config](https://code.claude.com/docs/en/model-config)
- Interactive `/model` saves the choice to user settings unless you press `s` in the picker for session-only. In `-p`, `/model` applies to the current session only. Resumed sessions keep their model. — [model-config](https://code.claude.com/docs/en/model-config)
- In `-p` mode, `/model`, `/effort`, `/fast`, `/color` and `/rename` accept arguments, and `/config key=value` changes settings. — [headless docs](https://code.claude.com/docs/en/headless)
- Effort: `/effort`, `--effort` (`low|medium|high|xhigh|max`), `CLAUDE_CODE_EFFORT_LEVEL` and `effortLevel`. — [model-config](https://code.claude.com/docs/en/model-config); [local --help]
- `--fallback-model a,b` holds for the current turn, up to 3 models. Auth, billing, rate-limit and request-size errors don't trigger it. — [model-config](https://code.claude.com/docs/en/model-config)
- `availableModels`, `enforceAvailableModels` and `deniedModels` are admin restrictions. — [model-config](https://code.claude.com/docs/en/model-config)
- `PreModelSwitch` (blockable) and `PostModelSwitch` hooks fire on changes. — [hooks](https://code.claude.com/docs/en/hooks)

### Inferences
- **IDE must build:** a model picker that sends `/model <id>` into the stream-json input for mid-session changes and passes `--model` at launch. Confirm the switch through the `PostModelSwitch` hook or the next `assistant` message's model field. Canopy should avoid interactive `/model` in terminal sessions if it doesn't want the user's default rewritten.

### Gaps
- I did not verify whether an SDK control message (`setModel`) exists separately from the `/model` prompt.

---

## 14. Self-update mechanism (update command, auto-update setting/env, version pinning, how to disable)

### Takeaway
**Support: native. Programmatic: yes, through `claude update`, `claude install <version|stable|latest>`, `DISABLE_AUTOUPDATER=1`, `DISABLE_UPDATES=1`, the `autoUpdatesChannel` and `minimumVersion` settings, and the managed `requiredMinimumVersion`/`requiredMaximumVersion`. Official.**

### Cited Findings
- Native installs auto-update in the background. They check at startup and periodically, and an update takes effect on the next launch. Homebrew, WinGet, apt, dnf and apk installs do not auto-update, though `CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE=1` opts Homebrew and WinGet in. — [setup](https://code.claude.com/docs/en/setup)
- `claude update` / `upgrade` installs immediately. `claude install [stable|latest|<version>] [--force]` installs a specific build. — [local --help]; [setup](https://code.claude.com/docs/en/setup)
- `autoUpdatesChannel` is `"latest"` (default) or `"stable"` (about a week behind, skipping regressions). `minimumVersion` sets a floor. The managed `requiredMinimumVersion` and `requiredMaximumVersion` refuse to start outside a range. — [setup](https://code.claude.com/docs/en/setup)
- `DISABLE_AUTOUPDATER=1` stops only the background check, so `claude update` and `claude install` still work. `DISABLE_UPDATES` blocks every update path and is recommended when distributing your own builds. `claude doctor` reports the auto-update state. — [setup](https://code.claude.com/docs/en/setup)
- Layout: `~/.local/bin/claude` is a symlink into `~/.local/share/claude/versions/`. A custom launcher keeps all versions. The installer otherwise keeps the active version plus the two newest. — [setup](https://code.claude.com/docs/en/setup)
- Pin at install with `curl -fsSL https://claude.ai/install.sh | bash -s 2.1.89` or `bash -s stable`. — [setup](https://code.claude.com/docs/en/setup)
- Integrity: a signed `manifest.json` (GPG fingerprint `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`) is published from 2.1.89. — [setup](https://code.claude.com/docs/en/setup)
- `claude respawn [--all]` restarts background sessions on the current version. — [local --help]

### Inferences
- **IDE must build:** a version manager policy. Pin a tested version by launching sessions with `DISABLE_UPDATES=1` and installing via `claude install <ver>`, or point a custom launcher at `~/.local/share/claude/versions/<ver>`. Canopy also needs a compatibility gate on `claude --version` or the `system/init` capabilities, and an "update available" UX. On shared-storage remote VMs, follow the docs' network-storage guidance: use `DISABLE_UPDATES` and keep one version per directory.

### Gaps
- None material.

---

## 15. Clipboard / copy behaviour in terminal UI, OSC 52 support, any known copy/paste issues over remote/SSH

### Takeaway
**Support: native, but behaviour depends on the renderer. In fullscreen (alt-screen) mode, Claude Code captures the mouse and copies on select through native tools (`pbcopy`, `wl-copy`/`xclip`/`xsel`, `Set-Clipboard`). It falls back to OSC 52 over SSH and also writes the tmux buffer. Programmatic: env vars and settings control it. Official, with known issues in GitHub reports.**

### Cited Findings
- Fullscreen rendering draws on the alternate screen and captures the mouse. Selection happens in-app and copies on mouse release. "Copy on select" is toggled in `/config`. With it off, `Ctrl+Shift+C` copies, as does `Cmd+C` on kitty-protocol terminals, and `Ctrl+C` copies while a selection is active. — [fullscreen](https://code.claude.com/docs/en/fullscreen)
- Copy paths: locally, `pbcopy` (macOS), `wl-copy` or `xclip`/`xsel` on Linux (which also write PRIMARY), and PowerShell `Set-Clipboard` (Windows and WSL). Inside tmux it also writes the tmux paste buffer. "Over SSH it falls back to OSC 52 escape sequences." A toast says which path was used. — [fullscreen](https://code.claude.com/docs/en/fullscreen)
- iTerm2 blocks OSC 52 until "Applications in terminal may access clipboard" is enabled, and `/terminal-setup` enables it. A GNU screen base64 leak on selections over about 570 characters was fixed in v2.1.219. — [fullscreen](https://code.claude.com/docs/en/fullscreen); [terminal-config](https://code.claude.com/docs/en/terminal-config)
- Native selection bypass: hold `Shift` in most terminals, `Option` in iTerm2, `Fn` in Terminal.app, or `Shift`/`Option` in VS Code. `CLAUDE_CODE_DISABLE_MOUSE=1` disables mouse capture entirely. `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1` keeps the wheel but drops clicks. — [fullscreen](https://code.claude.com/docs/en/fullscreen)
- Renderer controls: `/tui fullscreen|default`, the `tui` setting, `CLAUDE_CODE_NO_FLICKER=1|0`, and `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`, which forces classic mode with native scrollback. Attached background sessions always render fullscreen. Fullscreen is the default only for users who first ran Claude Code on or after 2026-05-06 and whose sessions fetch feature flags, or whose first launch ran v2.1.239+ without feature flags. Existing users, and Bedrock, Vertex, Foundry or telemetry-off sessions, otherwise stay on the classic renderer unless they opt in. — [fullscreen](https://code.claude.com/docs/en/fullscreen)
- The terminal's Cmd+F and tmux search can't see alt-screen content. `Ctrl+O` then `[` dumps the conversation to native scrollback, and `v` opens it in `$EDITOR`. — [fullscreen](https://code.claude.com/docs/en/fullscreen)
- The docs list `/copy` as writing to the system clipboard (iTerm2 needs the clipboard permission). `/export` copies or saves the transcript. — [terminal-config](https://code.claude.com/docs/en/terminal-config); [sessions](https://code.claude.com/docs/en/sessions)
- tmux: `set -g allow-passthrough on` is needed for notifications and progress to reach the outer terminal, and `set -g mouse on` for wheel scrolling in fullscreen. — [terminal-config](https://code.claude.com/docs/en/terminal-config); [fullscreen](https://code.claude.com/docs/en/fullscreen)
- Pasting more than 800 characters or more than 3 lines collapses to `[Pasted text #N]`, cached in `~/.claude/paste-cache/`. The VS Code terminal can drop characters from very large pastes. — [terminal-config](https://code.claude.com/docs/en/terminal-config)
- Known issue: GH #20974 requested OSC 52 over SSH and was closed in March 2026. The current docs confirm the OSC 52 fallback over SSH. — [GH #20974](https://github.com/anthropics/claude-code/issues/20974); [fullscreen](https://code.claude.com/docs/en/fullscreen)
- Known issue: GH #66192 (v2.1.168, Termius to Linux over SSH) and GH #61043 (v2.1.146, MobaXterm/WSL) report that the "sent N chars via OSC 52" toast appears but the clipboard is not set. The likely cause is the local terminal not honouring OSC 52. — [GH #66192](https://github.com/anthropics/claude-code/issues/66192); [GH #61043](https://github.com/anthropics/claude-code/issues/61043)
- Known issue: tmux 3.5a defaults (`set-clipboard external`, `allow-passthrough off`) block OSC 52 from inside panes. — [Devolutions forum](https://forum.devolutions.net/topics/55613/claude-code-osc-52-copy-text)
- Known issue: image paste over SSH fails because Claude Code shells out to xclip, which needs a display (GH #42712). OSC 52 text lands in CLIPBOARD, not X11 PRIMARY (GH #57654). — [GH #42712](https://github.com/anthropics/claude-code/issues/42712); [GH #57654](https://github.com/anthropics/claude-code/issues/57654)
- `/terminal-setup` sets `terminal.integrated.gpuAcceleration: "off"` in VS Code, Cursor and Devin Desktop, to prevent garbled text. — [terminal-config](https://code.claude.com/docs/en/terminal-config)

### Inferences
- **IDE must build:** if Canopy hosts `claude` in its own xterm.js terminal, particularly for remote VMs reached over a WebSocket bridge: (a) OSC 52 handling in the terminal emulator. xterm.js does not write the clipboard from OSC 52 by default, so Canopy needs the clipboard addon or a custom OSC 52 handler gated by a permission. Because the remote host has no display, OSC 52 is the only path that works; (b) a choice between launching with `CLAUDE_CODE_NO_FLICKER=1` (fullscreen, in-app selection that relies on OSC 52 reaching Canopy) and `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` (classic renderer, so Canopy's own selection and scrollback search work). The classic renderer is the safer default for an embedding IDE; (c) a modifier-key passthrough (Shift-drag native selection) in Canopy's terminal; (d) image paste for remote sessions. Native image paste uses xclip on the host and fails headlessly, so Canopy should upload the image to the workspace and insert a path reference. For headless stream-json sessions none of this applies, because Canopy renders text itself and owns the clipboard.

### Gaps
- Whether 2.1.310 sets OSC 52 on the remote host when an `SSH_*` env var is absent (for example under Canopy's own WebSocket PTY bridge, which is not SSH) is undocumented. Detection may fall back to xclip and fail silently. Test this empirically.
- I did not confirm what fix closed GH #20974, though the current docs state the SSH fallback.

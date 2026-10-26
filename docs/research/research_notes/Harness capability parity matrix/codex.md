# OpenAI Codex CLI: native capability parity matrix (for Canopy)

**Pinned version:** `codex-cli 0.162.1` (`codex --version`), installed globally via npm at `~/.local/lib/node_modules/@openai/codex` (the wrapper is `bin/codex.js`). Researched 2026-10-26. Source-code citations point to the `rust-v0.162.1` tag of github.com/openai/codex.
**Doc URLs:** every `developers.openai.com/codex/*` page now returns a 308 redirect to `learn.chatgpt.com/docs/*` (checked with `curl -sI`). The citations below use the learn.chatgpt.com URL.
**Source labels:** "official" means OpenAI docs, `--help` output, or the generated app-server schema. "Reverse-engineered (RE)" means read from source files or PRs on the openai/codex repo, or from local files under `~/.codex`. Neither is a public contract.
**Local evidence:** `codex app-server generate-json-schema --experimental --out <dir>` produced the full protocol schema: 170 client→server request methods, 84 server notifications and 11 server→client requests. Many findings below come from it (cited as "local schema", official, generated for this version).
**Live exec run:** I tried one `codex exec --json --ephemeral` run. It **failed at auth**: 401, "refresh token was already used". The only event shapes seen live are `thread.started`, `turn.started`, `error`, `item.completed{item.type:"error"}` and `turn.failed`. Every other event shape below comes from the docs, not from observation.
**Existing Canopy setup on this machine:** `~/.codex/hooks.json` already sends SessionStart, UserPromptSubmit, Stop and SessionEnd to `/usr/local/bin/canopy-hook --agent codex`. `~/.codex/config.toml` has `[mcp_servers.canopy]` with `command = "/usr/local/bin/canopy-hook"`, `args = ["--mcp"]`. So Canopy already uses the hooks + MCP path.

---

## 1. Headless/structured mode

### Takeaway
- **Support level:** native and rich. There are two surfaces: `codex exec` (one-shot JSONL) and `codex app-server` (bidirectional JSON-RPC that runs full sessions; marked experimental).
- **How it works:**
  - **exec:** `codex exec [PROMPT|-]` takes these flags: `--json` (JSONL on stdout), `-o/--output-last-message <file>`, `--output-schema <file>` (JSON Schema for the final answer), `--ephemeral`, `-m`, `-s read-only|workspace-write|danger-full-access`, `--approve-for-me`, `--dangerously-bypass-approvals-and-sandbox`, `--add-dir`, `--worktree`, `-C`, `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`, `-i <image>` and `-c key=value`.
  - **exec resume/fork:** `codex exec resume <SESSION_ID|name> [PROMPT]` or `--last`. `codex exec fork` also exists.
  - **app-server:** `codex app-server --listen stdio://|unix://PATH|ws://IP:PORT`, plus WebSocket auth flags `--ws-auth capability-token|signed-bearer-token`.
- **System prompt:**
  - Config keys `instructions` and `developer_instructions` ("inserted as a `developer` role message").
  - `model_instructions_file`, which replaces the built-in instructions. OpenAI calls this "STRONGLY DISCOURAGED".
  - app-server `thread/start` and `thread/fork` take `baseInstructions` and `developerInstructions`.
- **Tool allow/deny:** partial.
  - Per-MCP-server `enabled_tools` and `disabled_tools`.
  - Feature toggles such as `features.shell_tool` and `--disable <feature>`.
  - execpolicy `.rules` files using `prefix_rule(pattern=[...], decision="allow")`.
  - A `PreToolUse` hook that denies.
  - There is no generic `--allowedTools` list for built-in tools.
- **Plan mode:** partial. The TUI has `/plan`. The app-server has `turn/start.collaborationMode = {mode:"plan"|"default", settings:{model, reasoning_effort, developer_instructions}}`, marked EXPERIMENTAL. `exec` has no plan flag.
- **Input streaming:** native on the app-server only: `turn/steer` (with an `expectedTurnId` precondition), `turn/interrupt`, and `thread/queue/*`. `codex queue --thread <id> --message <text>` queues a message from the CLI. exec reads the prompt from stdin once. There is no multi-turn stdin protocol.
- **Programmatic/headless:** yes.
- **Version introduced:** unknown per flag. `--full-auto` has been removed.
- **Official vs RE:** official (help output, docs, local schema).
- **IDE must build:**
  - A plan-mode wrapper for exec. Either use the app-server `collaborationMode`, or run read-only with a planning prompt.
  - A generic allow/deny list for built-in tools, enforced through `PreToolUse` hooks or execpolicy rules.
  - For the app-server: version pinning and schema regeneration on every Codex upgrade, because schemas are tied to the version that produced them.

### Cited Findings
- exec help, 0.162.1: `--json` "Print events to stdout as JSONL"; `--output-schema`; `--ephemeral`; `-o`; `resume`/`fork`/`review` subcommands. If stdin is piped along with a prompt, stdin is appended as a `<stdin>` block. — local `codex exec --help` (official)
- Without `--json`, progress goes to stderr and only the final message goes to stdout. JSONL event types: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`. Item types: agent messages, reasoning, command executions, file changes, MCP tool calls, web searches, plan updates. Example: `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}`. exec defaults to a read-only sandbox. `--full-auto` "is no longer supported". A `required = true` MCP server that fails to start makes exec exit with an error. — [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- Live run (failed at auth): `{"type":"thread.started","thread_id":"01a1772e-..."}`, `{"type":"turn.started"}`, then repeated `{"type":"error","message":"Reconnecting... n/5 (...401)"}`, `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport..."}}`, and `{"type":"turn.failed","error":{"message":"..."}}`. — local observation (RE)
- app-server: stdio is the default, newline-delimited JSON. WebSocket is "experimental and unsupported". The handshake is `initialize` (with `clientInfo`, plus optional `capabilities.experimentalApi` and `optOutNotificationMethods`) followed by the `initialized` notification. Session methods: `thread/start|resume|fork`, `turn/start`, `turn/steer`, `turn/interrupt`. Notifications include `item/started|completed` and `item/agentMessage/delta`, and a turn ends with `turn/completed`. The page recommends the Codex SDK for automation and CI, and positions the app-server as the protocol for rich clients such as the VS Code extension. — [App Server](https://learn.chatgpt.com/docs/app-server)
- Server→client requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/tool/call` (dynamic tools that the client implements), `account/chatgptAuthTokens/refresh`. — local schema `ServerRequest.json` (official)
- `ThreadStartParams` includes `baseInstructions`, `developerInstructions`, `dynamicTools`, `approvalPolicy`, `sandbox`, `permissions`, `model`, `ephemeral`, `cwd` and `config`. `TurnStartParams` includes `input`, `model`, `effort`, `collaborationMode`, `outputSchema`, `sandboxPolicy`, `approvalPolicy` and `additionalContext`. — local schema (official)
- `thread/inject_items`: "Append raw Responses API items to the thread history without starting a user turn." — local schema (official)
- MCP-server mode was **removed**: PR #42993, "Remove the deprecated `codex mcp-server` command", merged 2026-09-05. On 0.162.1, `codex mcp-server --help` falls through to the top-level help. — [PR #42993](https://github.com/openai/codex/pull/42993); local check

### Inferences
- For an IDE that wants live streaming, approvals, steering, revert and forking, the app-server is the strongest choice. exec suits fire-and-forget jobs.
- The app-server's `dynamicTools` plus `item/tool/call` let Canopy expose IDE tools without running MCP.

### Gaps
- `item.*` payload shapes for file_change, mcp_tool_call and reasoning were not observed, because the live run failed at auth.
- No version history was found for when `--json` and the app-server stabilised.

## 2. Checkpoints / rewind / undo

### Takeaway
- **Support level:** **none** for restoring files. Partial for conversation history: `thread/revert` removes turns but "doesn't change local files".
- **How it works:**
  - Ghost-commit undo was removed by PR #19481 (merged 2026-04-28).
  - The feature flag `undo` shows as `removed`, and there is no `/undo` in the 0.162.1 slash-command enum. A `ghost_snapshot` config key is still accepted for compatibility.
  - The TUI still has Esc-based rewind of the conversation history (PR #19510 "Hide rewind preview…"; PR #18739 "keep /copy aligned with rollback"). Its effect on files was not verified and is presumed to be none.
  - app-server: `thread/revert {threadId, beforeTurnId}` and `thread/fork {beforeTurnId|lastTurnId}`. `thread/rollback` was removed.
- **Native alternatives:** `--worktree` / `/worktree` (a managed git worktree), and `turn/diff/updated` notifications.
- **Programmatic:** history revert yes, through the app-server. File restore no.
- **Official vs RE:** official for app-server behaviour; RE (PR) for the removal.
- **IDE must build:** its own file snapshot layer, for example a shadow git repo or object-store snapshots keyed by `turn_id`, taken on `turn/started` or on PreToolUse/PostToolUse hooks. Pair it with `thread/revert` (history) to get a full rewind. The IDE must also handle files touched by shell commands, not just apply_patch.

### Cited Findings
- "`thread/revert` removes a specified turn and all later turns… doesn't change local files. `thread/rollback` has been removed." — [App Server](https://learn.chatgpt.com/docs/app-server)
- `ThreadRevertParams {threadId, beforeTurnId}`: "Turn excluded from the replacement history, together with every later turn". The response returns the thread with empty `turns` and pagination cursors. — local schema (official)
- PR #19481 "Remove ghost snapshots": "Remove `ghost_snapshot` / `GhostCommit`… make undo a no-op that reports the feature is unavailable." Merged 2026-04-28. — [PR #19481](https://github.com/openai/codex/pull/19481)
- Original design (PR #3914, Sep 2025): unreferenced "ghost" commits restored with `git restore --source`. — [mirror of commit e0fbc11](https://forge.lthn.ai/core/core-agent-ide/commit/e0fbc112c772f87c9386cb2de992fbf8cdcb07d7) (third-party mirror; treat with caution)
- `codex features list`: `undo  removed  false`. — local (official)
- The IDE extension page's screenshot shows an "Undo" button on edit summaries. The mechanism is not documented. — [IDE](https://learn.chatgpt.com/docs/codex/ide)

### Inferences
- The VS Code extension's Undo probably reverts the edits it tracked itself, client-side. That would be consistent with the core no longer snapshotting. Unverified.

### Gaps
- The reason for the removal is not stated. It is also unclear whether the desktop app or extension "Undo" covers changes made by shell commands.

## 3. IDE integration protocol

### Takeaway
- **Support level:** partial.
- **How it works:**
  - **Selection and open tabs:** the TUI's `/ide [on|off|status]` (PR #20294, merged 2026-05-01) pulls context **from** an IPC server that the IDE extension or desktop app hosts. The TUI is the client.
    - Unix socket path: `$CODEX_HOME/ipc/ipc.sock`, with legacy paths in the temp directory as fallback. Windows path: `\\.\pipe\codex-ipc`.
    - Framing: a 4-byte little-endian length prefix, then JSON.
    - Request: `{"type":"request","requestId":<uuid>,"sourceClientId":…,"version":0,"method":"ide-context","params":{"workspaceRoot":…}}`.
    - Expected result: `{activeFile:{label,path,selection:{start:{line,character},end},activeSelectionContent,selections[]}, openTabs:[{label,path}]}`. The test fixture also shows `fsPath`, `startLine`, `endLine` and `processEnv`, which the extension sends but the TUI's Rust structs ignore.
    - The socket's directory must be owned by the user and must not be writable by group or others.
    - The TUI injects the context into the prompt as `# Context from my IDE setup:` … `## My request for Codex:` and hides it in the transcript.
  - **Diagnostics:** no native channel.
  - **Diffs:** the app-server streams `turn/diff/updated`, `item/fileChange/outputDelta` and `item/fileChange/patchUpdated`, and asks for approval with `item/fileChange/requestApproval`. A client can render these however it likes.
  - The VS Code extension itself runs on the app-server. The `--analytics-default-enabled` flag text mentions "first-party use cases like the VSCode IDE extension".
- **Programmatic:** yes, through the app-server. `/ide` is TUI-only.
- **Official vs RE:** `/ide` IPC is **RE** (source and PR). App-server diffs are official.
- **IDE must build:**
  - (a) Either serve the `ide-context` IPC socket so that `/ide` works in an embedded Codex TUI, or (simpler and documented) inject selection and diagnostics itself via `turn/start.additionalContext`, `UserPromptSubmit`/`SessionStart` hook `additionalContext`, or an MCP tool such as `canopy_diagnostics`.
  - (b) A diff viewer driven by `turn/diff/updated` and fileChange items.
  - (c) Diagnostics injection, which is entirely the IDE's job.

### Cited Findings
- The slash command enum in 0.162.1 includes `Ide`, described as "include current selection, open files, and other context from your IDE". — [slash_command.rs @ rust-v0.162.1](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/slash_command.rs) (RE)
- PR #20294: "An IPC client that uses a socket (Mac/Linux) or named pipe (Windows) to talk to the IDE Extension… same `## My request for Codex:` delimiter… `/ide [on|off|status]`." — [PR #20294](https://github.com/openai/codex/pull/20294)
- Socket path `codex_home.join("ipc").join("ipc.sock")`; `\\.\pipe\codex-ipc`; the `write_ide_context_request` JSON; u32 LE length framing; checks for owner and non-writable directory; unknown inbound requests are answered with `"error":"no-handler-for-request"`. — [ide_context/ipc.rs @ rust-v0.162.1](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/ide_context/ipc.rs) (RE)
- The `IdeContext` struct (`activeFile`, `openTabs`, `selection`, `activeSelectionContent`, `selections`). — [ide_context.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/ide_context.rs) (RE)
- IDE extension: "Reference open files, selected code, and recent chats directly from the composer". Supports VS Code, Cursor and Windsurf; JetBrains and Xcode have their own integrations. Internals are not documented. — [IDE](https://learn.chatgpt.com/docs/codex/ide)
- Notifications `turn/diff/updated`, `item/fileChange/outputDelta`, `item/fileChange/patchUpdated`; request `item/fileChange/requestApproval`; `fuzzyFileSearch*` and `fs/*` methods (readFile, writeFile, watch…). — local schema (official)

### Inferences
- The IPC socket looks like a router shared by the desktop app and extension (it has `sourceClientId` and unsolicited inbound requests). A third-party server that only answers `ide-context` would probably work for `/ide`, but this is untested and can change without notice.

### Gaps
- I did not verify whether the IPC needs a registration or handshake before `ide-context`. Only the request and response path was read.
- There is no documented way to push diagnostics.

## 4. Hooks / lifecycle events

### Takeaway
- **Support level:** native (feature `hooks` is stable and on by default).
- **Events:** `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`.
- **Config:**
  - Files: `~/.codex/hooks.json`, `[hooks]` in `config.toml`, `<repo>/.codex/hooks.json`, plugin `hooks/hooks.json`, and managed `requirements.toml`.
  - Structure: event → `matcher` (regex) → `hooks:[{type:"command"|"mcp_tool", command, timeout, statusMessage, async, additionalContextLimit}]`. The types `prompt` and `agent` are parsed but skipped.
- **Payload (stdin JSON):**
  - Every event: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, and sometimes `permission_mode`.
  - Plus per-event fields such as `tool_name`, `tool_use_id`, `tool_input`, `tool_response`, `prompt`, `trigger`, `agent_id`, `agent_type`, `agent_transcript_path`, `stop_hook_active` and `last_assistant_message`.
- **Blocking:** exit code 2 (reason on stderr) works for PreToolUse, UserPromptSubmit, Stop, SubagentStop and PostToolUse. JSON options:
  - `hookSpecificOutput.permissionDecision:"deny"` with `permissionDecisionReason`.
  - `decision:"block"`.
  - PermissionRequest: `hookSpecificOutput.decision.behavior:"allow"|"deny"`.
  - PreToolUse: `updatedInput` rewrites the tool input.
- **Context injection:** `hookSpecificOutput.additionalContext` for SessionStart, SubagentStart, UserPromptSubmit, PreToolUse and PostToolUse. Plain stdout also counts as context for SessionStart, UserPromptSubmit and SubagentStart. Large output spills to disk above about 2,500 tokens.
- **Trust:** non-managed hooks must be trusted per hash via `/hooks`. `--dangerously-bypass-hook-trust` skips this for one invocation.
- **Programmatic:** yes. Hooks run in exec and the app-server. The app-server also has `hooks/list` and `hook/started` / `hook/completed` notifications (sync hooks only).
- **Official vs RE:** official.
- **IDE must build:** nothing core. The IDE does need to handle the hook-trust step: changed hooks are skipped until re-trusted, so either pre-trust them or pass `--dangerously-bypass-hook-trust` in automation. It also needs to accept that `suppressOutput` is parsed but not implemented.

### Cited Findings
- Full event list, payload fields, exit-code semantics, matcher rules (SessionStart matcher `startup|resume|clear|compact|fork`; PreCompact `manual|auto`; `apply_patch` also matches `Edit|Write`), timeouts (default 600 s; SessionEnd and Interrupt default 1 s, maximum 3 s), and the trust model. — [Hooks](https://learn.chatgpt.com/docs/hooks)
- Schema: `HookEventName` enum (12 values); `HookHandlerType: command|mcpTool|prompt|agent`; `HookSource` includes `user`, `project`, `plugin`, `mdm`, `sessionFlags`, `cloudManagedConfig`…; `HookTrustStatus: managed|untrusted|trusted|modified`; `additionalContextLimit` "`null` uses 2,500 tokens; `0` disables spilling". — local schema (official)
- "`hook/started` and `hook/completed`… aren't emitted for asynchronous hooks." — [App Server](https://learn.chatgpt.com/docs/app-server)
- `allow_managed_hooks_only = true` works only in `requirements.toml`. — [docs/config.md](https://github.com/openai/codex/blob/main/docs/config.md)
- The CLI flag `--dangerously-bypass-hook-trust` exists on `codex`, `exec`, `resume`, `fork` and `queue`. — local `--help` (official)

### Inferences
- Codex hooks closely mirror Claude Code's hook schema (field names, exit code 2), so Canopy's `canopy-hook` can probably share most of its parser across both.

### Gaps
- The version where each event was introduced was not found.

## 5. Permission/approval modes and OS sandbox

### Takeaway
- **Support level:** native.
- **Sandbox modes:** `-s read-only|workspace-write|danger-full-access` (config `sandbox_mode`), plus named **permission profiles** (`default_permissions`, `[permissions]` tables, `-P/--permission-profile` on `codex sandbox`, `/permissions`). Extra writable paths: `sandbox_workspace_write.{writable_roots,network_access,exclude_tmpdir_env_var,exclude_slash_tmp}` and `--add-dir`.
- **Approval policy (inconsistent across sources):**
  - The installed `-a` offers only `on-request|never`.
  - The app-server schema `AskForApproval` still includes `untrusted` and a `granular{sandbox_approval,rules,mcp_elicitations,request_permissions,skill_approval}` object.
  - The sandboxing doc says `untrusted` "is no longer a selectable policy".
- **Approval reviewer:** `approvals_reviewer = user|auto_review` (legacy `guardian_subagent`), or `--approve-for-me`.
- **Bypass:** `--dangerously-bypass-approvals-and-sandbox`.
- **OS sandbox:** macOS Seatbelt; Linux/WSL2 bubblewrap (the `bwrap` on PATH, otherwise a bundled helper that needs unprivileged user namespaces); native sandbox on Windows. `codex sandbox <cmd>` runs any command under the sandbox.
- **Programmatic:** yes. The app-server sends approvals as server→client requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`), and approval and sandbox can be overridden per turn. In exec, an action that needs approval fails.
- **Official vs RE:** official.
- **IDE must build:** an approval UI that answers the app-server requests (or uses the PermissionRequest hook in TUI mode). The IDE also needs to detect a missing bwrap or user-namespace support on Linux hosts and VMs.

### Cited Findings
- Sandbox per platform, `bwrap` fallback, AppArmor note for Ubuntu 24.04, modes, `untrusted` no longer selectable, `approvals_reviewer`. — [Sandboxing](https://learn.chatgpt.com/docs/sandboxing)
- `AskForApproval` = `untrusted|on-request|never` or `granular{…}`. `ApprovalsReviewer` = `user|auto_review|guardian_subagent`. `SandboxMode` has 3 values. `thread/start.permissions` is a "Named profile id… Cannot be combined with `sandbox`". — local schema (official)
- `-a` possible values `on-request`, `never`; `--approve-for-me` "Route approval requests through automatic review using the workspace-write sandbox". — local `codex --help` (official)
- `codex sandbox` options `-P/--permission-profile`, `--sandbox-state-json`, `--sandbox-state-disable-network`. — local `codex sandbox --help` (official)
- Feature flags: `use_linux_sandbox_bwrap removed`, `use_legacy_landlock deprecated`, `network_proxy experimental`. — local `codex features list`
- In non-interactive flows, "an action needing new approval fails". — [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)

### Inferences
- bwrap appears to be the only supported Linux backend now, since the Landlock flag is deprecated.

### Gaps
- The default network policy for local `workspace-write` is not stated on the sandboxing page (the schema has `network_access`). Protected paths such as `.git` and `.codex` are not documented there.

## 6. Sessions: list, resume, fork, transcript

### Takeaway
- **Support level:** native.
- **CLI:** `codex resume [ID|name] [--last] [--all] [--include-non-interactive]`, `codex fork [ID] [--last]`, `codex exec resume|fork`, `codex archive|unarchive|delete <id|name>`, `codex migrate-rollouts`, and `codex agents` (browses sessions on the shared app-server daemon). TUI: `/resume`, `/fork`, `/side` (an ephemeral fork), `/rename`, `/rollout` (prints the path), `/export` (markdown).
- **App-server:** `thread/list`, `thread/search`, `thread/read`, `thread/turns/list`, `thread/items/list` (paginated), `thread/resume`, `thread/fork` (`beforeTurnId`/`lastTurnId`), `thread/archive|delete|name/set`.
- **Storage (in transition):**
  - Legacy rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, plus `~/.codex/session_index.jsonl` with lines `{id,thread_name,updated_at}`.
  - SQLite next to them: `state_5.sqlite`, `thread_history_1.sqlite`.
  - `ThreadHistoryMode = legacy|paginated`.
- **Rollout line kinds observed:** `session_meta` (with `id`, `cwd`, `cli_version`, `base_instructions`, `model_provider`, `history_mode`, `context_window`), `turn_context` (`model`, `effort`, `approval_policy`, `permission_profile`, `collaboration_mode`), `response_item`, `event_msg` (`task_started`, `item_completed`, `token_count`, `task_complete`), `token_usage_record`, `world_state`.
- **Hooks:** every hook payload includes `transcript_path`.
- **Programmatic:** yes.
- **Official vs RE:** commands and API are official. The rollout line format is RE (local files), not a documented contract.
- **IDE must build:** a session browser UI. It can use `thread/list` or `codex resume` instead of parsing files. If Canopy parses rollouts directly, it must handle both the legacy JSONL and the paginated/SQLite stores.

### Cited Findings
- Subcommands `resume`, `fork`, `archive`, `delete`, `unarchive`, `migrate-rollouts`, `queue`, `agents`; `exec resume` takes "UUID or thread name. UUIDs take precedence". — local `--help` (official)
- `ThreadForkParams.path` "[UNSTABLE] Specify the rollout path to fork from"; `excludeTurns`; `ThreadHistoryMode: legacy|paginated`; "Full-history hydration is deprecated". — local schema (official)
- Deprecated: full-history loading on `thread/resume` and `thread/fork`. — [App Server](https://learn.chatgpt.com/docs/app-server)
- Slash commands `/resume` "resume a saved chat", `/fork`, `/side` "start a side conversation in an ephemeral fork", `/rollout` "print the rollout file path", `/export` "export the conversation as markdown". — [slash_command.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/slash_command.rs) (RE)
- Rollout directory layout and line kinds (44 files on this machine). — local `~/.codex/sessions` (RE)

### Inferences
- `codex resume` hides exec sessions unless `--include-non-interactive` is passed, so Canopy-launched exec runs will not show in the default picker.

### Gaps
- The paginated history store schema was not inspected.

## 7. Subagents / parallel tasks

### Takeaway
- **Support level:** native. The `multi_agent` feature is stable and on; `multi_agent_v2` is stable but off.
- **How it works:**
  - The model spawns agents through collab tools: `spawnAgent`, `sendInput`, `resumeAgent`, `wait`, `closeAgent`, `sendMessage`, `followupTask`, `interruptAgent`, `listAgents`.
  - Custom agents are TOML files in `~/.codex/agents/` or `.codex/agents/`. Required fields: `name`, `description`, `developer_instructions`. Optional: `model` and `model_reasoning_effort`.
  - Config: `agents.max_concurrent_threads_per_session` (legacy alias `agents.max_threads`), `agents.max_depth` (V1 only), `agents.default_subagent_model`, `agents.default_subagent_reasoning_effort`, `agents.enabled`.
  - TUI: `/subagents`, `/agents` (command center). Effort `ultra` makes delegation proactive.
  - Subagents inherit the parent's sandbox and approval settings.
- **Hooks:** `SubagentStart` and `SubagentStop` (with `agent_id`, `agent_type`, `agent_transcript_path`).
- **App-server:** `SubAgentSource.thread_spawn{parent_thread_id, depth, agent_role, agent_nickname}`; turn `parentTurnId`/`rootTurnId`.
- **Separately:** `--worktree` and `codex cloud` support parallel isolated tasks.
- **Programmatic:** partial. Spawning is model-driven; there is no "spawn subagent" API call. Visibility comes from hooks and app-server threads.
- **Official vs RE:** official.
- **IDE must build:** deterministic fan-out (N parallel exec or app-server threads, each in its own worktree), plus a roster UI that links child threads through `SubagentStart/Stop` hooks or `parent_thread_id`.

### Cited Findings
- Agent definition location, format and fields; settings that cannot be overridden (`sandbox_mode`, `approval_policy`, `model_provider`, `mcp_servers`); concurrency keys; `/subagents`; non-interactive approvals fail. — [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- `CollabAgentTool` enum; `SubAgentSource` (`review`, `compact`, `memory_consolidation`, `thread_spawn{…}`); `MultiAgentMode` "@deprecated Ignored. Use `effort: "ultra"`". — local schema (official)
- `AgentsToml.max_depth`: "Maximum nesting depth for V1 agent threads. Ignored by V2." — [config.schema.json @ rust-v0.162.1](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/config.schema.json)

### Inferences
- In exec JSONL, subagent activity probably shows up as collab tool-call items. Not verified.

### Gaps
- Docs are silent on exec/headless subagent visibility, and no exec `item.type` for collab calls was observed.

## 8. Context compaction / summarize

### Takeaway
- **Support level:** native.
- **How it works:**
  - TUI: `/compact` ("summarize conversation to prevent hitting the context limit") and `/recap`.
  - Automatic: `model_auto_compact_token_limit` (+ `model_auto_compact_token_limit_scope`), `model_post_turn_compact_threshold_percent`.
  - Custom prompt: `compact_prompt` or `experimental_compact_prompt_file`.
  - App-server: `thread/compact/start {threadId}` returns `{}` immediately; progress arrives through turn/item notifications with a `contextCompaction` item, then `thread/compacted`.
  - Hooks: `PreCompact` and `PostCompact` (matcher `manual|auto`).
- **Programmatic:** yes, through the app-server. exec has no compact command.
- **Official vs RE:** official.
- **IDE must build:** a context meter, computed from `modelContextWindow` and `last` token usage, and optionally a compact button wired to `thread/compact/start`. There is nothing to build for exec one-shots.

### Cited Findings
- "`thread/compact/start` triggers history compaction and returns `{}` immediately… `contextCompaction` item." — [App Server](https://learn.chatgpt.com/docs/app-server)
- Config keys `model_auto_compact_token_limit` ("Token usage threshold triggering auto-compaction"), `compact_prompt`. — [config.schema.json](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/config.schema.json)
- `/compact` and `/recap` descriptions. — [slash_command.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/slash_command.rs)
- PreCompact and PostCompact hooks. — [Hooks](https://learn.chatgpt.com/docs/hooks)

### Inferences
- None beyond the above.

### Gaps
- Default auto-compact thresholds per model were not found.

## 9. Usage, cost and model reporting

### Takeaway
- **Support level:** partial. Token counts are native. **There is no dollar cost anywhere.**
- **How it works:**
  - exec: `turn.completed.usage{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}`.
  - App-server: `thread/tokenUsage/updated {threadId, turnId, tokenUsage:{last, total, modelContextWindow}}` with `TokenUsageBreakdown{inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens, totalTokens}`.
  - Account: `account/rateLimits/read` and the `account/rateLimits/updated` notification. `account/usage/read` (daily token buckets) only works with ChatGPT/Codex-backed auth, not API key or Bedrock.
  - Model: `model/list`, `model/rerouted` notification, `turn_context.model` in rollouts. TUI: `/status` and `/usage`.
  - Rollouts contain `token_usage_record` and `event_msg.token_count` (with `rate_limits`).
  - OTEL export is available via `[otel]`.
- **Programmatic:** yes.
- **Official vs RE:** official, except rollout fields (RE).
- **IDE must build:** cost calculation from its own price table (tokens × model rate). For ChatGPT-plan users, show quota from rate limits rather than dollars. The IDE also needs to handle `model/rerouted`, where the served model differs from the requested one.

### Cited Findings
- exec usage example `{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}`. — [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) (doc example; not observed live)
- `ThreadTokenUsage`/`TokenUsageBreakdown` schema; notifications `model/rerouted` and `account/rateLimits/updated`. — local schema (official)
- "`account/usage/read`… requires authentication backed by Codex services"; `rateLimits` vs `rateLimitsByLimitId`. — [App Server](https://learn.chatgpt.com/docs/app-server)
- `/status` "show current session configuration and token usage"; `/usage` "view account usage or use a usage limit reset". — [slash_command.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/slash_command.rs)

### Inferences
- None.

### Gaps
- `account/usage/read` and the rate-limit methods were not exercised (auth was expired). No exec JSONL field reports the model name.

## 10. Memory and instruction files (AGENTS.md etc.)

### Takeaway
- **Support level:** native.
- **Instruction files:**
  - Global: `$CODEX_HOME/AGENTS.override.md`, otherwise `AGENTS.md`.
  - Project: walks from the git root down to the cwd. Each directory contributes at most one of `AGENTS.override.md`, `AGENTS.md`, or a name from `project_doc_fallback_filenames`. Files are concatenated root-first.
  - Combined cap: `project_doc_max_bytes` (default 32 KiB). `project_root_markers` is configurable. `/init` generates an AGENTS.md.
- **Memories:**
  - Off by default (`features.memories = true` to enable; stable).
  - Files live under `~/.codex/memories/`; this machine also has `memories_1.sqlite`.
  - Keys: `memories.generate_memories`, `use_memories`, `disable_on_external_context`, `extract_model`, `consolidation_model`, `min_rollout_idle_hours`, …
  - Per-chat control: `/memories` in the TUI, `thread/memoryMode/set` and `memory/status|reset` on the app-server.
- **Skills:** there is also a skills system (`skills/list`, `$CODEX_HOME/skills`).
- **Programmatic:** yes.
- **Official vs RE:** official.
- **IDE must build:** nothing core. Optionally an editor and "effective instructions" viewer (`codex debug prompt-input` renders the model-visible input as JSON). If Canopy injects its own instructions, it should use `developer_instructions` or a hook, not AGENTS.md edits.

### Cited Findings
- Discovery order, override files, 32 KiB default, fallback filenames, CODEX_HOME, "no cache… chain is rebuilt each run". — [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- Memories: storage location, default off, config keys, `/memories` is per-chat, `no_memories_if_mcp_or_web_search` alias. — [Memories](https://learn.chatgpt.com/docs/customization/memories?surface=cli)
- `MemoriesToml` keys incl. `version`, `dedicated_tools`, `max_rollout_age_days`. — [config.schema.json](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/config.schema.json)
- `codex debug prompt-input` "Render the model-visible prompt input list as JSON". — local `codex debug --help`
- `/import`: "import setup, this project, and recent chats from Claude Code". — [slash_command.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/slash_command.rs)

### Inferences
- None.

### Gaps
- None significant.

## 11. MCP client configuration and MCP server mode

### Takeaway
- **Client:** native.
  - Config: `[mcp_servers.<name>]` with `command`, `args`, `env`, `env_vars`, `cwd`, `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `oauth`, `scopes`, `enabled`, `required`, `enabled_tools`, `disabled_tools`, `default_tools_approval_mode`, `startup_timeout_sec`, `tool_timeout_sec`, `supports_parallel_tool_calls`, `startup_readiness`.
  - CLI: `codex mcp list|get|add|remove|login|logout`. TUI: `/mcp`, `/mcp verbose`, `/mcp login <name>`.
  - App-server: `mcpServerStatus/list`, `config/mcpServer/reload`, `mcpServer/oauth/login`, `mcpServer/tool/call`, `mcpServer/resource/read`. Elicitations go through `mcpServer/elicitation/request`.
  - Per-run override: `-c 'mcp_servers.x.command="…"'`.
- **Server mode:** **none** in 0.162.1. `codex mcp-server` was removed on 2026-09-05; the app-server replaces it.
- **Programmatic:** yes.
- **Official vs RE:** official.
- **IDE must build:** if Canopy needs to drive Codex as an MCP tool from another agent, it must wrap `codex exec` or the app-server behind its own MCP server. The client side needs nothing; Canopy's MCP server is already configured.

### Cited Findings
- PR #42993 "Remove the deprecated `codex mcp-server` command… and the standalone `codex-mcp-server` crate". Merged 2026-09-05. — [PR #42993](https://github.com/openai/codex/pull/42993)
- `RawMcpServerConfig` field list. — [config.schema.json](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/config.schema.json)
- `codex mcp` subcommands. — local `codex mcp --help`
- A `required = true` server that fails makes exec exit. — [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- App-server MCP methods. — local schema (official)

### Inferences
- Older guides that describe `codex mcp-server` (tools `codex` and `codex-reply`) are obsolete for 0.162.1.

### Gaps
- None.

## 12. Auth model and third-party-use policy

### Takeaway
- **Support level:** native auth. The policy is restrictive for commercial use.
- **How it works:**
  - ChatGPT sign-in (subscription): browser OAuth on `localhost:1455`, or `codex login --device-auth`.
  - API key: `printenv OPENAI_API_KEY | codex login --with-api-key`, or a per-run `CODEX_API_KEY` env var for exec and review.
  - Enterprise access token: `codex login --with-access-token`.
  - Storage: `cli_auth_credentials_store = file|keyring|auto|ephemeral` (default is the `auth.json` file in `CODEX_HOME`).
  - Admin restrictions: `forced_login_method`, `forced_chatgpt_workspace_id`.
  - App-server: `account/login/start` with type `apiKey|chatgpt|chatgptDeviceCode|chatgptAuthTokens`. The external-tokens mode is experimental and "intended for host apps that already own the user's ChatGPT auth lifecycle".
- **Policy:** the App Server page says local or open-source apps that use app-server auth "can continue using it", but "**App-server authentication has never been permitted for commercial or hosted services.**" It points to Sign in with ChatGPT (SIWC) and a partner waitlist.
- **Programmatic:** yes.
- **Official vs RE:** official.
- **IDE must build:**
  - A legal and product decision on how a commercial IDE authenticates. Options are to have users run their own CLI login (the user's own install and credentials) or to apply for SIWC partnership.
  - Handling for refresh failures, with a prompt to re-login. A "refresh token was already used" error was observed once on this machine; its cause was not established.
  - UI for login status (`codex login status`) and re-login.

### Cited Findings
- Sign-in methods, `cli_auth_credentials_store` values, device auth, access tokens, automatic refresh, `forced_login_method`, `CODEX_CA_CERTIFICATE`, "treat `~/.codex/auth.json` like a password". The page has no explicit third-party-app rules. — [Auth](https://learn.chatgpt.com/docs/auth)
- Verbatim, from the "Auth endpoints" section: "If you've built a local or open-source application using Codex app-server authentication, you can continue using it… we recommend migrating to Sign in with ChatGPT… App-server authentication has never been permitted for commercial or hosted services." Links: [SIWC docs](https://developers.openai.com/siwc), [partner waitlist](https://openai.com/form/sign-in-with-chatgpt-interest/). — [App Server](https://learn.chatgpt.com/docs/app-server)
- Enterprise integrations should identify themselves via `clientInfo.name`. — [App Server](https://learn.chatgpt.com/docs/app-server) (paraphrased by the fetch tool; verbatim text not captured)
- `CODEX_API_KEY` works with exec, review and the SDK. Don't set it at job level in workflows that run repo-controlled code. — [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- Live error: "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again." — local stderr (RE)

### Inferences
- One possible cause of the refresh-token error is several processes or hosts sharing one `auth.json` and racing to refresh rotating tokens. If so, Canopy should avoid running many concurrent Codex processes that each refresh independently, or use the shared app-server daemon. Unverified.
- Spawning the user's own locally installed `codex` binary under the user's own login is closer to the "local application" case than Canopy brokering tokens through `chatgptAuthTokens`. Canopy is commercial, so this needs legal review.

### Gaps
- The policy section has no date. I found no OpenAI ToS clause that explicitly covers third-party IDEs spawning the CLI binary. The verbatim `clientInfo.name` registration text was not captured.

## 13. Model switching (per run, mid-session, reasoning effort)

### Takeaway
- **Support level:** native.
- **Per run:** `-m <model>`, `-c model_reasoning_effort="high"`, `-p <profile>` (layers `$CODEX_HOME/<name>.config.toml`), `--oss --local-provider lmstudio|ollama`, `model_provider` / `[model_providers]`.
- **Mid-session:** TUI `/model` ("choose what model and reasoning effort to use"). Service tier is set through the `service_tier` config key, `TurnStartParams.serviceTier` / `serviceTierForTurn`, and the feature flags `fast_mode` / `ultrafast_mode` (stable, on). The 0.162.1 slash-command enum has no `/fast`. App-server `turn/start.model`, `.effort` and `.summary` apply "for this turn and subsequent turns". There is also `turn/settings/update` and `serviceTierForTurn`.
- **Effort values:** model-advertised strings (`ReasoningEffort` is free-form). The local `models_cache.json` lists `low/medium/high/xhigh/max` and `ultra` on some models.
- **Related keys:** `plan_mode_reasoning_effort`, `review_model`, `agents.default_subagent_reasoning_effort`. Model catalog: `model/list` or `codex debug models`.
- **Programmatic:** yes.
- **Official vs RE:** official.
- **IDE must build:** a model and effort picker populated from `model/list` (do not hardcode). exec cannot switch mid-run, so the IDE must resume with new `-m`/`-c`.

### Cited Findings
- `TurnStartParams.model`: "Override the model for this turn and subsequent turns"; `.effort` likewise; `ReasoningEffort` "A non-empty reasoning effort value advertised by the model". — local schema (official)
- `-m`, `-p`, `--oss`, `--local-provider` flags. — local `codex --help`
- Supported reasoning levels per model in `~/.codex/models_cache.json` (e.g. `gpt-5.6-terra`: low…max, ultra; context window 272000). — local (RE)
- Feature flags `reasoning_effort_override` and `step_model_switching` are "under development". — local `codex features list`

### Inferences
- None.

### Gaps
- None significant.

## 14. Self-update mechanism

### Takeaway
- **Support level:** native, prompt-based. There is no silent auto-update in the CLI.
- **Update command:** `codex update` applies the command that matches the install method:
  - npm: `npm install -g @openai/codex`
  - bun: `bun install -g @openai/codex`
  - vite-plus: `vp install -g …`
  - pnpm: `pnpm add -g @openai/codex`
  - Homebrew: `brew upgrade --cask codex`
  - Standalone Unix: `curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh`
  - Windows: `irm https://chatgpt.com/codex/install.ps1 | iex`
- **Startup check:** the TUI checks on startup and caches the result in `~/.codex/version.json` (`{"latest_version","last_checked_at","dismissed_version"}`). npm installs check GitHub Releases, but only once the npm `dist-tags.latest` confirms the same version.
- **Disable:** `check_for_update_on_startup = false` (meant for centrally managed fleets; can be enforced via managed config).
- **Pin:** `npm i -g @openai/codex@0.162.1`, a brew version, or the DotSlash file in GitHub releases.
- **Programmatic:** yes (`codex update`, the config key, `codex doctor --json`).
- **Official vs RE:** the command and config key are official; the per-method commands are RE (source).
- **IDE must build:** version detection (`codex --version`), a minimum and maximum supported version gate (app-server schemas are tied to versions), and either set `check_for_update_on_startup=false` for embedded sessions or show its own update prompt.

### Cited Findings
- The `UpdateAction` enum and `command_args` for npm, bun, vp, pnpm, brew, standalone Unix and Windows. — [update_action.rs @ rust-v0.162.1](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/update_action.rs) (RE)
- `check_for_update_on_startup`: "When `true`, checks for Codex updates on startup and surfaces update prompts. Set to `false` only if your Codex updates are centrally managed. Defaults to `true`." — [config.schema.json](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/config.schema.json)
- PR #7213 "Allow enterprises to skip upgrade checks and messages" (2025-11-24). PR #19389 "Guard npm update readiness" (2026-04-26). — [PR #7213](https://github.com/openai/codex/pull/7213), [PR #19389](https://github.com/openai/codex/pull/19389)
- `codex update`: "Check for and apply a Codex CLI update when the installed release supports self-update." — [CLI docs](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- DotSlash file in GitHub releases for pinning. — [docs/install.md](https://github.com/openai/codex/blob/main/docs/install.md)
- Feature `in_app_updates` (stable, on) likely applies to the desktop app. — local `codex features list`

### Inferences
- None.

### Gaps
- Whether `codex update` runs without a prompt in a non-TTY context was not tested.

## 15. Clipboard / copy behaviour in the TUI, OSC 52, remote/SSH issues

### Takeaway
- **Support level:** native.
- **How it works:**
  - Commands and keys: `/copy` ("copy the last response or part of it") and `Ctrl+O` copy the last response as markdown. `Ctrl+Insert` copies a TUI selection. `/raw` or `tui.raw_output_mode` switches to "copy-friendly" scrollback.
  - Mouse: `tui.copy_on_select` (default `auto`; in 0.162.1 it covers transcript text only. PR #53753 extended it to composer text with X11 PRIMARY, but that PR merged 2026-10-13, after 0.162.1 was published on 2026-10-09, and is not in the tag), `tui.copy_on_select_clear_selection`, `tui.right_click_paste`.
  - Screen modes: `--no-alt-screen` or `tui.alternate_screen` keep native terminal scrollback. `tui.fullscreen_transcript` defaults to true and means the TUI owns selection.
- **Backend rules:**
  - Native clipboard first (arboard), with WSL PowerShell as a fallback.
  - In tmux, the copy is also forwarded to the attached terminal.
  - Over SSH without tmux, OSC 52 is sent directly.
  - Otherwise, OSC 52 is used only when native copy fails.
  - OSC 52 payloads are capped at 100,000 raw bytes.
  - Terminal writes are unacknowledged (status "Requested" rather than "Copied").
  - On Linux X11 and Wayland, a clipboard lease is kept so contents survive.
- **Known issues:** before PR #16966, `/copy` was fragile: content was cleared on rollback, and Linux clipboard contents vanished when the handle was dropped. OSC 52 only works if the terminal supports it (kitty, WezTerm, iTerm2, Ghostty…). Payloads above 100 KB are rejected. Right-click paste never reads over SSH.
- **Programmatic:** n/a (TUI only). Headless output has no clipboard involvement.
- **Official vs RE:** RE (source comments and PRs); config keys are in the schema.
- **IDE must build:** if Canopy hosts the Codex TUI in its own terminal emulator, the emulator must implement OSC 52 read/write and a size policy so SSH and remote sessions can copy. Also consider default `tui.copy_on_select`, or `--no-alt-screen`, so native selection works. If Canopy uses the app-server, it renders text itself and owns copy entirely.

### Cited Findings
- Module docs: "Local copying uses the native clipboard, with WSL PowerShell as a fallback. In tmux, also forward to the attached terminal… Over SSH without tmux, send OSC 52 directly… Outside tmux and SSH, use OSC 52 only if native copying fails"; `OSC52_MAX_RAW_BYTES: usize = 100_000`; Linux `ClipboardLease`; "OSC 52 is supported by kitty, WezTerm, iTerm2, Ghostty, and others". — [clipboard_copy.rs @ rust-v0.162.1](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/clipboard_copy.rs) (RE)
- PR #16966 (2026-04-09): Ctrl+O, "Copy server clipboard to the client over SSH (OSC 52)", Linux handle fix; problem statement "The TUI's `/copy` command was fragile…". — [PR #16966](https://github.com/openai/codex/pull/16966)
- PR #13201 "Slash copy osc52 wsl support" (2026-03-13). — [PR #13201](https://github.com/openai/codex/pull/13201)
- PR #53753 "Extend copy-on-select to composer text" (merged 2026-10-13; **not in rust-v0.162.1**, per `gh api compare`: diverged). PR #50215 "Support Ctrl+Insert…" (merged 2026-10-02; **included** in rust-v0.162.1, per compare: ahead). Tag `rust-v0.162.1` was published 2026-10-09T19:44Z. — [PR #53753](https://github.com/openai/codex/pull/53753), [PR #50215](https://github.com/openai/codex/pull/50215)
- `tui.copy_on_select`, `tui.raw_output_mode`, `tui.alternate_screen`, `tui.fullscreen_transcript`, `tui.right_click_paste` ("neither mode reads over SSH or in recognized VS Code terminals"). — [config.schema.json](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/config.schema.json)
- `/raw` "toggle raw scrollback mode for copy-friendly terminal selection". — [slash_command.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/slash_command.rs)
- Local config on this machine sets `tui.fullscreen_transcript = true`. — `~/.codex/config.toml` (RE)

### Inferences
- In Canopy's embedded terminal, a fullscreen TUI that owns mouse selection blocks the emulator's native selection, unless the user holds a modifier key or Canopy passes `--no-alt-screen`.

### Gaps
- I did not survey open GitHub issues on copy/paste over SSH or remote sessions. The findings come from PR problem statements only.

# Canopy per-CLI bridge inventory (2026-10-26)

A read-only pass over the repo at HEAD e3083299 (0.4.5). Paths are relative to the repo root.

The matrix distinguishes two cases. **Harness-native** means the CLI provides the feature and Canopy only passes flags. **Canopy shim** means Canopy supplies the feature through a hook helper, a generated plugin, a parser, an overlay or a gate.

## Where things live
| Area | File |
|---|---|
| TS registry | src/projects.ts. `AgentCli` type 609-747, `AgentCliCapabilities` 749-777, `BUILTIN_AGENT_CLIS` 867-1315, command builders 1832-2011, update and version check 1722-1832 |
| Rust manifest | src-tauri/src/agent_cli.rs 47-129 (profiles, account probe, integration adapter) |
| Hook and MCP installers | src-tauri/src/agents.rs. Dispatch `setup_agent_in` 793-881. Health check and self-heal 2870-3266. Usage parsers 3500-4356. `cli_versions` 4742-4871 |
| Hook helper | src-tauri/src/bin/canopy_hook.rs. Stdin hook contract 523-733, `normalize_event` 742-909, `--statusline` 505-521, `--mcp` 2379+ |
| Lifecycle fidelity | shared/agentLife/fidelity.json |
| Structured runners | src/structuredRunners.ts, structuredEvents.ts, projectRunner.ts, companionTransport.ts |
| Model switch | src/agentModels.ts, `MODEL_SWITCH` 64-97 |
| Bootstrap | src-tauri/src/agent_instructions.rs |
| Native stores | src-tauri/src/stores.rs |
| Profiles | src-tauri/src/profiles.rs |
| Remote host | packages/remote-host: install-agents.sh, agents.lock.json, Dockerfile, agent-integrations.mjs, agent-mcp.mjs, agent-usage.mjs, session-digests.mjs |

## `AgentCli` fields (projects.ts:609-747)
- **Identity and display:** id, aliases, name, bin, icon, brandColor.
- **Install and update:** install, pkgs (npm:/brew:/py:), latestUrl, update.
- **Launch:** resume(sessionId), rebound (user override, which suppresses the update badge), custom, prompt(text). When `prompt` is absent, Canopy types the prompt into the TUI.
- **Permissions:** skipPermissions, sessionArgs, unattended, unattendedEnv.
- **Other:** execution (launchArgs for model/effort/provider/profile), capabilities, structuredRunner, modelSwitch.

`AgentCliCapabilities` holds: profiles, managedIntegration, conversationTransfer, remoteIntegration, approvalInput:"keystroke", terminalMinimumContrast, eventSessionLookup, planUsageRequiresSession, restoreRequiresHumanPrompt, usageLimitNote, routingModelFamily, refreshModelCatalog, instructionCompanions, conversationStore.

How commands are built:
- `launchCommand` is bin + sessionArgs + (skipPermissions or unattended). The two are never combined.
- `restoreCommand` refuses an empty id.
- `remoteCliMetadata` never sends installers.
- Detection uses `command -v` in a login shell.
- `EXTRA_AGENT_BINS` (gemini, goose, copilot, qwen, droid) are detected only.

## Per CLI

### claude (projects.ts:868-937)
- **Registry:**
  - Install with npm `@anthropic-ai/claude-code`. Update with `claude update` (verified on 2.1.226, 2026-08-09).
  - Resume `--resume`. Prompt is positional.
  - skipPermissions is `--dangerously-skip-permissions`. Unattended is `--permission-mode auto` (requires 2.1.158 or later).
  - Execution settings: model, effort, profile.
- **Capabilities:** profiles, managedIntegration, conversationTransfer, remoteIntegration, keystroke approval, restoreRequiresHumanPrompt, usageLimitNote `/usage`. Store is `~/.claude/projects/**/*.jsonl`.
- **Runner `CLAUDE_RUNNER`** (structuredRunners.ts:190-241):
  - Tier structured. Stamp 2.1.226 / 2026-08-09.
  - Present: structuredJson, systemPrompt, planMode, toolAllowlist. Missing: workspaceSandbox.
  - argv: `-p --input-format stream-json --output-format stream-json --include-partial-messages --verbose --session-id|--resume --append-system-prompt --add-dir --model --permission-mode --allowedTools --disallowedTools`.
- **Event dialect `claudeLine`** (structuredEvents.ts:304-356) maps init→ready, text_delta→delta, tool_use→tool, permission-denied tool_result→blocked, result→turnEnd.
- **Hooks** (agents.rs:2235-2366) are written to `.claude/settings.json`:
  - Events: PostToolUse(+Failure), Stop, StopFailure, Notification, PermissionRequest, UserPromptSubmit, SessionStart, SessionEnd, PreCompact, SubagentStop, PreToolUse:AskUserQuestion, PreToolUse:Write|Edit|MultiEdit|NotebookEdit.
  - statusLine is wrapped by `canopy-hook --statusline`.
- **Claude-only canopy-hook paths:**
  - additionalContext peer injection on SessionStart and UserPromptSubmit.
  - Edit-diagnostics injection on PostToolUse.
  - Research-harness PreToolUse deny.
  - Build-mode destructive-Bash gate, which fails closed.
  - statusLine records 5h/7d rate limits and billed cost.
- **MCP:** `mcpServers.canopy` (stdio, `canopy-hook --mcp`) in the profile's `.claude.json`. Bootstrap is MCP instructions.
- **Usage:** tray reads `transcript_path`; statistics come from `fold_claude`; cost is the statusLine billed figure or an estimate; the plan chip uses the statusLine.
- **Other:** model switching is inline `/model`. Profiles use CLAUDE_CONFIG_DIR, and conversation transfer is supported.

### codex (projects.ts:938-1026)
- **Registry:**
  - Install with npm `@openai/codex`. There is **no update field**, so updating re-runs the installer.
  - Resume `codex resume <id>`.
  - skipPermissions is `--dangerously-bypass-approvals-and-sandbox`.
  - sessionArgs is `--no-daemon` (0.160.1, 2026-10-08).
  - Unattended is `--approve-for-me -c sandbox_workspace_write.network_access=true [writable_roots]` (0.159.1).
  - Execution settings: model `-m`, effort via `-c model_reasoning_effort=`, profile.
- **Capabilities:** profiles, managedIntegration, conversationTransfer, remoteIntegration, planUsageRequiresSession, terminalMinimumContrast 4.5. Store is `~/.codex/sessions/**/rollout-*.jsonl`.
- **Runner `CODEX_RUNNER`** (258-301):
  - Tier oneshot. Stamp 0.147.0 / 2026-08-09.
  - Present: structuredJson, workspaceSandbox.
  - No system prompt flag, so the brief is prepended. No tool allow/deny list. Resume rejects `-C` and `--add-dir`.
  - argv: `exec --json --skip-git-repo-check -C --add-dir -m -s read-only|workspace-write`. Resume is `exec resume <id> --json -c sandbox_mode=`.
- **Event dialect `codexLine`** (203-300) maps thread.started→ready; item agent_message, command_execution, file_change and mcp_tool_call to their events; turn.completed and turn.failed end the turn.
- **Hooks** (3268-3340) are written to `.codex/hooks.json`:
  - Events: SessionStart, UserPromptSubmit, Stop, SessionEnd, PostToolUse, PermissionRequest. PreToolUse is deliberately absent.
  - Legacy `notify` is set in config.toml.
  - The user must run `/hooks` once to trust them (needsTrust).
- **canopy-hook coverage:** additionalContext injection is shared with claude. Codex does NOT get the research deny, the destructive gate or edit diagnostics.
- **MCP:** a `[mcp_servers.canopy]` TOML splice with `env_vars=CODEX_FORWARDED_ENV`.
- **Usage:** `fold_codex` reads the model and token_count. The plan chip uses `codex_plan_usage`, which reads rate_limits live from the rollout. Cost is an estimate.
- **Other:** model switching is the `/model` picker. Profiles use CODEX_HOME, and conversation transfer is supported.

### amp (projects.ts:1027-1049)
- **Registry:**
  - Install with npm `@ampcode/cli`. Update with `amp update`.
  - Resume `amp threads continue <id>`. No prompt support.
  - No skipPermissions or unattended mode, because Amp permissions are driven by its settings.
  - Profile only.
- **Not supported:** runner, model switch, usage reporting, native store (threads live on the server).
- **Hooks:** a generated plugin at `~/.config/amp/plugins/canopy.ts` maps session.start→SessionStart, agent.start→UPS, agent.end→Stop, tool.result→PostToolUse. There is no permission event.
- **MCP:** `"amp.mcpServers".canopy` in settings.json.
- **Profiles:** AMP_SETTINGS_FILE.

### aider (projects.ts:1050-1092)
- **Registry:**
  - Install with pip (this doubles as update).
  - No resume and no prompt support.
  - skipPermissions and unattended are both `--yes-always` (0.86.2).
  - Execution settings: provider, model, reasoning-effort.
- **Not supported:** runner, MCP, usage reporting, profiles.
- **Hooks:** `notifications-command` in `.aider.conf.yml` runs `canopy-hook --agent aider --signal needs-human-ambiguous`. This gives attention only.
- **Bootstrap:** AIDER_READ points at the context file.
- **Model switching:** inline `/model`.
- **Store:** `.aider.chat.history.md`.

### agy (projects.ts:1100-1143)
- **Registry:**
  - Install with a curl script. There is no pkgs, latestUrl or update field, so updating re-runs the installer and no update badge is ever shown.
  - Resume `--conversation <id>`. No prompt support.
  - skipPermissions is `--dangerously-skip-permissions`. Unattended is `--mode accept-edits` (1.1.11).
- **Runner:** none, although stream-json was noted in a comment.
- **Hooks:** written to `.gemini/antigravity-cli/hooks.json`, covering PostToolUse, PreInvocation, PostInvocation and Stop. Setup also sets `notifications: true` (OSC 9).
- **canopy-hook:** normalizes camelCase fields.
- **MCP:** `.gemini/config/mcp_config.json`.
- **Usage:** model only, taken from the hook.
- **Store:** SQLite/protobuf.
- **Profiles:** none.

### opencode (projects.ts:1144-1206)
- **Registry:**
  - Install with npm `opencode-ai`. Update with `opencode upgrade`.
  - Resume `--session`. No prompt support.
  - skipPermissions is `--auto`. Unattended is `--agent build` plus the OPENCODE_PERMISSION env (1.18.32).
- **Runner:** none. Model switching is the `/models` picker.
- **Hooks:** a generated plugin at `.config/opencode/plugin/canopy.ts`:
  - chat.message→UPS, session.created→SessionStart, session.idle→Stop, permission.asked→Notification, file.edited and tool.execute.after→PostToolUse (normalized edit arguments, which feed the edit journal).
  - tool.execute.before refuses research-harness calls.
- **MCP:** `mcp.canopy` as type local.
- **Usage:** a SQL query over `opencode.db` gives tokens and billed cost.
- **Profiles:** XDG dirs.

### omp (projects.ts:1209-1258)
- **Registry:**
  - Install with a curl script. pkgs are brew:omp and npm:@oh-my-pi/pi-coding-agent. There is no latestUrl or update field.
  - Resume `--resume`. No prompt support.
  - skipPermissions is `--auto-approve`. Unattended is `--approval-mode=write` plus a task-approval overlay via PI_CONFIG_FILES.
- **Runner:** none. Model switching is the `/model` picker; the model list comes from `omp models --json`.
- **Hooks:** an extension at `.omp/agent/extensions/canopy.ts` maps session_start, before_agent_start (which also returns systemPrompt+SESSION_CONTEXT), agent_end, session_shutdown, tool_result and tool_approval_*.
- **MCP:** none.
- **Usage:** `fold_omp`, with cost computed by the CLI.
- **Profiles:** none.

### cursor (cursor-agent; projects.ts:1259-1287)
- **Registry:**
  - Install with a curl script. Update with `cursor-agent update`.
  - resume `--resume`, positional prompt and skipPermissions `--force` are **all unverified**.
  - Unattended is `--auto-review` (verified on 2026.08.31). Known gap: no hook fires while a prompt is waiting.
- **Runner `CURSOR_RUNNER`:**
  - Tier oneshot. The stamp reads "current beta", taken from **docs, not the binary**.
  - Present: structuredJson only. No sandbox and no system prompt flag.
  - argv: `-p --output-format stream-json --stream-partial-output [--resume] [--force] [--model]`.
- **Hooks:** `.cursor/hooks.json` covers sessionStart, beforeSubmitPrompt, postToolUse(+Failure), stop, sessionEnd. There is no permission event.
- **MCP:** `.cursor/mcp.json`.
- **Not supported:** usage reporting, native store, profiles.

### grok (projects.ts:1288-1314)
- **Registry:**
  - Install with a curl script. Update with `grok update`.
  - resume, prompt and skipPermissions `--always-approve` are unverified.
  - Unattended is `--permission-mode auto` (1.0.13).
- **Runner:** none. The `/model` picker is unverified.
- **Hooks:** `.grok/hooks/canopy.json` covers SessionStart, UPS, PostToolUse(+Failure), Stop/StopFailure/StopCancelled, Notification (idle_prompt, permission_prompt) and SessionEnd. Subagent events are dropped.
- **MCP:** a TOML splice into `.grok/config.toml`.
- **Not supported:** usage reporting, native store, profiles.

## Cross-cutting
- **Integration self-heal:** `heal_integrations` re-applies setup on every launch for installed or owned CLIs. Hooks are gated on `$CANOPY=1`.
- **Lifecycle fidelity** (shared/agentLife/fidelity.json):
  - claude and grok are the richest.
  - codex needs trust.
  - agy maps no start or end events.
  - aider is attention-only.
  - amp and cursor have no permission event.
- **Native store readers:** claude, codex, omp, gemini, agy, opencode, aider. None for amp, cursor or grok.
- **Resume:** works everywhere except aider.
- **Edit journal:** only records tools named exactly Edit, Write, MultiEdit or NotebookEdit with `tool_input.file_path`. Native for claude, normalized by the opencode plugin, unverified for codex, agy, cursor and grok, and absent for omp, amp and aider.
- **Shared-context injection:** claude and codex only.
- **MCP coverage:** claude, codex, amp, agy, opencode, cursor, grok. Aider uses the AIDER_READ context file and omp uses its extension systemPrompt.
- **Token and cost tracking:**
  - Rich for claude, codex (including the live plan chip), opencode (billed) and omp (CLI cost).
  - Model only for agy.
  - Nothing for amp, aider, cursor or grok.
- **Install and update (desktop):**
  - `checkCliUpdates` (projects.ts:1762-1828) calls `cli_versions` (agents.rs:4742-4871). It resolves the binary path and chooses brew upgrade, npm/pnpm `-g`, or latestUrl. Results are cached for 6h.
  - `runCliUpdate` (ProjectView/index.tsx:9056-9072) runs `updateCmd ?? update ?? install` in a run tab.
  - Update badges are possible for claude, codex, amp, aider and opencode only.
  - **No code disables or pins any CLI's own auto-updater** (only `NO_UPDATE_NOTIFIER=1` for managed processes).
- **Remote host:**
  - agents.lock.json pins amp, opencode, omp, aider, bun, cursor, grok and agy, with checksums.
  - claude 2.1.287 and codex 0.160.0 are hardcoded in the Dockerfile.
  - The only update path is an image rebuild.
  - Integrations, MCP, digests and sessions are claude/codex only remotely, and remote codex MCP has no env_vars.
- **Checkpoints:** Build-only, git-based and CLI-agnostic (vibeCheckpoints.ts, vibeAutoCheckpoint.ts, commits in vibeBuilderSession.ts). **There is no integration with any CLI's native checkpoint.**
- **Claude IDE protocol:** **none.** Equivalent features go through `canopy_editor_state`, `canopy_diagnostics` and `canopy_show_diff`.
- **Terminal attention:** OSC 9, 777 and 99 are handled. BEL is not.

## Outdated or contradicted in docs/agent-parity.md
1. The table covers 7 CLIs, but the registry has 9; cursor and grok are missing.
2. The MCP list omits Cursor and Grok.
3. The token row understates codex, opencode and omp.
4. The Build row has no cursor column and marks codex partial.
5. Version stamps are stale. Runners still say 2.1.226 / 0.147.0, but the registry cites codex 0.159.1/0.160.1 and remote pins claude 2.1.287, codex 0.160.0 and agy 1.2.14. The cursor runner stamp reads "current beta".
6. The agy PreToolUse claim is outdated.
7. The description of the aider notification mechanism is outdated.
8. P2 items 7–9 have shipped. Item 10 (BEL) is still open.
9. The claim that omp falls back to BEL is unverified.
10. Code comments still say "seven CLIs".

## Soft spots
- cursor and grok resume/prompt/skipPermissions and their model switches are unverified.
- The cursor runner was verified from docs, not the binary.
- codex, agy, omp and aider have no `update` field.
- No capability field records support for Claude-style hook stdout (additionalContext or permissionDecision); this is hardcoded in canopy_hook.rs:637-720.

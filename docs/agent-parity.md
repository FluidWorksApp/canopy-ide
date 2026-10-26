# Agent parity: connector audit (August 2026, corrected October 2026)

Canopy's agent features were built against Claude Code first, and some focused
paths remain. This document records the current capability surface and the
remaining work needed to keep every supported CLI deliberate rather than
accidentally second-class.

The October corrections come from the harness capability research of
2026-10-26 (`reports/Harness capability parity matrix.md`), which pinned every
CLI to the version installed in the research environment: Claude Code 2.1.310,
Codex 0.162.1, Amp 0.0.1790913650, Aider 0.86.2, Antigravity (agy) 1.2.14,
OpenCode 1.18.34, oh-my-pi (omp) 18.4.10, Cursor Agent 2026.10.01 and Grok
1.0.46.

## Where we are today

Hooks have first-class installers for all nine launcher CLIs. Codex, Cursor and
Grok use native hook files; the plugin/extension/hook adapters for the others
normalize events through the same Canopy helper. MCP registration is written
for every CLI with a native MCP client — all of them except Aider.

| Feature | claude | codex | amp | aider | agy | opencode | omp | cursor | grok |
|---|---|---|---|---|---|---|---|---|---|
| Hook auto-setup | full | full (needs `/hooks` trust) | plugin | notification command | full | plugin | extension | hooks.json | hooks.json |
| Event stream (stamped w/ pty) | yes | yes | yes | limited | yes | yes | yes | yes | yes |
| MCP auto-setup | yes | yes | yes | no native MCP | yes | yes | yes | yes | yes |
| Canopy bootstrap | MCP system instructions | MCP system instructions | MCP system instructions | read-only context | MCP system instructions | MCP system instructions | system-prompt hook + MCP | MCP system instructions | MCP system instructions |
| Session digests (powers restore + shared context) | yes | yes | yes | limited | yes | yes | yes | yes | yes |
| Resume command in registry | yes | yes | yes | – | yes | yes | yes | yes (unverified) | yes (unverified) |
| Token/cost/model tray | yes | tokens + live plan chip | native source available, not wired | – | model only | tokens + billed cost | CLI cost | – | native source available, not wired |
| Model switcher | yes | yes | – | yes | yes | yes | yes | yes | yes |
| Shared context (receive) | yes | yes | – | – | – | – | – | – | – |
| Shared-checkout file attribution | full | `apply_patch` | no | no | file tools | built-in edit/write | write/edit | Claude-named tools only | `search_replace` |
| Build headless runner | yes | partial | no | no | no | capable, not built | capable, not built | partial (oneshot) | capable, not built |
| Detection / tab promotion / launcher | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Rollback | Build only (git) | Build only (git) | none | none | none | none | none | none | none |
| Claude IDE protocol | not served | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| Clipboard (OSC 52 in Canopy's terminal) | no | no | no | no | no | no | no | no | no |
| Update pinning | none | none | none | none | none | none | none | none | none |

The Build row is deliberately narrower than terminal support. The Claude and
Codex runner argv was verified against Claude Code 2.1.226 and Codex 0.147.0 on
2026-08-09 and re-verified against Claude Code 2.1.310 and Codex 0.162.1 on
2026-10-26 (`src/structuredRunners.ts`). Claude has the complete stream-json,
system-prompt, plan-mode, and tool-list argv surface, but no OS-backed workspace
boundary. Codex has stream-json and an OS workspace sandbox, but no native
system-prompt, plan-mode, or tool-list flags; Canopy prepends the brief and
therefore marks it partial. The Cursor runner (oneshot `-p` stream-json) is
stamped "current beta" from Cursor's docs and is **not** verified against a
binary; the installed 2026.10.01 build has not been re-checked. OpenCode
(`serve` HTTP + SSE), omp (`--mode rpc`) and Grok (Claude-format stream + ACP)
all have structured surfaces with system prompt, tool lists, plan mode and
resume, so they are capable but have no runner yet.

The registry's interactive-launch argv stamps in `src/projects.ts` (Claude
2.1.226, Codex 0.147.0, Antigravity 1.1.11) have not been re-checked at the
new pins. Every CLI self-updates (or is reinstalled) past whatever version was
verified, and no code disables an updater; that is the "update pinning" row.

The rollback, IDE-protocol, clipboard and update-pinning rows are new: the
August audit did not track them. Rollback is Build-only and git-commit-based
(`vibeCheckpoints.ts`, `vibeAutoCheckpoint.ts`); there is no `~/.claude/ide`
server; Canopy's terminal handles OSC 9, 777 and 99 but not OSC 52 or BEL.

OpenCode's `chat.message` plugin hook maps to `UserPromptSubmit`, including
the text parts and active provider/model. It is missing from OpenCode's current
plugin docs but still triggered by 1.18.34 (found in the shipped binary), and
the plugin also derives the same event from the documented `message.updated`
bus event with role `user`, once per message id, so the turn boundary survives
if the hook is removed. Its bus events provide `SessionStart`, `Stop`,
`permission.asked`, file edits and tool use. Edit attribution comes from
`tool.execute.after`, not the sessionless `file.edited` broadcast: the former
carries the session id and original tool arguments together, which lets Canopy
normalize `filePath`/`oldString`/`newString` and retain Claude-equivalent edit
journal entries for OpenCode's built-in `edit` and `write` tools.

The shared-checkout row is intentionally stricter than the global Changes view.
An isolated worktree belongs to one agent, but a shared checkout is filtered to
paths reported by that session. Provider adapters that only report tool activity
without a path cannot safely populate that row; showing the whole working tree
would misattribute another agent's changes. `canopy-hook` reads each CLI's own
edit tools on PostToolUse: Codex `apply_patch` (paths and hunks parsed from the
patch body), Grok `search_replace`, omp `write`/`edit` (the extension forwards
the tool input), and agy `write_to_file`, `replace_file_content`,
`multi_replace_file_content` and `edit_file` (path only). Aider has no
per-session edit hook; Amp's and Cursor's native edit tool names and argument
shapes are not verified, so they stay unattributed rather than guessed.

The load-bearing pieces every feature hangs off:

- Every Canopy PTY exports `CANOPY=1` and `CANOPY_PTY=<id>` (pty.rs). This is
  the identity/trust basis for everything. It also exports
  `GROK_CLAUDE_HOOKS_ENABLED=0` and `GROK_CURSOR_HOOKS_ENABLED=0` (unless
  already set), because Grok otherwise runs Canopy's Claude and Cursor hooks
  as well as its own.
- `agent_instructions.rs` is the canonical bootstrap. MCP-capable clients get
  its complete workspace/tool routing through the MCP `instructions` field;
  Aider gets the capability-neutral portion through `AIDER_READ`, and the
  oh-my-pi extension appends that portion to its real system prompt. The split
  is intentional: a client without Canopy tools is never instructed to invent
  them. The MCP prompt starts with `canopy_project` and checks
  `canopy_agents`/`canopy_mesh history` before shared-checkout edits.
- `~/.canopy/bin/canopy-hook` reads hook JSON on stdin, gates on `$CANOPY`,
  stamps `canopy_pty` from `$CANOPY_PTY`, appends to
  `~/.canopy/agent-events.jsonl`, maintains per-session digests
  (`~/.canopy/sessions/<id>.json`), and prints context-injection JSON for the
  compatible Claude/Codex hook contract on SessionStart/UserPromptSubmit. It
  drops a non-grok event run by Grok's hook runner (`GROK_SESSION_ID` and
  `GROK_HOOK_EVENT` both set).
- The normalized JSON contract is `session_id`, `cwd`, and `hook_event_name`.
  Adapters translate vendor fields before publishing. Extra value: `prompt` (digests),
  `tool_name` + `tool_input` (edited-file tracking, per-CLI tool map),
  `transcript_path` (token tray), `message` (notification cards),
  `last_assistant_message` or legacy `last-assistant-message` (idle card text),
  and `model` (active-tab model label).

## What each CLI offers

### Claude Code (`claude`, 2.1.310)
- The reference integration: 13 hook events in `~/.claude/settings.json` plus
  the statusLine wrapper; peer-context injection, edit diagnostics and the
  destructive-Bash gate. MCP in the profile's `.claude.json`. Rich usage
  (statusLine cost, 5h/7d limits). `-p` defaults to Manual mode since 2.1.302;
  Canopy's runner always passes `--permission-mode`.

### Codex CLI (`codex`, 0.162.1)
- **Full hooks system**: `SessionStart`, `UserPromptSubmit`, `Stop`,
  `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`/`PostCompact`,
  subagent events. JSON on stdin with `session_id`, `transcript_path`, `cwd`,
  `hook_event_name` — near-identical to Claude's contract. Config
  `~/.codex/hooks.json` (or `[hooks]` in config.toml). Caveat: non-managed
  hooks need one-time trust via `/hooks`, per content hash, so Canopy keeps the
  generated file byte-stable and rewrites it only when its content changes.
- `apply_patch` hook payloads carry the patch body in `tool_input.command`.
- Sessions: `~/.codex/sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl`; per-turn
  model in `turn_context`, cumulative token counts in `token_count` events.
  Headless resume `codex exec resume <id>`.
- `/model` in TUI. OSC 9 / BEL notifications for `approval-requested` via
  `tui.notifications`.
- Legacy `notify` fires only `agent-turn-complete` — never approvals. It is
  routed through `canopy-hook` so the same trust gate and pty stamp apply.

### Antigravity CLI (`agy`, 1.2.14)
- **Agent Hooks**, keyed by hook name: `SessionStart`, `PreToolUse`,
  `PostToolUse`, `PreInvocation`, `PostInvocation`, and `Stop`. Tool events are
  grouped by matcher; the others take a flat handler list. JSON uses protojson
  camelCase (`conversationId`, `workspacePaths`, `transcriptPath`,
  `modelName`, `toolCall{name, args}`). The global file is
  **`~/.gemini/config/hooks.json`** (project: `.agents/hooks.json`); agy's docs
  say hooks in `~/.gemini/antigravity-cli/settings.json` are not loaded, and
  1.0.8 moved `/hooks` off `~/.gemini/antigravity-cli/hooks.json`. Canopy
  writes its `canopy` hook (SessionStart, PostToolUse, PreInvocation,
  PostInvocation, Stop) to the shared file, and still to the old file while
  that directory exists, until an authenticated run shows 1.2.x ignores it.
- `PreToolUse` is the documented interception point and returns
  `{decision: allow|deny|ask|force_ask}`. Canopy does not register it: it sits
  in the approval path, and what agy does with an empty verdict is unverified.
- **OSC 9 notifications (off by default)** — fires when the CLI "requires your
  attention" or finishes; auto-setup enables the setting.
- Sessions: `~/.gemini/antigravity-cli/` — `conversations/<uuid>.db` (SQLite,
  protobuf blobs) but `brain/<uuid>/…/transcript_full.jsonl` is readable
  JSONL. Headless usage only. Resume `agy --conversation <id>`. `/model`
  mid-session. AGENTS.md natively. MCP in `~/.gemini/config/mcp_config.json`.

### Aider (`aider`, 0.86.2)
- **No hooks**. Canopy's setup adds `notifications: true` and
  `notifications-command: canopy-hook --agent aider --signal
  needs-human-ambiguous` to `~/.aider.conf.yml`. Aider runs that command
  whenever it is waiting for input — both after an LLM turn and at y/n confirm
  prompts (verified in its source) — and the helper synthesizes the event
  itself, recording "waiting, kind unknown" rather than guessing finished or
  blocked from a sentence.
- History: single append-only `.aider.chat.history.md` per directory; no
  session identity → no per-session resume (registry correctly offers none).
  Token/cost printed in-band; `--llm-history-file` (off by default) is the
  machine-readable option.
- `/model <name>` mid-session (also `/editor-model`, `/weak-model`).
  Context: `--read CONVENTIONS.md` + `.aider.conf.yml`, plus Canopy's
  `AIDER_READ` context file.

### Amp (`amp`, 0.0.1790913650)
- **TypeScript plugin system** (`~/.config/amp/plugins/*.ts`): events
  `session.start`, `agent.start`, `agent.end`, `tool.call` (can
  allow/reject/modify), `tool.result`; Canopy's generated plugin forwards
  them to the helper.
- Permissions: the plugin bridge still raises no blocked state, but the
  "no permission-request event" claim is partly outdated — threads expose an
  `awaiting-approval` state that is not wired yet.
- Threads are **server-side** (ampcode.com); no local transcript store.
  Usage is available through `amp threads usage` and `--stream-json` usage,
  neither wired into the tray yet.
- Model = modes (`low/medium/high/ultra`); no `/model`. Edit-tool names and
  argument shapes are unverified (`amp tools list` needs auth).

### OpenCode (`opencode`, 1.18.34)
- **Richest surface**: JS plugins (`~/.config/opencode/plugin/`) with bus
  events incl. `message.updated`, `permission.asked`, `permission.replied`,
  `session.idle`, `session.error`, `tool.execute.before/after`, `file.edited`;
  plus `opencode serve` HTTP + SSE (`GET /event`) and a TS SDK.
- Sessions: `~/.local/share/opencode/opencode.db` (SQLite); assistant messages
  persist per-step token usage, model, and cost. `opencode session list
  --format json`; resume `--session <id>` (in registry).
- Usage & cost: captured. `agent_usage` reads running token totals, model, and
  billed cost straight off `session` rows in `opencode.db` (per profile root),
  and the status tray follows the live session the same way
  (`opencode_session_stats`), preferring the CLI's billed figure.
- `/models` picker. AGENTS.md + CLAUDE.md fallback.

### oh-my-pi (`omp`, 18.4.10)
- **TS extensions** (`~/.omp/agent/extensions/`): session lifecycle,
  `before_agent_start`/`agent_end`, `tool_call`, `tool_result`, and
  `tool_approval_requested/resolved`. These are not observability only:
  `tool_call` can block a tool. Canopy's extension forwards `tool_result`
  with the tool's input for edit attribution.
- **Native MCP client**: reads `~/.omp/agent/mcp.json` (and project
  `.omp/mcp.json`); Canopy registers `canopy` there. omp merges servers by
  name with its native config ahead of the `~/.claude.json` and Codex copies
  it imports, so Canopy's server runs once (verified on 18.4.10).
- Approvals: `tools.approvalMode` defaults to `yolo` and subagents are forced
  to `yolo`. Canopy launches omp with `--approval-mode=write` plus an overlay
  that allows bash/eval/task while omp's critical-pattern list still prompts.
- Sessions: `~/.omp/agent/sessions/<dir>/<ts>_<id>.jsonl` — assistant entries
  carry `provider`, `model`, and `usage` **including computed cost**. Resume by
  id prefix (in registry).
- `/model` picker + `Ctrl+P` cycling + role aliases. Context files: its own
  AGENTS.md conventions natively; other tools' user-level files are opt-in, so
  "reads every context-file convention" overstated it.
- Terminal notifications: OSC 99 / OSC 9 by terminal detection. The claimed
  BEL fallback under Canopy's xterm is unverified.

### Cursor Agent (`cursor-agent`, 2026.10.01 installed)
- **Hooks** in `~/.cursor/hooks.json`; Canopy registers `sessionStart`,
  `beforeSubmitPrompt`, `postToolUse`, `postToolUseFailure`, `stop` and
  `sessionEnd`. No hook fires while a permission prompt waits, so a blocked
  task is not raised.
- MCP in `~/.cursor/mcp.json`. Resume, positional prompt and `--force` are
  unverified against a binary, as is the runner stamp. `/copy` uses only
  `pbcopy`/`wl-copy`/`xclip` and fails on headless remotes.

### Grok Build (`grok`, 1.0.46)
- **Hooks**: 16 Claude-compatible events; Canopy installs
  `~/.grok/hooks/canopy.json` (9 events, `--agent grok`). Payloads carry both
  snake_case `hookEventName` and Claude's PascalCase `hook_event_name`; the
  runner injects `GROK_SESSION_ID`, `GROK_HOOK_EVENT`, `GROK_WORKSPACE_ROOT`.
- Grok also scans `~/.claude/settings.json` and `~/.cursor/hooks.json` hooks by
  default (`[compat.claude] hooks`, `[compat.cursor] hooks`), which made it run
  Canopy's Claude hooks as `--agent claude`. Canopy's PTYs turn those scans off
  through `GROK_CLAUDE_HOOKS_ENABLED=0` / `GROK_CURSOR_HOOKS_ENABLED=0`
  (verified with `grok inspect --json`). The Claude MCP scan stays on: grok
  dedupes Canopy's server by name, its own `config.toml` entry winning.
- MCP in `~/.grok/config.toml` `[mcp_servers]`. Native usage (`grok usage`
  JSON, USD) is not wired. Subagent hook events are dropped by the helper.

## Ranked plan

**P0 — big wins, small diffs** (done)
1. **Codex → full pipeline.** `setup_codex_hooks` writes a byte-stable
   `~/.codex/hooks.json`, keeps legacy `notify` for old versions, and setup
   registers the Canopy MCP server in `~/.codex/config.toml`.
2. **Antigravity → hooks + OSC.** `setup_agy_hooks` writes the `canopy` hook to
   `~/.gemini/config/hooks.json` (and the legacy file while it exists) and
   flips its `notifications` setting so OSC 9 reaches Canopy; `canopy-hook`
   normalizes the camelCase payload, treats invocation hooks as progress, and
   maps only `Stop` to a turn boundary. MCP goes to
   `~/.gemini/config/mcp_config.json`.
3. **Aider → waiting signal.** Done, as described above.

**P1 — plugin-based integrations** (done)
4. **OpenCode plugin**, with the `message.updated` prompt fallback.
5. **oh-my-pi extension** plus native MCP registration.
6. **Amp plugin.** Blocked state (`awaiting-approval`) and usage
   (`amp threads usage`) are the remaining gaps.

**P2 — de-Claude the core**
7. ~~`derivePending` reads agent identity from the payload.~~ Shipped.
8. ~~Per-agent token tray parsers.~~ Shipped (claude, codex, omp, opencode).
9. ~~Per-agent model switcher capability.~~ Shipped.
10. Treat BEL from an agent-hosting terminal as an attention signal (ring the
    tab). Still open, alongside OSC 52.

**Open from the October research**
- Rollback for every harness outside Build (turn snapshots under hidden refs).
- The Claude IDE protocol server.
- Structured runners for Grok, OpenCode and omp.
- Usage sources for Amp and Grok.
- Update pinning, and re-stamping the registry argv at the new pins.
- Verify Cursor against the 2026.10.22 binary; verify agy's legacy hooks path
  and `PreToolUse` empty verdict with an authenticated run.

Every integration keeps the same trust rule as Claude's: hooks fire
machine-wide, the helper drops anything not launched from a Canopy PTY
(`$CANOPY`), and per-tab attribution comes only from `$CANOPY_PTY` stamping.

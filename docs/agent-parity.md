# Agent parity: research and plan (July 2026)

Canopy's agent features were built against Claude Code first, and it shows.
This document records (a) exactly which features are Claude-only today and the
contract each feature demands from a CLI, and (b) what every CLI in the
launcher actually offers, verified against docs/source in July 2026. It ends
with the ranked implementation plan.

## Where we are today

Everything beyond process detection, launch/install, and the resume-command
string is effectively Claude-only. Codex has a thin second path (its legacy
`notify` appends raw events to the bridge — enough for "finished" cards only:
unstamped, no digests, no restore, no per-tab attribution).

| Feature | claude | codex | amp | aider | agy | opencode | omp |
|---|---|---|---|---|---|---|---|
| Hook auto-setup | full | notify only | – | – | – | – | – |
| Event stream (stamped w/ pty) | yes | unstamped | – | – | – | – | – |
| Pending cards (questions/permissions/idle) | all | idle only | – | – | – | – | – |
| Session digests (powers restore + shared context) | yes | – | – | – | – | – | – |
| Resume command in registry | yes | yes | yes | – | yes | yes | yes |
| Token/cost/model tray | yes | – | – | – | – | – | – |
| Model switcher | yes | – | – | – | – | – | – |
| Shared context (receive) | yes | – | – | – | – | – | – |
| Detection / tab promotion / launcher | yes | yes | yes | yes | yes | yes | yes |

The load-bearing pieces every feature hangs off:

- Every Canopy PTY exports `CANOPY=1` and `CANOPY_PTY=<id>` (pty.rs). This is
  the identity/trust basis for everything.
- `~/.canopy/bin/canopy-hook` reads hook JSON on stdin, gates on `$CANOPY`,
  stamps `canopy_pty` from `$CANOPY_PTY`, appends to
  `~/.canopy/agent-events.jsonl`, maintains per-session digests
  (`~/.canopy/sessions/<id>.json`), and (Claude only) prints context-injection
  JSON on SessionStart/UserPromptSubmit.
- The minimum JSON contract to join: `session_id` (or `conversation-id`),
  `cwd`, `hook_event_name` (or `type`). Extra value: `prompt` (digests),
  `tool_name` + `tool_input.file_path` (edited-file tracking),
  `transcript_path` (token tray), `message` (notification cards),
  `last-assistant-message` (idle card text).

## What each CLI offers (verified July 2026)

### Codex CLI (`codex`, v0.144.x)
- **Full hooks system, stable since ~v0.124**: `SessionStart`,
  `UserPromptSubmit`, `Stop`, `PreToolUse`, `PostToolUse`,
  `PermissionRequest`, `PreCompact`/`PostCompact`, subagent events. JSON on
  stdin with `session_id`, `transcript_path`, `cwd`, `hook_event_name` —
  near-identical to Claude's contract. Config `~/.codex/hooks.json` (or
  `[hooks]` in config.toml). Caveat: non-managed hooks need one-time trust via
  `/hooks` (hash-based).
- Sessions: `~/.codex/sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl`; per-turn
  model in `turn_context`, cumulative token counts in `token_count` events.
  Headless resume `codex exec resume <id>`.
- `/model` in TUI (picker confirmed; inline arg unverified). OSC 9 / BEL
  notifications for `approval-requested` via `tui.notifications`.
- Legacy `notify` fires only `agent-turn-complete` — never approvals.

### Antigravity CLI (`agy`, v1.1.x)
- **Agent Hooks**: `PreToolUse`, `PostToolUse`, `PreInvocation` (≈ prompt
  submit), `PostInvocation` (≈ turn end), `Notification`. JSON on stdin with
  `session_id`, `transcript_path`, `cwd`, `hook_event_name`. Config
  `~/.gemini/antigravity-cli/hooks.json` or project `.agents/hooks.json`.
  Absolute command paths; exit 0 required.
- **OSC 9 notifications (off by default)** — fires when the CLI "requires your
  attention" or finishes; Canopy already parses OSC 9, so enabling this
  setting during auto-setup lights up blocked/finished signals with zero new
  plumbing. No dedicated permission hook confirmed; `PreToolUse` is the
  interception point.
- Sessions: `~/.gemini/antigravity-cli/` — `conversations/<uuid>.db` (SQLite,
  protobuf blobs) but `brain/<uuid>/…/transcript_full.jsonl` is readable
  JSONL. No confirmed persisted token usage. Resume `agy --conversation <id>`
  (verified, in registry). `/model` mid-session (Gemini 3.5/3.1, Claude,
  GPT-OSS — plan-gated). AGENTS.md natively.

### Aider (`aider`)
- **No hooks**, but `--notifications-command CMD` runs an external command
  whenever aider is *waiting for input* — verified in source to fire both at
  the main prompt after an LLM turn and at y/n confirm prompts. This is the
  integration point: point it at a script appending a `Notification` event to
  the bridge.
- History: single append-only `.aider.chat.history.md` per directory; no
  session identity → no per-session resume (registry correctly offers none).
  Token/cost printed in-band; `--llm-history-file` (off by default) is the
  machine-readable option.
- `/model <name>` mid-session (also `/editor-model`, `/weak-model`).
  Context: `--read CONVENTIONS.md` + `.aider.conf.yml`.

### Amp (`amp`)
- **TypeScript plugin system** (`~/.config/amp/plugins/*.ts`): events
  `session.start`, `agent.start`, `agent.end`, `tool.call` (can
  allow/reject/modify), `tool.result`; plugins can run shell commands — a
  Canopy plugin can forward everything to the bridge.
- Permissions: rules with a **`delegate`** action — Amp executes an external
  program with `AMP_THREAD_ID`, tool params on stdin; exit code decides
  allow/ask/reject. Clean blocked-on-approval signal.
- Threads are **server-side** (ampcode.com); no local transcript store; no
  documented per-thread token/model API → token tray parity is weakest here.
  `--stream-json` carries usage in headless mode only.
- Model = modes (`low/medium/high/ultra`) via Ctrl+S / command palette; no
  `/model`. Completion sound / BEL (`AMP_FORCE_BEL`); no OSC, no documented
  approval-wait bell.

### OpenCode (`opencode`)
- **Richest surface**: JS plugins (`~/.config/opencode/plugin/`) with bus
  events incl. `permission.asked`, `permission.replied`, `session.idle`,
  `session.error`, `tool.execute.before/after`, `file.edited`; plus
  `opencode serve` HTTP + SSE (`GET /event`) and a TS SDK; TUI remote-control
  endpoints exist.
- Sessions: `~/.local/share/opencode` — recent versions migrated JSON → SQLite
  `opencode.db`; assistant messages persist per-step token usage
  (in/out/cache/reasoning), model, and cost. `opencode session list
  --format json`; resume `--session <id>` (in registry).
- `/models` picker, F2 cycles recent models. AGENTS.md + CLAUDE.md fallback.
  Built-in `attention` config (sounds/desktop notifications on questions,
  permissions, errors, completion).

### oh-my-pi (`omp`, v17.x)
- **TS hooks/extensions** (`~/.omp/agent/hooks/`, `--hook file.ts`): session
  lifecycle, `turn_start`/`turn_end`, `tool_call` (can block), `tool_result`,
  plus observability events `tool_approval_requested/resolved`.
- Sessions: `~/.omp/agent/sessions/<dir>/<ts>_<id>.jsonl` — assistant entries
  carry `provider`, `model`, and `usage` **including computed cost** — the
  easiest token-tray integration of the lot. Resume by id prefix (in
  registry).
- `/model` picker + `Ctrl+P` cycling + role aliases. Reads every context-file
  convention (AGENTS.md, CLAUDE.md, GEMINI.md, …).
- Terminal notifications built in: OSC 99 (Kitty), OSC 9 (WezTerm/Ghostty),
  BEL fallback; the `ask` tool sends "Waiting for input". Caveat: protocol
  chosen by terminal detection (env vars) — under Canopy's xterm it falls back
  to BEL, which Canopy doesn't currently treat as a signal.

## Ranked plan

**P0 — big wins, small diffs**
1. **Codex → full pipeline.** Rewrite `setup_codex_hooks` to write
   `~/.codex/hooks.json` pointing the same six-ish events at `canopy-hook`
   (contract already matches). Keep legacy `notify` for old versions. Handle
   the one-time hook-trust step (surface the `/hooks` trust requirement in the
   UI). Unlocks: stamped events, digests, restore, permission cards, shared
   context contribution.
2. **Antigravity → hooks + OSC.** Add a `setup_agent_hooks("agy")` arm:
   write `hooks.json` (PreToolUse/PostToolUse/PreInvocation/PostInvocation/
   Notification → `canopy-hook`), and enable its `notifications` setting so
   OSC 9 reaches the handlers Canopy already has. `canopy-hook` needs a small
   event-name mapping (PreInvocation≈UserPromptSubmit, PostInvocation≈Stop).
3. **Aider → waiting signal.** Auto-setup writes
   `notifications-command` (via `.aider.conf.yml` or env) to a one-line
   append of a `Notification` event to the bridge. Gives "waiting for you"
   cards for the CLI most likely to sit at y/n prompts.

**P1 — plugin-based integrations**
4. **OpenCode plugin.** Ship `canopy.ts` into
   `~/.config/opencode/plugin/`: forward `permission.asked`, `session.idle`,
   `tool.execute.after`, `file.edited` (+ session ids) to the bridge/helper.
   Later: token tray from its per-step usage/cost data.
5. **oh-my-pi hook module.** Ship a hook file into `~/.omp/agent/hooks/`
   forwarding turn/tool/approval events. Token tray: parse its session JSONL
   (model + usage + cost already computed).
6. **Amp plugin + delegate rule.** Plugin forwards session/tool events;
   a `delegate` permission rule provides the approval signal. Accept that
   token/cost stays unavailable (server-side threads).

**P2 — de-Claude the core**
7. `derivePending`: read agent identity from the payload instead of
   hardcoding `"claude"`/`"codex"` per branch; recognize the mapped event
   names emitted by the new integrations.
8. Token tray: replace the single `~/.claude`-locked parser with per-agent
   transcript parsers behind one command (codex rollouts and omp JSONL first;
   agy partial; amp none).
9. Model switcher: per-agent capability in the registry
   (`/model` syntax for codex/aider/agy/opencode/omp; Amp = modes) instead of
   the hardcoded Claude alias list; enable the status-bar chip whenever the
   detected agent supports switching.
10. Treat BEL from an agent-hosting terminal as an attention signal (ring the
    tab) — universal fallback that catches omp today and anything else that
    only beeps. The CPU-idle heuristic (shipped) stays as the last-resort net.

Every integration keeps the same trust rule as Claude's: hooks fire
machine-wide, the helper drops anything not launched from a Canopy PTY
(`$CANOPY`), and per-tab attribution comes only from `$CANOPY_PTY` stamping.

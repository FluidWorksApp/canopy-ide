# Pass through native features, own the gaps

Across the nine agent CLIs Canopy supports, the founder's rule ("use the agent's own feature where it exists, build our own where it doesn't") resolves into a small, stable split. **Eight of the fifteen checklist features should be pure passthroughs**: hooks, subagents, memory files, MCP registration, model switching, compaction, auth and self-update. Nearly every harness has them natively, and Canopy only maps flags and normalizes events, with small per-harness shims where one CLI lacks a feature (Aider hooks, Amp and agy manual compaction, agy and Cursor version pinning). **Five features need a Canopy-owned layer that runs for every harness, Claude Code included**, because even the best native versions have holes. Those five are per-turn file snapshots for rollback, MCP editor tools where no IDE protocol exists, OSC 52 clipboard handling in Canopy's own terminal, a cross-session usage ledger, and a session index. **The remaining two are hybrids**: a normalized headless event schema, and a unified permission-mode vocabulary with a VM sandbox for harnesses that lack one. Claude Code 2.1.310 is the right first brain because it is native on all fifteen rows, but it still leans on two Canopy layers: its checkpoints skip Bash, subagent and external edits, and Canopy's terminal **does not handle OSC 52 today** (`src/components/Term.tsx` registers only OSC 9, 777 and 99). That second gap silently breaks copy in remote workspaces for at least seven harnesses. The research also surfaced five live integration bugs: agy hooks written to a deprecated path, grok firing Canopy's Claude hooks as `--agent claude`, omp's `yolo` default approval, omp's native MCP client going unused, and Cursor's clipboard failing on remote hosts. On policy, building on each user's own signed-in, unmodified CLI is the defensible path for Anthropic, Cursor, Amp and xAI. **Google explicitly bars wrapping `agy` on consumer plans**, OpenAI says app-server auth "has never been permitted for commercial or hosted services", and omp still ships a claude.ai OAuth flow Canopy must never surface. This report is the implementation appendix to item 1/1b of the strategy report "Make the workspace verify, not just generate". The Claude Code IDE-protocol section is written from documentation and community reverse-engineering, with **traffic capture pending**.

Evidence comes from six research notes dated 2026-10-26, each pinned to a locally installed binary, plus a read-only pass over the Canopy repo. Notes are cited as links. Findings that came from local `--help`, binary strings or source reads carry the note as their citation, because they have no public URL. One note, `claude_ide_protocol_capture.md`, does not exist yet.

## Fifteen features, nine harnesses: the native-support matrix

### Pinned versions and how to read the matrix

Each harness is pinned to the version installed in the research environment. Three pins need care. **Cursor** was examined at 2026.10.01-e373342, while the brief pins 2026.10.22-27dcf5f, which is not installed ([amp_cursor.md](../research_notes/Harness%20capability%20parity%20matrix/amp_cursor.md)). **agy's** web docs and `agy changelog` describe 1.4.7, so every agy cell below is restricted to features the changelog places at or before 1.2.14 ([agy_grok.md](../research_notes/Harness%20capability%20parity%20matrix/agy_grok.md)). **Claude Code** is researched at 2.1.310, but Canopy's runner stamp still says 2.1.226 and the remote Dockerfile hardcodes 2.1.287 ([canopy_bridge_inventory.md](../research_notes/Harness%20capability%20parity%20matrix/canopy_bridge_inventory.md)). Newer releases exist upstream for OpenCode (1.19.4) and omp (18.12.6). Aider 0.86.2 is still the latest on PyPI ([opencode_omp_aider.md](../research_notes/Harness%20capability%20parity%20matrix/opencode_omp_aider.md)).

**N** = native, **P** = partial, **none** = absent in the pinned version. For row 12, P means the auth works natively but policy constrains how Canopy may use it. "RE" marks a mechanism known only from reverse-engineering, with no public contract.

| # | Feature | Claude Code 2.1.310 | Codex 0.162.1 | Amp 0.0.1790913650 | Aider 0.86.2 | agy 1.2.14 | OpenCode 1.18.34 | omp 18.4.10 | Cursor 2026.10.01 | Grok 1.0.46 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Headless / structured | **N** `-p` stream-json in/out | **N** `exec --json` + app-server | **P** `-x --stream-json`; no sys-prompt/plan | **P** `--message` one-shot, no JSON | **P** `-p` stream-json; no sys-prompt, no approvals | **N** `serve` HTTP + SSE | **N** `--mode rpc` JSONL | **P** `-p` stream-json; no sys-prompt | **N** Claude-format stream + ACP |
| 2 | Checkpoints / rewind | **N** per-prompt files; `--rewind-files` | **P** `thread/revert`, history only | **none** | **P** `/undo` last git commit | **P** TUI `/rewind`, git snapshots | **N** `/undo` + HTTP revert | **P** `/branch` tree; files unverified | **P** TUI `/rewind` files+chat | **P** `/rewind`; file restore disputed |
| 3 | IDE protocol | **N** WS MCP lockfile (RE schemas) | **P** `/ide` IPC socket (RE) | **P** `--ide` WS lockfile (RE) | **none** (`--watch-files` only) | **none** | **P** VS Code ext + ACP | **P** ACP + RPC host tools | **P** hidden `agent acp` server | **P** ACP server (inverted) |
| 4 | Hooks / lifecycle | **N** 33 events, blocking, context | **N** 12 events, trust-gated | **N** TS plugins, 6 events | **none** (notify command only) | **N** 6 events, camelCase | **N** JS plugins + SSE bus | **N** TS extensions, can block | **N** hooks.json, ~18 events | **N** 16 events, Claude-compatible |
| 5 | Permissions & OS sandbox | **N** 6 modes; Seatbelt/bwrap (shell) | **N** sandbox modes; Seatbelt/bwrap | **P** rules; no OS sandbox | **P** y/n confirms; no sandbox | **N** rules; terminal-only sandbox | **P** allow/ask/deny; no sandbox | **P** tiers, `yolo` default; no sandbox | **N** modes; Seatbelt/Landlock | **N** 6 modes; Landlock/Seatbelt |
| 6 | Sessions & transcripts | **N** resume/fork by id; JSONL | **N** `thread/list`, resume/fork | **P** server threads; no fork | **P** one markdown history, no ids | **P** resume by id; list/fork TUI | **N** `session list --format json`, fork | **N** JSONL tree; no list CLI | **P** `--resume`; no JSON list | **N** `grok sessions list`, fork |
| 7 | Subagents | **N** Agent tool, `parent_tool_use_id` | **N** collab tools, model-driven | **N** Task sync/async | **none** | **N** `invoke_subagent`, `subagent_info` | **N** `task` tool, child sessions | **N** `task` tool, RPC control | **N** Task, subagent hooks | **N** `spawn_subagent`, depth 1 |
| 8 | Compaction | **N** auto + `/compact`, hooks | **N** `thread/compact/start` | **P** auto only; handoff | **P** auto weak-model summary | **P** auto only (`/compact` is 1.3.5) | **N** `/compact` + HTTP summarize | **N** RPC `compact`, tunable | **N** `/summarize`, preCompact | **N** `/compact`, ACP, hooks |
| 9 | Usage / cost / model | **N** `total_cost_usd`, statusLine | **P** tokens + rate limits; no $ | **N** stream usage, `threads usage` | **P** in-band text only | **P** tokens headless only; no $ | **N** `opencode.db` tokens + cost | **N** `model_usage`, CLI cost | **P** model; undocumented `result.usage` | **N** `grok usage` JSON, USD |
| 10 | Memory & instructions | **N** CLAUDE.md, rules, auto memory | **N** AGENTS.md chain; memories opt-in | **N** AGENTS.md hierarchy, skills | **P** `--read` files only | **N** AGENTS/GEMINI.md, rules | **N** AGENTS.md + Claude files | **N** `.omp/AGENTS.md`, memory backends | **N** `.cursor/rules`, AGENTS.md | **N** AGENTS/CLAUDE.md, opt-in memory |
| 11 | MCP | **N** client, `--mcp-config` | **N** client; server mode removed | **N** `amp.mcpServers`, `--mcp-config` | **none** | **N** `~/.gemini/config/mcp_config.json` | **N** `mcp` config, HTTP `/mcp` | **N** `~/.omp/agent/mcp.json` | **N** `.cursor/mcp.json` | **N** `[mcp_servers]`, imports Claude |
| 12 | Auth & third-party policy | **N** own login OK; no brokering | **P** app-server auth barred commercially | **N** `AMP_API_KEY`; ToS silent | **N** BYOK keys only | **P** consumer-plan wrapping banned | **N** BYOK; Claude OAuth removed | **P** ships claude.ai OAuth | **P** ToS bans RE | **N** ACP hosting documented |
| 13 | Model switching | **N** `--model`, `/model` in stream | **N** `-m`, `turn/start.model` | **P** modes only (`-m low…ultra`) | **N** `/model` via PTY | **N** `--model`, `/model` (TUI) | **N** per-prompt model in API | **N** RPC `set_model` | **N** `--model`, `/model` | **N** ACP `set_config_option` |
| 14 | Self-update | **N** `claude install <ver>`, `DISABLE_UPDATES` | **N** `codex update`, prompt-only | **N** `--target-version`, env off | **N** pip `--upgrade`, `--no-check-update` | **P** auto-updates; no pin flag | **N** `upgrade <ver>`, env off | **N** `omp update`, banner only | **P** auto-updates; no pin command | **N** `update --version`, env off |
| 15 | Clipboard / OSC 52 | **N** native tools; OSC 52 over SSH | **N** arboard; OSC 52 fallback | **N** OSC 52 + native (RE) | **P** pyperclip only, no OSC 52 | **P** `/copy`; OSC 52 (RE) | **P** OSC 52; known fallback bugs | **N** OSC 52 first | **P** X11/Wayland only; fails remote | **N** OSC 52 + fallback file |

Sources by column: Claude Code ([claude_code.md](../research_notes/Harness%20capability%20parity%20matrix/claude_code.md)); Codex ([codex.md](../research_notes/Harness%20capability%20parity%20matrix/codex.md)); Amp and Cursor ([amp_cursor.md](../research_notes/Harness%20capability%20parity%20matrix/amp_cursor.md)); agy and Grok ([agy_grok.md](../research_notes/Harness%20capability%20parity%20matrix/agy_grok.md)); OpenCode, omp and Aider ([opencode_omp_aider.md](../research_notes/Harness%20capability%20parity%20matrix/opencode_omp_aider.md)).

### What the matrix says at a glance

Read by row, the matrix shows how far the field has converged. Hooks, subagents, instruction files and MCP are native almost everywhere, and grok, Amp and Cursor deliberately mimic Claude Code's stream-json and hook schemas. Read by column, it ranks the harnesses. **Claude Code is native on all fifteen rows and Grok on thirteen. Aider is native on three.** The rows that stay mixed are rollback, the IDE protocol and clipboard. Those are where Canopy has to own a layer.

Two cells are counter-intuitive. First, **"native" clipboard support does not mean copy works inside Canopy.** Seven harnesses emit OSC 52 escape sequences over remote links, and Canopy's terminal discards them today. Second, **Claude Code's "native" rollback covers only files changed by its own edit tools.** "Back to here" has to mean the whole tree, so Canopy's snapshot layer is required even for the best-covered harness.

## The decision grid: passthrough versus Canopy-owned layers

### The grid

The grid turns the matrix into one decision per cell. **H** means use the harness-native mechanism through the adapter (passthrough). **C** means Canopy supplies the feature itself. **H+C** means the native mechanism is primary and a Canopy layer fills a documented hole. The last column says whether the Canopy side is a per-harness shim or a single layer that runs for every harness.

| # | Feature | Claude | Codex | Amp | Aider | agy | OpenCode | omp | Cursor | Grok | Canopy side |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Headless | H | H | H+C | C | H+C (policy-gated) | H | H | H+C | H | Owned: normalized event schema |
| 2 | Rollback | H+C | C (+H history) | C | H+C | C (+H in TUI) | H+C | C (+H branch) | C (+H in TUI) | C (+H once verified) | **Owned for all**: per-turn snapshots |
| 3 | IDE protocol | H | C | C | C | C | C | C | C | C | **Owned for all**: MCP editor tools + journal diffs |
| 4 | Hooks | H | H | H | C | H | H | H | H | H | Owned: `canopy-hook` normalizer |
| 5 | Permissions / sandbox | H | H | H+C | C | H (+C for file tools) | H+C | H+C | H | H | Owned: mode vocabulary + VM boundary |
| 6 | Sessions | H+C | H | H+C | C | H+C | H | H+C | H+C | H | **Owned for all**: session index |
| 7 | Subagents | H | H | H | C | H | H | H | H | H | Owned: tree view, cross-harness mesh |
| 8 | Compaction | H | H | H+C | H+C | H+C | H | H | H | H | Shim: digest-seeded fresh session |
| 9 | Usage | H | H+C | H | C | H+C | H | H | C | H (+C on OAuth) | **Owned for all**: usage ledger + price table |
| 10 | Memory / instructions | H | H | H | H+C | H | H | H | H | H | Owned: single-source instruction generator |
| 11 | MCP | H | H | H | C | H | H | H | H | H | Owned: one Canopy MCP server, deduped |
| 12 | Auth | H | H | H | H | H | H | H | H | H | Owned: status panel, no token handling |
| 13 | Model switching | H | H | H (modes) | H | H | H | H | H | H | Owned: picker UI only |
| 14 | Self-update | H | H | H | H | H+C | H | H | H+C | H | Owned: pin and compat-gate policy |
| 15 | Clipboard | H+C | H+C | H+C | C | H+C | H+C | H+C | C | H+C | **Owned for all**: OSC 52 handler + clipboard shim |

### How the grid reconciles with the founder's rule

The founder's rule holds without contradiction. Wherever a harness has the feature, the adapter calls it. Canopy-owned layers exist for three reasons only. Some features have no harness equivalent at all, such as Aider hooks or Amp rollback. Some native versions have documented holes, such as Claude's Bash-blind checkpoints or Codex's lack of dollar cost. And some concerns cross harnesses and belong to Canopy, such as a usage ledger spanning sessions, a session index spanning CLIs, or the terminal emulator Canopy owns.

The subsections below give, per feature, the passthrough mechanism per CLI and a concrete spec for the Canopy-native side.

### 1. Headless and structured mode: passthrough adapters feeding one Canopy event schema

**Passthrough.** Each adapter drives the harness's own structured surface:

- **Claude:** `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages`. `--replay-user-messages` makes each user message's `uuid` a checkpoint id ([claude_code.md](../research_notes/Harness%20capability%20parity%20matrix/claude_code.md)).
- **Codex:** `codex exec --json` for one-shot jobs. Phase 2 moves to `codex app-server`, which adds steering, approvals as server-to-client requests, `thread/revert` and `thread/compact/start` ([App Server](https://learn.chatgpt.com/docs/app-server)), subject to the policy caveat in the policy section.
- **Grok:** `--output-format streaming-messages-json` emits Anthropic's stream-json wire format, so Canopy's existing `claudeLine` parser applies nearly unchanged. `grok agent stdio` (ACP) adds interactive approvals.
- **OpenCode:** prefer `opencode serve`, which publishes an OpenAPI spec and an SSE bus ([OpenCode server docs](https://opencode.ai/docs/server/)), over the undocumented `run --format json` schema.
- **omp:** `--mode rpc`, a newline-delimited JSON protocol with v2 chunking ([OMP rpc.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/rpc.md)).
- **Amp:** `-x --stream-json --stream-json-input` is "Claude Code-compatible" ([Amp streaming JSON](https://ampcode.com/docs/cli/streaming-json)).
- **Cursor:** `-p --output-format stream-json --stream-partial-output`.
- **agy:** `-p --output-format stream-json --input-format stream-json`.

**Canopy-native fallbacks.** Four harnesses lack a system-prompt flag:

- **agy:** prepend the brief to the prompt, as `CODEX_RUNNER` already does, or ship a Canopy `--agent` Markdown definition.
- **Cursor:** inject into the first user message, or write a temporary `.cursor/rules/*.mdc`.
- **Amp:** generate a plugin agent with `createAgent({extends, instructions})` and select it with `-m`.
- **OpenCode:** generate a per-run agent definition under `.opencode/agents/`.

Per-run tool allow/deny is likewise built by writing a scoped settings file before the run: `--settings-file` for Amp, `.cursor/cli.json` for Cursor, and a `permissions` block for agy. Do not use Cursor's hidden `--allowed-tools`, which is marked "internal only" ([amp_cursor.md](../research_notes/Harness%20capability%20parity%20matrix/amp_cursor.md)).

**Aider** gets no structured runner. It is driven through the PTY with `--message --yes-always --no-stream` per turn and is not Build-eligible. Its Python API "is not officially supported" ([Aider scripting](https://aider.chat/docs/scripting.html)).

**Canopy-owned layer.** A single `CanopyEvent` union is the only thing features consume: `ready`, `delta`, `tool`, `blocked`, `subagent`, `usage`, `compacted` and `turnEnd`. The repo's existing `claudeLine`, `codexLine` and `cursor` dialects in `src/structuredEvents.ts` become adapter-private.

Feature detection reads Claude's `system/init.capabilities` array, Codex's generated app-server schema and grok's ACP `initialize` response, rather than version strings. One Claude-specific trap: from v2.1.302 a `claude -p` run with no mode set starts in Manual mode and denies anything that needs approval ([headless docs](https://code.claude.com/docs/en/headless)). Every adapter launch must therefore set a mode explicitly. Approvals go through a `PermissionRequest` HTTP hook or a Canopy-hosted `--permission-prompt-tool`.

### 2. Checkpoints and rollback: a Canopy snapshot layer for all nine, native rewind as an accelerator

**Native capability is uneven.**

- **Claude** checkpoints each prompt and exposes `--rewind-files <uuid>` headlessly, but it does not track files changed only by Bash, most subagent edits, external or concurrent edits, or symlinks. Snapshots are kept for 100 checkpoints and about 30 days ([checkpointing](https://code.claude.com/docs/en/checkpointing)).
- **Codex** removed ghost-commit undo in PR #19481. `thread/revert` "doesn't change local files" ([PR #19481](https://github.com/openai/codex/pull/19481); [App Server](https://learn.chatgpt.com/docs/app-server)).
- **OpenCode** reverts files and conversation over HTTP (`POST /session/:id/revert`, `/unrevert`), but only inside a git repository ([OpenCode TUI docs](https://opencode.ai/docs/tui/)).
- **agy and Cursor** restore files only from the interactive `/rewind`.
- **grok's** own embedded docs say `/rewind` "does not restore files on disk", while docs.x.ai says it does ([grok sessions](https://docs.x.ai/build/features/sessions)).
- **omp** branches the conversation tree. Its file effect is untraced.
- **Aider** undoes only its last auto-commit.
- **Amp** has nothing.

**Canopy-owned spec (runs for every harness).**

1. **Turn boundary.** Each adapter maps its native turn-start and turn-end signals:
   - Claude, Codex, Grok: `UserPromptSubmit` and `Stop`.
   - Cursor: `beforeSubmitPrompt` and `stop`.
   - Amp: `agent.start` and `agent.end`.
   - agy: `PreInvocation` and `PostInvocation`.
   - OpenCode: `chat.message` (or `message.updated` with role `user`) and `session.idle`.
   - omp: `turn_start` and `turn_end`.
   - Aider: its notifications command plus a git watcher.
2. **Snapshot.** At turn start, write the full working tree, including untracked non-ignored files, into a tree object using a temporary `GIT_INDEX_FILE`. Commit it under a hidden ref `refs/canopy/turns/<session>/<n>`. The working tree, the user's index and the user's branches are never touched. Non-git workspaces fall back to a content-addressed copy of every path the edit journal or a filesystem watcher saw change during the turn.
3. **Scope.** On a shared checkout, restore only paths attributed to this agent's session by Canopy's edit journal, so undoing one agent never undoes another.
4. **Restore.** Diff the target snapshot against the current tree for the scoped paths, show the preview, then apply. Where the harness has a native file restore (Claude `--rewind-files`, OpenCode `revert`), call it first and use the snapshot to cover what it skipped.
5. **Conversation side.** Use the native mechanism where one exists:
   - Codex: `thread/revert`.
   - OpenCode: `revert`.
   - omp: RPC `branch`.
   - Grok: ACP `x.ai/rewind/*`.
   - Claude headless: `--resume <id> --fork-session` plus a re-send, because truncation is interactive-only.
   - Everywhere else: start a fresh session seeded with a digest up to the chosen turn.
6. **Irreversible actions.** Migrations, network calls and deploys are labelled as not undoable.
7. **Retention.** A Canopy policy (default: last 200 turns or 30 days) prunes the hidden refs.

Two repo facts shape this spec. Today rollback is Build-only and git-commit-based (`vibeCheckpoints.ts`, `vibeAutoCheckpoint.ts`). And **the edit journal only recognizes tools named exactly `Edit`, `Write`, `MultiEdit` or `NotebookEdit` with `tool_input.file_path`** ([canopy_bridge_inventory.md](../research_notes/Harness%20capability%20parity%20matrix/canopy_bridge_inventory.md)). Per-agent scoping therefore needs per-adapter tool-name maps: Codex `apply_patch`, grok `search_replace`, plus the omp, Amp and Aider edit tools. Until those maps exist, those harnesses fall back to filesystem-watcher attribution.

### 3. IDE integration: native for Claude, Canopy MCP tools for everyone else

Claude Code is the only harness with a host-IDE protocol Canopy can serve as the IDE side. The protocol is detailed in its own section below.

The other "partial" cells point the wrong way or are unpublished:

- **Grok, Cursor, OpenCode and omp** are ACP *servers*. The IDE hosts the agent, and none of them documents a channel for pushing selection or diagnostics.
- **Codex's** `/ide` is an RE'd IPC client that pulls `ide-context` from a socket at `$CODEX_HOME/ipc/ipc.sock` ([codex.md](../research_notes/Harness%20capability%20parity%20matrix/codex.md)).
- **Amp's** `--ide` WebSocket lockfile under `~/.local/share/amp/ide` is unpublished ([amp.nvim](https://github.com/sourcegraph/amp.nvim)).

**Canopy-owned layer.** Canopy's existing MCP tools (`canopy_editor_state`, `canopy_diagnostics`, `canopy_open_file`, `canopy_show_diff`) are the universal path for the eight non-Claude harnesses, and Aider receives context via `AIDER_READ`. Canopy should also push context, not just wait to be pulled:

- **Claude, Codex:** `additionalContext` on `UserPromptSubmit` hooks (Canopy already injects peer context this way).
- **Codex app-server:** `turn/start.additionalContext`.
- **agy:** `PreInvocation` `injectSteps`.
- **Grok:** `--rules` or ACP `_meta.rules`.
- **omp RPC:** `set_host_tools`.

Diff review for every harness except Claude comes from Canopy's edit journal and turn snapshots, not from a harness protocol. Pass `--no-ide` to Amp so it does not race a user's VS Code. Reverse-engineering Amp's or Codex's sockets is deferred, because both are undocumented and can change in any release.

### 4. Hooks: passthrough everywhere except Aider

All harnesses but Aider have native hooks. The work is to keep Canopy's normalizer (`normalize_event` in `canopy_hook.rs`) mapping each dialect onto Claude's event names:

- Codex mirrors Claude's field names and exit-code-2 semantics.
- grok and Cursor are explicitly Claude-compatible.
- agy uses camelCase protojson keyed by hook name.
- Amp and omp are in-process TypeScript.

Two passthrough upgrades follow from the notes. **Amp's plugin `ctx.thread.state` now emits `awaiting-approval`**, which supplies the blocked signal the August audit said was missing. **omp's `tool_call` handler can return `{block:true}`**, so Canopy's research-harness deny and destructive-Bash gate can extend to omp. The gate also extends to Cursor (`preToolUse` with exit 2) and grok (`PreToolUse`).

Hook stdout semantics should become a declared capability. The inventory notes that support for Claude-style `additionalContext` and `permissionDecision` output is hardcoded in `canopy_hook.rs:637-720`. The notes now establish it for Codex, Cursor and grok, and establish a different shape (`injectSteps`) for agy.

**Aider fallback.** Turn boundaries come from `--notifications-command`. Per-edit events come from a git or filesystem watcher. There is no blocking.

### 5. Permissions and sandbox: one Canopy mode vocabulary, mapped per harness

**Canopy-owned layer.** Canopy defines five user-facing modes and the adapter maps each to the harness's flag. Cells come from the notes and the registry ([canopy_bridge_inventory.md](../research_notes/Harness%20capability%20parity%20matrix/canopy_bridge_inventory.md)).

| Canopy mode | Claude | Codex | Amp | Aider | agy 1.2.14 | OpenCode | omp | Cursor | Grok |
|---|---|---|---|---|---|---|---|---|---|
| Plan (read-only) | `--permission-mode plan` | app-server `collaborationMode: plan`; exec `-s read-only` | C: read-only plugin mode | `--chat-mode ask` | `--mode plan` | `--agent plan` | `/plan` | `--mode plan` | `--permission-mode plan` |
| Ask | `manual` | `-a on-request` | `amp.permissions` `ask` | default | `request-review` preset | `ask` rules | `--approval-mode=always-ask` | `allowlist` | `default` |
| Accept edits | `acceptEdits` | `-s workspace-write` | allow rule for edit tools | none | `--mode accept-edits` | `edit: allow` | `--approval-mode=write` | `Write(glob)` allow | `acceptEdits` |
| Auto (classifier) | `--permission-mode auto` | `--approve-for-me` | none | none | none in pin (`auto` is 1.3.5) | none | none | `--auto-review` | `auto` |
| Bypass | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `amp.dangerouslyAllowAll` | `--yes-always` | `--dangerously-skip-permissions` | `--auto` | `--auto-approve` | `--force` | `--always-approve` |

**Sandbox.** Native OS sandboxes cover different scopes:

- **Claude:** shell commands only, via Seatbelt or bwrap. The file tools, MCP and WebFetch are not sandboxed ([sandboxing](https://code.claude.com/docs/en/sandboxing)).
- **Codex:** shell commands.
- **agy:** terminal commands only.
- **grok:** process-wide via Landlock or Seatbelt ([grok sandbox](https://docs.x.ai/build/features/sandbox)).
- **Cursor:** Landlock plus seccomp, but it silently falls back to prompting when Landlock is unavailable ([Cursor run modes](https://cursor.com/docs/agent/security/run-modes)).

**Canopy-native fallback.** The remote VM workspace is the boundary for Amp, Aider, OpenCode and omp. On desktop, those harnesses need a bwrap or Seatbelt wrapper around the CLI process before Canopy can claim a workspace boundary. Amp's `delegate --to <program>` permission action should route approvals into Canopy UI once its stdin and exit-code protocol is verified.

### 6. Sessions: native resume and fork, Canopy-owned index

Resume and fork are passthroughs wherever they exist. Codex, OpenCode and Grok have scriptable listing: `thread/list`, `opencode session list --format json`, and `grok sessions list` (no `--json` flag seen). Claude has no CLI that lists historic sessions, and its docs call the JSONL format "internal to Claude Code" ([sessions](https://code.claude.com/docs/en/sessions)).

**Canopy-owned layer.** A session index records id, title, cwd, model, cost and last activity for every harness, captured at runtime from `system/init` and `result` events or their equivalents. Tolerant store readers (already in `src-tauri/src/stores.rs` for claude, codex, omp, agy, opencode and aider) fill history. New readers are needed for Cursor (`~/.cursor/projects/*/agent-transcripts/`, RE) and Grok (`summary.json` and `updates.jsonl`). Amp needs a local cache of `amp threads export` JSON, because its threads are server-side.

**Fallbacks:**

- **Fork for Amp** and **headless fork for agy**: a new session seeded with a Canopy handoff digest.
- **Aider identity**: a Canopy-chosen per-tab `--chat-history-file`, reloaded with `--restore-chat-history`. This gives Aider a cheap pseudo-resume, the one row the registry marks unsupported today.

### 7. Subagents: native in eight, Canopy renders and orchestrates

Render the tree from each harness's native linkage:

- Claude, Amp: `parent_tool_use_id`.
- agy: `subagent_info`.
- Codex, Cursor, Grok: `SubagentStart` and `SubagentStop` hooks.
- OpenCode: child sessions (`GET /session/:id/children`).
- omp: RPC `get_subagents`.

Native subagents stay inside one harness. Cross-harness fan-out, and Aider parallelism (separate processes in worktrees), is Canopy's mesh. One safety note: **omp forces subagents to `yolo` approval regardless of the parent's mode** (`task/executor.ts:1093`, per [opencode_omp_aider.md](../research_notes/Harness%20capability%20parity%20matrix/opencode_omp_aider.md)).

### 8. Compaction: native everywhere it exists, digest-seeded restart elsewhere

A "compact now" button calls the native trigger:

- Claude: `/compact <focus>` sent into stream-json.
- Codex: `thread/compact/start`.
- OpenCode: `POST /session/:id/summarize`.
- omp: RPC `compact`.
- Cursor: `/summarize`.
- Grok: ACP `x.ai/compact_conversation`.

A context meter reads Claude's status-line `context_window.used_percentage` or token usage from events.

**Canopy-native fallback.** For Amp, agy 1.2.14 and Aider, which only compact automatically, start a new session seeded with Canopy's session digest. For agy, an alternative is to raise the pin to 1.3.5 or later. agy has no compaction hook, so Canopy detects compaction from `step_type: checkpoint` in the stream.

### 9. Usage, cost and model: native where reported, Canopy ledger always

**Native sources:**

- **Claude:** `result.total_cost_usd` plus status-line `rate_limits.five_hour` and `rate_limits.seven_day`. Subscription quota is visible *only* there ([statusline](https://code.claude.com/docs/en/statusline)).
- **Grok:** `grok usage <id>` JSON with `costUsdTicks`. Cost is often missing on OAuth sessions.
- **OpenCode:** `opencode.db` rows.
- **omp:** `model_usage` entries.
- **Amp:** stream `usage` and `amp threads usage`.

**Canopy-owned layer.** A usage ledger persists per-turn tokens, cost and model across sessions and harnesses, because native totals reset per session or on `/clear`. A versioned price table supplies dollars where the harness reports only tokens: Codex ("no dollar cost anywhere"), agy, and Cursor's undocumented `result.usage`. Aider's in-band "Tokens … Cost …" lines are scraped from the PTY as a best-effort source. The inventory shows the ledger has nothing to read today for amp, aider, cursor or grok, even though Amp and Grok have native sources ([canopy_bridge_inventory.md](../research_notes/Harness%20capability%20parity%20matrix/canopy_bridge_inventory.md)).

### 10. Memory and instruction files: passthrough, plus one generator

Every harness except Aider loads instruction files natively, and their discovery rules overlap heavily. AGENTS.md is read by Codex, Amp, agy, OpenCode, omp (as `.omp/AGENTS.md`, plus foreign project files), Cursor, Grok, and Claude when no CLAUDE.md exists (v2.1.277+) ([memory](https://code.claude.com/docs/en/memory)).

**Canopy-owned layer.** A single-source instruction generator writes AGENTS.md and, where needed, CLAUDE.md or `.cursor/rules/*.mdc`. Per-session IDE context never touches the repo; it goes through each harness's prompt channel listed in section 1. Aider keeps its existing `AIDER_READ` bridge. Cross-session "memory" as an audited ledger is a Canopy layer (strategy item 9), since only Claude, Codex, omp and grok have native memory, and those are opt-in or experimental outside Claude.

### 11. MCP: one Canopy server, registered natively, deduplicated

Register `canopy-hook --mcp` through each harness's native config:

- **Claude:** prefer per-session `--mcp-config` over editing `~/.claude.json`.
- **Codex:** a `[mcp_servers.canopy]` block.
- **Amp:** `amp.mcpServers`.
- **agy:** `~/.gemini/config/mcp_config.json`.
- **OpenCode:** `mcp.canopy`.
- **Cursor:** `.cursor/mcp.json`, plus `--approve-mcps` headless.
- **Grok:** `~/.grok/config.toml`.
- **omp: `~/.omp/agent/mcp.json`. This registration is missing today.**

**Canopy-owned layer.** A dedupe step is needed because grok and omp both import other harnesses' MCP configs, including `~/.claude.json` ([grok MCP](https://docs.x.ai/build/features/mcp-servers); [OMP mcp-config.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/mcp-config.md)). Disable grok's import with `[compat.claude] mcps = false`. For omp, either register natively and accept that the imported entry shadows or duplicates it, or detect the duplicate at `system/init`. Aider has no MCP, so it gets read-only context only.

Codex removed `codex mcp-server` in PR #42993 ([PR #42993](https://github.com/openai/codex/pull/42993)). No harness except Claude (`claude mcp serve`, tools only, no agent loop) runs as an MCP server.

### 12. Auth: passthrough, never intermediated

Every harness authenticates through its own login. Canopy shows status by calling the harness's status command:

- `claude auth status --json`
- `codex login status`
- `cursor-agent status --format json`
- `amp account list`

Sign-in launches the harness's own login in a terminal. Canopy never reads, stores or proxies tokens. The policy section sets which auth types each feature may run under.

### 13. Model switching: passthrough with a catalog-fed picker

**Mid-session switching:**

- **Claude:** `/model <id>` in stream-json input, confirmed by the `PostModelSwitch` hook.
- **Codex app-server:** `turn/start.model` "for this turn and subsequent turns".
- **omp:** RPC `set_model`.
- **Grok:** ACP `session/set_config_option`.
- **OpenCode:** per-prompt `model` in the API.
- **PTY-only harnesses:** `/model` is typed into the TUI.

**Catalogs** come from the harness: `model/list` (Codex), `agy models`, `grok models`, `cursor-agent models`, `omp models --json` and `opencode models`. **Amp** has no model choice, only modes (`low|medium|high|ultra`), so its chip is a mode picker. Avoid interactive `/model` in Claude terminal sessions, because it persists the choice to the user's settings unless the session-only option is picked ([model-config](https://code.claude.com/docs/en/model-config)).

### 14. Self-update: native commands, Canopy-owned pin policy

Every harness has an update command. **No Canopy code disables or pins any CLI's auto-updater today**, so the verified stamps in the registry drift silently ([canopy_bridge_inventory.md](../research_notes/Harness%20capability%20parity%20matrix/canopy_bridge_inventory.md)).

**Canopy-owned policy.** On remote VMs and vendored binaries, pin and disable updates. The per-harness switches are:

| Harness | Disable auto-update | Pin a version |
|---|---|---|
| Claude | `DISABLE_UPDATES=1` | `claude install <ver>` |
| Codex | `-c check_for_update_on_startup=false` | install a specific version |
| Amp | `AMP_SKIP_UPDATE_CHECK=1` | `amp update --target-version` |
| Aider | `--no-check-update` | pip version |
| agy | `AGY_CLI_DISABLE_AUTO_UPDATE=true` | vendored binary only (no pin flag) |
| OpenCode | `OPENCODE_DISABLE_AUTOUPDATE=1` | `opencode upgrade <ver>` |
| omp | `startup.checkUpdate: false` | package manager version |
| Cursor | `channel: "static"` in a Canopy-owned config dir (RE) | vendored `versions/<ver>` directory |
| Grok | `GROK_DISABLE_AUTOUPDATER=1` | `grok update --version` |

On desktop, where the user owns the install, leave their updater alone. Instead, gate features on detected capabilities (Claude's `system/init.capabilities`, Codex's schema) plus a supported-version range, and offer updates through the native command.

### 15. Clipboard: Canopy's terminal must speak OSC 52, plus a shim for the two that can't

Most harnesses already do the right thing remotely, and Canopy currently drops it:

- **Claude** "over SSH … falls back to OSC 52" ([fullscreen](https://code.claude.com/docs/en/fullscreen)).
- **Codex** sends OSC 52 over SSH and when native copy fails, capped at 100,000 bytes ([clipboard_copy.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/clipboard_copy.rs)).
- **omp** emits OSC 52 first.
- **Grok, Amp, OpenCode and agy** have OSC 52 paths.

**Canopy-owned spec.**

1. Register `term.parser.registerOscHandler(52, …)` in `Term.tsx` beside the existing 9, 777 and 99 handlers. Parse `Pc;Pd`, accept the `c`, `p` and `s` targets, base64-decode the payload, and cap it at 1 MB.
2. Write to the host clipboard through Tauri, behind a per-workspace consent setting ("Let terminal programs set the clipboard"). Show a toast naming the session.
3. **Refuse OSC 52 read queries (`?`) by default.** Amp issues them, and answering would leak clipboard contents to remote processes.
4. Tolerate tmux passthrough. tmux unwraps DCS passthrough when `allow-passthrough` is on, so Canopy sees the inner OSC.

**Shim for harnesses that never emit OSC 52.** Cursor shells out only to `pbcopy`, `wl-copy` or `xclip` and aborts when neither `DISPLAY` nor `WAYLAND_DISPLAY` is set ([Cursor forum](https://forum.cursor.com/t/cursor-agent-cli-copy-fails-in-remote-ssh-headless-terminal-should-support-osc52-fallback-or-configurable-clipboard-command/164019)). Aider uses `pyperclip`. For both, remote VMs get small `xclip` and `wl-copy` shims on `PATH` that forward stdin to Canopy's clipboard bridge (or emit OSC 52), plus a dummy `WAYLAND_DISPLAY` so Cursor does not bail out early.

The same shim covers Claude, which shells to `xclip` on Linux when it does not detect SSH. Canopy's WebSocket PTY bridge is not SSH, and whether Claude chooses OSC 52 there is undocumented ([claude_code.md](../research_notes/Harness%20capability%20parity%20matrix/claude_code.md)).

**A last-resort action for every harness.** "Copy last assistant message" reads the structured stream or transcript and needs no terminal cooperation.

**Renderer defaults.** Launch Claude with `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` and Codex with `--no-alt-screen` where Canopy's own selection and scrollback search matter more than in-app mouse selection.

## What Canopy already ships, and what the parity doc gets wrong

### Current bridges per CLI

The inventory was taken at HEAD e3083299 (0.4.5). The worktree HEAD (8ad6a239) adds `src/brain.ts`, the single brain resolver, and `src/harness.ts`, a typed capability ledger that nothing consumes yet ([canopy_bridge_inventory.md](../research_notes/Harness%20capability%20parity%20matrix/canopy_bridge_inventory.md)).

| CLI | Hooks | MCP | Structured runner | Usage | Resume | Native store reader | Update | Rollback |
|---|---|---|---|---|---|---|---|---|
| claude | `.claude/settings.json`, 13 events + statusLine wrapper; peer-context injection, edit diagnostics, destructive-Bash gate | yes (profile `.claude.json`) | `CLAUDE_RUNNER`, structured tier, stamp 2.1.226 | rich (statusLine cost, 5h/7d limits) | yes | yes | `claude update` | Build-only git |
| codex | `.codex/hooks.json`, 6 events (no PreToolUse); needs `/hooks` trust | yes (TOML splice) | `CODEX_RUNNER`, oneshot, stamp 0.147.0 | tokens + live plan chip; cost estimated | yes | yes | reinstall | Build-only git |
| amp | generated plugin, 4 events, no permission event | yes | none | none | yes | none (server threads) | `amp update` | none |
| aider | `notifications-command`, attention only | none | none | none | none | yes (markdown history) | pip reinstall | none |
| agy | `.gemini/antigravity-cli/hooks.json` (**deprecated path**), 4 events | yes (correct path) | none | model only | yes | yes (SQLite/protobuf) | reinstall, no badge | none |
| opencode | generated plugin; edit normalization; research deny | yes | none | tokens + billed cost | yes | yes (SQL) | `opencode upgrade` | none |
| omp | extension, 6 event groups incl. approvals | **none (native client missed)** | none | CLI-computed cost | yes | yes | reinstall | none |
| cursor | `.cursor/hooks.json`, 6 events, no permission event | yes | `CURSOR_RUNNER`, oneshot, docs-derived stamp | none | unverified | none | `cursor-agent update` | none |
| grok | `.grok/hooks/canopy.json`, 9 events; subagent events dropped | yes (TOML) | none | none | unverified | none | `grok update` | none |

The Claude IDE protocol is unimplemented: there is no `~/.claude/ide` code. Terminal attention handles OSC 9, 777 and 99 but not BEL or OSC 52. Remote hosts wire integrations, MCP and digests for claude and codex only, and remote codex MCP lacks `env_vars`.

### Gaps that matter most

Read against the decision grid, the highest-value gaps are:

1. A rollback layer for all harnesses outside Build.
2. The Claude IDE server.
3. OSC 52 handling.
4. Structured runners for grok, OpenCode and omp, all now capable.
5. Usage sources for Amp and Grok, which have native data Canopy ignores.
6. omp MCP registration.
7. Update pinning.

### Extending `src/harness.ts` to the full adapter

`HarnessFeature` has ten keys. The checklist has fifteen features. The ledger should gain `permissionsSandbox`, `memoryInstructions`, `mcp`, `authPolicy`, `modelSwitching` and `clipboard`, keeping `planMode` as its own key because surfaces decide on it separately.

Its Claude entry deliberately leaves `checkpointsRewind`, `ideProtocol`, `subagents` and `compaction` as `unknown`. This research supplies dated stamps for all four, from Claude Code 2.1.310, `claude --help` and the code.claude.com docs on 2026-10-26 ([claude_code.md](../research_notes/Harness%20capability%20parity%20matrix/claude_code.md)):

| Key | New verdict | Note for the stamp |
|---|---|---|
| `checkpointsRewind` | native | Edit-tool files only, via `--rewind-files`; Bash, subagent and external edits are not tracked, so Canopy's snapshot layer is required |
| `ideProtocol` | native | Tool schemas are RE |
| `subagents` | native | |
| `compaction` | native | |
| `sessionsResumeFork` | native | `--fork-session` is now documented, so this moves up from partial |

The `support` vocabulary (native, partial, none, unknown) already matches this report's matrix. The ledger needs one addition: a `canopyLayer` field per feature (`none`, `gapFill`, `replace`), so surfaces read the grid's H, H+C or C decision rather than re-deriving it.

The adapter itself should be a single interface that features call. Optional members encode capability, and the ledger records the evidence:

```ts
interface HarnessAdapter {
  id: string;
  capabilities(version: string): HarnessCapabilities;           // 15 keys + canopyLayer
  launch(o: { mode: CanopyMode; model?: string; context?: string;
              resume?: string; fork?: boolean }): { argv: string[]; env: Record<string,string> };
  structured?: { start(o): Session; send(s, msg): void; interrupt(s): void;
                 events(s): AsyncIterable<CanopyEvent> };
  turnSignals: { start: string[]; end: string[] };              // native hook names
  editToolMap: Record<string, (input: unknown) => string[]>;    // tool -> touched paths
  rewind?: { files?(s, turnId): Promise<void>; conversation?(s, turnId): Promise<void> };
  sessions?: { list?(): Promise<SessionMeta[]>; transcriptPaths(): string[] };
  compact?(s, focus?: string): Promise<void>;
  setModel?(s, model: string): Promise<void>;
  usage?(s): Promise<UsageRecord | null>;
  env: { pinUpdates: Record<string,string>; clipboard: Record<string,string> };
  policy: { headless(auth: AuthKind): "allowed" | "warn" | "blocked" };
}
```

### Corrections to `docs/agent-parity.md`

The August 2026 audit covers seven CLIs, and the following corrections should land in it. The first ten are from the inventory; the rest are from the research notes.

1. **Add Cursor and Grok columns.** The registry has nine CLIs, and code comments still say "seven CLIs".
2. **MCP auto-setup:** add Cursor and Grok as "yes", and change omp from "no native MCP" to "native client, not yet registered". omp reads `~/.omp/agent/mcp.json` and the feature predates 18.1 ([OMP mcp-config.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/mcp-config.md)).
3. **Token/cost/model tray:** raise codex to "tokens + live plan chip", opencode to "tokens + billed cost" and omp to "CLI cost". Mark Amp and Grok as "native source available, not wired".
4. **Build headless runner:** add a Cursor column. Re-rate OpenCode, omp and Grok from "no" to "capable, not built", since all three have structured surfaces, system prompt, tool lists, plan mode and resume.
5. **Version stamps:** replace them with this report's pins (claude 2.1.310, codex 0.162.1, agy 1.2.14, omp 18.4.10). Flag the Cursor runner stamp ("current beta", from docs) as unverified against a binary.
6. **agy:** the hooks path is `~/.gemini/config/hooks.json`, not `~/.gemini/antigravity-cli/hooks.json`. Also fix the stale PreToolUse claim.
7. **Aider:** update the description of the notification mechanism.
8. **Ranked plan:** P2 items 7–9 have shipped. Item 10 (BEL) remains open.
9. **omp:** the BEL fallback claim is unverified. "Observability only" is wrong because `tool_call` can block. "Reads every context-file convention" overstates it, since foreign user-level files are opt-in.
10. **Amp:** the "no verified permission-request event" claim is partly outdated (`awaiting-approval` thread state). Usage is available via `amp threads usage`.
11. **OpenCode:** `chat.message`, on which the plugin's UserPromptSubmit mapping relies, is not on the current plugin docs page. Re-verify it on 1.18.34.
12. **Add rows** for rollback, IDE protocol, clipboard and update pinning, which the audit does not track.

## Claude Code's IDE protocol: what to serve (verified by traffic capture)

**Status:** verified against the real Claude Code 2.1.310 by wire capture on 2026-10-26. The full spec, with every frame, timing and failure case, is in [claude_ide_protocol_capture.md](../research_notes/Harness%20capability%20parity%20matrix/claude_ide_protocol_capture.md), and its section 10 is the implementation contract. This section is a summary of it. Where the capture and the community spec disagree, the capture wins.

- **Scope.**
  - The IDE channel works only in the interactive TUI.
  - `claude -p` and SDK runs never connect, whatever the env or flags. Canopy's PTY sessions qualify; structured runs must keep using Canopy's MCP tools.
- **Discovery.**
  - The lock file is `$CLAUDE_CONFIG_DIR/ide/<port>.lock`. `~/.claude/ide` is also scanned.
  - The port comes from the file name.
  - Fields: `pid`, `workspaceFolders`, `ideName`, `transport:"ws"`, `authToken`.
  - Any claude process deletes a lock whose `pid` is dead.
  - Canopy sets `CLAUDE_CONFIG_DIR` per profile, so locks must follow it.
- **Connecting.**
  - Set `CLAUDE_CODE_SSE_PORT=<port>` in the PTY env. It turns on auto-connect, pins the session to its own server, and skips the workspace and ancestor-pid checks.
  - `CLAUDE_CODE_AUTO_CONNECT_IDE=true` alone fails when two Canopy sessions share a folder: the match is ambiguous, so neither connects.
  - `ENABLE_IDE_INTEGRATION` does not exist in 2.1.310.
  - Do not set `TERM_PROGRAM=vscode`.
- **Transport.**
  - WebSocket on `127.0.0.1`, path `/`, header `x-claude-code-ide-authorization`.
  - The server **must echo the `mcp` subprotocol**, or the client drops the socket.
  - One JSON-RPC message per text frame. MCP handshake `initialize` (2025-11-25 or 2024-11-05), then `ide_connected {pid}`, `tools/list` and `prompts/list`.
  - Reconnection: the client retries only with the token it cached, about 7 s and 15 s after a drop, and then gives up.
- **Tools that are actually used.**
  - The CLI calls `openDiff`, `close_tab`, `closeAllDiffTabs` and `getDiagnostics` by name.
  - The model sees only `getDiagnostics` and `executeCode`.
  - `openFile`, `getOpenEditors`, `getWorkspaceFolders`, `getCurrentSelection`, `getLatestSelection`, `checkDocumentDirty` and `saveDocument` are not in the binary at all.
- **Diff review.** `openDiff` is the permission prompt for Edit and Write. It fires only when a prompt would show (default mode), not in acceptEdits or auto.
  - It blocks with no timeout.
  - `FILE_SAVED` plus the final contents accepts, and the CLI writes the contents the user may have edited.
  - `DIFF_REJECTED` rejects and aborts the turn.
  - `TAB_CLOSED` means **accept as proposed**.
  - If the user answers in the terminal first, the CLI sends `close_tab` and never cancels the request.
- **Diagnostics.** Every Edit or Write, in every mode, is bracketed by:
  1. a baseline `getDiagnostics {uri}`, with a 500 ms timeout (three timeouts disable it);
  2. a `{}` fetch, with a 2 s timeout.

  Only new diagnostics reach the model, as `<new-diagnostics>`. Ranges are 0-based, and severity is a string.
- **Context.**
  - `selection_changed` attaches the selected lines, or "opened file" for an empty selection, to the next prompt. `null` does not clear it.
  - `at_mentioned` inserts `@file#Lx-y` into the prompt box.
- **`ideName`** is display-only ("…in Canopy").
- **Remote workspaces.** The server must run on the VM, in claude's PID namespace, not on the desktop.

## Bugs and risks in today's integrations

Each item below was checked against the worktree where noted. File references are to the Canopy repo.

| # | Bug or risk | Evidence | Impact | Recommended fix |
|---|---|---|---|---|
| 1 | **agy hooks written to a deprecated path** | `src-tauri/src/agents.rs:891` writes `.gemini/antigravity-cli/hooks.json`, and tests at lines 5348, 5530, 5796 and 5932 assert it. agy docs: "Hooks in `~/.gemini/antigravity-cli/settings.json` aren't loaded"; the global file is `~/.gemini/config/hooks.json`. The changelog moved `/hooks` to the shared file in 1.0.8 ([agy hooks](https://antigravity.google/docs/hooks)) | agy lifecycle events may never fire. The inventory already records "agy maps no start or end events" | Write `~/.gemini/config/hooks.json` (keyed by a `canopy` hook name), keep the old file until an authenticated run proves it unused, then drop it. Add `SessionStart` and `PreToolUse` |
| 2 | **grok runs Canopy's Claude hooks as `--agent claude`** | `grok inspect --json` lists five hooks from `~/.claude` targeting `canopy-hook --agent claude` with `compatibilityStatus: "enabled"`, and imports 17 Claude permission rules ([agy_grok.md](../research_notes/Harness%20capability%20parity%20matrix/agy_grok.md)). The `agent == "grok"` branch at `canopy_hook.rs:780` never sees these, because `--agent claude` wins | grok events are stamped as Claude in digests and the roster. Once Canopy's native `.grok/hooks/canopy.json` is also installed, every event will fire twice (not yet observed). Claude's permission rules silently govern grok | Set `[compat.claude] hooks = false` and `mcps = false` in Canopy-managed grok config, or export `GROK_CLAUDE_HOOKS_ENABLED=0` in grok PTYs. Defensively, make `canopy-hook` drop an `--agent claude` event when `GROK_SESSION_ID` is set. Moving Canopy's Claude hooks into per-session `--settings` would also remove the leak |
| 3 | **omp runs `yolo` unless Canopy says otherwise** | omp docs: `tools.approvalMode` defaults to `yolo`; subagents are forced to `yolo` ([OMP approval-mode.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/approval-mode.md)). The registry passes `--approval-mode=write` only for unattended launches. Its comment calls `always-ask` "a configurable default", which conflicts with the docs. The unattended overlay additionally allows bash, eval and task | A plain interactive omp tab on a shared checkout auto-approves every tool, including shell | Pass `--approval-mode=always-ask` on interactive launches, or the mode chosen in Canopy's vocabulary. Show a "subagents run unattended" warning. Rely on turn snapshots for recovery |
| 4 | **omp's native MCP client is unused** | No omp MCP registration exists in `agents.rs`. omp reads `~/.omp/agent/mcp.json` and `.omp/mcp.json` ([OMP mcp-config.md](https://github.com/can1357/oh-my-pi/blob/v18.4.10/docs/mcp-config.md)) | omp gets only a system-prompt bootstrap and no Canopy tools (mesh, diagnostics, browser) | Register `canopy` in the profile-aware `~/.omp/agent/mcp.json`. Dedupe against omp's import of `~/.claude.json` and Codex TOML |
| 5 | **Cursor clipboard fails on remote hosts** | The 2026.10.01 bundle copies only via `pbcopy`, `wl-copy` or `xclip`, aborts without `DISPLAY` or `WAYLAND_DISPLAY`, and contains no `]52;` sequence; user reports confirm it ([Cursor forum](https://forum.cursor.com/t/cursor-agent-cli-copy-fails-in-remote-ssh-headless-terminal-should-support-osc52-fallback-or-configurable-clipboard-command/164019)) | `/copy` is dead in every Canopy remote workspace | Add the `xclip`/`wl-copy` shim and a dummy `WAYLAND_DISPLAY` in remote VMs, plus "copy last message" from the transcript |
| 6 | **Canopy's terminal ignores OSC 52** (fix open as PR #674: OSC 52 handler with input gating and read-query refusal; the remote xclip/wl-copy shim is still a follow-up) | `src/components/Term.tsx:1010-1023` registers OSC 9, 777 and 99 only. Verified by grep | Remote copy fails for Claude (over SSH-like links), Codex, omp, Grok, Amp, OpenCode and agy, even though each does the right thing | The OSC 52 handler specified in section 15 |
| 7 | **Auto-updaters drift past verified stamps** | No code disables any updater. Runner stamps say 2.1.226 and 0.147.0, while installed versions are 2.1.310 and 0.162.1 | Behaviour changes land unannounced. Example: Claude `-p` defaults to Manual mode from 2.1.302 | The pin-and-gate policy in section 14. Re-stamp the runners at the new pins |
| 8 | **Codex hook trust can silently lapse** | Codex skips non-managed hooks until each content hash is trusted via `/hooks` ([Codex hooks](https://learn.chatgpt.com/docs/hooks)). `heal_integrations` rewrites hooks on every launch | Any byte change in Canopy's hook file un-trusts it, so events stop | Keep the generated `hooks.json` byte-stable across versions. Detect `HookTrustStatus: modified` and prompt the user |
| 9 | **Edit journal is blind to non-Claude edit tools** | It records only tools named `Edit`, `Write`, `MultiEdit` and `NotebookEdit`; it is unverified for codex, agy, cursor and grok, and absent for omp, amp and aider | Per-agent rollback scoping and file attribution break on shared checkouts | Per-adapter `editToolMap`, with a filesystem-watcher fallback |
| 10 | **OpenCode prompt-submit may rely on an undocumented hook** | `chat.message` is absent from the current plugins page ([OpenCode plugins](https://opencode.ai/docs/plugins/)) | UserPromptSubmit and turn boundaries could vanish on upgrade | Derive the event from `message.updated` with role `user` as a fallback |
| 11 | **Cursor integration rests on unverified flags** | resume, positional prompt and `--force` are unverified. The runner was stamped from docs. The pin mismatch is 10.01 installed versus 10.22 in the brief | Silent launch failures | Verify against the 10.22 binary before any Cursor feature work |
| 12 | **Codex refresh-token race** | A live run failed with "refresh token was already used" ([codex.md](../research_notes/Harness%20capability%20parity%20matrix/codex.md)). The cause is unverified, but possibly concurrent processes sharing `auth.json` | Codex tabs fail auth intermittently | Investigate. If confirmed, serialize Codex processes per `CODEX_HOME` or use the shared app-server daemon |
| 13 | **agy headless on consumer plans** | The Google FAQ bars wrapping agy in third-party apps on consumer plans (see the policy section) | Account suspension risk for users | Gate any agy runner behind a Gemini API key, ADC or an Enterprise login, and warn consumer accounts |

## Policy decides the order more than capability does

### Per-vendor rules

| Vendor / harness | Rule (primary source) | Safe to build on | Needs legal review |
|---|---|---|---|
| **Anthropic / Claude Code** | Third parties may not "offer Claude.ai login", "route requests through Free, Pro, or Max plan credentials on behalf of their users", or "collect, store, or intermediate Claude.ai credentials". The policy does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code", on condition the binary is unmodified, no auth method is disabled, the vendor neither pays for nor resells usage, and the "Claude Code" name is kept out of product branding ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)) | Spawning the user's own unmodified `claude` binary, interactive or `-p`, with the user's own login. Status via `claude auth status`. API-key and cloud-provider auth | Whether an IDE spawning `claude -p` for background features on a subscription counts as "routing requests" (the key ambiguity). Embedding the Agent SDK on subscription OAuth looks closer to the prohibited pattern. Copying `.credentials.json` between remote VMs. Do not adopt `--bare`, which also drops OAuth |
| **OpenAI / Codex** | "App-server authentication has never been permitted for commercial or hosted services." Local or open-source apps "can continue using it". OpenAI points commercial integrators to Sign in with ChatGPT and a partner waitlist ([App Server](https://learn.chatgpt.com/docs/app-server)) | `codex exec` and the TUI under the user's own `codex login`. `CODEX_API_KEY` for API-key users | Driving `codex app-server` from a commercial IDE, even on the user's own login. Never use the `chatgptAuthTokens` external-token mode. Apply for SIWC in parallel |
| **Google / agy** | "Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service." "Wrapping `agy` inside third-party coding agents or applications … is not supported under consumer plans" ([agy FAQ](https://antigravity.google/docs/faq)). Users report bans after using OpenCode or OAuth proxies ([Google AI forum](https://discuss.ai.google.dev/t/got-banned-from-antigravity-for-using-opencode-submitted-appeal-but-still-locked-out/131169)) | agy as a plain terminal tab the user drives, with a warning. Any automation only on a Gemini API key (`modelProvider: gemini`), ADC or Enterprise | Whether hosting the PTY counts as "wrapping". The exact Antigravity ToS text was not fetched |
| **Cursor** | ToS §1.5(i) forbids attempts to "reverse engineer, disassemble, decompile, decode"; §1.5(viii) forbids "harvest, scrape, or extract data" ([Cursor ToS](https://cursor.com/terms-of-service)). Staff say using Cursor as a backend "is a supported and intended use of the Cursor SDK" ([Cursor forum](https://forum.cursor.com/t/inquiry-regarding-official-api-or-commercial-license-for-using-cursors-engine-as-a-backend-component/165063)) | Documented surfaces only: hooks, stream-json, ACP, `cli-config.json`, `mcp.json` | Anything RE'd from the bundle: hidden `--allowed-tools`, the `store.db` layout, `channel: "static"`, `--disable-auto-update`. The positive position rests on forum posts, not the ToS |
| **xAI / Grok** | ACP is documented for "IDEs, SDKs, eval harnesses, and custom apps", and Zed, Neovim and Emacs are listed clients ([grok headless/ACP](https://docs.x.ai/build/cli/headless-scripting#acp)) | ACP and headless hosting. `XAI_API_KEY` gives complete cost reporting | No statement found on SuperGrok OAuth from third-party hosts, and none prohibiting it either |
| **omp** | omp 18.4.10 ships `omp login anthropic` with `authorize-url "https://claude.ai/oauth/authorize"` and a Claude Code fingerprint module ([pi-ai oauth/anthropic.ts](https://github.com/can1357/oh-my-pi/blob/v18.4.10/packages/ai/src/registry/oauth/anthropic.ts)). OpenCode removed the equivalent in PR #18186 after "anthropic legal requests" ([opencode PR #18186](https://github.com/anomalyco/opencode/pull/18186)) | omp with API keys or cloud providers | Canopy must never surface, default to or automate omp's Anthropic OAuth. Treat it as conflicting with Anthropic's policy |
| **Amp** | License is "limited, revocable, non-exclusive"; no reselling of quotas or credits. Silent on embedding ([Amp terms](https://ampcode.com/terms)) | The user's own `amp login` or `AMP_API_KEY` | The Acceptable Use Policy was not read |
| **OpenCode, Aider** | Bring-your-own-key clients. OpenCode's bundled Claude Pro/Max OAuth was removed | Safe on the user's own provider keys | OpenCode's ChatGPT-subscription login has no OpenAI primary source approving it |

### What the rules imply

Across vendors, one principle survives every rule: **Canopy launches the vendor's official, unmodified binary under the user's own credentials, and never touches the tokens.** Every adapter should declare `policy.headless(authKind)` so that features refuse to run background intelligence where the vendor forbids it. Concretely, that means agy on consumer OAuth, and Codex app-server pending counsel. This is a policy interpretation, not legal advice. The Anthropic `-p`-on-subscription question deserves counsel before Canopy's background features (digests, naming, auto-review) ship on Claude subscriptions.

## Sequenced implementation plan

### Phase 1: Claude Code only

Phase 1 builds the adapter seam, rollback, the IDE protocol and clipboard, all on Claude Code.

1. **Adapter seam.**
   - Extend `src/harness.ts` to fifteen keys plus `canopyLayer`.
   - Add the `HarnessAdapter` interface and implement `ClaudeAdapter` by moving argv construction from `CLAUDE_RUNNER` and the registry behind it.
   - Fill Claude's ledger from this research and enforce a minimum version (2.1.302 or later, so the Manual-default behaviour is known).
   - Route every feature through `brain.ts` and the adapter, never through CLI-specific code.
2. **Rollback.**
   - Build the Canopy turn-snapshot layer (section 2) on Claude's `UserPromptSubmit` and `Stop` hooks, so it covers PTY sessions too.
   - Layer Claude's `--rewind-files` on structured sessions, keyed on replayed user-message `uuid`s.
   - Add the turn timeline UI and per-agent scoping via the edit journal.
3. **IDE protocol.** Build the lock-file WebSocket MCP server, `openDiff` blocking review, selection push and diagnostics. Capture 2.1.310 traffic first and turn it into contract tests.
4. **Clipboard.** Add the OSC 52 handler with consent and read-query refusal, the remote `xclip`/`wl-copy` shim, and "copy last message".
5. **Claude hygiene.**
   - Set an explicit permission mode on every `-p` launch.
   - Route approvals through a `PermissionRequest` HTTP hook.
   - Add a status-line forwarder for quota.
   - Move hook and MCP injection to per-session `--settings` and `--mcp-config` for Canopy-launched sessions. This keeps the existing file-based install for user-typed `claude`, but stops the grok leak at its source.
   - Apply the version pin policy on remote VMs.

### Phase 1, in parallel: cheap fixes for the other eight

These are bug fixes, not adapter work, and each takes hours:

- agy hooks path (bug 1).
- grok compat flags and `canopy-hook` guard (bug 2).
- omp approval flag (bug 3) and MCP registration (bug 4).
- Auto-update env vars for vendored remote binaries.
- Corrections to `docs/agent-parity.md`.

### Phase 2 onward: harness order by coverage and policy safety

Each new harness is an adapter plus ledger entry. Features do not change.

| Order | Harness | Why here | Blockers to clear first |
|---|---|---|---|
| 2 | **Codex** | Hooks mirror Claude, an exec runner already exists, and the user base is large. Native compaction, sessions and model switching. Rollback is Canopy-layer plus `thread/revert` | Policy review before using app-server. Start on `exec` and hooks. Re-stamp at 0.162.1. Hook-trust stability (bug 8) |
| 3 | **Grok** | Native on thirteen of fifteen rows, partial on the other two. The Claude-format stream reuses the parser. ACP hosting is vendor-sanctioned | Empirical `/rewind` file-restore test. Narrow user access tier |
| 4 | **OpenCode** | HTTP revert/unrevert, summarize and permission replies make it the richest programmatic surface. BYOK and policy-clean | Capture the SSE event schema. Verify `chat.message`. No OS sandbox, so use the VM boundary |
| 5 | **omp** | RPC covers prompt, steer, branch, compact, set_model and subagents | Approval defaults (bug 3), forced-yolo subagents, hide the Anthropic OAuth, verify `/branch` file effect |
| 6 | **Cursor** | Real OS sandbox, `/rewind`, hooks, ACP blessed by staff | ToS bars RE surfaces. Verify the 10.22 binary. Usage needs a price table. Clipboard shim |
| 7 | **Amp** | Claude-compatible stream and rich usage | No rollback, no plan mode, server-side threads, undocumented IDE socket, no OS sandbox |
| 8 | **agy** | Capable headless and native rewind in the TUI | Consumer-plan wrapping ban. API-key, ADC or Enterprise gating. No system-prompt or approval channel. Raise the pin to 1.3.5 or later for `/compact` |
| 9 | **Aider** | Terminal-only, carried entirely by Canopy layers (snapshots, `AIDER_READ`, history-file resume, PTY usage scrape) | Never Build-eligible. No hooks, MCP or structured output |

## Unverified items that need live or authenticated runs

### Claude Code 2.1.310

- [ ] Capture IDE-protocol traffic: lock-file body, negotiated MCP version (`2024-11-05` or `2025-03-26`), full `tools/list`, `openDiff` parameters and return, `selection_changed` payload.
- [ ] Stream-json input envelope and full `result` fields for this version. Contract of `--permission-prompt-tool`, which is absent from the captured `--help`.
- [ ] Whether a mid-session permission-mode or model change works as a stream-json control message (`setPermissionMode`, `setModel`).
- [ ] Whether Claude emits OSC 52 under Canopy's non-SSH WebSocket PTY, or falls back to `xclip` and fails silently.
- [ ] `compact_boundary` stream message, and the env var that fully disables auto-compaction.
- [ ] A programmatic way to list a session's checkpoints. A headless equivalent of "summarize from here".

### Codex 0.162.1

- [ ] Authenticated `exec --json` capture of `file_change`, `mcp_tool_call`, reasoning and collab-agent items.
- [ ] `account/usage/read` and rate-limit methods. Exec-mode subagent visibility.
- [ ] Whether `/ide` needs an IPC handshake before `ide-context`.
- [ ] Root cause of "refresh token was already used". Whether `codex update` prompts in a non-TTY.

### agy 1.2.14

- [ ] Whether `~/.gemini/antigravity-cli/hooks.json` is still read. Whether `SessionStart` fires.
- [ ] `subagent_info` and `checkpoint` step types in the 1.2.14 stream. Whether `transcript.jsonl` carries usage.
- [ ] Whether the updater overwrites a root-owned `/usr/local/bin/agy`. Meaning of `AGY_CLI_FORCE_OSC`. User-namespace fallback in containers.

### Grok 1.0.46

- [ ] Does `/rewind` restore files (embedded docs versus docs.x.ai)? Schema of `x.ai/rewind/*`.
- [ ] Whether a Canopy MCP entry in `~/.claude.json` is imported. Whether passive `SessionStart` can inject context. Whether ACP `clientCapabilities.fs` can serve unsaved buffers.
- [ ] A machine-readable `grok sessions list`.

### Cursor 2026.10.22

- [ ] Install and re-verify the brief's pin: resume, positional prompt, `--force`, `/model`, and runner argv against the binary.
- [ ] `result.usage` field names. Stream-json subagent events. JSONL transcript schema and `store.db` root. Headless `/fork`.
- [ ] Whether 10.22 added OSC 52 (the changelog shows no clipboard entry). Official meaning of `channel: "static"`.

### Amp 0.0.1790913650

- [ ] Edit-tool names and argument shapes (`amp tools list` hung without auth). Output format of `amp threads usage`.
- [ ] `delegate` permission protocol. Whether `--dangerously-allow-all` is supported. Clipboard path selection under Canopy's environment. A manual compact command.

### OpenCode 1.18.34

- [ ] `run --format json` and SSE event schemas. Whether `chat.message` and `permission.ask` still exist.
- [ ] Whether issues #11996 and #25253 (OSC 52 fallback and tmux wrapping) are fixed. Whether `autoupdate` still auto-installs at this version.

### omp 18.4.10

- [ ] End-to-end RPC session trace. Whether `/branch` or `/tree` reverts files.
- [ ] Actual default `tools.approvalMode` on a fresh profile (docs say `yolo`, the registry comment implies `always-ask`).
- [ ] Root `AGENTS.md` discovery. Double MCP registration once `~/.omp/agent/mcp.json` is written.

### Aider 0.86.2

- [ ] Exact in-band cost-line format for PTY scraping. Timing of the summarization trigger.

### Policy

- [ ] Counsel on Claude `-p` with subscription OAuth for background features.
- [ ] Counsel on Codex app-server in a commercial IDE.
- [ ] Counsel on whether agy PTY hosting counts as wrapping.
- [ ] Read Amp's AUP and the Antigravity ToS clause text.

## Conclusion

The matrix changes the shape of the problem. "Support nine harnesses" sounds like nine integrations, but the real work is **five Canopy-owned layers built once, plus thin adapters**. The five layers are turn snapshots, MCP editor tools, the OSC 52 terminal, the usage ledger and the session index. Each adapter mostly maps flags and event names, and the field's convergence on Claude Code's stream-json and hook schemas keeps shrinking that work. Claude-first is cheap insurance rather than lock-in, provided every feature reads `src/harness.ts` and the adapter interface from day one rather than Claude's argv.

The less obvious lesson is that **vendor policy, not capability, now sets the integration order**. The most capable surfaces after Claude are Codex's app-server and agy's headless mode. Those two are precisely the ones whose vendors restrict third-party hosting. The safest long-term posture is therefore Canopy's existing one, hardened: the user's own official binary, the user's own login, and no token custody.

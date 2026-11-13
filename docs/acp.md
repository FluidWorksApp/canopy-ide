# Agent Client Protocol (ACP)

ACP is JSON-RPC 2.0 over a child process's stdio ([spec](https://agentclientprotocol.com)).
Canopy treats it as a runner tier next to `structured` and `oneshot`: a runner
with `tier: "acp"` is driven by `AcpTransport` instead of a vendor stream.

## Architecture

- `src/acp/rpc.ts`: line framing, request/response correlation, notifications.
  An agent's `$/cancel_request` aborts the matching in-flight handler, which
  then replies `-32800`.
- `src/acp/protocol.ts`: the subset of ACP v1 types Canopy uses, including
  `sessionCapabilities`, auth methods, config options and the fs shapes.
- `src/acp/client.ts`: the session (`AcpSession`): `initialize`, session setup,
  `session/prompt`, `session/cancel`, `session/close`, and replies to agent
  requests (`session/request_permission`, `fs/read_text_file`,
  `fs/write_text_file`).
- `src/acp/fsGuard.ts`: pure path policy for the fs handlers.
- `src/acp/events.ts`: maps `session/update` onto the normalized
  `StructuredRunnerEvent` stream (`delta`, `reply`, `tool`, `blocked`,
  `turnEnd`, plus the additive `thought`, `plan`, `usage`, `toolFailed`).
  No host renders the additive kinds yet; they are emitted and ignored.
- `src/acp/transport.ts`: the long-lived process, wired over the existing
  `structured_runner_*` Tauri commands (full duplex, 1 MiB line cap, so no Rust
  change was needed).
- `src/acp/providers.ts`: `AcpProviderSpec`, `buildAcpRunner`, custom CLI
  helpers and the preset table. `src/acp/registry.ts`: registry discovery.
- `src/structuredRunners.ts`: the built-in ACP rows (`KIRO_ACP_SPEC`,
  `CLAUDE_ACP_SPEC`, `CODEX_ACP_SPEC`, `CURSOR_ACP_SPEC`, `OPENCODE_ACP_SPEC`).
- `src/projects.ts`: the resolver. `structuredRunnerFor(id)` returns the ACP
  runner when the agent has one and Settings > Agents > "Use ACP" is not off.
  `legacyRunnerFor(id)` always returns the vendor runner.
- `src/sessionOrigin.ts`: records which kind of transport minted a session id.

## Runner resolution

Build and the project runner call `structuredRunnerFor`. The setting is
`acpAgents` (a map of agent id to boolean); only an explicit `false` switches an
agent off. If the ACP process cannot be spawned (for example `npx` is missing),
`startStructured` starts the vendor runner instead. If the process starts but
the handshake fails, the error names the "Use ACP" setting.

Brain calls, context compaction and the companion keep using the vendor runner
(`legacyRunnerFor`). ACP has no one-shot mode, and the Tauri `brain.rs` puts the
prompt on argv for one-shot calls, so those stay on vendor argv.

A session id is only resumed by the kind of transport that minted it. Vendor
runners take an id Canopy generated; ACP agents mint their own. When the setting
changes between attempts, the builder session starts fresh instead of passing a
vendor id to `session/resume` (or an ACP id to `--resume`).

## Permission policy

Decided from the launch authority alone (`src/acp/permissions.ts`). Read-only
sessions answer `reject_once`. Workspace-write answers `allow_once`. Canopy
never selects `allow_always` or `reject_always`; with no matching one-shot
option the request is cancelled, which ACP defines as a refusal. A provider's
`trustAllArg`, when it has one, is passed only for workspace-write.

## Capability advertisement and session setup

Client capabilities: `fs.readTextFile` and `fs.writeTextFile` are advertised
only when the session was given fs handlers (the Tauri transport always gives
them). `terminal` is never advertised: `terminal/*` would need a new Rust
process manager, and it must go through the terminal governor. That is a
follow-up. `auth.terminal` is not advertised either.

fs requests must use an absolute path inside the session root, with `..`
resolved. Writes require workspace-write authority. Writes to `.git/hooks`,
`.git/config`, and agent settings or MCP config files (`.kiro`, `.claude`,
`.codex`) are refused. A refused write returns a JSON-RPC error and emits
`blocked`. Unsaved editor buffers are not read.

Session setup, in order:

1. `systemPrompt` (append) is sent on `session/new`/`load`/`resume` when the
   agent advertises `sessionCapabilities.systemPrompt`. Otherwise the brief is
   prepended to the first turn.
2. With a stored id, `session/resume` is preferred when advertised (no replay),
   then `session/load` when `loadSession` is advertised, then `session/new`.
3. If `session/new` fails with `auth_required`, Canopy calls `authenticate` with
   the first agent-type method. Terminal-type methods, or a failure, surface the
   provider's `authHint`.
4. The wanted model and mode are applied with `session/set_config_option`
   (categories `model` and `mode`), falling back to `session/set_mode`. Failures
   are ignored. This is how agents without a `--model` flag get a model.
5. On stop, `session/close` is sent when advertised (`-32002` counts as
   success), then the process is killed.

`mcpServers` is still `[]`: there is no ready-made Canopy MCP server definition
the transport can hand over (the context bridge needs a binary path and env).

## Agent migration

Every agent with an ACP entrypoint and an `AgentCli` row now runs over ACP by
default. Launch commands and versions come from the ACP registry v1 JSON read
on 2026-11-09. "Live-tested" means a real `initialize` and `session/new`.

| Agent | ACP command | Source | Status |
| --- | --- | --- | --- |
| Kiro | `kiro-cli acp` | live, kiro-cli 3.1.0, 2026-10-27 | live-tested |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp@0.102.0` | registry `claude-acp` | registry-sourced, not live-tested |
| Codex | `npx -y @agentclientprotocol/codex-acp@2.6.0` | registry `codex-acp` | registry-sourced, not live-tested |
| Cursor | `cursor-agent acp` | registry `cursor` 2026.11.05 | registry-sourced, not live-tested |
| OpenCode | `opencode acp` | registry `opencode` 2.2.6 | registry-sourced, not live-tested; ACP only, off means terminal only |
| Gemini CLI | `--acp` | registry `gemini` 0.67.0 | preset only (no `AgentCli` row) |
| Goose | `goose acp` | registry `goose` 1.57.0 | preset only |
| GitHub Copilot CLI | `npx -y @github/copilot@1.0.108 --acp` | registry | preset only |
| Qwen Code | `npx -y @qwen-code/qwen-code@0.27.1 --acp --experimental-skills` | registry | preset only |

The npx adapters are launched through `npx`, not through the agent's own binary,
so the first run needs network access. The registry's Kiro entry uses
`kiro-cli acp --agent-engine=v3`; Canopy keeps plain `acp`, which is what was
verified.

### Kiro flags

`kiro-cli --agent canopy --trust-all-tools` fails with "unexpected argument"
(checked on kiro-cli 3.3.0): `--trust-all-tools`, `--model` and `--effort` belong
to `kiro-cli chat` and `kiro-cli acp`, not the top level, which takes only
`--agent` and `--resume-id` as shorthands. So every terminal launch names `chat`
(`kiro-cli chat --agent canopy [--trust-all-tools]`, resume `kiro-cli chat
--resume-id <id> ...`; the entry's `launchSubcommand`), and the ACP launch uses
`kiro-cli acp --agent canopy [--trust-all-tools]`.

## What stays off ACP

- Brain and compaction one-shots (see above).
- The vendor runners, kept as the fallback and for the one-shot paths.
- The `terminal` client capability.
- `session/list`, `session/delete`, `session/fork`, elicitation and the v2
  draft.
- Rendering `thought`, `plan` and `usage` events in the UI.

## Adding a provider

1. Settings > Agents > Other CLIs: add a CLI, set the command, and fill
   "ACP args" (for example `--acp`). Args are stored as an array; quotes group
   words, and nothing is shell-expanded.
2. Or click a preset (Gemini CLI, Goose, GitHub Copilot CLI, OpenCode, Qwen Code), or browse the registry.
3. The entry becomes an agent with an `ACP` badge in the default-agent picker.
   Built-in agents have a per-agent "Use ACP" switch in Settings > Agents.
   Custom entries carry an `unverified` stamp; Canopy has not tested them.

In code, a built-in provider is one `AcpProviderSpec` row (see `KIRO_ACP_SPEC`
in `src/structuredRunners.ts`) passed to `buildAcpRunner`.

## Registry

`src/acp/registry.ts` reads
`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`. The
payload is capped at 1 MiB and validated field by field; bad entries are
dropped and a non-registry payload is an error. Results are cached in
localStorage for 6 hours; a stale cache serves when the network fails. With no
cache and no network the picker says so and the presets still work.

Distributions map to launch commands: `npx` becomes `npx -y <pinned package>
<args>`, `uvx` becomes `uvx <pinned package> <args>`, and a `binary` entry for
this platform becomes the executable name expected on PATH (Canopy does not
download or unpack archives). Packages must carry an exact version. Nothing
runs until the user adds the entry and starts it. The registry does not vouch
for the code it points at, so treat a registry entry like any package you
install.

## Verification

Presets and built-in rows were checked against the registry JSON on 2026-11-09
(versions in the table above). Kiro was checked live against `kiro-cli` 3.1.0 on
2026-10-27. The Claude, Codex, Cursor and OpenCode rows have not had a live
handshake: no adapter binary was available, and their stamps say
"NOT live-tested".

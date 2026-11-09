# Agent Client Protocol (ACP)

ACP is JSON-RPC 2.0 over a child process's stdio ([spec](https://agentclientprotocol.com)).
Canopy treats it as a runner tier next to `structured` and `oneshot`: a runner
with `tier: "acp"` is driven by `AcpTransport` instead of a vendor stream.

## Architecture

- `src/acp/rpc.ts`: line framing, request/response correlation, notifications.
- `src/acp/protocol.ts`: the subset of ACP types Canopy uses.
- `src/acp/client.ts`: the session: `initialize`, `session/new` or
  `session/load`, `session/prompt`, `session/cancel`, and replies to
  `session/request_permission`.
- `src/acp/events.ts`: maps `session/update` onto the normalized
  `StructuredRunnerEvent` stream (`delta`, `reply`, `tool`, `blocked`, `turnEnd`).
- `src/acp/transport.ts`: the long-lived process, wired over the existing
  `structured_runner_*` Tauri commands (full duplex, 1 MiB line cap, so no Rust
  change was needed).
- `src/acp/providers.ts`: `AcpProviderSpec`, `buildAcpRunner`, custom CLI
  helpers and the preset table. `src/acp/registry.ts`: registry discovery.

Consumers that need a one-question argv (brain calls, compaction) skip `acp`
runners; Build sessions use them.

## Permission policy

Decided from the launch authority alone (`src/acp/permissions.ts`). Read-only
sessions answer `reject_once`. Workspace-write answers `allow_once`. Canopy
never selects `allow_always` or `reject_always`; with no matching one-shot
option the request is cancelled, which ACP defines as a refusal. A provider's
`trustAllArg`, when it has one, is passed only for workspace-write.

## Capability advertisement

Canopy advertises no client capabilities (`fs.readTextFile`/`writeTextFile`
false, `terminal` false), so agents use their own tools. Session resume uses
`session/load` only when the agent reports `loadSession`. Because the agent
mints the session id, Build stores the transport's id after each turn and
resumes it on the next launch. ACP has no system-prompt field, so the brief is
prepended to the first turn.

## Adding a provider

1. Settings > Agents > Other CLIs: add a CLI, set the command, and fill
   "ACP args" (for example `--acp`). Args are stored as an array; quotes group
   words, and nothing is shell-expanded.
2. Or click a preset (Gemini CLI, Goose), or browse the registry.
3. The entry becomes an agent with an `ACP` badge in the default-agent picker.
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

Presets were checked against the registry JSON on 2026-11-09: `gemini` 0.67.0
(`--acp`) and `goose` 1.57.0 (`acp`). Kiro was checked live against
`kiro-cli` 3.1.0 on 2026-10-27.

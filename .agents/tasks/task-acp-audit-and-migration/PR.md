# Complete the ACP client and move ACP-capable agents onto ACP

## Why

An audit of `src/acp` against the ACP v1 spec found gaps in the client, and only
Kiro ran over ACP. Claude, Codex and Cursor used vendor runners although the ACP
registry lists ACP entrypoints for them.

## Audit

| Spec feature | Before | After |
| --- | --- | --- |
| `systemPrompt` session param | Brief prepended to first turn | Sent at session setup when advertised; prepended only otherwise |
| `session/resume` | Unused | Preferred over `session/load`, then `new` |
| `authenticate` / `auth_required` | None | Agent-type methods authenticated; terminal methods surface `authHint` |
| `session/set_config_option` | None | Model and mode applied, `set_mode` fallback |
| `session/close` | None | Sent on stop when advertised |
| `fs/*` client methods | Not advertised | Advertised with handlers; path guard, authority check, protected paths |
| `terminal/*` | Not advertised | Still not advertised (needs a Rust process manager behind the terminal governor) |
| Update kinds (thought, plan, usage, failed tool) | Dropped | Emitted as additive events; no UI renders them yet |
| `$/cancel_request` | Ignored | Aborts the handler, replies -32800 |
| `mcpServers` | `[]` | Still `[]`: no ready-made Canopy MCP server definition is available to the transport |
| `session/list`, `delete`, `fork`, elicitation, v2 draft | Absent | Absent, not in scope |

## Moved to ACP

Claude Code, Codex and Cursor now resolve to the ACP runner by default (registry
commands, pinned versions). OpenCode gains an ACP-only runner. Kiro is unchanged.
Gemini, Goose, GitHub Copilot CLI and Qwen Code stay presets (no `AgentCli` row).

- `structuredRunnerFor(id)` returns the ACP runner unless Settings > Agents >
  "Use ACP" is off (`acpAgents[id] === false`). `legacyRunnerFor(id)` always
  returns the vendor runner.
- Brain, compaction, companion and the background-model lookup use
  `legacyRunnerFor`: ACP has no one-shot mode and `brain.rs` puts prompts on argv.
- npx adapters launch through `npx`, not the agent's binary (`adapter` flag).
- If the ACP process fails to spawn and a vendor runner exists, `startStructured`
  falls back to it. A later handshake failure names the setting.
- A session id is resumed only by the transport kind that minted it. If ACP
  fails to spawn during a resume, the vendor runner starts a fresh session under
  a new id (never `--resume <acp id>`) and the transport exposes
  `fallbackSessionId`, which `VibeBuilderSession` stores at `turnEnd`.
- ACP `fs/write_text_file` goes through a new `fs_write_file_confined` command
  on this computer: it resolves symlinks, requires the real path to sit inside
  the session roots, refuses protected files on the real path, opens with
  `O_NOFOLLOW` and re-checks the path against the open handle before writing.
  The TS guard now also protects `opencode.json(c)`, `.opencode/`, `.gitmodules`,
  `.husky/`, `.vscode/tasks.json` and a `.git` file, case-insensitively.
- Docs: `docs/acp.md` rewritten, `docs/agent-parity.md` updated, including the
  note that `kiro-cli --agent canopy --trust-all-tools` is invalid on older
  kiro-cli (the flag belongs to `chat` / `acp`).

## Review follow-up

Fixed: fallback resume state, symlink bypass, protected list (OpenCode, hooks,
case), `fs_write_file` TOCTOU for the ACP path (the plain `fs_write_file` used by
the editor is unchanged).

Not fixed, with reasons:

- Protected-file checks on a remote workspace host: `fsWriteFileConfined` sends
  the plain `fs_write_file` there, since the host has no confined command. Only
  the TS path check applies. A host-side equivalent is a separate change.
- Reads are still bounded only by the session roots and 8 MiB; a CLI agent can
  read the same files natively.
- The post-fallback oneshot branch in `startStructured` is not dead: a legacy
  runner (Codex) can be oneshot, so it stays.
- Silent replacement of a session that fails `resume`/`load`: no visible signal
  yet; needs UI work beyond this change.
- Defaults stay ACP for Claude, Codex and Cursor with spawn-only fallback.
  Live handshakes need the agent binaries and accounts, which are unavailable
  here. The per-agent "Use ACP" toggle is the escape hatch; run a handshake per
  agent before release.

## Not done

- Live handshakes for Claude, Codex, Cursor and OpenCode adapters. No ACP agent
  binaries were available. The verification stamps say "NOT live-tested".
- `terminal` capability, MCP server hand-off, UI for thought/plan/usage.
- Brain and compaction on ACP.
- Kiro registry flag `--agent-engine=v3` (kept plain `acp`, the verified form).
- Fallback covers spawn failures only; an initialize timeout after a successful
  spawn reports an error naming the setting instead of retrying.

## Tests

`npm run typecheck`, `npm run lint` (0 errors, 237 existing warnings),
`npm run test` and `npm run build` pass. New: `src/acp/builtins.test.ts`
(specs, resolver, npx launch, fallback incl. resumed-id case, session origin),
`src/acp/fsGuard.test.ts` (new protected names, case), Rust tests for
`is_agent_protected` and `write_confined` (symlinks, outside roots),
`src/components/AcpAgentToggle.test.tsx`. Existing vendor-runner tests
(`codexRunner`, `projectRunner`) now set `acpAgents` off explicitly.

Rust: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features`
passes the new `fsx` tests; about 20 pty/which/preview tests fail in this
sandbox with and without these changes.

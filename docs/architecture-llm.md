# Canopy Architecture: LLM Context

> Purpose: compact repository context for coding agents. Read this before
> proposing or making a cross-boundary change. The canonical human explanation
> is [Canopy Architecture](./architecture.md). Contribution-specific routing
> is in [Contributor Integration Guide](./contributor-integrations.md). Native
> ownership is expanded in [Core Rust System](./core-rust-system.md).

## System identity

```yaml
project: Canopy
product: local-first desktop IDE for coding agents
desktop_shell: Tauri v2
desktop_ui: React + Vite + TypeScript
native_core: Rust
editor: Monaco
terminal_renderer: xterm.js
native_pty: portable-pty in Rust
remote_ui: React SPA embedded in the Rust binary
hosted_backend_required: false
primary_package_manager_for_docs_and_ci: npm
```

## 60-second model

```text
src/                  trusted desktop WebView and UI orchestration
    | Tauri commands, channels, events
src-tauri/src/        native authority and durable services
    | spawns and observes
agent CLIs / LSPs / git / gh / tunnels

shared/               browser-safe behavior used by desktop and Remote
portal/               restricted Remote client over HTTP/WebSocket
packages/ui/          publishable package; not the current app UI source of truth
```

Canopy is not a normal route-based web application. `App.tsx` keeps open
projects mounted. Each project is a long-lived `ProjectView` containing tabs,
PTYs, editor models, panels, runs, agents, and previews. Rust owns privileged
resources. React owns composition and transient visual state.

## Non-negotiable invariants

Use these as review rules.

### MUST

- Put native process ownership in Rust.
- Register every desktop Tauri command in `src-tauri/src/lib.rs`.
- Use a typed frontend wrapper in `src/ipc.ts` for native calls.
- Scope ordinary filesystem and Git paths through registered workspace roots.
- Bound streams, queues, retained history, and externally supplied payloads.
- Define teardown for every child process, thread, socket, watcher, proxy, and
  native view.
- Treat Rust stores and disk as authoritative; frontend caches are projections.
- Keep `shared/` free of imports from `src/` and Tauri IPC.
- Grant Remote commands explicitly in Rust at the least required scope.
- Preserve raw bytes on the PTY path.
- Add a failing behavior test before implementation, following
  `CONTRIBUTING.md`.

### MUST NOT

- Spawn native processes from JavaScript.
- Assume a desktop Tauri command is reachable from Remote.
- Add a Remote capability only in TypeScript.
- Trust agent identity supplied in an HTTP body; use the credential-derived
  identity from `context.rs`.
- Treat an absent agent signal as `idle`; use shared lifecycle policy.
- Duplicate a cross-shell domain rule or component when it belongs in `shared/`.
- Assume `packages/ui` changes desktop or Remote rendering.
- Unmount terminals or editor surfaces merely to hide them.
- Add unbounded polling or buffering where an event or capped store fits.
- Edit generated `dist/`, staged sidecars, ONNX libraries, or lock-derived
  artifacts as if they were source.

## Source map

| Concern | Primary source of truth | Frequent caller or projection |
|---|---|---|
| Product constraints | `SPEC.md` | `README.md` |
| Desktop bootstrap | `src/main.tsx` | `src/App.tsx` |
| App-wide orchestration | `src/App.tsx` | project views and global overlays |
| Project composition | `src/components/ProjectView/index.tsx` | feature components |
| Project tab types | `src/components/ProjectView/helpers.ts` | tab openers and render switch |
| Desktop native API | `src-tauri/src/lib.rs` command registry | `src/ipc.ts` wrappers |
| PTY lifecycle | `src-tauri/src/pty.rs` | terminal components, Remote transport |
| Filesystem scope | `src-tauri/src/fsx.rs` | file tree, Git, agent tools, Remote |
| Git and GitHub | `src-tauri/src/git.rs` | changes, PR, branch, worktree UI |
| LSP processes | `src-tauri/src/lsp.rs` | Monaco language client bridge |
| Agent process evidence | `src-tauri/src/agents.rs`, `agentid.rs` | `src/agentSessions.ts` |
| Agent lifecycle policy | `shared/agentLife/` | desktop and Remote agent rows |
| Agent context/MCP bridge | `src-tauri/src/context.rs` | `canopy_hook.rs`, `src/agentOps.ts` |
| CLI definitions | `src/projects.ts` | agent launch UI and companion runners |
| Companion policy | `src/companion.ts` | `companionSession.ts`, Rust companion process |
| Browser and preview | `browser.rs`, `preview.rs`, `src/browserHost.ts` | `PreviewView.tsx` |
| Remote authorization | `src-tauri/src/remote/mod.rs` | `shared/remote/`, `portal/src/rpc.ts` |
| Remote UI | `portal/src/App.tsx`, `portal/src/panels/` | shared models and transport |
| Shared domain model | `shared/model.ts` | desktop and Remote |
| Notes | `src-tauri/src/notes.rs` | `src/notes.ts` cache and UI |
| Research | `src-tauri/src/research.rs` | `src/research.ts` cache and UI |
| Search index | `src-tauri/src/spot.rs`, `stores.rs` | `src/spot*.ts` |
| Relay/collaboration | `relay.rs`, `src/collab.ts`, `src/collab-ot.ts` | App-level manager and views |
| Build topology | `package.json`, `tauri.conf.json` | Vite configs and scripts |

## Authority rules

When two files appear to describe the same thing, use these precedence rules.

1. Runtime code is authoritative over comments and old design notes.
2. `src-tauri/src/lib.rs` is authoritative for trusted desktop command
   registration.
3. `src-tauri/src/remote/mod.rs` is authoritative for Remote command exposure.
4. `shared/agentLife/` is authoritative for lifecycle vocabulary and policy.
5. `shared/model.ts` is authoritative for transport-neutral agent rows used by
   both shells.
6. Rust notes/research files are authoritative; TypeScript modules cache them.
7. Live PTY snapshots are authoritative for current liveness; historical
   digests alone do not prove a session is live.
8. `shared/` is the current cross-shell application UI/model layer;
   `packages/ui` is a separate publishable package.
9. Current CI and workflow files are authoritative when release documentation
   is stale.

## Change routing

The detailed bus decision table and contribution recipes live in
`docs/contributor-integrations.md`. Reuse those seams instead of inventing a
parallel store, event, socket, modal, component, or registry.

### UI-only desktop change

Read:

```text
src/components/<feature>
src/components/ProjectView/index.tsx
src/components/ProjectView/helpers.ts
src/<feature-domain>.ts
```

Prefer pure logic in `src/<feature-domain>.ts` with a colocated test. Keep the
large composition components focused on wiring and state ownership.

### Native operation

Touch, in order:

```text
src-tauri/src/<owning-module>.rs
src-tauri/src/lib.rs                 # register command/manage service
src/ipc.ts                          # typed wrapper
src/<caller>.ts(x)
```

Ask before coding:

- Is the path workspace-scoped?
- Can output or memory grow without a cap?
- Is work blocking or async?
- How is it cancelled and reaped?
- Does the frontend need an event instead of polling?
- Does the command expose secrets?
- Should Remote be denied by default? Usually yes.

### New project tab or side panel

Check all affected surfaces:

```text
src/components/ProjectView/helpers.ts  # union and metadata
src/components/ProjectView/index.tsx   # opener, state, render dispatch
src/tabKind.ts                         # classification if relevant
src/restorable.ts / hibernation paths  # persistence if relevant
src/deepLinks.ts                       # direct navigation if relevant
src/spotSources.ts                     # discoverability if relevant
```

Do not add a tab kind in only one switch.

### New coding-agent CLI

```text
src/projects.ts                        # stable ID, launch/resume templates
src/companion.ts                       # only for verified companion transport
src-tauri/src/agents.rs                # hooks and integration healing
src-tauri/src/bin/canopy_hook.rs       # hook/MCP protocol if needed
```

Never guess a resume flag. Unknown CLIs should degrade to terminal fallback or
non-resumable behavior.

### Shared desktop and Remote feature

```text
shared/<pure-model-or-component>
portal/src/<remote-adapter>
shared/<structural-or-behavior-test>.test.ts
```

Inject transport and platform operations. Do not import `src/ipc.ts` into
`shared/`.

### Remote feature

Minimum path:

```text
shared/remote/modules/<feature>.ts
shared/remote/modules/index.ts
src-tauri/src/remote/mod.rs            # explicit grant and dispatch
portal/src/panels/<feature>.tsx
portal/src/panels/index.ts
shared/remote/registry.test.ts
portal/src/remote.test.ts
```

Security question: what is the least scope (`view`, `drive`, `admin`) that can
perform the action? If the command writes files, moves Git refs, or exposes
vault data, the current architecture intentionally excludes it from Remote.

### Durable Canopy-owned data

Use `notes.rs` and `research.rs` as patterns:

```text
~/.canopy/<store>/<project-id>/<item-id>/
src-tauri/src/<store>.rs               # authority, validation, atomic write
src/<store>.ts                         # cache and invalidation projection
src/components/<StoreView>.tsx         # UI
src-tauri/src/spot.rs                  # optional derived indexing
```

Keep list responses bounded. Fetch full bodies and raw sources separately.

## Boundary protocols

### Desktop IPC

```text
React caller
  -> src/ipc.ts
  -> Tauri invoke / Channel
  -> command registered in src-tauri/src/lib.rs
  -> managed Rust service
  -> result or native event
```

### Agent tool request

```text
agent child process
  -> inherited CANOPY_CTX_PORT + CANOPY_CTX_TOKEN
  -> loopback context.rs handler
  -> direct Rust answer OR ticketed WebView request
  -> App resolves project
  -> ProjectView/Preview executes
  -> browser_result resolves waiting request
```

### Remote RPC

```text
portal panel
  -> portal/src/rpc.ts act message
  -> portal.rs authenticated WebSocket
  -> remote/mod.rs grant + scope check
  -> scoped Rust handler
  -> act-ack
```

### Agent state

```text
hook digest + live PTY + process stats + usage + attention
  -> shared lifecycle/evidence policy
  -> fused agent row
  -> desktop or Remote presentation
```

## Concurrency and lifecycle reminders

- PTYs use native reader, writer, and flusher threads plus acknowledgement-based
  backpressure. Preserve the raw-byte and bounded-memory design.
- System Git is synchronous and goes through the existing blocking choke point.
- LSP uses a child process and a reader thread that parses `Content-Length`
  frames.
- MCP stdio children and the companion use async child-process management.
- Relay mixes blocking peer threads and async WebSocket pumps.
- Global native subscriptions should normally exist once and fan out through a
  frontend store or router.
- Project and tab visibility is not equivalent to lifecycle. Hidden surfaces
  stay alive; close and hibernate have explicit semantics.

## Security checklist

For any new boundary or command, verify:

- caller identity comes from a credential or trusted Tauri boundary;
- path input is canonicalized and contained;
- URL schemes are allowlisted where navigation is involved;
- output size, request body size, history, and queue depth are capped;
- secrets do not enter logs, serialized UI models, or agent context;
- Remote remains deny-by-default;
- repeated or retried actions are idempotent or single-flight where required;
- temporary files use atomic finalization;
- shutdown removes credentials, claims, child processes, and pending requests.

## Testing map

```text
TypeScript behavior        colocated *.test.ts / *.test.tsx, Vitest
React component behavior   Testing Library + jsdom
Tauri command mocks        src/test/setup.ts and mockCommands(...)
Rust rules                 #[cfg(test)] in the owning module
Architecture constraints   source-scanning structural tests
Cross-shell Remote parity  shared/remote/registry.test.ts + portal/src/remote.test.ts
Collaboration algorithm    src/collab-ot.test.ts + scripts/collab-fuzz.mjs
```

Required contributor gate:

```sh
npm run typecheck
npm run lint
npm run test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features
```

If `packages/ui` changes, run its workspace build and typecheck separately.

## Common wrong assumptions

| Wrong assumption | Correct model |
|---|---|
| Canopy is a web app with a backend server | It is a Tauri desktop process; Tauri IPC is the main boundary |
| React owns terminal processes | Rust owns PTYs; React owns terminal views and IDs |
| Closing, hiding, and hibernating are equivalent | They have distinct lifecycle and cleanup behavior |
| `ipc.ts` alone defines a native command | Rust registration in `lib.rs` is required |
| Desktop command availability implies Remote availability | Remote has a separate fail-closed Rust grant table |
| Agent-provided cwd or owner identifies the caller | Per-PTY credentials establish agent identity |
| A stored digest means an agent is alive | Live PTY evidence is authoritative for liveness |
| `packages/ui` is the desktop design system source | The applications currently compile `shared/` directly |
| A Remote manifest grants authority | It requests authority; Rust grants it |
| Search index data is canonical | SpotSearch's SQLite data is derived and rebuildable |
| Inactive projects unmount | Open projects stay mounted unless hibernated |

## Minimal reading sets

### Understand the whole system

```text
SPEC.md
src/main.tsx
src/App.tsx
src/components/ProjectView/index.tsx (top-level state and render dispatch)
src/ipc.ts (relevant section only)
src-tauri/src/lib.rs
shared/model.ts
portal/src/App.tsx
```

### Change terminals or agents

```text
src-tauri/src/pty.rs
src-tauri/src/agents.rs
src-tauri/src/context.rs
src-tauri/src/bin/canopy_hook.rs
src/agentSessions.ts
shared/agentLife/
src/components/Term.tsx
```

### Change files, Git, branches, or worktrees

```text
src-tauri/src/fsx.rs
src-tauri/src/git.rs
src-tauri/src/sync.rs
src/workspaces.ts
src/branchSync.ts
relevant ProjectView panels
```

### Change browser or preview behavior

```text
src-tauri/src/browser.rs
src-tauri/src/preview.rs
src/browserHost.ts
src/browserTransport.ts
src/previewAgent.ts
src/components/PreviewView.tsx
```

### Change Remote

```text
src-tauri/src/portal.rs
src-tauri/src/remote/
shared/remote/
portal/src/wire.ts
portal/src/rpc.ts
portal/src/App.tsx
portal/src/panels/
```

## Completion checklist for an LLM-authored change

- [ ] Identified the authoritative owner of the changed state.
- [ ] Reused an existing boundary instead of creating a parallel path.
- [ ] Updated every registry or discriminated union involved.
- [ ] Preserved workspace path scope and caller authentication.
- [ ] Added bounded memory/output and explicit cleanup where applicable.
- [ ] Added a test at the layer where the rule lives.
- [ ] Ran focused tests during development.
- [ ] Ran the repository quality gate before completion.
- [ ] Updated architecture docs only if a boundary, authority rule, or extension
      path actually changed.

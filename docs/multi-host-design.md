# Multi-host workspace: local and remote tabs in one strip

Status: design proposal, no code changed. Counts come from `grep` over `src/` (non-test files) on the
working tree of branch `release/v0.5.12`, which has uncommitted edits from other work, so treat counts as
+/- 5%. Anything not read in code is marked **[I]** (inference). Run the greps again before scoping a phase.

## 1. Goal

Local and remote projects, terminals, files and agents appear together in one tab strip, differentiated by
icon and colour. Hibernated ones are hidden. Launching an agent on another machine never forces a switch.

Today one `Host` is global (`src/host/index.ts`: module variable `host`, `installHost()`, `invoke()`,
`listen()`). Choosing another machine calls `setExecutionMode()` (`src/executionMode.ts`), which ends in
`window.location.reload()`. Agent launch on a non-active target shows "Switch to X, then launch the agent
there" (`src/components/AgentLaunchButton.tsx:289`, `src/components/ProjectView/index.tsx:15582`) and
`requestTargetTransition()` (`src/placement/transitions.ts`) only dispatches `SHOW_WORKSPACE_EVENT`.

## 2. What already helps (read in code)

- `NativeWorkspaceHost` (`src/remoteExecution/NativeWorkspaceHost.ts`, 575 lines) is already shaped like
  one environment connection. Per instance it owns: token renewal (`resolveToken`, `tokenFreshUntil`,
  refresh via `canopy_account_request`), a heartbeat, a 3 s poll that emits `pty:*`/`git:change`/`fs:change`,
  PTY output streams, port forwarding keyed by `connectionKey(endpoint, workspaceId)`, a `HarnessStream`,
  and `dispose()`. Nothing in the class itself is a module singleton. Its second constructor argument is
  `desktop: Host = nativeHost`.
- Command routing already exists inside it: `LOCAL_UI` (about 150 command names: clipboard, notes, vault,
  brain, ledger, android, relay, tunnel, t3_*, account, companion) stays on the desktop; everything else
  goes to the workspace. `isDesktopLocal(cmd)` is exported. `DESKTOP_EVENTS` does the same for events.
- `SocketHost` handshake already returns `environmentId` and rejects a host whose id changes
  (`src/host/socket.ts`, `shared/host/contract.ts`).
- `connectionState.ts` and `requestQueue.ts` are keyed by `endpoint`/`workspaceId`, not global.
- `harnessStores.ts` already keeps mesh/notes/research/attention rows per `(service, workspace)` and uses
  `ws:${workspace}` as a project id. So "rows from many hosts in one list" has precedent.
- `placement/types.ts` already has `Target = local | remote{workspaceId} | t3{machineId}` with `targetKey()`.
- `workspaceProbe.ts` fetches a credential with `canopy_account_request{action:"connect"}`, lists
  `/sessions`, caches 20 s, never heartbeats, never resumes. It is the read-only prototype of a handle.

## 3. Blast radius (measured)

| Singleton surface | Refs | Files | Needs |
|---|---|---|---|
| `isRemoteHost()` | 47 | 13 | decide per call: "is *this* env remote" |
| `activeWorkspace()` | 42 | 23 | replace with registry lookup |
| `isReadOnlyHost()` / `isWorkspaceHost()` | 32 | 14 | per-env capability |
| `installHost()` | 3 | 2 | only `workspace.tsx` and tests |
| `invokeDesktop()` | 32 | 8 | no change (always desktop) |
| files importing `src/host` | 32 | 32 | mostly `ipc.ts`, `Term.tsx`, `ProjectView`, `placement/` |

Hand-edited singleton readers: 47 + 42 + 32 + 3 = **about 124 refs in at most 50 files** (files overlap).

The bigger surface is `src/ipc.ts` (5,535 lines, about 420 `invoke(` calls, 476 exports). Callers use
`ipc.fn(...)` in about 189 files with **about 925 references to functions** (369 distinct; 1,653 including
types). Heaviest: `ProjectView/index.tsx` 134, `App.tsx` 65, `vibeBuilderSession.ts` 44, `Term.tsx` 30,
`PrView.tsx` 22, `SettingsDialog.tsx` 20. None passes an environment, because there is only one host.

Per area (function-call refs from `ipc.*`, grouped by name prefix, so approximate **[I]** for the grouping):

| Area | ~Refs | Per-env by passing a handle? |
|---|---|---|
| Terminals/PTY (`ptyWrite`, `ptyKill`, `ptyOutput`, `onPtyExit`, spawn*) | 133 | Mostly yes, but ids need redesign (below) |
| Git/GitHub (`git*`, `gh*`, `onGitChange`) | 170 | Yes, pure request/response keyed by repo path. `onGitChange` is a poll tick with `root:'/workspace'` |
| File system/editor (`fs*`, `onFsChange`) | 78 | Yes, path is only meaningful with its env |
| Agents/hooks/sessions/tasks | 110 | Yes for calls; `agent:events` is polled per host; hook bridge needs a look **[I]** |
| Preview/ports/browser | 67 | Needs redesign: forwarding and `preview_allow_ports` are desktop-global |
| Projects store/settings | 45 | Needs redesign: `store_load`/`store_save` load and save the whole state blob of one host |
| LSP | 4 | Yes (per project), but `ipc` lsp events untagged |
| Desktop-local (clipboard, vault, notes, brain, relay, android, crash, `jsLog`) | 154 | No change, stay global |
| Other (research, context, mcp, spot, remote portal...) | 164 | Unclassified; audit per phase |

Other couplings found:
- `ptyId: number` appears **882 times in 88 files**. Ids are allocated per host, so local id 3 and
  workspace id 3 collide. A comment in NativeWorkspaceHost already notes a pty id "would alias a VM
  session's".
- `TermSubTab` (`components/ProjectView/helpers.ts`) has no env field. Snapshots persist tabs.
- `ProjectView/index.tsx` is 15,785 lines with 134 `ipc.*` refs; one instance per project (`visible`
  prop keeps hidden ones mounted **[I]**: confirm).
- `initializeWorkspace()` (`workspace.tsx`) installs the host before React mounts. Switching reloads. The
  `installHost` comment says "Switching a live IDE's host is unsafe: its models, paths and process ids
  belong to the original host." Multi-host removes that hazard by never swapping.
- `NativeWorkspaceHost.forward()` calls `preview_allow_ports` with only *this host's* forwarded ports.
  If the native command replaces rather than merges, two live hosts will clobber each other **[I]**
  (`src-tauri/src/preview.rs:493`, not read in full).
- `onAccountChanged` disposes the host on `canopy:account-changed`; with N hosts all N dispose. Fine, but
  the registry must rebuild them.
- `mirror.ts` and `LocalProjectImport.tsx` already read both stores (`store_load` on local and remote).

## 4. Smallest architecture

### 4.1 Ids

`EnvId` = `targetKey(target)` from `placement/types.ts`: `"local"`, `"remote:<workspaceId>"`, `"t3:<machineId>"`.
Reuse it so placement and registry agree. It contains `:`, so unlike T3's `"${env}:${localId}"` use a
different joiner: `scopedKey(env, id) = env + "|" + id` **[I: choice]**. The host handshake `environmentId`
is verified against the registry entry after connect (already enforced for change-detection in
`socket.ts`), not used as the registry key because it is unknown before connecting.

```ts
// src/environments/scoped.ts (new)
type EnvId = string;
interface Scoped<T = string|number> { env: EnvId; id: T }
const scopedKey = (r: Scoped) => `${r.env}|${r.id}`;
```

Absence of `env` on persisted data means "primary" (the host loaded at startup, today's behaviour), so old
snapshots (`TermSubTab`, project records, saved layouts) load unchanged and no migration is needed.

### 4.2 EnvironmentRegistry

```ts
// src/environments/registry.ts (new)
interface Environment {
  id: EnvId; target: Target; name: string;
  host: Host;                       // NativeWorkspaceHost, or nativeHost for "local"
  status: "idle"|"connecting"|"connected"|"reconnecting"|"auth-error"|"stopped"|"hibernated";
  readOnly: boolean;                // from host.readOnly (token scope)
  connect(): Promise<void>;         // resume if stopped: the only call that can wake a VM
  dispose(): void;
}
registry.get(id) / list() / ensureConnected(id) / subscribe(fn)
```

- `local` entry wraps `nativeHost`; each `remote:*` entry is one `NativeWorkspaceHost`, created lazily from
  the same `WorkspaceConnection` that `execution_remote_get`/`canopy_account_request{action:"connect"}`
  produce (see `workspaceProbe.defaultDeps.connect`). Token renewal is the class's existing logic,
  unchanged and per instance. This is the "connection supervisor per environment" in T3 terms.
- The existing global becomes `registry.primary`. `host/index.ts` keeps exporting `invoke`, `listen`,
  `isRemoteHost` etc. bound to primary, so unmigrated code behaves exactly as today. `installHost()`
  becomes `registry.setPrimary()`. This is what makes every phase shippable.
- Status mapping: feed `connectionState.ts` (already per `connectionKey`) into `status`. `hibernated`
  comes from workspace lifecycle (`workspaceLifecycle.ts`), not from probing.

### 4.3 Routing: `ipc` bound to an environment

Do not add an `env` argument to 925 call sites. Two layers **[I: design choice]**:

1. `host/index.ts`: `invokeIn(env, cmd, args)` = if `isDesktopLocal(cmd)` then local host, else
   `registry.get(env).host.invoke`. Reuses `LOCAL_UI`. Add `listenIn(env, event, h)` which wraps the
   handler to stamp `{env}` onto the event, and drops `DESKTOP_EVENTS` from non-local envs so a desktop
   event is not delivered N times.
2. `ipc.ts` becomes a factory: `ipcFor(env): typeof ipc` returning the same function surface bound to
   `env`; `export const ipc = ipcFor(primary)` stays for compatibility. Implementation is mechanical:
   `ipc.ts` calls a module-level `invoke`; swap it for one passed in via closure. In React,
   `useIpc()` reads an `EnvironmentProvider` context placed around each `ProjectView` and tab content.
   Non-React helpers (`vibeBuilderSession.ts`, `agentOps.ts`, `useBranchSwitch.tsx`) receive an `ipc` or
   `env` parameter from their component caller.

Why not ambient routing by path or id? A path like `/workspace/app` is only meaningful inside one env, and
numeric `ptyId` is not unique, so the environment must travel with the tab, not be inferred **[I]**.

### 4.4 How a tab, terminal or file carries its environment

- `Project` and `Component` get `env?: EnvId`. Project ids are per host store, so the unified project
  key is `scopedKey(env, project.id)`.
- `TermSubTab`, file/diff/preview tabs get `env?: EnvId` (inherited from the project). The tab strip shows
  an env badge (icon + colour from `Environment`), as T3's sidebar does.
- PTY state keyed by `ptyId` (maps in `Term.tsx`, `ProjectView`, `placement`, governor, stats) is re-keyed
  by `ptyKey = scopedKey(env, ptyId)`. For `local` or primary-only phases it is the identity function
  until phase P3, so the 882 refs change in a controlled sweep, not at once.

### 4.5 Streams and events

`NativeWorkspaceHost` already delivers events through per-instance `listeners`, so namespacing is a
subscription-side concern: every subscriber calls `listenIn(env, ...)`. Subscribers to unwrap (about 61
`ipc.on*` refs in non-test code): `onPtyExit`, `onPtySpawned`, `onGitChange`, `onFsChange`,
`onAgentEvents`, `onTerminalGovernor`, `onPtyStats`. `onPtyExit`/`onPtySpawned` use a renderer pull loop
(`pty_renderer_events`) for the *native* host and a plain `listen` for socket hosts (`ipc.ts` ~550-600);
only the local env keeps the pull loop. Each env's PTY output stream already carries its own `Stream`
with `generation`/`cursor`, so output needs no id change beyond the scoped key.

### 4.6 The "switch" flow and the Workspace menu

- "Switch" stops being a mode flip. Selecting a workspace = `registry.connect(id)` (resume if needed),
  then open its projects as tabs. No reload. `setExecutionMode()` survives only as "which env is primary
  at startup".
- `WorkspaceMenu.tsx`/`WorkspaceSelector.tsx` change from radio ("use this workspace") to a list of
  environments with connect/stop/hibernate actions and a status dot. `WorkspaceSelector.tsx:315`
  "Use this workspace" becomes "Connect".
- `requestTargetTransition()` becomes: local -> no-op; remote -> `registry.ensureConnected(id)` then launch;
  t3 -> unchanged (opens its machine view; T3 machines are desktop-owned sockets, `t3_socket_*` in
  `LOCAL_UI`, so they are **not** a `Host` and stay out of scope).
- `canLaunchOnActiveTarget` and the `machineTransition` dialog in `ProjectView/index.tsx:15576` are
  deleted for local/remote targets once P3 lands.

### 4.7 Hibernated workspaces

Two different things share the word **[I: confirm with product]**: a *hibernated project* (snapshot,
`hibernatedProjects()` in `App.tsx:2118`, saved via `ipc.remoteSetHibernated`) and a *stopped workspace*
(VM stopped; `hibernateWorkspaceProjects`, `waitForWorkspaceStopped`). Rule: a tab is hidden when its
project is hibernated or its env status is `stopped`/`hibernated`; its env still appears (dimmed) in the
environment list. Opening a hidden env goes through the explicit `connect()` which may bill/resume
(`workspaceProbe` never does this, by design). Do not auto-connect all environments at startup.

### 4.8 Credentials per environment

Reuse `NativeWorkspaceHost`'s resolver as is: it is per instance (`refreshing`, `tokenFreshUntil`,
`credentialAccountKey` check via `canopy_account_cache_key`, one clientId per connection via
`connectionClientId`). Registry rules: (a) one stable clientId per workspace (as `stableClientId` in
`workspaceProbe.ts`) so reconnects match the lease; (b) idle envs set `setProjectIdle(true)` so they do
not renew tokens or heartbeat (existing mechanism, `projectIdle.ts`); (c) on `canopy:account-changed`
the registry disposes and rebuilds all handles; (d) read-only (`scope==='view'`) is per env, so
`isReadOnlyHost()` readers become `env.readOnly`; (e) `workspaceProbe` becomes `registry.peek(id)`, same
code path, so the Session rows (P0) do not change behaviour.

## 5. Phases (each ships, app works after each)

| Phase | Ships | Removes switch dialog? |
|---|---|---|
| **P0** (done) | Read-only unified list: Session rows from `workspaceProbe` in the unified view (`placement/unified.ts`) | No |
| **P1** | `src/environments/`: `EnvId`, `scopedKey`, registry holding only the primary env. Add `env?` to `TermSubTab`, `Project`, file tabs; stamp it at creation; show the env badge/colour in the strip. `host/index.ts` unchanged externally. No behaviour change except the badge | No |
| **P2** | Registry can hold a second `NativeWorkspaceHost`, connected on demand, **terminals only**: `ipcFor(env)` for the PTY + `onPty*` subset (133 refs, `Term.tsx`, the terminal strip), PTY keys scoped. A remote terminal tab opens beside local ones. Projects/files/git still follow primary | Partly: an agent *terminal* can start on another machine; project store, git, file editor do not |

**P2 status (foundation built, unused):** `src/environments/ptyFor.ts` provides `ptyIpcFor(env)` (spawn, write, resize, kill, onExit through that environment's host), the branded `ScopedPtyId` and `ptyKey`/`parsePtyKey`. It refuses a terminal of another environment and any write on a view-only connection. Nothing calls it yet: `Term.tsx`, the terminal strip and every `ipc.pty*` call site still use the primary host. Not built: per-environment renderer registration (`pty_renderer_register`, so `rendererGeneration` is injected and defaults to 0), `ack`/`attach`/`spawn_argv`/`set_title`, the pty:spawned event, scoped PTY keys in the 882 `ptyId` references.
| **P3** | **Agent launch on another machine without a switch.** Needs: P2 plus `git*`/`fs*` per env for the launch path, `launchAgent()` (`placement/launch.ts`) resolving the env, `ensureProjectWorkspace()` (`projectWorkspace.tsx`) per env instead of primary, the target project present in that env's store, and the agent-hooks/`agent_events_poll` subscription for that env. Delete the `machineTransition` dialog for `local`/`remote` | **Yes, first phase** |
| **P4** | Project/file/git/editor per env: `EnvironmentProvider` around `ProjectView`, `useIpc()`, codemod `import * as ipc` -> `useIpc()` in components (about 189 files, mechanical), per-env `store_load`/`store_save` and merged project list | Fully |
| **P5** | Drop the primary concept at the UI level, retire `isRemoteHost`/`activeWorkspace()` call sites; Workspace menu becomes the environment list; startup connects only envs with open tabs | n/a |

P3's real prerequisites, in order: (1) `Environment` exposes `host.invoke` for pty spawn on a non-primary
env; (2) the new tab remembers `env`; (3) snapshot save/restore round-trips `env`; (4) `preview_allow_ports`
merge across envs; (5) agent status/attention events from that env reach the global attention UI
(`harnessStores` is already source-keyed, so this is probably small **[I]**).

## 6. Risks

1. **Wrong-host writes.** A call routed to the primary env by default (unmigrated code) while the tab is
   remote would write a path on the wrong machine. Mitigation: after P2, make unscoped `ipc.*` on a
   non-primary-env tab fail loudly in dev (assert) rather than fall back.
2. **PTY id aliasing** across envs in the 882 `ptyId` refs (maps, `sessionPreview`, governor, stats).
   Any missed spot mixes sessions. Mitigation: branded type so `number` no longer compiles.
3. **Snapshot compatibility.** Old snapshots have no `env`; downgrade after upgrade would drop `env` and
   open a remote tab as local. Version the snapshot field.
4. **Desktop-global singletons**: `preview_allow_ports`, `pty_renderer_register`, the clipboard
   (`LOCAL_UI`), `notify_native`, window zoom, shortcuts. Each needs an owner decision (local wins, or
   merge). `pty_renderer_register` is called from NativeWorkspaceHost (line ~397); whether a second
   instance re-registers and invalidates the first is **not verified [I]**.
5. **Resource cost.** N hosts means N polls (3 s), N heartbeats (30 s), N harness streams. Idle envs must
   be quiet. Mitigation: `setProjectIdle`, connect only envs with open tabs.
6. **Token and billing surprises.** Auto-connecting wakes/bills a stopped workspace (member vs owner
   billing is shown in `WorkspaceHero.tsx`). Never `connect()` without a user action or an explicit
   placement choice.
7. **15.8k-line `ProjectView`** is the long pole; hot-path regressions (typing latency: see
   `terminalLatency.test.ts`) if scoped keys add allocation per keystroke.
8. **Git/worktree identity.** The same repo cloned on two machines has two unrelated working trees;
   "same project" across envs must not merge their state. Treat as two projects with one name **[I]**.

## 7. Tests required

- Unit: `scopedKey` round trip; registry lifecycle (create, connect, dispose, account change); routing
  (`invokeIn` sends `LOCAL_UI` commands to local from any env); event stamping and `DESKTOP_EVENTS`
  de-duplication; snapshot load of old (no `env`) and new data.
- Existing suites to keep green: `NativeWorkspaceHost.test.ts`, `connectionLifecycle.test.ts`,
  `remoteParity.test.ts`, `workspaceProbe.test.ts`, `WorkspaceSelector*.test.tsx`, `placement/*.test.ts`,
  `terminalLatency.test.ts`, `ProjectView/terminalRecovery.integration.test.ts`.
- New integration: two `NativeWorkspaceHost` instances against fake gateways with colliding pty ids;
  token expiry on one env while the other is active; one env drops (reconnecting) while a local tab keeps
  typing; stop one workspace and verify its tabs hide and local ones are untouched; account sign-out.
- Manual: local + one remote + one stopped remote; launch an agent on each; hibernate a project; close
  the app with mixed tabs and reopen; read-only (`view` scope) member workspace beside a driver one.

## 8. Decisions for the owner

1. Is a remote workspace its own set of projects (my assumption: yes, per-env stores, no merging), or may a
   project exist on several machines as one tab group?
2. Primary env at startup: always local, or last used? (Today `savedExecutionMode`.)
3. Auto-connect policy for envs with open tabs on launch: connect all, connect active only, or lazy on
   first tab focus? This sets cost and token traffic.
4. Colour/icon scheme and whether the env badge is always shown or only when more than one env exists.
5. Do hibernated *projects* hide only their tabs, or also the env row when all its projects are hibernated?
6. T3 machines: keep as a separate surface (recommended), or also appear in the strip later?
7. Settings that are per machine versus global (agent CLIs, accounts, themes): per env, or desktop-wide?
8. Accept P3 shipping before P4 (agent runs remotely, but the project editor still follows the primary)?

## 9. Reference: T3 Code (confirmed in source)

`packages/client-runtime/src/environment/scoped.ts` (pingdotgg/t3code) builds `{environmentId, projectId}`
and `{environmentId, threadId}` refs and the key `"${environmentId}:${localId}"`; `src/connection/` holds
per-environment catalog, credential store and driver. Difference for us: T3 threads are server-side
entities, so a scoped ref is enough; Canopy tabs hold renderer-local state tied to numeric PTY ids and
path strings, so the scoping work is larger and touches the tab model, not just a lookup **[I]**.


## P2 follow-up (additive, unused by default)

- **`src/environments/ptyFor.ts`** now covers `spawn_argv`, `ack`, `attach`, `set_title`, the `pty:spawned` event and a scoped session list, all through that environment's host and with scoped ids.
- **Renderer registration, verified in code.** `pty_renderer_register` (`pty.rs`) calls `PtyManager::register_renderer`, which increments the generation and runs `detach_desktop()` on every session, so the previous page's streams stop. The workspace adapter's own `pty_renderer_register` (`NativeWorkspaceHost.ts`) calls the desktop's `pty_renderer_register` first. Therefore a second host that registers would invalidate the first host's streams. Rule for P3: the window registers once (the primary does it); every other host reuses that generation (`adoptRendererGeneration`) and lists its sessions with `pty_renderer_sessions`, which does not register. Not verified by running two live hosts.
- **Tab snapshots** (`hibernation.ts`): terminal tabs carry an optional `machine` ("remote:<id>"; `env` was already the spawn environment array), written only for non-primary machines. Absent means the primary, so older snapshots restore as before; `snapshotEnv` returns null for an unusable value so the restorer skips the tab instead of opening it on the wrong machine. The store version stays 1 (the field is additive). **Downgrade risk:** a build without this field ignores `machine` and would reopen such a tab on its own primary machine, and may attach the remote `attachId` to a local PTY number. Nothing writes `machine` yet (no tab has one), so the risk starts only when P3 creates non-primary terminals.
- **Wrong-host guard** (`src/environments/unscopedGuard.ts`): `assertScopedCall` / `guardUnscoped` warn, or throw when strict, if an unscoped call runs while the active tab belongs to another machine. Not wired.

## P3 status (first slice, built)

Starting an agent on another workspace from a window on this Mac no longer needs the
"switch to it" dialog when that workspace already has a complete copy of the project.

- **Connect on choice only.** `environments/live.ts` (`connectMachine`) opens the
  workspace through the same temporary connection the project mirror uses and registers
  it as a *secondary* environment (never the primary). Nothing calls it except a launch
  the person asked for.
- **Ids.** Instead of changing ~880 `ptyId: number` references, a terminal on another
  machine gets an alias id above 2^40 (`environments/ptyRoute.ts`). `ipc.pty*` resolve an
  alias to (host, real id); every other id takes the unchanged primary path. The alias is
  what tabs, the terminal strip, stats lookups and hook events carry.
- **Terminal I/O.** `Term` takes `machine`; it spawns through `ipc.ptySpawnOnMachine`
  (window renderer generation reused, never re-registered), writes/acks/resizes/kills by
  alias, stays attached while hidden (like a remote-primary terminal), and does not take
  geometry from resize responses. Exits arrive from the machine's own `pty:exit`, renamed to
  the alias. Agent hook events from that machine are renamed (`canopy_pty`) and merged into
  `onAgentEvents`; lines from terminals not started from here are dropped.
- **Project.** `environments/remoteLaunch.ts` reads the machine's `store_load` and finds
  the copy by identity (`counterpartOf`), then the component by label. No complete copy
  means the old flow (dialog, then setup).
- **Fallback.** Any failure (not reachable, view-only, no copy) leaves the old
  `machineTransition` dialog and pending-launch path in place.
- **Snapshots.** A machine tab saves `machine`; it is not woken on restore (it would start
  on the wrong machine), its session stays on the workspace.

Not done: a worktree for the remote agent (it runs in the component folder), account
profiles on the remote, `pty_stats`/CPU stats and session digests/lineage for remote agents,
file links and drops in that terminal (still resolve on this Mac), launching from a window
that is itself on a workspace, restoring machine tabs, and verification against a real
workspace.


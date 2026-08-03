# Contributor Integration Guide

> This is the practical companion to [Canopy Architecture](./architecture.md).
> Use it to find the existing bus, registry, adapter, or component seam before
> adding a new one.

Canopy is extensible, but it is not a general plugin host. Contributions land
through explicit, typed integration points. The central rule is:

> Extend the owner of the behavior. Do not create a second owner, a second
> event path, or a second component for the same concept.

## 1. Choose your contribution path

Each contribution type has a focused, diagrammed playbook under
[`docs/contributions/`](./contributions/README.md).

| Contribution | Playbook | Reuse this seam |
|---|---|---|
| Theme or visual skin | [Theme](./contributions/theme.md) | `SKINS` registry and CSS token contract |
| Reusable UI primitive | [Component](./contributions/component.md) | Shared component plus platform adapters |
| Desktop-only UI | [Desktop feature](./contributions/desktop-feature.md) | Existing feature component and `ProjectView` composition |
| New project tab or panel | [Project surface](./contributions/project-surface.md) | Existing tab union, opener, render dispatch, restore paths |
| Native capability | [Native capability](./contributions/native-capability.md) | Tauri command, managed state, typed `src/ipc.ts` wrapper |
| Agent-visible tool | [Agent tool](./contributions/agent-tool.md) | Token-gated context bridge and MCP descriptors |
| Search result source | [Search source](./contributions/search-source.md) | `registerSpotSource` and optional `registerSpotIcon` |
| Issue tracker | [Tracker](./contributions/tracker.md) | `TrackerProvider` registry plus native fetch command if needed |
| Coding-agent CLI | [Agent CLI](./contributions/agent-cli.md) | Agent CLI registry and verified launch/resume templates |
| Automated micro-task | [Micro-task](./contributions/micro-task.md) | `MicroTaskDef` and `MICRO_TASKS` registry |
| Durable Canopy data | [Durable store](./contributions/durable-store.md) | Rust store, atomic write, store invalidation, frontend cache |
| Canopy Remote feature | [Remote feature](./contributions/remote-feature.md) | Manifest request, Rust grant, generic RPC, panel registry |
| New file renderer | [File viewer](./contributions/file-viewer.md) | `ViewerKind`, extension dispatch, byte-based offline viewer |
| Keyboard shortcut | [Shortcut](./contributions/shortcut.md) | Shared manifest consumed by Rust menus and WebView handlers |
| Team collaboration message | [Relay message](./contributions/relay-message.md) | Existing relay protocol and app-wide `RelayHandle` |

If the contribution does not fit a row, identify its authoritative state owner
before writing code. A feature without one clear owner usually becomes two
implementations that drift.

## 2. The integration pattern

Most complete features use the same six-part shape.

1. **Authority:** one module owns the state or native resource.
2. **Contract:** a typed value, command, manifest, or adapter describes the
   boundary.
3. **Transport:** an existing bus carries requests or invalidations.
4. **Projection:** frontend code converts authoritative state into a view model.
5. **Presentation:** a component renders the projection.
6. **Parity guard:** tests prevent registries, transports, and consumers from
   silently disagreeing.

For example, notes use `notes.rs` as authority, Tauri commands as the mutation
contract, `store:change` as invalidation, `src/notes.ts` as the cache, Notes
components as presentation, and store guard tests as parity enforcement.

Do not begin with a new global event name. Begin with the authority and choose a
bus from the next section.

## 3. Messaging and state buses

Canopy deliberately has several buses because their trust, lifetime, and
delivery guarantees differ. There is no universal application event bus.

### 3.1 Bus selection table

| Need | Use | Do not use |
|---|---|---|
| Parent and child communicate | Typed props and callbacks | A global `window` event |
| Several React consumers observe one in-memory value | `createChannel` in `src/channel.ts` with `useChannel` or `useSyncExternalStore` | Duplicated module-level listener sets |
| Rust tells the trusted WebView about native state | One typed listener wrapper in `src/ipc.ts` over a Tauri event or `Channel` | Browser polling or direct Tauri imports across components |
| Any writer changed a durable Rust store | `change::pulse` -> `store:change` -> `registerStore` | Announcing only from the frontend caller |
| `App` routes a targeted request to the correct project | Existing `canopy:*` `CustomEvent` pattern with project or PTY identity | A second app-wide state store |
| Agent HTTP request needs renderer-owned state | Context bridge ticket -> WebView event -> `browser_result` | Giving the agent direct Tauri access |
| Operation must wait for a not-yet-mounted preview | `dispatchBrowserOp` / `registerBrowserTarget` | Dropping the request or polling for the component |
| Remote browser calls Rust | Existing WebSocket `act` / `act-ack` RPC and Rust grant table | A feature-specific WebSocket connection |
| Two Canopy instances communicate | Encrypted team relay protocol | The local context bridge or Remote RPC |
| Two local agents coordinate | `canopy_claim` and `canopy_message_agent` through `context.rs` | A repository file used as a lock or inbox |

### 3.2 Component-local communication

Use React props, callbacks, and locally owned state when all participants are in
one mounted tree. This is the default. A child should not dispatch a global
event merely to reach a parent that can pass a callback.

Lift state only to its real shared owner. Application-wide state belongs in
`App`; project-wide operational state belongs in its `ProjectView`; durable or
privileged state usually belongs in Rust.

### 3.3 In-memory observable channels

`src/channel.ts` is the standard module-store primitive. It provides a current
value, safe subscription, equality suppression, subscriber lifecycle hooks, and
React bindings.

```ts
const board = createChannel<State>(initialState)

export const state = board.get
export const subscribeState = board.subscribe
export const useState = () => useChannel(board)
```

Keep domain policy in the owning module. `createChannel` is the wire, not a
place to put feature logic. Use `onActive` and `onIdle` when the first subscriber
should start a resource and the last should stop it.

Existing examples include `prWatchStore.ts`, `companionContext.ts`,
`clipboardStore.ts`, and `activeView.ts`.

### 3.4 Tauri commands, channels, and events

Use Tauri IPC only for the trusted desktop WebView and Rust boundary.

| Shape | Use when | Example |
|---|---|---|
| `invoke` request/response | One bounded operation returns one result | Filesystem read, Git status, note mutation |
| Tauri `Channel` | One invocation opens a high-volume or ordered stream | PTY bytes, LSP messages, companion output |
| Tauri event | Rust publishes invalidation or lifecycle state independent of one call | `pty:exit`, `pty:stats`, `store:change`, filesystem changes |

Frontend feature code should call a typed wrapper in `src/ipc.ts`. Add the Rust
command to `tauri::generate_handler!` in `src-tauri/src/lib.rs`. Keep one global
native subscription per service and fan it out through a store or router when
many components need it.

Do not use an event when the caller requires a result. Do not use repeated
`invoke` calls for a continuous stream. Do not put large authoritative payloads
in invalidation events when readers can refetch only the slice they display.

### 3.5 Durable store invalidation

Every durable store can have several writers: the WebView, a Tauri command, an
agent through the context bridge, or Remote. Therefore the write boundary in
Rust announces the change.

```text
Rust store write
  -> change::pulse(Store, scope, id)
  -> debounced store:change Tauri event
  -> src/stores.ts single listener
  -> registerStore(storeId, handler)
  -> owning frontend cache refresh
  -> feature-specific UI event or channel update
```

To add a store to this bus:

1. Add a `change::Store` variant and stable `as_str()` value.
2. Call `change::pulse` only after a successful authoritative mutation.
3. Register a module-scope handler with `registerStore` in the frontend store.
4. Refresh from Rust rather than treating the event as complete state.
5. Extend the store parity guard instead of bypassing it.

The pulse is scoped and debounced with a maximum wait. Do not emit once per
keystroke or create one Tauri listener per component.

### 3.6 App-to-project routing events

Some native or agent requests arrive at `App` before their target project is
mounted or awake. `App` resolves the project, wakes it if necessary, and emits a
targeted `CustomEvent` such as `canopy:agent-action`, `canopy:agent-browser`,
`canopy:deep-link`, or `canopy:attach-terminal`.

Use this pattern only for routing across independently mounted project trees.
The event detail must include enough stable identity for non-target
`ProjectView`s to ignore it. Register and remove the listener in the same
effect. If a direct callback or shared channel can express the relationship,
prefer that instead.

### 3.7 Agent context and UI request bus

Agents are untrusted relative to the Tauri command surface. They receive a
per-PTY context credential and call the loopback bridge in `context.rs`. Rust
can answer native operations directly. Renderer-owned operations use a ticketed
request:

```text
agent MCP tool
  -> bearer-token loopback HTTP
  -> Rust authenticates PTY identity
  -> pending one-shot ticket
  -> App and ProjectView route the request
  -> UI or PreviewView executes it
  -> browser_result(ticket, result)
  -> waiting HTTP response completes
```

To add an agent tool:

1. Add its MCP descriptor and dispatch in `canopy_hook.rs`.
2. Add or reuse a context bridge endpoint and enforce the correct caller type.
3. For UI-owned work, add a typed request shape in `src/ipc.ts` and route it
   through the existing ticket/result path.
4. Add the user-facing tool row in `src/agentTools.ts` so it can be disabled.
5. Decide whether the app-wide companion may call it with the anonymous root
   token or whether it requires a named PTY agent.
6. Add timeout and error completion so a failed UI request cannot hang the
   agent.

Tool names are duplicated intentionally between the sidecar's model-facing
descriptors and `src/agentTools.ts`'s human-facing descriptions. Keep them in
parity.

### 3.8 Preview target queue

`src/previewAgent.ts` is a narrow queued bus between project routing and a
specific `PreviewView`. Use it for browser operations that may arrive before
the target view mounts. Registering a target drains queued operations and
returns an unregister function.

Do not generalize this queue into an application bus. Its per-tab buffering and
mount semantics are specific to preview automation.

### 3.9 Canopy Remote RPC

Remote uses one WebSocket. Panels call the generic promise wrapper in
`portal/src/rpc.ts`; Rust authorizes each action against
`src-tauri/src/remote/mod.rs`.

```text
panel -> act{id, action, args} -> Rust grant/scope check -> handler -> act-ack
```

A new Remote feature should not add a new socket or wire message. Declare its
needs in `shared/remote/modules/`, deliberately grant the command in Rust, and
add a panel. Commands that spawn or mutate non-idempotently should use the
existing replay and single-flight protection.

### 3.10 Team relay and collaboration

The relay is an app-wide encrypted peer transport owned by Rust and projected
to views through `RelayHandle` in `src/types.ts`. Chat, review requests, file
transfer, and collaboration frames are protocol message types, not browser
events.

To add a relay message:

1. Define and validate the wire payload in `relay.rs`.
2. Preserve encryption, frame-size limits, and peer identity checks.
3. Add a typed IPC projection in `src/ipc.ts`.
4. Let `App` update the one app-wide `RelayHandle`.
5. Pass the handle to project views rather than opening another relay
   connection.
6. Add protocol and UI behavior tests.

Collaborative editing has a separate owner-sequenced OT layer in `src/collab.ts`
and `src/collab-ot.ts`. Extend that protocol instead of sending raw editor
mutations through chat.

### 3.11 Local agent coordination

`canopy_claim` and `canopy_message_agent` are coordination tools served by the
context bridge.

- Claims are advisory, app-run-scoped ownership notices over paths. They do not
  block filesystem writes.
- Messages are attributed records delivered to another agent terminal. They are
  not equivalent to user keystrokes without provenance.
- Both derive sender identity from the context credential, not a body field.

Use claims before editing shared files in a multi-agent checkout. Use messages
for handoff or collision warnings. Do not invent lockfiles or hidden inbox files
inside the repository.

## 4. Contributing a theme

Canopy calls complete themes **skins**. A skin supplies the desktop token
palette, Settings preview, xterm palette, and Monaco surface as one definition.
The registry prevents a theme from recoloring the shell while leaving the
terminal or editor behind.

### 4.1 Files to add and edit

For a skin with ID `harbor`:

```text
src/skins/harbor.ts       SkinDef: metadata, preview, xterm, Monaco
src/skins/harbor.css      complete CSS token block
src/skins/skins.css       @import "./harbor.css"
src/skins/registry.ts     import and add to SKINS in picker order
```

`src/skins/skins.test.ts` verifies that every registered skin has every part.
Do not add a separate switch in Settings, terminal themes, or Monaco setup;
those consumers already read `SKINS`.

### 4.2 TypeScript definition

Copy an existing skin such as `orchard.ts`, then provide:

- a stable lowercase `id` that is also persisted and used as `data-theme`;
- a title-cased picker `label`;
- a short lowercase `note` without a trailing period;
- four preview colors;
- all xterm foreground, background, cursor, selection, and ANSI colors;
- a Monaco base and at least `editor.background`.

Never rename a shipped skin ID. Existing settings persist it. Removing a skin
is safe because unknown IDs fall back to Gotham, but renaming unexpectedly
changes a user's selection.

### 4.3 CSS token block

The selector must be:

```css
:root[data-theme="harbor"] {
  /* complete token contract */
}
```

Declare every palette token required by `skins.test.ts`, plus `--accent-soft`,
`--ring`, and `color-scheme`. A light skin must also provide its shadow tokens.
Use semantic variables in component CSS; do not add a component-specific color
override merely to make one skin pass.

Remote receives resolved theme tokens from the desktop and applies them through
`shared/model.ts`. A well-tokenized shared component should inherit the skin
without Remote-specific theme code.

### 4.4 Theme verification

Run:

```sh
npm run test -- src/skins/skins.test.ts
npm run typecheck
```

Then inspect the Settings preview, app chrome, Monaco, terminal ANSI colors,
dialogs, focus rings, disabled controls, and both light/dark `color-scheme`
behavior where applicable.

## 5. Creating or contributing a component

### 5.1 Choose the correct home

| Component scope | Location | Rule |
|---|---|---|
| Used by desktop and Remote | `shared/` or `shared/ui/` | Browser-safe; inject platform operations |
| Desktop feature only | `src/components/` | May call typed domain modules; avoid direct native imports |
| Remote-only navigation or presentation | `portal/src/` | Use Remote RPC and shared models |
| Publishable external primitive | `packages/ui/` | Independent package API; not automatically used by the apps |

Do not put a component in `packages/ui` expecting the desktop to start using it.
Today the live applications import `shared/` directly.

### 5.2 Reuse existing primitives

Before creating another implementation, check:

| Need | Existing primitive |
|---|---|
| Button | `shared/ui/Button.tsx` |
| Dialog, confirmation, prompt | `shared/Dialog.tsx` |
| Context menu | `shared/ContextMenu.tsx` |
| Large list | `shared/WindowedList.tsx` |
| File tree | `shared/FileTree.tsx` with `FileTreeFs` adapter |
| Escape layering | `shared/useEscape.ts` |
| Icons | `shared/icons.tsx` and `src/components/icons.tsx` |
| Agent cards and marks | `shared/components.tsx`, `shared/agentGlyphs.tsx` |
| Design tokens | `shared/tokens.css` and app skin variables |

The shared `Button` uses semantic variants: `default`, `accent`, `danger`, and
`ghost`. Add a variant only when it represents a reusable job, not a one-off
color. Icon-only buttons require an accessible name.

The shared `Dialog` already handles focus trapping, Escape ownership, Enter,
focus restoration, scroll locking, and exit animation. Do not recreate those
details in a feature modal.

### 5.3 Adapter pattern

A cross-shell component must describe the operations it needs without importing
a platform.

```ts
export interface ThingAdapter {
  read(id: string): Promise<Thing>
  save?(thing: Thing): Promise<void>
}
```

The desktop adapter can call `src/ipc.ts`. The Remote adapter can call
`portal/src/rpc.ts`. Optional mutation methods allow Remote to remain read-only
without fake implementations. `shared/FileTree.tsx` and its `FileTreeFs`
interface are the reference implementation.

### 5.4 Styling and behavior

- Use semantic CSS variables instead of literal colors.
- Put component CSS beside the shared component when both shells use it.
- Preserve the mounted-surface lifecycle for terminals, editors, previews, and
  stateful panels.
- Prefer controlled props and callbacks over global events.
- Keep expensive parsing, sanitization, and model creation out of render.
- Use established overlay, escape, and native-browser occlusion infrastructure.
- Add accessibility labels, keyboard behavior, focus handling, and a behavior
  test.

### 5.5 Structural guards

Some tests intentionally scan source code. For example,
`shared/sharedComponents.test.ts` ensures `shared/` does not import the desktop,
the file tree is not duplicated, and Remote mutations remain gated. If such a
test fails, fix the architecture mismatch rather than adding an exemption.

## 6. Contributing a feature

### 6.1 Classify it first

| Feature shape | Integration path |
|---|---|
| Pure calculation or policy | Framework-free TypeScript or Rust module plus unit tests |
| Desktop presentation over existing data | Feature component plus existing domain store |
| New project surface | Tab/panel union, opener, render dispatch, restore/deep-link/search integration |
| Native or privileged operation | Rust owner, command registration, typed IPC wrapper, cleanup |
| Cross-shell behavior | Shared model/component plus desktop and Remote adapters |
| Remote exposure | Manifest request, explicit Rust grant, generic RPC, panel |
| Agent automation | Context bridge/MCP tool or `MicroTaskDef`, depending on who initiates it |

### 6.2 Desktop feature checklist

1. Identify whether state is app-wide, project-wide, component-local, or
   durable.
2. Reuse an existing store, channel, or feature domain module.
3. Put pure behavior outside `App.tsx` and `ProjectView/index.tsx`.
4. Add a tab or panel only when the feature needs navigation or long-lived
   mounted state.
5. Use shared components and tokenized CSS.
6. Add SpotSearch, deep-link, shortcut, or restore integration only when the
   feature genuinely needs to be discoverable through that surface.
7. Add behavior tests at the owner layer.

### 6.3 Native feature checklist

1. Put ownership in one Rust module or managed service.
2. Reuse `WorkspaceManager` for path scope.
3. Reuse the existing blocking boundary for synchronous system commands.
4. Bound output, queues, bodies, and retained history.
5. Register the Tauri command in `lib.rs`.
6. Add a typed wrapper in `src/ipc.ts`.
7. Emit lifecycle or invalidation events from the authoritative write/resource
   boundary.
8. Add shutdown handling before considering the feature complete.
9. Keep Remote denied unless a separate least-privilege design is approved.

### 6.4 New tab or side panel

Tab contributions commonly touch more than the render switch:

```text
src/components/ProjectView/helpers.ts  tab or side-panel type
src/components/ProjectView/index.tsx   open, select, render, close
src/tabKind.ts                         classification
src/deepLinks.ts                       direct navigation, if needed
src/spotSources.ts                     discovery, if needed
hibernation/restoration code           persistence, if needed
```

Search for every switch over the relevant discriminated union before adding a
new member. Preserve stable IDs and keep stateful panes mounted while hidden.

## 7. Contributing through a registry

Registries are the preferred extension point when one exists.

### 7.1 SpotSearch source

Call `registerSpotSource` with a stable ID, section, timing, and row producer.
Use `instant` only for synchronous in-memory work. Use `deferred` for I/O; it is
debounced and isolated so one failed source does not empty the palette.

If the source introduces a new row kind, call `registerSpotIcon`. Both
registrations return cleanup functions. Test ordering, minimum query behavior,
failure isolation, and cleanup.

### 7.2 Tracker provider

Add a `TrackerProvider` to `TRACKERS` in `src/trackers.ts`. The panel already
iterates providers. Define whether it is repository-scoped or global, how
availability is detected, how tickets are fetched, and whether local secret
configuration is required.

If native network or CLI work is needed, add a scoped Rust command and typed IPC
wrapper. Map provider-specific states into the existing unified status model.

### 7.3 Agent CLI

Add a CLI definition to the registry in `src/projects.ts`. Use a stable ID and
verified executable, prompt, and resume templates. Unknown resume behavior must
remain unsupported rather than guessed.

If the CLI supports hooks or MCP, extend installation and healing in
`agents.rs`. If it supports an app-wide companion transport, add that only after
the structured protocol is verified; otherwise use the existing terminal
fallback.

### 7.4 Micro-task

Add a `MicroTaskDef` in `src/microTasks.ts` and register it in `MICRO_TASKS`.
Define its source surface, payload, working directory, environment, brief,
effect, and progress protocol. Do not add generic tasks with invented progress
steps; a task's rail must reflect work the task can actually report.

### 7.5 File viewer

Extend `ViewerKind`, `viewerKindFor`, source-view behavior, and the render
dispatch in `src/components/viewers.tsx` and its caller. Viewers receive bytes
read by Rust and should work offline. Lazy-load heavy parsers, sanitize rendered
HTML, revoke object URLs, and define size/binary refusal behavior before reading
unbounded files.

### 7.6 Shortcut

Add the command once to `shared/shortcuts.json`. The manifest is consumed by
WebView handlers and Rust native menus. Define platform chords, surfaces, and
terminal collision policy there instead of hardcoding key checks in a
component. Keep shared TypeScript and Rust parity tests green.

## 8. Contribution profiles

Contributors do not need to understand the entire application. Pick the profile
closest to the change and read its minimum set.

| Profile | Minimum reading | Typical contribution |
|---|---|---|
| Visual designer | `src/skins/types.ts`, existing skin pair, `skins.test.ts`, shared tokens | New skin or token-safe polish |
| React component contributor | Shared primitives, nearest component, owning domain module, colocated tests | New view or reusable component |
| Rust/native contributor | `lib.rs`, owning module, `fsx.rs` scope pattern, `blocking.rs`, exit cleanup | Native capability or platform support |
| Agent integration contributor | `projects.ts`, `agents.rs`, `canopy_hook.rs`, `context.rs`, `agentTools.ts` | New CLI, hook, model metadata, or MCP tool |
| Remote contributor | `portal.rs`, `remote/`, `shared/remote/`, portal RPC and panel registry | New read/drive surface |
| Knowledge workflow contributor | notes/research Rust and TypeScript stores, `change.rs`, `stores.ts`, Spot index | New durable workflow or indexing |
| Collaboration contributor | `relay.rs`, `wsbridge.rs`, `collab.ts`, `collab-ot.ts` | Peer message, transfer, or live editing |
| Search contributor | `spotSources.ts`, `SpotSearch.tsx`, `spotIcons.tsx`, Spot index if persistent | New discoverable source |
| Documentation contributor | `README.md`, `CONTRIBUTING.md`, architecture pages, nearest code comments | Guides, diagrams, examples, corrections |

## 9. Avoiding parallel infrastructure

Before opening a pull request, answer these questions in its description:

1. Which module is the authority for the new state or resource?
2. Which existing registry or bus carries it?
3. Why are props, `createChannel`, Tauri IPC, store invalidation, Remote RPC,
   or relay the correct transport?
4. Which duplicate implementation did the change avoid?
5. What bounds memory, payload size, retries, and lifetime?
6. What cleanup runs when the view, project, connection, or app closes?
7. Which parity or behavior test proves every side is wired?

Common warning signs:

- a second WebSocket for one Remote panel;
- direct `@tauri-apps/api` imports scattered through feature components;
- a new module with its own hand-rolled subscriber set;
- a frontend mutation that announces itself instead of the Rust store write;
- a desktop and Remote copy of the same component;
- a new modal that implements its own focus trap;
- a theme that changes CSS but not xterm or Monaco;
- a command added to Remote because it already exists for desktop;
- a hidden JSON file used as a local agent message bus;
- a new switch statement beside an existing registry.

## 10. Verification by contribution type

Run focused tests while iterating, then the repository gate from
`CONTRIBUTING.md`.

| Change | Focused verification |
|---|---|
| Skin | `npm run test -- src/skins/skins.test.ts` |
| Shared component | Component test plus `shared/sharedComponents.test.ts` |
| SpotSearch source | `src/spotSources.test.ts` and `src/components/SpotSearch.test.tsx` |
| Durable store | Rust store tests, frontend cache tests, store parity guard |
| Remote feature | `shared/remote/registry.test.ts` and `portal/src/remote.test.ts` |
| Shortcut | TypeScript shortcut tests and Rust shortcut tests |
| Agent tool | Sidecar/context Rust tests and frontend tool parity/route tests |
| Collaboration | OT unit/fuzz tests and relay protocol tests |

Repository gate:

```sh
npm run typecheck
npm run lint
npm run test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features
```

# Linux workspace command parity

In a Linux (cloud) workspace, the IDE's `invoke(command, args)` calls go through
`src/remoteExecution/NativeWorkspaceHost.ts`. Each command ends up in exactly one
of these places:

| Where | What decides it | Examples |
|---|---|---|
| The workspace host (`packages/remote-host/native.mjs` and one module per family) | `NATIVE_COMMANDS` in `packages/remote-host/native-commands.mjs` | git, gh, task and workflow stores, turns, LSP, MCP |
| The workspace's canopy-service (research, claims, mesh) | `HARNESS_COMMANDS` in `src/remoteExecution/harnessCommands.ts` | `research_*`, `context_claims` |
| The adapter itself (terminals, browser streams, uploads, note attachments) | `WORKSPACE_ADAPTER_COMMANDS` | `pty_spawn`, `chrome_stream_open` |
| The desktop (the computer showing the IDE) | `LOCAL_UI` in `NativeWorkspaceHost.ts` | vault, Android devices, LAN relay |
| Refused with a message, without a network call | `UNSUPPORTED_REMOTE` in `src/remoteExecution/remoteSupport.ts` | `fs_reveal` |

`src/remoteExecution/remoteParity.test.ts` scans `src/` for `invoke("…")` calls and fails
when a command has none of these homes. It also checks the two small allowlists kept in
the test: desktop-direct Tauri calls, and callers that branch on `isRemoteHost()`.
`packages/remote-host/native-commands.test.mjs` keeps `NATIVE_COMMANDS` exactly equal to
what `native.mjs` dispatches.

## Version skew

The desktop and the workspace host are updated separately, so a newer app can talk to a
host runtime from weeks earlier.

- **Command list.** The desktop imports `native-commands.mjs` too. If the host answers
  "does not support X yet" for a command a current host serves, the adapter throws
  *"This workspace is running an older Canopy host. Restart or update the workspace to
  use …"*. It also fires `canopy:workspace-host-outdated` once per connection, which App
  shows as a single deduplicated notice.
- **`host_capabilities`.** Returns `{protocol, commands, prefixes}`. Ten seconds after
  boot the adapter compares `protocol` with `HOST_PROTOCOL`. A host that doesn't know the
  command at all, or reports a lower protocol, gets the same notice before anyone hits a
  missing command.
- **Older gateway or service.** The research, claims and mesh commands go to canopy-service,
  not the host. An older gateway or service refuses a query or action it doesn't know
  (`Invalid harness action`, `no query … on store …`, `unknown action kind …`). The
  adapter turns those refusals into the same "older Canopy host" notice.
- **View-only members.** They can read research and claims. A write is refused in the
  adapter, so the gateway's 403 never shows the workspace as signed out.
- **Bump `HOST_PROTOCOL`** in `native-commands.mjs` whenever commands are added.
- **No more endless spinner.** The agent changes panel (`AgentWorkspaceView`) shows an
  error, or "no diff for a detached/base checkout", instead of "Reading this agent's
  changes…" forever.

## Transport additions

- **Channels.** A Tauri `Channel` argument (LSP output, structured runner lines) is sent
  to the host as `{__canopyChannel: id}`. The host queues messages for it in
  `channels.mjs`, and the adapter drains them with `channel_poll`, a short long-poll.
  A closed `lsp_start` channel becomes the desktop's `lsp:exit` event. Channels nobody
  drains are closed after 8 MiB or 5 idle minutes.
- **Timeouts.** `nativeTimeoutMs()` in `native-commands.mjs` sets both the gateway and
  the client timeouts:
  - network Git and worktree work: 330 s
  - `gh_*`: 135 s
  - MCP calls: 300 s, and connecting: 180 s
  - everything else: 15 s
- **Store changes.** Host stores (tasks, workflows, provenance, sessions) push changes to
  `store_changes`, the same way `change::pulse` does on the desktop.
- **Task-attempt terminals.** `pty_spawn` with `runId`/`attemptId` binds the attempt
  like `pty.rs`: `task_spawn_binding`, then `task_mark_spawned` or
  `task_mark_launch_failed`.

## Persistence

Every host store lives under `/home/agent/.canopy/` (persistent workspace storage, never
`/scratch`). Writes are atomic: a temp file, then a rename. Files are 0600 and
directories 0700.

| Store | Location |
|---|---|
| Tasks | `tasks/runs/<runId>/` (envelope JSON, plus JSONL for transcript, events and artifacts) |
| Workflows | `workflows/<runId>.json` |
| Provenance | `provenance.jsonl` (the desktop's format) |
| Turns | git refs under `refs/canopy/…`, plus `turns/<session>.native.jsonl` |
| Spot index | `spot/` |
| Per-CLI memory maximums | `terminal-governor-defaults.json` |

Research, claims and mesh history are owned by canopy-service, outside the container, at
`/var/lib/canopy-service/ws/<id>/`. The service also serves the workspace's agents.

## Image requirements

The workspace image (`packages/remote-host/Dockerfile`) already has `gh` and `git`.

- **gh sign-in.** `gh` is signed in by `profile_import_git`. Without that, the `gh_*`
  commands report gh as unauthenticated, exactly as on a desktop without `gh auth`.
- **git version.**
  - `git_sync_probe`'s `merge-tree --write-tree` needs git 2.38 or later; older versions
    report `state: unknown`.
  - `git_work_audit`'s ahead/behind needs 2.41 or later; older versions report
    `counts_degraded`.
- **Commit identity.** `git_sync_apply` and `git_checkout_carry` create commits, so they
  need a global git identity, which `profile_import_git` sets.
- **Files to ship.** Every host module must be listed in the Dockerfile `COPY` line and,
  when the gateway imports it, in `install.sh`. `install.test.mjs` enforces both.

## Known differences from the desktop

**Brought onto the desktop's footing**
- **Research.** `research_update` with `body` replaces the write-up through the service's
  user-only `replace` action (no agent op reaches it). `research_import` sends a file larger
  than one harness action (the gateway caps a body at 256 KiB) in `import_chunk` pieces the
  service joins, up to the store's own 512 KB limit. `research_dir` answers a real
  directory in the VM, `~/.canopy/research/<id>` (host `research_entry_dir`), so a run's
  prose gate and progress file work; what the run writes there is copied into the entry as
  sources the next time the IDE reads it (`research_entry_files`).
- **Per-terminal memory budgets.** `terminal-governor.mjs` applies `governor.rs`'s policy to
  each terminal's process-tree RSS, sampled every 2 s: the same allowances, warn/ask/clear
  thresholds and dwell, 512 MiB / 1 GiB grants, stop, remembered per-CLI defaults and
  maximums, and incidents. The adapter drains `terminal_governor_events` into
  `terminal:governor`. It reports `monitor_only`: the container has no writable cgroup
  subtree for a per-terminal `memory.high`, so the workspace's own limit stays the only
  hard cap.
- **`structured_runner_spawn`.** The gateway mints a context-bridge credential per attempt
  (`runner-<attempt>`), the host puts it in the runner's environment like an agent
  terminal's, a failed spawn or `structured_runner_kill` revokes it, and the service keeps
  it while `structured_runner_live` lists the attempt.
- **`cleanup:progress`.** The adapter names a channel for `cleanup_scan`; the host sends
  one message per checkout and the adapter emits them as `cleanup:progress`. In a workspace
  cleanup still defaults to deleting rather than trashing, because the VM's trash is never
  emptied.
- **`pr_watch` provenance rows.** The host watches the projects named by `pr_watch_set`
  (`pr-observer.mjs`, every 3 minutes while the IDE is focused, 15 otherwise, and on
  `pr_watch_now`): `provenance_observe` lists the repository's PRs with `gh`, records a
  `pr_watch` edge for each new one a session's branch produced, and reports when each
  opened and merged, which Outcomes uses for merges and time in review.
- **Shared-account sessions.** Their HOME is a per-session copy of the account; its
  `.canopy` event bus, digests, edit journals, Rules policy, research bindings and
  workflow runs are linked to the workspace's own (`account-homes.mjs`), so turns,
  provenance, awareness and gates see them. Spot search also reads their transcripts.
- **Proof receipts.** A check runs as a host job (`receipt_check_start`, long-polled with
  `receipt_check_status`), so it gets the desktop's 10/5-minute limits instead of the
  gateway's request timeout; an older host falls back to `receipt_run_check`. The turn's
  start and end snapshots come from the host's `turn_list`.
- **Agent awareness.** Runs in a workspace: digests, journals, churn (`git_churn`) and
  checkouts from the host, `context_hotspot_claim` and notes (`context_mesh_job_update`,
  `refKind: "awareness"`) through the service. The host tells the service each agent's
  origin remote, checkout and recently written files (from its hook events), and the
  roster carries them, so awareness on any machine can tell an agent in another cloud
  workspace on the same repository over the mesh.
- **Rules on connect.** Each connect and reconnect writes every open project's policy with
  `gates_policy_write`. The host installs Canopy's hooks for every CLI the image ships, as
  the desktop's installers in `agents.rs` do: Claude Code and Codex (`agent-integrations.mjs`,
  PreToolUse matchers included) and Cursor, Grok, OpenCode, oh-my-pi, Amp and Antigravity
  (`agent-gates.mjs`; the OpenCode, oh-my-pi and Amp plugin sources are generated from
  `agents.rs` into `agent-templates.mjs` by `gen-agent-templates.mjs`, and a test fails when
  they drift). When `agent_integration_health` reports an installed CLI's hooks missing or
  out of date, the workspace offers **Update agent hooks** (`setup_agent_hooks`). The same
  setup registers the `canopy-hook --mcp` server in each CLI's own registry (Cursor,
  Antigravity, oh-my-pi and OpenCode JSON, Amp's `amp.mcpServers`, Grok's TOML), as
  `setup_*_mcp` in `agents.rs` does.
- **Team memory.** The ledger stays on the desktop. Each connect, and each change to a
  memory, sends the approved, unexpired entries to the workspace's canopy-service
  (`memory_sync`), which answers `canopy_memory` from that copy with the desktop's rules
  (`canopy-core` `memory`). `canopy_memory_propose` validates like the desktop and queues
  the proposal; the IDE pulls the queue (`workspace_memory_proposals`, every minute and on
  connect), files each as `proposed` in the ledger and acknowledges it (`memory_ack`).
- **Android with the project in the VM.** `android_run` with a `/workspace` APK reads it
  from the VM in slices, stages it here (`android_stage_file`) and runs it on this
  computer's device. `android_describe` on a `/workspace` project answers from its Gradle
  files (modules, application ids, APKs already built), because the SDK that evaluates the
  build is on this computer and the VM image has none; build in the workspace first.
  Agents running in the VM still can't drive devices (`canopy_device_*` stay laptop-only).

**Narrower than the desktop on purpose**
- **Paths stay in `/workspace`.** `scoped()` keeps every path there (and in
  `/home/agent` for global instruction files). Worktree paths outside `/workspace` are
  refused.
- **Process limits.** `kill_process` refuses pid ≤ 1, the host and its parent, and
  processes owned by another uid.
- **Native rewind.** `turn_restore` only runs `claude`.
- **GraphQL strings** go as raw `-f` fields, so a reply starting with `@` can never read
  a file.
- **Drive-only commands.** Fetching probes (`git_sync_probe`, `git_pr_merge_probe`) and
  transcript search (`spot_search`, `spot_index_stats`) need drive access. View-only
  members can't use them.

## Classification of the 236 commands the static scan reported

Categories:
- **(a)** Already worked remotely through another path.
- **(b)** Runs on the desktop (`LOCAL_UI`).
- **(c)** Implemented for the workspace: host module, service, or adapter.
- **(d)** Deliberately not offered in a workspace; the UI hides it.
- **test** Test-only.

Counts: **(a) 11 · (b) 62 · (c) 148 · (d) 13 · test 2**.

| Command | Cat. | Where / why |
|---|---|---|
| `agent_edits` | c | Host: `agent-workspace.mjs` (mirrors git.rs) |
| `agent_workspace` | c | Host: `agent-workspace.mjs` (mirrors git.rs) |
| `android_avds` | b | LOCAL_UI: Devices and emulators are attached to the person's computer; the VM image has no Android SDK. |
| `android_describe` | b | LOCAL_UI; a `/workspace` project is described from its Gradle files (androidBridge.ts). |
| `android_devices` | b | LOCAL_UI: Devices and emulators are attached to the person's computer; the VM image has no Android SDK. |
| `android_emulator_start` | b | LOCAL_UI: Devices and emulators are attached to the person's computer; the VM image has no Android SDK. |
| `android_emulator_stop` | b | LOCAL_UI: Devices and emulators are attached to the person's computer; the VM image has no Android SDK. |
| `android_foreground` | b | LOCAL_UI: Devices and emulators are attached to the person's computer; the VM image has no Android SDK. |
| `android_key` | b | LOCAL_UI: Devices and emulators are attached to the person's computer; the VM image has no Android SDK. |
| `android_layout` | b | LOCAL_UI: Devices and emulators are attached to the person's computer; the VM image has no Android SDK. |
| `android_logcat` | b | LOCAL_UI: Devices and emulators are attached to the person's computer; the VM image has no Android SDK. |
| `android_run` | b | LOCAL_UI; a `/workspace` APK is staged on this computer first (androidBridge.ts). |
| `android_screencap` | b | LOCAL_UI: Devices and emulators are attached to the person's computer; the VM image has no Android SDK. |
| `android_sdk_status` | b | LOCAL_UI: Devices and emulators are attached to the person's computer; the VM image has no Android SDK. |
| `android_swipe` | b | LOCAL_UI: Devices and emulators are attached to the person's computer; the VM image has no Android SDK. |
| `android_tap` | b | LOCAL_UI: Devices and emulators are attached to the person's computer; the VM image has no Android SDK. |
| `android_text` | b | LOCAL_UI: Devices and emulators are attached to the person's computer; the VM image has no Android SDK. |
| `android_ui_dump` | b | LOCAL_UI: Devices and emulators are attached to the person's computer; the VM image has no Android SDK. |
| `app_stats` | a | ipc.ts asks `workspace_metrics` when remote. |
| `browser_clear_data` | d | Native child webview of the desktop window; a workspace replaces it with the streamed VM browser and browser_supported answers false, so the UI never offers it (refused without a round trip if sent). |
| `browser_close` | d | Native child webview of the desktop window; a workspace replaces it with the streamed VM browser and browser_supported answers false, so the UI never offers it (refused without a round trip if sent). |
| `browser_close_metrics` | b | LOCAL_UI: Desktop app diagnostics (no workspace meaning). |
| `browser_command` | d | Native child webview of the desktop window; a workspace replaces it with the streamed VM browser and browser_supported answers false, so the UI never offers it (refused without a round trip if sent). |
| `browser_frame` | d | Native child webview of the desktop window; a workspace replaces it with the streamed VM browser and browser_supported answers false, so the UI never offers it (refused without a round trip if sent). |
| `browser_here` | d | Native child webview of the desktop window; a workspace replaces it with the streamed VM browser and browser_supported answers false, so the UI never offers it (refused without a round trip if sent). |
| `browser_navigate` | d | Native child webview of the desktop window; a workspace replaces it with the streamed VM browser and browser_supported answers false, so the UI never offers it (refused without a round trip if sent). |
| `browser_open` | d | Native child webview of the desktop window; a workspace replaces it with the streamed VM browser and browser_supported answers false, so the UI never offers it (refused without a round trip if sent). |
| `browser_painted` | d | Native child webview of the desktop window; a workspace replaces it with the streamed VM browser and browser_supported answers false, so the UI never offers it (refused without a round trip if sent). |
| `browser_pressure_reload_metrics` | b | LOCAL_UI: Desktop app diagnostics (no workspace meaning). |
| `browser_run_op` | d | Native child webview of the desktop window; a workspace replaces it with the streamed VM browser and browser_supported answers false, so the UI never offers it (refused without a round trip if sent). |
| `browser_set_bounds` | d | Native child webview of the desktop window; a workspace replaces it with the streamed VM browser and browser_supported answers false, so the UI never offers it (refused without a round trip if sent). |
| `browser_set_visible` | d | Native child webview of the desktop window; a workspace replaces it with the streamed VM browser and browser_supported answers false, so the UI never offers it (refused without a round trip if sent). |
| `browser_snapshot` | d | Native child webview of the desktop window; a workspace replaces it with the streamed VM browser and browser_supported answers false, so the UI never offers it (refused without a round trip if sent). |
| `browser_supported` | a | The adapter answers : workspace previews use the Chrome stream. |
| `build_operation_acquire` | c | Host: `workspace-misc.mjs` (mirrors fsx.rs / agents.rs / profiles.rs / prwatch.rs / governor.rs) |
| `build_operation_release` | c | Host: `workspace-misc.mjs` (mirrors fsx.rs / agents.rs / profiles.rs / prwatch.rs / governor.rs) |
| `cleanup_disk` | c | Host: `workspace-cleanup.mjs` (mirrors cleanup.rs) |
| `cleanup_run` | c | Host: `workspace-cleanup.mjs` (mirrors cleanup.rs) |
| `cleanup_scan` | c | Host: `workspace-cleanup.mjs` (mirrors cleanup.rs) |
| `cli_install_shim` | b | LOCAL_UI: Installs the desktop's `canopy` launcher. |
| `context_claim_history` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `context_claim_history_for_path` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `context_claims` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `context_mesh_job_update` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `context_mesh_sever` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `context_mesh_severed` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `context_messages` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `context_release_claim` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `execution_remote_account_candidates` | a | Invoked through `@tauri-apps/api/core` directly: desktop account / workspace switcher plumbing. |
| `execution_remote_activate` | a | Invoked through `@tauri-apps/api/core` directly: desktop account / workspace switcher plumbing. |
| `execution_remote_forget` | a | Invoked through `@tauri-apps/api/core` directly: desktop account / workspace switcher plumbing. |
| `execution_remote_import_accounts` | a | Invoked through `@tauri-apps/api/core` directly: desktop account / workspace switcher plumbing. |
| `execution_remote_list` | a | Invoked through `@tauri-apps/api/core` directly: desktop account / workspace switcher plumbing. |
| `execution_remote_login_prepare` | a | Invoked through `@tauri-apps/api/core` directly: desktop account / workspace switcher plumbing. |
| `fs_repo_path` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `fs_reveal` | d | A VM path cannot be shown in this computer's file manager. Menu items hidden in a workspace (GitPanel, FileView); relay downloads use fsRevealDesktop. |
| `fs_snapshot_files` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `gh_auth` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_available` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_issue_comment` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_issue_detail` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_issue_list` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_issue_set_state` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_auto_merge` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_body` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_checkout` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_close` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_conversation` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_diff` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_diff_since` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_failing_logs` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_file_viewed` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_links` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_list` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_merge` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_ready` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_request_review` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_retarget` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_review` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_review_batch` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_reviewer_candidates` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_state` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_thread_reply` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_thread_resolved` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `gh_pr_update_branch` | c | Host: `github.mjs` (mirrors git.rs (gh_*)) |
| `git_branch_at` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_branch_delete` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_branch_delete_remote` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_branch_release` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_checkout_carry` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_checkout_detached` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_discard` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_operation_quit` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_pr_merge_probe` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_rev_count` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_share_context` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_show_at` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_sync_abort` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_sync_apply` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_sync_probe` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_work_audit` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_worktree_add` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_worktree_add_pr` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_worktree_bootstrap` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_worktree_prune` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_worktree_realign` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `git_worktree_remove` | c | Host: `git-ops.mjs` (mirrors git.rs / sync.rs / fsx.rs) |
| `instructions_read` | c | Host: `workspace-tools.mjs` (mirrors instructions.rs / agents.rs) |
| `instructions_scan` | c | Host: `workspace-tools.mjs` (mirrors instructions.rs / agents.rs) |
| `instructions_write` | c | Host: `workspace-tools.mjs` (mirrors instructions.rs / agents.rs) |
| `kill_process` | c | Host: `workspace-tools.mjs` (mirrors instructions.rs / agents.rs) |
| `linear_issue_comment` | b | LOCAL_UI: Plain HTTPS API with a key from the desktop's settings. |
| `linear_issue_detail` | b | LOCAL_UI: Plain HTTPS API with a key from the desktop's settings. |
| `linear_issue_set_state` | b | LOCAL_UI: Plain HTTPS API with a key from the desktop's settings. |
| `linear_issues` | b | LOCAL_UI: Plain HTTPS API with a key from the desktop's settings. |
| `lsp_send` | c | Host: `lsp.mjs` (mirrors lsp.rs) |
| `lsp_start` | c | Host: `lsp.mjs` (mirrors lsp.rs) |
| `lsp_stop` | c | Host: `lsp.mjs` (mirrors lsp.rs) |
| `mcp_call_tool` | c | Host: `mcp-client.mjs` (mirrors mcp_client.rs) |
| `mcp_connect` | c | Host: `mcp-client.mjs` (mirrors mcp_client.rs) |
| `mcp_connected` | c | Host: `mcp-client.mjs` (mirrors mcp_client.rs) |
| `mcp_disconnect` | c | Host: `mcp-client.mjs` (mirrors mcp_client.rs) |
| `mcp_task_cancel` | c | Host: `mcp-client.mjs` (mirrors mcp_client.rs) |
| `mcp_task_get` | c | Host: `mcp-client.mjs` (mirrors mcp_client.rs) |
| `mcp_task_update` | c | Host: `mcp-client.mjs` (mirrors mcp_client.rs) |
| `model_catalog` | c | Host: `workspace-tools.mjs` (mirrors instructions.rs / agents.rs) |
| `notes_attach_file` | c | Adapter: reads the workspace file with fs_read_range and attaches it with the desktop's notes_add_attachment. |
| `pr_watch_now` | c | Host: `workspace-misc.mjs` (mirrors fsx.rs / agents.rs / profiles.rs / prwatch.rs / governor.rs) |
| `preview_start` | a | previewEngine() streams every web page from the workspace browser; the proxy engine never starts. |
| `preview_stop` | a | As preview_start. |
| `probe_http_readiness` | c | Host: `workspace-tools.mjs` (mirrors instructions.rs / agents.rs) |
| `process_capture_metrics` | b | LOCAL_UI: Desktop app diagnostics (no workspace meaning). |
| `profile_setup` | c | Host: `workspace-misc.mjs` (mirrors fsx.rs / agents.rs / profiles.rs / prwatch.rs / governor.rs) |
| `provenance_backfill` | c | Host: `provenance.mjs` (mirrors provenance.rs) |
| `provenance_for_pr` | c | Host: `provenance.mjs` (mirrors provenance.rs) |
| `provenance_for_session` | c | Host: `provenance.mjs` (mirrors provenance.rs) |
| `provenance_record` | c | Host: `provenance.mjs` (mirrors provenance.rs) |
| `pty_kill_all` | test | Test-only: never invoked from src/ (rendererRecoveryGuard.test.ts asserts so). |
| `pty_output` | c | Host: native.mjs (runner scrollback tail, as pty.rs scrollback_tail) |
| `pty_renderer_events` | a | onPtyExit/onPtySpawned listen to the adapter's pty:exit/pty:spawned events remotely. |
| `relay_accept_file` | b | LOCAL_UI: LAN relay between desktops; status and relay:* events forwarded from the desktop. |
| `relay_connect` | b | LOCAL_UI: LAN relay between desktops; status and relay:* events forwarded from the desktop. |
| `relay_disconnect` | b | LOCAL_UI: LAN relay between desktops; status and relay:* events forwarded from the desktop. |
| `relay_host_start` | b | LOCAL_UI: LAN relay between desktops; status and relay:* events forwarded from the desktop. |
| `relay_host_stop` | b | LOCAL_UI: LAN relay between desktops; status and relay:* events forwarded from the desktop. |
| `relay_offer_file` | b | LOCAL_UI: LAN relay between desktops; status and relay:* events forwarded from the desktop. |
| `relay_regenerate_code` | b | LOCAL_UI: LAN relay between desktops; status and relay:* events forwarded from the desktop. |
| `relay_send_chat` | b | LOCAL_UI: LAN relay between desktops; status and relay:* events forwarded from the desktop. |
| `relay_send_collab` | b | LOCAL_UI: LAN relay between desktops; status and relay:* events forwarded from the desktop. |
| `relay_send_command` | b | LOCAL_UI: LAN relay between desktops; status and relay:* events forwarded from the desktop. |
| `research_delete` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `research_dir` | c | Host `research_entry_dir`: the entry's directory in the VM (harnessCommands.ts) |
| `research_for_file` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `research_get` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `research_import` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `research_link` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `research_read_file` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `research_search` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `research_set_status` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `research_start` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `research_sweep` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `research_update` | c | canopy-service via /harness/query or /harness/actions (src/remoteExecution/harnessCommands.ts) |
| `selftest_checkpoint` | b | LOCAL_UI: Desktop self-test harness state. |
| `selftest_checkpoint_save` | b | LOCAL_UI: Desktop self-test harness state. |
| `selftest_finish` | b | LOCAL_UI: Desktop self-test harness state. |
| `selftest_reload_renderer` | b | LOCAL_UI: Desktop self-test harness state. |
| `selftest_spawn_remote` | b | LOCAL_UI: Desktop self-test harness state. |
| `selftest_store_contains` | b | LOCAL_UI: Desktop self-test harness state. |
| `session_forget` | c | Host: `workspace-misc.mjs` (mirrors fsx.rs / agents.rs / profiles.rs / prwatch.rs / governor.rs) |
| `snapshot_capture_metrics` | b | LOCAL_UI: Desktop app diagnostics (no workspace meaning). |
| `some_other_cmd` | test | Test-only fixture (src/test/ipc-harness.test.ts). |
| `spot_index_clear` | c | Host: `spot-index.mjs` (mirrors spot.rs) |
| `spot_index_stats` | c | Host: `spot-index.mjs` (mirrors spot.rs) |
| `spot_ingest` | c | Host: `spot-index.mjs` (mirrors spot.rs) |
| `spot_save_context_text` | c | Host: `spot-index.mjs` (mirrors spot.rs) |
| `spot_search` | c | Host: `spot-index.mjs` (mirrors spot.rs) |
| `structured_runner_kill` | c | Host: `structured-runner.mjs` (mirrors structured_runner.rs) |
| `structured_runner_spawn` | c | Host: `structured-runner.mjs` (mirrors structured_runner.rs) |
| `structured_runner_write` | c | Host: `structured-runner.mjs` (mirrors structured_runner.rs) |
| `task_artifact_read` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_artifact_write` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_attempt_reserve` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_attempt_settle` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_attempt_start` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_attempt_wait` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_clear_history` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_delete` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_event_append` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_event_list` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_get` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_get_for_attempt` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_interrupt_stale` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_list` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_list_all` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_reserve` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_transcript_append` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_transcript_list` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `task_update_metadata` | c | Host: `task-store.mjs` (mirrors tasks.rs) |
| `terminal_governor_grant` | c | Host: `workspace-misc.mjs` (mirrors fsx.rs / agents.rs / profiles.rs / prwatch.rs / governor.rs) |
| `terminal_governor_incidents` | c | Host: `workspace-misc.mjs` (mirrors fsx.rs / agents.rs / profiles.rs / prwatch.rs / governor.rs) |
| `terminal_governor_memory_maxima` | c | Host: `workspace-misc.mjs` (mirrors fsx.rs / agents.rs / profiles.rs / prwatch.rs / governor.rs) |
| `terminal_governor_remember_default` | c | Host: `workspace-misc.mjs` (mirrors fsx.rs / agents.rs / profiles.rs / prwatch.rs / governor.rs) |
| `terminal_governor_set_memory_maximum` | c | Host: `workspace-misc.mjs` (mirrors fsx.rs / agents.rs / profiles.rs / prwatch.rs / governor.rs) |
| `terminal_governor_stop` | c | Host: `workspace-misc.mjs` (mirrors fsx.rs / agents.rs / profiles.rs / prwatch.rs / governor.rs) |
| `tunnel_start` | b | LOCAL_UI: Exposes the desktop's own portal port (tunnel.rs); tunnel:state forwarded. |
| `tunnel_status` | b | LOCAL_UI: Exposes the desktop's own portal port (tunnel.rs); tunnel:state forwarded. |
| `tunnel_stop` | b | LOCAL_UI: Exposes the desktop's own portal port (tunnel.rs); tunnel:state forwarded. |
| `turn_list` | c | Host: `turns.mjs` (mirrors turn_rollback.rs) |
| `turn_native_checkpoint` | c | Host: `turns.mjs` (mirrors turn_rollback.rs) |
| `turn_preview` | c | Host: `turns.mjs` (mirrors turn_rollback.rs) |
| `turn_restore` | c | Host: `turns.mjs` (mirrors turn_rollback.rs) |
| `turn_snapshot` | c | Host: `turns.mjs` (mirrors turn_rollback.rs) |
| `vault_approvals` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_approve` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_change_passphrase` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_create` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_delete` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_fill` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_import_kdbx` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_list` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_lock` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_matches` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_read` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_reveal` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_revoke` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_save` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_status` | b | LOCAL_UI: The person's credential vault on their computer. |
| `vault_unlock` | b | LOCAL_UI: The person's credential vault on their computer. |
| `workflow_run_advance` | c | Host: `workflow-store.mjs` (mirrors workflow.rs) |
| `workflow_run_create` | c | Host: `workflow-store.mjs` (mirrors workflow.rs) |
| `workflow_run_get` | c | Host: `workflow-store.mjs` (mirrors workflow.rs) |
| `workflow_run_list` | c | Host: `workflow-store.mjs` (mirrors workflow.rs) |
| `workflow_run_resume` | c | Host: `workflow-store.mjs` (mirrors workflow.rs) |
| `workflow_step_record` | c | Host: `workflow-store.mjs` (mirrors workflow.rs) |
| `workspace_export` | b | LOCAL_UI: Path comes from the desktop's save/open dialog. |
| `workspace_import` | b | LOCAL_UI: Path comes from the desktop's save/open dialog. |

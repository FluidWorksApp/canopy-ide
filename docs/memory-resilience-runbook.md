# Canopy memory-resilience incident runbook

This runbook collects bounded, content-free evidence without restarting Canopy
or sacrificing live terminals. A renderer or preview may be unhealthy while the
native host and PTYs are still making progress; treat those as separate layers.

## Safety rules

1. Do not quit, relaunch, signal, or attach a debugger to Canopy while a live
   terminal/agent owns work unless the user explicitly authorizes it.
2. Record native-host, main WebContent, preview WebContent, graphics/media,
   networking, and PTY-tree PIDs separately. A new child WebContent process is
   not by itself proof of a main-renderer restart.
3. Never collect terminal output, command lines, prompts, environment variables,
   URLs, file contents, or full paths in the release incident record.
4. Prefer scalar counters and short bounded samples. Stop a collection command
   if it adds visible pressure.

## First five minutes

- Record wall-clock time with timezone, app version/commit, platform/version,
  physical memory, pressure level, and whether the UI is responsive.
- Record whether each existing terminal still accepts input and whether its
  native PTY/session id remains present. Do not type into an agent mid-turn just
  to test it.
- Read Canopy's bounded watchdog/governor incident rings and current app/session
  metrics. Preserve only numeric fields, state, capability, and outcomes.
- Record native browser-close counters (pending labels, retry-worker state,
  attempts, successes, and failures). An idle WebContent PID alone is not a
  leak; a pending label that survives repeated close retries is actionable.
- Record preview pressure-reload counters (kill-switch enabled state, decisions,
  targets, attempts, successes, failures, missing views, suppressed targets,
  and synchronous dispatch latency). Compare them with close counters and OS
  samples by timestamp; dispatch latency is not page-load completion time, and
  the counters alone do not measure reclaimed WebContent memory.
- Preserve the rotating `resilience` log from the platform app-log directory.
  It is capped at 1 MiB and filters to native watchdog/app-exit records; do not
  substitute a broad debug log that may contain paths, URLs, or user text.
- Record process identity, start time, current/peak footprint, CPU, thread count,
  file-descriptor/handle count, and parent/child relationship. Re-sample the same
  identities; do not infer continuity from a reused PID.
- Classify the event as native-host exit, main-renderer replacement, preview
  lifecycle, UI event-loop stall, host-critical pressure, or still unknown.

## Bounded OS collection

### macOS

- Activity Monitor: group Canopy children but record `tauri://localhost`, preview
  URL WebContent, Graphics and Media, and Networking rows individually.
- Capture at most one five-second `sample <pid> 5 1` from the suspected process.
- Capture one `vmmap -summary <pid>` when the renderer is responsive enough to
  tolerate it. Prefer Physical Footprint/private dirty summaries over virtual
  address size.
- Use unified-log time windows of five minutes around the event and filter to
  Canopy/WebKit termination, process launch, memory-pressure, and watchdog
  categories. Do not export unrelated browsing or terminal text.

### Linux

- Record `/proc/<pid>/status`, `/proc/<pid>/stat`, and `/proc/<pid>/fd` count for
  the host, WebKit helpers, and PTY roots.
- If verified containment is active, record scalar `memory.current`,
  `memory.high`, and `memory.events` from that session cgroup. Never alter
  `memory.max` during diagnosis.
- Record cgroup membership before interpreting a soft-limit result; otherwise
  capability is monitor-only.

### Windows

- Record Process Explorer/Task Manager working set, private bytes/commit, CPU,
  handle count, start time, parent, and Job membership separately.
- Until Canopy reports a verified Job backend, all allowance decisions are
  monitor-only; do not describe a UI allowance as an enforced cap.

## Pass/fail profiles

Use a release build, a fixed workload, and at least three repetitions per
platform. Warm for ten minutes before measuring slopes.

- Idle main renderer: over the next 30 minutes, net physical-footprint growth
  must be no more than 32 MiB and must not rise in every five-minute sample.
- Browser frames: after 100 dirty/capture/replacement cycles, retained frontend
  frame count and Blob bytes must return to the number/bytes owned by live tabs;
  native active capture/payload counters must return to zero.
- Preview relief experiment: on a disposable runner only, compare reload against
  close and close/recreate after the frontend handle contract supports destroyed
  views. Use identical pages/warm-up and record main/child process identity plus
  footprint before and after each action. `CANOPY_DISABLE_PREVIEW_PRESSURE_RELOAD=1`
  suppresses automatic preview reload while retaining decision/target telemetry.
- Hidden terminals: one visible plus 32 hidden terminals producing bounded test
  output for 30 minutes must keep native replay per session within its ring,
  renderer compacted VT payloads within 4 MiB each and 64 MiB total, and hidden
  xterm cell graphs absent after the idle boundary, with hidden terminals
  detached from live renderer delivery.
- Editors/viewers: switch repeatedly across code, image, PDF, and spreadsheet
  tabs. After the 60-second idle boundary, editor compact backing must remain at
  or below 32 models/64 MiB total, inactive native-viewer source bytes must reach
  zero, and activation must restore exact unsaved text or bounded file bytes.
  Owner/lease saturation must report fail-closed rather than dispose a visible
  or agent-owned model.
- File churn: 1,000 switches among bounded fixtures must return shared active and
  queued I/O bytes to zero and editor view-state entries to at most 32.
- Renderer replacement: from the first stale heartbeat observation, recovery
  must begin within 12 seconds (three observations plus one probe interval), and
  all marker PTYs must retain the same Rust session id/generation and child PID.
- Resource ownership: after closing all test tabs/projects, file-descriptor or
  handle counts must return within 5% or 16 handles (whichever is larger) of the
  warmed baseline; three consecutive increasing teardown baselines fail.

A test fails on any lost PTY/process identity, missing transcript marker, silent
truncation without the visible gap marker, unbounded queue/cache counter, or
capability claim stronger than the runtime-verified backend.

## Recovery and escalation

- Allow the single bounded native pressure-shed probe and coordinated renderer
  reload. Do not manually reload in parallel.
- If the UI returns, confirm live PTY reconciliation before closing anything.
- If the UI does not return and native incident telemetry reaches its reload
  rate limit, preserve the host and PTYs and ask the user before any app exit.
- A terminal tree above its allowance requires an explicit 512 MiB or 1 GiB
  grant. On monitor-only platforms, say plainly that the grant changes warning
  policy, not an OS memory boundary.
- Automatic pause/kill is not a diagnostic action: pausing can break an active
  network turn and retain file claims, while stopping destroys in-memory CLI
  state. Escalate for an explicit user decision.

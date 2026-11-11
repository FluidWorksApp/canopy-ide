# Persistent PTY host: terminals that outlive the Canopy app

Status: in progress. Local (Unix) host first, off by default. Remote runner and
Tailscale are separate follow-ups described below.

Goal: quitting, updating or crashing the desktop app does not kill the
terminals or the agents inside them. Reopening Canopy reattaches.

Approach (user decision): a small native host process owns the PTYs; the app is
a client of it. tmux/zellij was rejected because agent detection walks each
PTY's child tree (`agents.rs`), containment and process-group teardown assume we
are the parent, and tmux would re-emulate the byte stream.

## Scope of the first PR

- Unix only (macOS, Linux). Windows keeps in-process PTYs (job-object lifetime,
  untestable here). The host binary still compiles on Windows as a stub so the
  sidecar packaging step does not break.
- Off by default behind `CANOPY_PTY_HOST=1`. No UI change, so no mock is owed yet.
  What Quit should mean when it is on is an open product decision (below).
- Hosted sessions are monitor-only for containment.
- New crate `crates/canopy-pty-host`: protocol, server, client, tests. Nothing in
  `pty.rs` changes until CI is green on the crate.

## Decisions needed from the user

1. What does Quit mean once the host is on? Default: Quit detaches, plus a
   separate "Quit and stop all terminals".
2. Should surviving agents be visible with no app open (tray entry)? Default: no.

## Verified facts

- `Session` holds `Box<dyn MasterPty>`, `Box<dyn Child>`, `Box<dyn ChildKiller>`
  (`pty.rs:169-172`). portable-pty 0.9 traits can be implemented by a client that
  talks to a host, so the only branch point is the spawn body (`pty.rs` ~2000-2075).
  The reader/flusher/writer threads, ring, ack and broadcast code stay.
- `foreground_pid` and `raw_mode` call `process_group_leader()` and `as_raw_fd()`
  (`pty.rs:1023, 1043`), so the protocol needs `pgrp` and `rawmode` ops with
  timeouts, since they run under the `master` lock.
- Quit calls `kill_all()` (`lib.rs:1185`). No release-build boot reaper exists.
- `next_id` / `next_session_generation` start at 0 each launch (`pty.rs:407`), so
  they must be seeded past adopted sessions.
- The Canopy hook already accepts `CANOPY_CTX_SOCKET` as well as `CANOPY_CTX_PORT`
  (`canopy_hook.rs:3404`). The context bridge port is ephemeral
  (`context.rs:551`). A stable per-profile socket could keep tools alive across an
  app restart. Not yet checked: whether the socket transport speaks the same API.
- Sidecars ship through `externalBin` in `tauri.conf.json`; CI stubs them with
  `touch` and releases build them through `scripts/prepare-sidecar.mjs`.
- POC (python stdlib, not committed): a `setsid` host survives SIGKILL of its
  launcher with the same child pid; a new client reattaches from a byte offset
  with no gap; a non-parent client can resize (SIGWINCH observed) and send input;
  kill by process group works; killing the host hangs up its children (so a host
  crash loses every session, a stated non-goal).

## Design

**Process.** `canopy-pty-host`, one per profile, started by the app on demand with
`setsid` and stdio on `/dev/null` (never `fork()` from the Tauri process). It
exits after a quiet period with no sessions and no clients. SIGTERM stops the
children, then exits. A lock file prevents a start race; a stale socket is
removed; directory mode 0700 and a peer-uid check; short socket path (macOS limit
is about 104 bytes, recalled).

**Wire.** One raw connection per session: a one-line JSON attach handshake, then
plain bytes both ways. The host blocks on a slow client and drains into its ring
when none is attached, so a stalled client blocks the child rather than growing
host memory. Control ops (`spawn`, `list`, `resize`, `kill`, `pgrp`, `rawmode`,
`stats`) are short request/response calls with timeouts. Unknown JSON fields are
tolerated; on a version mismatch the app can still `list` and `kill`, so agents
are never invisible. No multiplexing, framing or fd passing in this PR.

**Spawn.** The client sends argv, cwd and the full environment taken from the
`CommandBuilder`. The host applies exactly that, never its own env. It carries
tokens, so it is never logged or persisted.

**Adoption.** On launch the app lists host sessions and builds `Session`s whose
reader attaches with `after=N`, so offsets continue from the host ring. The host
stores an opaque metadata blob per session (project, name, execution context).
The first app hands its instance token to the host; later launches read it back
before anything calls `instance_token()`, so adopted agents are not also resumed
as a second agent on the same conversation. Ids are seeded past the adopted max.

**Not in the first PR:** context-bridge continuity (second commit), quit
semantics UI, Windows.

## Remote runner (follow-up, investigated)

The remote runner has the same problem with a different cause. `runner.mjs`
spawns terminals with node-pty (`runner.mjs:323`, `CMD ["node","runner.mjs"]`).
A host update replaces the workspace container (`docker.mjs updateOwnerImage`
runs `docker stop --time 30`). **A holder process inside the same container dies
with it, because stopping a container ends its whole PID namespace.** So a holder
only helps for in-container restarts of the runner or gateway, not image updates.

Options, to be decided separately: (a) keep the holder in a long-lived sidecar
container that the updated workspace container joins, which needs shared PID and
IPC namespaces and a careful security review; (b) update code in place inside the
running container instead of replacing it; (c) accept a clean stop and rely on
agent resume (`session-resume.mjs`), which exists today. This is a separate design
and PR. The Unix host protocol here is intended to be reusable by it.

## Tailscale (follow-up, separate PR)

User requirement: native Tailscale support with an in-app login. It fronts the
Canopy Remote portal; the PTY-host socket stays local-only. Findings: on this Mac
the Homebrew `tailscale` on PATH cannot reach the daemon, while the app's own
binary `/Applications/Tailscale.app/Contents/MacOS/Tailscale` works, so binary
discovery must probe candidates. `tunnel.rs` currently only runs
`tailscale funnel PORT` via PATH.

## Tests (CI is the compiler; local cargo builds are off)

Pure protocol tests, plus integration tests in `tests/` that run the real detached
binary: kill the client and reattach with the same pid and consecutive output;
stalled client blocks the child; drain with the gap flag; start race; SIGTERM
leaves no orphans. Existing `pty.rs` tests must pass with the switch off.

## Non-goals

Survival across reboot; surviving a host crash; tmux compatibility; fd passing to
a new host; Windows in this PR.

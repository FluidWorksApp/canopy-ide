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

- Unix only (macOS, Linux). Windows keeps in-process PTYs for now; the host
  binary compiles on Windows as a stub so the sidecar packaging step does not
  break. A real Windows host (named pipe, ConPTY, job objects) is a stacked
  follow-up PR.
- Off by default behind `CANOPY_PTY_HOST=1`. No UI change in this PR.
  With it on, Quit leaves adoptable terminals running in the host (micro-tasks
  and run-bound tabs are still stopped) and the next launch adopts them.
  "Quit and Stop All…" (stacked PR #794; app menu under Quit, ⌥⌘Q on macOS,
  Ctrl+Shift+Q elsewhere) stops everything. On every platform, host on or off,
  it asks "Stop N running agents?" whenever agents run (Cancel, Quit only, Stop
  all; no Quit only with the host off, where Quit stops everything anyway). Stop
  all first asks the host to stop every Canopy session no live app is attached
  to, plus this launch's strays, and a failure there is shown in the dialog
  and nothing quits; then exit stops this app's terminals, hosted ones
  included, and the host idles out.
- Hosted sessions are monitor-only for containment.
- New crate `crates/canopy-pty-host`: protocol, server, client, tests. Nothing in
  `pty.rs` changes until CI is green on the crate.

## Decisions

1. Quit detaches; "Quit and Stop All…" stops everything (user, 2026-11-11).
2. Should surviving agents be visible with no app open (tray entry)? Open;
   default no.

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
  (`src-tauri/src/bin/canopy_hook.rs` `bridge_env`), prefers the socket when both
  are set, re-reads its environment on every call, and speaks the same HTTP/1.1
  over either. The context bridge port is ephemeral (`context.rs` `start`).
- Sidecars ship through `externalBin` in `tauri.conf.json`; CI stubs them with
  `touch` and releases build them through `scripts/prepare-sidecar.mjs`.
  tauri-build copies them into the target dir with the triple stripped, and
  tauri-bundler 2.10 signs them on macOS (`bundle/macos/app.rs`, sidecars added
  to the sign list as executables).
- POC (python stdlib, not committed): a `setsid` host survives SIGKILL of its
  launcher with the same child pid; a new client reattaches from a byte offset
  with no gap; a non-parent client can resize (SIGWINCH observed) and send input;
  kill by process group works; killing the host hangs up its children (so a host
  crash loses every session, a stated non-goal).

## Design

**Process.** `canopy-pty-host`, one per user (debug builds use their own directory), started by the app on demand with
`setsid` and stdio on `/dev/null` (never `fork()` from the Tauri process). It
exits after a quiet period with no sessions and no clients. SIGTERM stops the
children, then exits. A lock file prevents a start race; a stale socket is
removed; directory mode 0700 and a peer-uid check; short socket path (macOS limit
is about 104 bytes, recalled).

**Linger.** `SpawnSpec.linger_secs` kills a session that long after its last
client detaches (or after spawn if none attaches), so a crash or force-quit does
not leave invisible agents running forever. The clock only runs while nothing is
attached, so adoption does not need to lift it; how long a session may outlive the
app is the user's Quit decision, and the app sets two hours for now (long enough
to quit, update and relaunch; an app that never returns does not leave agents
running unseen for longer).

**Wire.** One raw connection per session: a one-line JSON attach handshake, then
plain bytes both ways. The host blocks on a slow client and drains into its ring
when none is attached, so a stalled client blocks the child rather than growing
host memory. Control ops (`spawn`, `list`, `resize`, `kill`, `pgrp`, `rawmode`,
`stats`) are short request/response calls with timeouts. Unknown JSON fields are
tolerated; on a version mismatch the app can still `list` and `kill`, so agents
are never invisible. No multiplexing, framing or fd passing in this PR.

A plain `attach` replaces whatever client is attached (the app reclaiming its own
terminal after a reload depends on that). Protocol 3 adds two ops for other
clients such as the `canopy-term` CLI: `attach` with `exclusive: true` checks and
takes the session in one step inside the host and answers `busy` if a client is
attached, and `read_ring` returns ring bytes from an offset without attaching, so
`capture` never disconnects the app and never starts the linger clock. A host
older than 3 ignores `exclusive`, so `HostClient::attach_exclusive` checks
`hello` first and refuses such a host.

A replaced client is disconnected: the host closes its connection, so it sees
EOF instead of a frozen screen whose typing would still reach the child. In the
app that only happens when something takes a session with `--force`; the app's
terminal then stops updating while the child keeps running in the host (a later
launch can adopt it). Reattaching automatically is a follow-up.

**Versioning and containers.** `hello` carries the client's protocol version and
the host replies with its own and the oldest client it accepts; `attach` repeats
the client version. A client too old is refused with a clear message, and a
client refuses a host older than it can use, so app, runner and a long-lived host
can skew without misreading bytes (0 means "did not say" and is accepted, for
older peers). The host is one static-capable binary (CI builds it for
`x86_64-unknown-linux-musl` and checks it is static) whose socket comes from
`--socket` or `CANOPY_PTY_HOST_SOCKET`, so a Linux container can run it without
the app. Not yet exercised in a container.

**Idempotent spawn.** `SpawnSpec.key` is a caller-supplied key (for example a
runner's session id plus request id). A second spawn with the same key returns the
existing session, even if it has exited, so a retried spawn gets its first answer
instead of a second run, like the runner's receipts. `list` returns the key, so
the caller never has to learn the host's own id. The key is freed when the
session is reaped.

**Spawn.** The client sends argv, cwd and the full environment taken from the
`CommandBuilder`. The host applies exactly that, never its own env. It carries
tokens, so it is never logged or persisted.

**Adoption.** On launch the app lists host sessions and builds `Session`s whose
reader attaches with `after=N`, so offsets continue from the host ring. The host
stores an opaque metadata blob per session (project, name, execution context).
The first app hands its instance token to the host; later launches read it back
before anything calls `instance_token()`, so adopted agents are not also resumed
as a second agent on the same conversation. Ids are seeded past the adopted max.

**Adoption design notes (from reading the code).**
- The instance token is not only a staleness marker. A hosted child's env, digests
  and sidecar actions carry the token it was spawned with, and mesh delivery
  (`pty.rs` `write`), job updates and sidecar actions (`context.rs`) and digest
  pairing in the session panel all compare against the current token. A fresh
  token would silence every adopted agent, so an adopting launch reuses the token
  found in the metadata of the waiting sessions (the token most free, ours,
  non-micro-task sessions agree on). Debug instances can coexist, so it is read
  from the sessions, not from a first-writer-wins store.
- Reusing it breaks the stale sweep, which matches `appInstance` by inequality
  (`tasks.rs interrupt_stale`). The sweep and the `appInstance` stamps use a
  separate per-launch tag (`launch_token`, command `launch_id`), equal to the
  pairing token whenever nothing was adopted.
- A pty id must never repeat under one token, including ids of dead terminals, so
  adoption raises the id and generation floor from every session carrying the
  token (before attempting any adopt, with a non-launching client) and from a
  high-water mark the app writes ahead in blocks to the host.
- Run-bound sessions (a task run id in the metadata) are micro-task tabs: they
  are never adopted, matching "micro-task tabs are never restored" and the sweep.
- An adopted session skips what a fresh spawn registers by pty id: no containment
  lease, no IDE server; the exit-path releases for those are no-ops. Its bridge
  credential does come back when its metadata carries a verifier (see "Context
  bridge continuity" below); metadata written before that keeps no credential. Adoption starts with a one-second
  bound per host call and ten seconds in total; sessions it does not reach stay
  in the host.
- Replayed history goes straight into the replay ring and does not stamp the
  output clock; the redraw nudge's repaint is masked from it for a moment.
- Release builds allow one app instance (`tauri-plugin-single-instance`, compiled
  out of debug builds), so no claim op is planned. Debug instances can coexist
  and would share the `pty-host-dev` directory; a second one attaching to the
  first's sessions would replace its connection, so adoption is for release
  builds, or debug builds get a per-instance directory.
- A resize to the size a terminal already has delivers no SIGWINCH (checked on
  macOS with a python pty). After replaying history, adoption has to nudge a
  redraw by resizing one row and back.
- The terminal view already reattaches to an existing pty id (`Term.tsx`
  `attachId`, used when the web view reloads). Whether tabs persist across a quit,
  and so whether adoption fills an existing tab or needs a new surface, is still
  open.
- Replacing an incompatible, idle host uses the protocol 4 `shutdown_if_idle`
  op: the host checks that nothing runs and stops accepting spawns under the one
  lock spawns take, so a terminal another client starts meanwhile is never
  killed. A host older than 4 lacks the op; there the client lists again right
  before `shutdown`, which leaves a small window. A failed start of the host
  client is retried after 30 s rather than kept for the app's lifetime.
- Adoption attaches with `exclusive` on a protocol 3 host, so a CLI client that
  attached after the `list` is refused rather than silently disconnected.

**Context bridge continuity.** An agent's environment is fixed at spawn, so a
surviving agent keeps the port and token of the launch that started it. With
the host on:
- The bridge also listens on a Unix socket at a fixed path, `ctx.sock` in the
  host's directory (`~/.canopy/pty-host`, `pty-host-dev` for debug builds, or
  `CANOPY_PTY_HOST_DIR`), and every terminal gets `CANOPY_CTX_SOCKET` beside
  `CANOPY_CTX_PORT`/`_TOKEN` (`ctx_socket.rs`, `context.rs` `start`). The hook
  prefers the socket, so after a relaunch its calls reach the new app. A missing
  or refused socket never falls back to the port: an old port can belong to
  anything. The one exception is a sandbox that denies the connect itself
  (`PermissionDenied`), which uses the port from the same environment.
- Access is unchanged: the directory is 0700 and must be ours and not a symlink
  (opened `O_NOFOLLOW`, checked and `fchmod`ed through that one descriptor),
  the socket is 0600, a connection from another uid is dropped (`peer_cred`),
  and every request still needs the same bearer credential. No TCP port is added.
- The credential survives without being stored: the bridge keys terminal
  credentials by SHA-256 (`context::verifier`), the spawn metadata records that
  verifier (`bridge`), and adoption re-registers it under the terminal's id,
  instance, cwd and spawn-tree position (`ContextBridge::readopt_agent`). The
  token the agent already holds then authenticates on the new launch. A verifier
  already registered, or a pty already holding one, is refused. A failed
  adoption retires the credential only if this adoption registered it.
- Any process of this user can write session metadata through the host, so what
  adoption acts on (`bridge`, depth, parent, identity fields) is sealed with an
  HMAC-SHA256 (`adoption_seal.rs`) whose key lives in the platform secret store,
  not the host. Unsealed or wrongly sealed metadata is adopted as a plain
  terminal with no credential, and sealed sessions alone vote on the instance
  token. On Linux the secret store is readable by any process of the same user,
  so there the seal only stops a forgery that does not also read the key.
- Spawn-tree position (`spawn_depth`, parent) is assigned after the spawn, so
  the app reseals the metadata with it (`reseal_lineage`, from its own copy, never
  from what the host returns). Lineage fails closed: a position that is unknown
  (a spawn made while a delegation was pending and not resealed, a failed
  write) is adopted at the delegation cap, so it keeps its tools but cannot
  spawn further agents.
- One app per directory holds the socket: an exclusive `flock` on `ctx.lock`,
  held as long as the listener lives. A launch that finds it held keeps
  retrying for as long as it runs (every half second for five seconds, an
  updater's old process still exiting, then every five seconds), serving TCP
  meanwhile; it never unlinks a socket it does not hold. A stale
  socket file is removed by the next owner. Two debug apps share
  `pty-host-dev`: the first holds the socket, the second runs port-only.
- Apps started from another Canopy's terminal drop an inherited
  `CANOPY_CTX_SOCKET` before stamping their own (terminals, companion,
  structured runs), since the socket would win over their port.
- With the flag off: no socket, no lock, no new variable. The one change that
  applies regardless is dropping an inherited `CANOPY_CTX_SOCKET` above, which
  only matters for an app launched from inside another Canopy's terminal.
- Still not restored for adopted agents: the Claude IDE server (diff and
  selection link) and anything keyed to the old launch's port. A hook call made
  while no app is running fails with "Canopy isn't reachable at ...ctx.sock".
  Hook events go through `~/.canopy/agent-events.jsonl`, which is already stable,
  but the app only reads events written after it starts.

**Packaging and updates.** The host ships inside the app as a Tauri sidecar
(`externalBin: binaries/canopy-pty-host`, built by `scripts/prepare-sidecar.mjs`
through its own manifest). Tauri places it next to the app binary
(`Canopy.app/Contents/MacOS`, `/usr/bin` for deb and rpm, the AppImage's
`usr/bin`, next to `canopy.exe` on Windows).
- macOS signing. tauri-bundler 2.10 signs every externalBin entry with the app's
  one entitlements file (`entitlements.plist`: JIT, library validation off, DYLD
  variables, microphone) and has no per-binary setting, and `codesign --force`
  would overwrite any signature put on the file beforehand. A long-lived process
  that outlives the app should not carry those. So for macOS release builds the
  host is not an externalBin: `prepare-sidecar.mjs --release` signs a copy
  (`binaries/canopy-pty-host-signed`) with the hardened runtime, a timestamp and
  the empty `pty-host-entitlements.plist`, and `tauri.release-macos.conf.json`
  (passed with `--config` by `release.yml` and `release-macos.sh`) removes the
  externalBin entry and copies that file to `Contents/MacOS/canopy-pty-host`
  through `bundle.macOS.files`, which the bundler never signs. Without
  `APPLE_SIGNING_IDENTITY` the copy is staged unsigned. Dev and CI builds do not
  use the override. The release workflow then checks the shipped host: valid
  signature, hardened runtime, timestamp, and no entitlement key at all; it fails
  the job when `APPLE_CERTIFICATE` is set and any of that is wrong.
- A host never runs from the bundle. An update replaces the bundle while the
  host keeps running. A translocated app, or an AppImage, runs from a mount that
  goes away when the app quits. And a later launch must never exec a path the
  update removed. So on first use (`CANOPY_PTY_HOST=1`, Unix) the app reads the
  bundled bytes and installs them as
  `<socket dir>/bin/<app version>-<sha256 prefix>/canopy-pty-host`. The socket
  dir is `~/.canopy/pty-host` (or `pty-host-dev`, or `CANOPY_PTY_HOST_DIR`),
  mode 0700. The host is then started from that copy, and a later restart reuses
  the same path (`src-tauri/src/pty_hosted/install.rs`).
  `CANOPY_PTY_HOST_EXE` still overrides this, with no copy.
- The copy is written from the hashed bytes, not with a file copy. So it has no
  extended attributes, in particular no quarantine flag from a downloaded app.
  The Mach-O signature travels inside the bytes. The copy is read back and must
  hash the same before it is renamed into place. A file under `bin/` is never
  rewritten in place: macOS kills a signed process whose file changes, and a
  rename leaves a running host on its old inode. If installing fails, terminals
  stay in-process. The app never falls back to the bundled path.
- After an update, the new app reaches the old host through the same socket.
  Protocol versions handle skew. `hello` now reports the host's own path, so the
  directory a live host came from is kept. Other install directories are pruned
  on a later launch. Pruning happens only when it is certain which directory is
  live: from a `hello` answer, or no socket. A refused
  connection (a live host with a full accept queue is refused too) and any other
  failure prune nothing. A running host also holds a shared lock on its own
  install directory, which a prune respects.
- Windows: the host is a stub that exits. It is staged and bundled, nothing
  launches it, and nothing depends on it.
- The launch probe asks `list` once more after 250 ms on anything but "no
  socket" or "nobody listening". Right after a quit, the host can briefly fail
  to answer, and that failure used to read as an unusable host (or as no host).

**Unproven: needs a real signed build, cannot be shown by PR CI.**
- The release-workflow signing of the sidecar. The verify step only runs on a
  tag build with the signing identity set.
- An app update on a signed build while terminals are running. The relaunched
  app should adopt them from the host started from the old version's install
  directory, which should be kept, and then pruned once that host exits.
- Whether macOS folder-permission prompts (for example `~/Documents`) name the
  host binary instead of Canopy. Hosted children are spawned by
  `canopy-pty-host`, which runs from outside the bundle.
- AppImage: quit and relaunch with hosted terminals, checking that the host
  keeps running after the AppImage mount is gone.
- A notarized build's copied host executing under Gatekeeper. Expected to work,
  since it is not quarantined and carries a valid Developer ID signature. On
  first launch of a freshly downloaded build, `xattr -l` on the installed copy
  should show no `com.apple.quarantine`.
- The sidecar's placement in the macOS and Linux bundles. PR CI builds a real
  bundle only on Windows.
- The whole launch path (install, `ensure_running`, prune) run end to end with
  a real host binary. Unit tests cover each step on its own.

**Not in this PR (stacked follow-ups):** Windows (no socket transport; the host is a stub). Quit and Stop All is #794.

## Remote runner (follow-up, investigated)

The remote runner has the same problem with a different cause. `runner.mjs`
spawns terminals with node-pty (`runner.mjs:323`, `CMD ["node","runner.mjs"]`).
A host update replaces the workspace container (`docker.mjs updateOwnerImage`
runs `docker stop --time 30`). **A holder process inside the same container dies
with it, because stopping a container ends its whole PID namespace.** So a holder
only helps for in-container restarts of the runner or gateway, not image updates.

Direction from the owner (relayed by the remote-workspace session, not yet
designed or tested): remote agent CLIs stay **pinned** (`agents.lock.json`,
root-owned, sha-checked, self-update disabled via `PINNED_CLI_ENV_KEYS` in
`runner.mjs`), but should be delivered from versioned root-owned directories
outside the image, so a CLI bump never swaps the container. New sessions get the
new version; old versions must be kept until their sessions exit (today
`install-agents.sh` removes the old `vendor/<name>` directory, which would break
running lazy loaders). Runner and gateway code likewise live outside the image
and restart through a holder. The image holds only the OS and Node and swaps
rarely, gated on idle; a `recoverRuntime` SIGKILL still kills PTYs. Untested:
CLIs running from a volume, and whether `canopy-hook` and browser assets can
leave the image. Keeping PTYs across the rare image swap is a separate decision
(a long-lived sidecar holder the workspace container joins, which needs shared
PID/IPC namespaces and a security review). This is a separate design and PR; the
Unix host protocol here is meant to be reusable by it.

## Tailscale (follow-up, separate PR)

User requirement: native Tailscale support, with an in-app login when one is
needed. It fronts the Canopy Remote portal (`portal.rs`); the PTY-host socket
stays local-only.

**Binary discovery.** On this Mac the Homebrew `tailscale` on PATH fails ("failed
to connect to local Tailscale service") while the app's own binary,
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`, answers. `tunnel.rs` only
runs `tailscale funnel PORT` via PATH, so it is broken here. Discovery must probe
candidates (app bundle, PATH, Linux and Windows install paths) and keep the first
whose `status --json` parses. That is a pure function and can be tested.

**Commands Canopy would run** (CLI help read locally; doc claims are from
tailscale.com and third-party reports, and the docs themselves say the JSON
format may change):
- State: `tailscale status --json`. `BackendState` is `Running` when connected;
  other values reported include `NeedsLogin`, `NeedsMachineAuth` (waiting for an
  admin to approve the node, no login URL), `Stopped` and `Starting`. `AuthURL`
  carries the login link when there is one; with the control plane unreachable it
  can be empty. Observed locally: `Self.DNSName`, `TailscaleIPs`, `Health`.
- Login: `tailscale up --json` (flag exists; its `AuthURL` field is reported by a
  third-party write-up, not confirmed in official docs, so verify against
  `cmd/tailscale/cli/up.go` before relying on it). Open the URL in the system
  browser and poll `status --json` until `Running`, since identity providers often
  refuse embedded webviews (recalled). Headless alternatives: `--auth-key`,
  `--login-server` (self-hosted control server).
- Tailnet-only portal: `tailscale serve --bg --https=443 http://127.0.0.1:6680`,
  which needs HTTPS certificates enabled for the tailnet. Inspect with
  `serve status --json` first so a user's own serve config is never overwritten;
  undo with `serve reset`.
- Public link: `tailscale funnel --bg PORT`, only on ports 443, 8443 and 10000,
  needs the `funnel` node attribute in the tailnet policy.
- Addresses and checks: `tailscale ip -4`, `whois`, `ping`.

**Do not run** `up`, `login`, `logout`, `serve` or `funnel` while testing on a
developer machine: they change the user's network. Fixtures must be synthetic,
since a real `status --json` holds tailnet names and peers.

**Login UX** goes in the existing remote-link section with no new settings page,
and gets a mock before it is built.

## Tests (CI is the compiler; local cargo builds are off)

Pure protocol tests, plus integration tests in `tests/` that run the real detached
binary: kill the client and reattach with the same pid and consecutive output;
stalled client blocks the child; drain with the gap flag; start race; SIGTERM
leaves no orphans. Existing `pty.rs` tests must pass with the switch off.
Bridge continuity: `ctx_socket::tests` (private modes, a held lock refuses a
second claim without unlinking, a stale socket is replaced, a relaunch answers
at the same path over HTTP), `pty::tests` (adoption from an in-process host
makes the held token name the terminal again, lineage included),
`context::tests` (a token minted on one bridge
names the same terminal on a fresh bridge fed only the verifier; wrong tokens,
duplicates and malformed verifiers refused), `pty_hosted::tests` (verifier in
the metadata, lineage stored and read back from an in-process host). macOS CI
runs the first and last of these as well.

## Non-goals

Survival across reboot; surviving a host crash; tmux compatibility; fd passing to
a new host; Windows in this PR.

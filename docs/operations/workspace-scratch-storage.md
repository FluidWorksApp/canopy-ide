# Workspace scratch storage

Managed Linux workspaces mount private VM-root storage at `/scratch`. Persistent
project, home, and account volumes retain their existing storage and identity.
No persistent disk expansion or database migration is part of this change.

## Host and runtime layout

`canopy-host.service` provisions `/var/lib/canopy-scratch` through systemd
`StateDirectory`. This directory remains writable with `ProtectSystem=strict`,
including when a managed bootstrap overrides `ReadWritePaths` for host state.
The default path must be on the host root filesystem; startup refuses a separate
mount there rather than silently using the retained data disk.

The host creates a directory and a Docker local bind-backed volume for each
owner/storage identity. Owners, members, and collaboration runtimes get distinct
scratch volumes. A member's directory survives grant-generation changes through
its stable storage identity, without sharing the owner's scratch.

The root of each private directory has mode 0700 and is assigned to the runtime's
uid/gid 1000 by a restricted helper. Container creation and reuse validate the
exact volume labels, bind-device path, mount identity, and environment. There is
no mount of the host root, other members' directories, or the Docker socket.

## Tool defaults

| Variable | Default |
| --- | --- |
| `CANOPY_SCRATCH_DIR` | `/scratch` |
| `TMPDIR` | `/scratch` |
| `XDG_CACHE_HOME` | `/scratch/cache` |
| `NPM_CONFIG_CACHE` | `/scratch/cache/npm` |
| `PIP_CACHE_DIR` | `/scratch/cache/pip` |
| `UV_CACHE_DIR` | `/scratch/cache/uv` |
| `CARGO_TARGET_DIR` | `/scratch/build/<session-hash>/cargo` |

The runner validates and creates cache/build directories before accepting work.
A configured but unavailable scratch mount fails startup; symlinks cannot
silently redirect directory creation into persistent storage. PTY sessions
receive these defaults even when they use an account-specific home. Explicit
command environment overrides remain possible. Cargo output directories are
separate per session, including for commands typed later into a bare shell.

`TMPDIR` grants the private scratch root in Codex's default workspace-write
sandbox. User or managed policies that exclude TMPDIR still apply; this does not
remove sandboxing or bypass approval restrictions.

Absolute terminal file paths under `/scratch` open directly in the Canopy editor,
including line references. File reads, stats, and editor writes permit the private
scratch root with realpath checks; symlinks into `/home`, `/accounts`, or `/etc`
remain blocked. Project execution and repository operations stay workspace-only.
Remote links do not use the local image-staging route.

npm cache configuration does not move `node_modules`; Python cache settings do
not move virtual environments. Build systems with repository-relative outputs
still need their output-directory configuration. Do not move a live database.

The common Canopy agent bootstrap explains how to use `CANOPY_SCRATCH_DIR`, when
scratch is available, and which data must remain persistent. It reaches existing
MCP instruction delivery, generated context files, and the oh-my-pi bootstrap.
An agent without an installed Canopy instruction integration still receives the
tool environment, but does not gain a new integration through this feature.

## Stop, restore, and upgrades

Scratch is disposable. After successful container shutdown, snapshot preparation
removes only the managed scratch directories before trimming/snapshotting the VM
root. A failed container-stop step skips scratch cleanup. This keeps temporary
builds and reproducible data out of paid snapshots. Scratch directories are
recreated when the runtime is started on a replacement host.

Existing containers without scratch remain usable with their original mounts;
this feature does not stop or recreate live jobs. Normal journaled image
replacement provisions scratch on the replacement container and keeps existing
persistent volumes and rollback behavior. Updating host code alone does not add
mounts to a running container. Ship both the host runtime and workspace image.

Portable hosts can explicitly configure `CANOPY_WORKSPACE_SCRATCH_ROOT` and must
provision a real directory accessible to the host service. Managed services use
the default VM-root directory. Scratch has finite shared VM-disk capacity; this
change adds no per-workspace quota or automatic capacity expansion.

## Verification

Run `npm run test --workspace @canopy/remote-host` and the standalone instruction
module tests (`rustc --test src-tauri/src/agent_instructions.rs`). Scratch tests
cover ownership, member isolation, foreign bind-device rejection, symlink
rejection, environment delivery, separate build directories, legacy containers,
and cleanup ordering. Real managed-host rollout also needs a Docker/systemd
smoke: verify `/scratch` and `/workspace` use different devices on retained-disk
hosts, write a build/cache file as uid 1000, and verify persistent files survive
runtime replacement while scratch can be recreated.

# Local managed-workspace replica

A local stand-in for a Canopy managed workspace host on Lightsail. It runs the
real control plane and the real host boot. Fixes to host bootstrap, runtime
packages and lifecycle code are verified here before anything reaches paid
cloud compute. It needs Docker only: Docker Desktop on macOS (arm64 or x64),
or a Linux runner.

```sh
# Current production pair: website main + runtime 7b23e25, plain resume of an
# existing retained-disk workspace
npm run replica -- --runtime 7b23e25 --scenario resume

# Any canopy-ide ref (built with package-host-release.sh when no CI artifact
# exists) against any canopy-website ref
npm run replica -- --runtime origin/fix/x --website origin/fix/x \
  --image ghcr.io/fluidworksapp/canopy-workspace@sha256:… --scenario resume

# Storage flags
npm run replica -- --runtime <ref> --flags snapshot,migrate,warmup --scenario migrate

npm run replica -- --clean   # remove leftovers of --keep / interrupted runs
```

`--runtime` accepts:

- a commit or ref (the CI artifact `workspace-release-<sha>` is downloaded with
  `gh` when one exists, otherwise the package is built from that commit);
- a `workspace-host.tar.gz`;
- an artifact directory.

`--website` is a canopy-website ref, taken with `git archive` from
`--website-repo`, which defaults to `../canopy-website`.
`--website-dir` uses a working tree instead.

The exit code is non-zero when the scenario fails. The failing operation phase,
the bootstrap stage reported to `/api/bootstrap-report`, the last error, the
tail of the host's bootstrap output and the relevant journal lines are printed.
Everything is kept under `~/.cache/canopy-replica/runs/<run>/`:

- the host journal before every stop and delete;
- `cloud-init-output.log`;
- the exact bootstrap script the host downloaded;
- the control plane log;
- provider events;
- the `workspace_operation` rows.

## Scenarios

The scenarios are driven through the same API calls the desktop app makes
(`/api/workspaces`, `/api/operations` with `resume`, `advance`, `hibernate`,
`retry` and `connect`, plus the status poll).

| scenario | steps |
| --- | --- |
| `new` | Create a workspace and start it. The disk is left blank, as Lightsail creates it. |
| `stop` | Create, start, stop (hibernate). |
| `resume` | Create, start, stop, then start again: the daily path of an existing retained-disk workspace. |
| `retry` | Create and start; if the start fails, use Retry, which replaces the host. |
| `migrate` | Start and stop with the flags off. Restart the control plane with the flags on. Then start (moves to snapshot storage), stop (TRIM and snapshot), and start from the snapshot (warm-up). |
| `share` | Whole-workspace sharing. The owner shares with a team, and the member connects. The member never sees the owner's home. A viewer is read-only. After an owner restart the member reconnects with no owner action. An attestation failure is shown to the owner and member, and Retry recovers it. |

The `retry` scenario takes `--first-runtime`, `--first-website` and
`--first-image`. With them, the first start runs on another release (for
example the broken production pair), and the control plane switches to the
fixed release before Retry, as a rollout would.

`--prebuilt-like`, `--pending-upgrade`, `--apt-during-pull` and
`--resume-image <digest>` model first-boot package maintenance on a factory
snapshot host:

- `--prebuilt-like` preinstalls Docker, containerd, runc and Caddy and leaves
  them disabled.
- `--pending-upgrade` adds an apt source that publishes this machine's
  containerd package with a higher version as an Ubuntu `noble-security`
  update.
- `--apt-during-pull` lets the apt upgrade timer elapse when the start reaches
  the image stage, if the host left the timer armed.
- `--resume-image <digest>` ships a new image between the stop and the resume,
  so the resumed host really pulls.

`--stale-apt-timers` backdates the apt timer stamps. systemd then catches
apt-daily and apt-daily-upgrade up at boot, as on a host restored from an
older snapshot.

Every scenario except `new` pre-formats a new data disk as `mkfs.ext4 -L
canopy-data`, the same command the bootstrap's own first-boot branch would run.
The reason is the new-workspace failure below. Pass `--preformat 0` to leave
disks blank.

## What runs for real

- **Control plane.** canopy-website at the given ref, unmodified:
  - `api/*.ts` handlers, run by Node's type stripping behind a small Vercel
    request/response adapter;
  - worker, reconcilers, lifecycle and host replacement;
  - bootstrap-script and bootstrap-report endpoints;
  - runtime release preflight;
  - readiness and storage-prep calls to the host;
  - the one-minute cron (`/api/reconcile`).

  It uses its own throwaway PostgreSQL 17 container. The schema comes from
  `database/ORDER` and then `migrations/*.sql`. The seed is one verified user
  with a desktop device token.
- **Host.** A privileged container whose PID 1 (`host/bin/replica-init`)
  loop-mounts the instance's ext4 boot disk and hands over to systemd, like
  firmware handing over to a kernel.
  - cloud-init runs the generated user data loader once per instance.
  - The loader downloads the real bootstrap over HTTPS from the control plane,
    as `canopyide.dev`.
  - The bootstrap runs as root and does all of its real work: masks docker,
    runs `apt-get` (cold path) or factory verification, discovers and mounts
    the attached disk, sets swap, downloads the runtime from the presigned
    "S3" URL and checks its sha256, runs `npm ci`, installs units, starts
    containerd and docker, pulls the image with `image-release.mjs`, starts
    host services and checks local readiness.
  - The disk is real ext4 on a block device. Nested Docker 29 / containerd 2.2
    run with overlayfs and the systemd cgroup driver. canopy-host runs as its
    own user under the shipped units, behind Caddy on :443.
- **Provider.** Lightsail is replaced at the SDK boundary.
  `control-plane/local-lightsail.mjs` answers the same commands that
  `lib/canopy/lightsail.mjs` sends, with Lightsail's asynchronous states
  (pending, stopping, in-use and so on) and error names:
  - an instance is a host container;
  - a disk is a sparse file attached as a loop device (hot attach and detach);
  - an instance snapshot is a sparse copy of a stopped instance's boot disk;
  - restoring from a snapshot boots that copy with a new cloud-init instance id.

## Local-only differences (everything that is not production)

| Production | Replica | Why |
| --- | --- | --- |
| Lightsail, Route 53, S3 SDK clients | `control-plane/local-*.mjs`, swapped in by module hooks (`hooks.mjs`) for imports from website `lib/` and `api/` only. The S3 client is the real SDK (it signs the real virtual-hosted URL) except `send()`, which answers HeadObject from the local package. | No cloud. |
| Public DNS and TLS for `canopyide.dev`, the runtime bucket and `ghcr.io` | Docker network aliases or `--add-host`, and a local CA (`~/.cache/canopy-replica/ca`). Hosts trust it through the OS store and `NODE_EXTRA_CA_CERTS` (a systemd `DefaultEnvironment`). The control plane trusts it through `NODE_EXTRA_CA_CERTS`. | No public names. |
| Workspace hostname with a Let's Encrypt certificate | `CANOPY_WORKSPACE_DOMAIN=replica.localhost`. Caddy issues from its own local CA, and the stand-in provider adds that root to the control plane's trusted roots once the host has issued it. Readiness still pins the observed instance IP and verifies the hostname. | No ACME. |
| S3 presigned GET | Served by the control plane container at the bucket hostname. The signature is not verified. The host still checks the sha256. | No S3. |
| ghcr.io | A local registry seeded with exact copies of the release index and this machine's platform manifest and layers (digests preserved). | Speed and reliability: ghcr drops long blob downloads. |
| EC2 metadata user data | cloud-init NoCloud seed (`host/cloud.cfg`). | No IMDS. |
| NVMe disks seen by `lsblk` | `lsblk` is diverted to `host/bin/lsblk`. It answers the bootstrap's three queries from the instance's own loop devices and passes every other query to the real lsblk. | Loop devices have TYPE `loop`, and the Docker VM's other devices are visible. |
| Swap | `swapon` and `swapoff` are diverted to shims that validate the signature and account for the swap without activating it. `mkswap` and `fallocate` are real. | Swap is kernel-global and would leak into the shared Docker VM. |
| udev | Absent (`/dev/disk/by-uuid` is missing). | The VM owns device events. |
| Docker base-image tweaks | Removed: `policy-rc.d` (which blocks service restarts from package scripts), the apt periodic disable and the dpkg doc excludes, so package maintenance behaves as on a cloud image. | Fidelity. |
| Instance memory and CPU | Container limits sized from the bundle and capped by the Docker VM. `/proc/meminfo` shows the VM total. | Shared kernel. |
| `vm.swappiness` | Set for real by the bootstrap. Restored on cleanup. | Global sysctl. |
| Prebuilt host snapshot (factory) | On arm64 the cold bootstrap path runs (`apt-get install docker.io caddy`, NodeSource Node 22, `npm ci`). Package versions are Ubuntu noble-updates on the day, not the factory pins. | `factory-metadata.mjs` and `selectHostSnapshot` accept amd64 and x64 only. |

`host/bin/replica-observer` is a replica-only unit that only reads. It logs
every mode or owner change under `/run/canopy` and saves the downloaded
bootstrap script, so the evidence shows the exact script and ordering.

## Findings the replica surfaced

- **canopy-host crash-loops at bootstrap stage `host-services` with `EACCES`
  on `/run/canopy/resource-admission.lock`** (production, 2026-10-07).
  - The bootstrap ran `mkdir -p /run/canopy` under `umask 077`, which leaves
    the directory root 0700. The observer records `/run/canopy 700 root:root`
    before canopy-host starts.
  - Runtimes from #557 (5fc6fa8) onward open the lock as the `canopy-host` user
    at gateway start (`recoverMigrations` → `withResourceLock`), and the
    website bootstrap has set `CANOPY_RESOURCE_ADMISSION_LOCK` since #32.
  - It reproduces identically with website 9d9db31 and a6f8b33, with runtimes
    7b23e25 and 34d0550, and on the first start as well as a resume.
  - It is fixed by website 8bad4d3 (`systemd-tmpfiles` creates the directory
    0755) and runtime 63e3f84 (`ExecStartPre=+systemd-tmpfiles`).

- **A new workspace always fails at bootstrap stage `storage` with "Retained
  storage has no filesystem; refusing to format".** The worker records
  `workspace.disk_name` in the `creating-compute` pass, and
  `bootstrapScriptFor` regenerates the script from that row when the host
  fetches it later. As a result, the `mkfs` branch for a blank disk
  (`w.disk_name` unset) is never taken. Reproduce with `--scenario new`.
  canopy-website #56 (12d2b3b) fixes it: `new` passes, and a resume still
  refuses to format a retained disk.
- **A containerd security update applied by unattended-upgrades during the
  image pull restarts containerd under dockerd, and the pull fails.** The
  error is "failed to extract layer … Unavailable" or "failed to send write:
  EOF". Reproduce with `--prebuilt-like --stale-apt-timers --pending-upgrade
  --apt-during-pull --resume-image <other digest> --scenario resume`. It
  fails on website main ac9a4e2 and passes on canopy-website #58, which stops
  the apt timers, waits for apt jobs and starts containerd and Docker once.
- **First-boot package maintenance overlaps the image stage.** With stale
  timer stamps, `apt-daily-upgrade.service` started 65 s after boot, 0.3 s
  before containerd and dockerd started for the image pull. A containerd
  upgrade at that point restarts containerd under dockerd.
- **`database/ORDER` omits `migrations/shared-runtime.sql`.** That migration
  adds `workspace.sharing_generation`, and every worker pass reads it, so a
  database built from `ORDER` alone fails every operation.

# Workspace host rollout: every release reaches every workspace

Status: proposed, 2026-10-28. Not yet reviewed.

A Canopy release changes three things: the desktop app, the workspace container
image, and the **host runtime** (`workspace-host.tar.gz`: the gateway in
`/opt/canopy-host`). Native commands such as `git_sync_probe` are not answered
by the gateway: it passes `/native` to the runner in the owner's container
(`gateway.mjs` → `runtime.nativeUrl`; the image runs `node runner.mjs`, which
imports `native.mjs`). So the protocol the app talks to changes with the
container's image, not with the host runtime. Only the app updates itself. The image follows the `:stable` tag CI promotes, but
the host reaches production only through hand-edited Vercel environment
variables, nothing records which release a
workspace runs, and the app learns a host is old only when a command fails. This
design makes a release reach cloud workspaces without anyone running steps by
hand, and makes Canopy offer the update instead of reporting an error.

## Where things stand (prod, read 2026-10-28)

| Fact | Evidence |
|---|---|
| Newest host archive in the release bucket is 0.4.11 (`e5f97883`), uploaded 10-27 05:14 UTC | `s3://canopy-runtime-…/releases/` |
| No 0.5.0, 0.5.1 or 0.5.2 host archive exists anywhere | same listing. The three `Workspace image` runs on 10-27 passed and left their archive only as a GitHub artifact |
| The release pointers were created 19–23 days ago. Their values were not read, and Vercel's listing may not show later edits | Vercel production env: `CANOPY_RUNTIME_KEY` and `CANOPY_RUNTIME_SHA256` 19d, `CANOPY_HOST_SNAPSHOTS_JSON` 21d, `CANOPY_WORKSPACE_IMAGE` 23d |
| Both live workspaces last resumed before 0.5.0 | `workspace_operation`: kasii 10-23, Coraa Workstation 10-08. On 10-26 Coraa Workstation's manifest said `1bb018af`, a 10-13 commit, and it also carries hand-installed host files. So it was changed outside any recorded operation, which is part 2's point |
| The container image is automatic | `/api/runtime-policy` resolves `CANOPY_WORKSPACE_IMAGE_CHANNEL` (`:stable`) to a digest on each call (`workspace-image-channel.mjs`) |
| A new runtime needs no new snapshot while the lock is unchanged | canopy-website `main` accepts a snapshot whose `lockSha256` matches `CANOPY_RUNTIME_LOCK_SHA256`. The only snapshot (`canopy-host-b24fca1aa586-…`, ap-southeast-1) has lock `ae34e6b8…`, the same as 0.5.2 |
| 2026-10-28 09:00 UTC: 0.5.2 host deployed by hand | `releases/4a8022ad…/workspace-host.tar.gz` uploaded (sha `82076682…`), `CANOPY_RUNTIME_KEY`/`SHA256`/`LOCK_SHA256` set, prod redeployed. Running workspaces keep their old host until resumed or updated in place |
| The host snapshot workflow has never run from CI | `host-snapshot.yml` has no runs. Snapshots were built from a laptop with `scripts/host-factory` |
| `packages/remote-host/package-lock.json` has not changed since 10-09 | `git log` |

So a restart cannot deliver 0.5.x today: resume creates a fresh VM from the
snapshot and downloads whatever runtime the Vercel env names, and no 0.5.x
runtime exists for it to name.

Facts the design relies on:

- Resume always creates new compute (`PHASES.resume` starts with
  `create-compute`). Hibernate deletes it. Disks are kept.
- Bootstrap downloads the runtime archive and checks its hash even on a
  prebuilt snapshot, then untars it over `/opt/canopy-host`
  (`bootstrap.mjs`). The snapshot only supplies Node, Docker, Caddy and
  `node_modules`, and the lock hash keeps those `node_modules` honest.
- The host already calls the control plane every 30 minutes to learn the
  current image (`release-prepull.mjs` → `/api/runtime-policy`) and pre-pulls
  it.
- Updating a running host in place works. On 10-26 a swap of the files in
  `/opt/canopy-host` plus `systemctl restart canopy-host` kept the owner's
  container running. It also **stopped member containers** (SIGTERM, exit
  143), which came back on the members' next open. A gateway swap alone does
  not change the native commands the owner's container serves.
- Moving a container onto a new image already exists: `upgradeRuntimeImage`
  (`image-upgrade.mjs`) replaces a stopped container with one on the release
  image, journals the step, and restores the previous container if the new one
  is not ready. Resume uses it today.

## 1. Publish: a release reaches prod without manual steps

**Release record instead of env vars.** Add a `workspace_release` table to the
control plane:

| column | meaning |
|---|---|
| `revision` | full git SHA (primary key) |
| `image` | `ghcr.io/…/canopy-workspace@sha256:…` |
| `runtime_key`, `runtime_sha256` | `releases/<revision>/workspace-host.tar.gz` and its hash |
| `lock_sha256` | hash of `packages/remote-host/package-lock.json` |
| `host_protocol` | `HOST_PROTOCOL` in that revision |
| `app_version` | the Canopy version released with it, if any |
| `state` | `candidate`, `active`, `retired` |
| `registered_at`, `activated_at`, `activated_by` | audit |

Exactly one row is `active`. `bootstrap`, `/api/runtime-policy` and
`createInstance` read the active row. The four Vercel variables stay as the
fallback until the first row is active, then are removed. Changing a release no
longer needs a redeploy.

**CI publishes and registers.** After the existing boot test and artifact upload
in `workspace-image.yml`:

1. Upload `workspace-host.tar.gz` to `releases/<revision>/` with its SHA-256 as
   object checksum metadata. CI assumes an AWS role through GitHub OIDC that can
   only `PutObject` under `releases/*`, mirroring the read-only grant the
   compute identity already has. No long-lived AWS keys in GitHub.
2. Register the release as a `candidate` with `POST /api/releases`,
   authenticated by the GitHub OIDC token (audience `canopyide.dev`, repository
   and `refs/heads/main` checked). The body is `workspace-release.json` plus
   the archive hash.

**Activation.**
- **When.** Activation happens when the desktop release workflow for a version
  tag finishes, so workspaces move with the app version that needs them. The
  `promote` input on manual runs keeps a way to activate without a release.
- **Snapshot check.** Activation is refused unless every region with live
  workspaces has a snapshot whose `lock_sha256` matches. Otherwise the previous
  release stays active and a failed resume is impossible.
- **Lock changes.** When the lock did change, CI runs `host-snapshot.yml` with
  the same revision and activates once the snapshots are verified.
- **Snapshot rule.** Port the lock-match rule from
  `packages/control-plane/lib/host-snapshot.mjs` to canopy-website so that a
  runtime change alone never needs a new snapshot. Then make canopy-website
  consume `packages/control-plane` instead of a copy, so the two cannot drift
  again.

**Rollback.** `POST /api/releases/<revision>/activate` on an older `active` or
`retired` row. Only owners of the Canopy deployment can call it, and every call
is written to the audit columns.

## 2. Know who runs what

**The host reports its release.** On each `/api/runtime-policy` call, which it
already makes on start and every 30 minutes, the gateway sends:
- `revision`: from its own `/opt/canopy-host/workspace-release.json`;
- `runtimeSha256`: the installed archive's hash, which the installer writes to
  `/opt/canopy-host/workspace-runtime.sha256` (the manifest is inside the
  archive, so it cannot carry it);
- `protocol` and `image`: what the owner's running container serves, its
  release image digest and the `HOST_PROTOCOL` its runner answers to
  `host_capabilities`. This is the protocol the app talks to; the gateway's own
  `HOST_PROTOCOL` is not reported.

**The control plane keeps it.** New `workspace` columns:
- `host_revision`
- `host_protocol`
- `runtime_image`
- `host_reported_at`

The hand-patched Coraa Workstation reports `1bb018af`, which is true of its
manifest. A field records that its files have since changed:
`host_modified=true`, set when the archive hash and the installed files differ.
The gateway can check that at start.

**Everyone can see the state.** Two places report it:
- The workspace list API returns `update: {state, available, reason}`:
  - `current`: the host runs the active release.
  - `available`: a newer release is active and this host still works with
    this app.
  - `required`: the container's protocol is older than the app needs.
  - `unknown`: the host has not reported since this column was added.
- The app asks the container's `host_capabilities` for its protocol when the
  list has no report (control plane unreachable).

## 3. Offer the update in the app

**Notice instead of error.** The one-time error notice
(`hostOutdatedMessage`) becomes a workspace update notice with a button:
- **Available:** "A newer Canopy host is ready for <workspace>." Buttons:
  **Update workspace** and **Later**. It shows once per release in the
  Workspaces panel, plus a dot on the workspace chip. It is not an error.
- **Required:** "<workspace> needs an update to use <feature> and other parts of
  this version." Buttons: **Update workspace** and **Not now**. The feature
  named is the first one that failed, with background probes leaving it out.
  It keeps showing until the workspace is updated, without repeating as a toast.

**Update workspace** starts a control-plane operation, `update-host`, with the
same request-key, confirmation and progress handling as hibernate. It picks the
lightest path that delivers the active release.

*Update in place* is the default when the release's lock hash matches what the
host already has. It never touches the VM, and does two steps, each only when
needed, in this order:

(a) Gateway, when the active release's runtime differs from the installed one:
1. The control plane checks that the active release's `lock_sha256` matches
   the host.
2. The host downloads the archive through a presigned URL and checks its hash.
3. It unpacks the archive next to `/opt/canopy-host`, keeps the previous tree,
   and switches by rename.
4. It restarts `canopy-host`.
5. If readiness (`MANAGEMENT_READINESS_SCRIPT`) fails within 2 minutes, it
   switches back to the previous tree, restarts again, and reports the failure.

(b) Owner container, when its image differs from the release image. This is
the step that fixes `required`, because the container serves native commands:
1. Members' containers stop (they move to the release on their next open).
2. The owner's container stops, and is moved onto the release image the same
   way resume does it (`upgradeRuntimeImage`): the previous container is kept
   until the new one is ready, and restored and started again if it is not.

Terminals and agents in the workspace restart; files, projects and volumes are
kept. When members are connected the confirmation says so first, the same way
`confirmOthers` does for hibernate.

*Full refresh* runs hibernate then resume. It is used only when the lock
changed. The confirmation says that the workspace will shut down and
start again, that files and projects are kept, and that agents and terminals
stop. It is never chosen without that confirmation.

Neither path replaces compute without the person pressing the button.

**Automatic updates.**
- A workspace that wakes from hibernation already gets the active release,
  because resume creates a fresh VM. Once part 1 exists, this needs no new
  code.
- Settings → Workspaces → **Update hosts automatically when idle**, off by
  default:
  - It runs the in-place update when the workspace has been idle past its
    hibernate timeout and no member is connected.
  - It never runs a full refresh.

## Rollout order

1. **Unblock 0.5.2 by hand now.** Use the existing procedure:
   - Upload the `4a8022ad` archive from run 40550192624.
   - Set `CANOPY_RUNTIME_KEY` and `CANOPY_RUNTIME_SHA256`.
   - Rebuild the ap-southeast-1 snapshot, because the deployed snapshot rule
     needs it. The lock has not changed, so porting the lock-match rule first
     would avoid this step.
   - Pin `CANOPY_WORKSPACE_IMAGE` to the 0.5.2 digest.
   - Redeploy.
   - Hibernate and resume kasii.
   - Coraa Workstation: in-place swap only, never a VM replacement. Its
     hand-installed fixes (a7bf9f53, b7932c59, 55e2d456) are all in 0.5.2.
2. **Part 2.** It is the smallest piece and makes every later step visible.
3. **Part 1.** Release table, OIDC upload and registration, activation, the
   snapshot rule port.
4. **Part 3.** The in-place update first, then the automatic setting.

## Open questions

- **Activation trigger.** Should activation follow the desktop version tag, or
  every main merge as `:stable` does now? Following the tag keeps hosts and
  apps in step. Every merge ships host fixes sooner.
- **Hosts newer than the app.** A host newer than the app is already tolerated
  (the host is a superset), but a host release that drops a command would
  strand older apps. Should the release record carry a minimum app version?
- **Members.** Can a member trigger an update, or only the owner? This design
  assumes owner only, and members see "ask the owner to update".
- **Image in place.** Decided (2026-10-28): update in place moves the owner's
  container onto the release image (step b), because that is where native
  commands run. The VM is never replaced by it.

## Implementation contract (2026-10-28)

Both repos build against this. canopy-website is the deployed control plane;
`packages/control-plane` in this repo is a partial mirror and is not deployed.

**Release bucket.** `releases/*` is write-once: every `PutObject` must send
`If-None-Match: *` (bucket policy `ReleasesAreWriteOnce`), and nothing there can
be deleted. Upload with `--checksum-sha256 <base64>` and metadata
`sha256=<hex>`. A `412 PreconditionFailed` means the object already exists:
verify its `ChecksumSHA256` matches and continue.

**CI identity.** GitHub Actions OIDC. The AWS role
`arn:aws:iam::703671915771:role/canopy-release-publisher` trusts
`repo:FluidWorksApp/canopy-ide:ref:refs/heads/main` and may only
`s3:PutObject` / `s3:GetObject` on `canopy-runtime-703671915771/releases/*`.
The control plane accepts a GitHub OIDC token with `aud=https://canopyide.dev`,
`iss=https://token.actions.githubusercontent.com`,
`repository=FluidWorksApp/canopy-ide`.

**Control plane API (canopy-website).**
- `POST /api/releases` (OIDC, `ref=refs/heads/main`). Body
  `{revision, runtimeKey, runtimeSha256, runtimeLockSha256, image, hostProtocol}`.
  The server HEADs the S3 object with the compute credentials and checks size
  and SHA-256 before inserting a `candidate` row. Idempotent per revision.
- `POST /api/releases/activate` (OIDC, `ref=refs/tags/v*`). Body
  `{revision, appVersion}`. Refused (409) unless the row exists and every region
  with a live workspace has a snapshot whose `lockSha256` equals the release's,
  or the region has no snapshot (cold bootstrap). Sets it `active`, retires the
  previous one.
- Active release resolution: one function returns
  `{revision, runtimeKey, runtimeSha256, runtimeLockSha256, hostProtocol}` from
  the active row, falling back to the `CANOPY_RUNTIME_*` env when the table is
  empty. Bootstrap, runtime preflight and snapshot selection use it.
- `/api/runtime-policy` request body carries
  `host: {revision, protocol, runtimeSha256, image}` (any field may be null):
  `revision` and `runtimeSha256` are the gateway tree's; `protocol` and
  `image` are the owner container's (the `HOST_PROTOCOL` its runner answers,
  and its release image digest `ghcr.io/…@sha256:…`). The server stores it on
  the workspace (`host_revision`, `host_protocol`, `host_runtime_sha256`,
  `runtime_image`, `host_reported_at`). The response adds
  `hostRelease: {revision, protocol, runtimeSha256, runtimeLockSha256}`.
- The workspace list the app reads adds
  `host: {revision, protocol, image, reportedAt} | null` and
  `release: {revision, protocol, image}`. The app decides `current` /
  `available` / `required` itself, by comparing `host.protocol` with its own
  `HOST_PROTOCOL` and `host.revision`/`host.image` with the release.
- Update in place is asynchronous, carried by two management-recovery actions
  on the existing encrypted recovery channel. The owner's request
  (`POST /api/operations` `{action:'update-host', workspaceId, requestKey,
  clientId, confirmOthers?}`; members get 403) creates an `update-host`
  operation that moves through three phases:
  1. **dispatch**: send `update-host` with the payload `{updateId, url,
     runtimeSha256, runtimeLockSha256, revision, image}` (presigned URL, 1 h;
     `image` is the active release's digest reference). The recovery agent
     writes the payload to a root-only file, starts
     `systemd-run … node /opt/canopy-host/host-update-run.mjs <payload.json>`
     detached, and answers `{started:true}`, or `{code:'busy'}` while
     `/var/lib/canopy-host/host-update/current` names another update.
  2. **wait**: poll `update-host-status {updateId}`, which answers the
     contents of `/var/lib/canopy-host/host-update/<updateId>.json`. While it
     is `{state:'running', step}`, copy `step` to the operation's
     `context.updateStep` (`download` | `gateway` | `gateway-ready` | `image`
     | `rollback`), which the app shows. The gateway restarts during this
     phase, so a status call may fail and is retried.
  3. **complete**: on `{state:'done', code, host, image, detail}` the
     operation succeeds for `updated` and `current`, and fails with `detail`
     as `last_error` for `rolled-back`, `failed`, `invalid` and
     `refresh-required`. With no `done` status 20 minutes after dispatch, the
     operation fails ("The workspace update did not finish").
  The operation stays pending/running until complete: the app treats an
  `update-host` operation that has left pending/running, with the workspace
  `ready`, as finished, and then reconnects.

**Host (this repo, `packages/remote-host`).**
- The gateway sends `host` on every runtime-policy call
  (`host-release.mjs` `hostReport`, `DockerWorkspaces.ownerRuntimeReport`).
  Bootstrap must write the archive hash to
  `/opt/canopy-host/workspace-runtime.sha256`, or `runtimeSha256` is null.
- `host-update-run.mjs <payload.json>` (in the host archive) is what the
  recovery agent starts detached, as root. It runs
  `updateWorkspaceInPlace(payload, {ready, onStep})` from `host-update.mjs`
  with the management readiness check (`canopy-host` and `caddy` active,
  `http://127.0.0.1:8787/v1/workspaces` answering 401, as in
  `MANAGEMENT_READINESS_SCRIPT`), and writes its status atomically (temporary
  file + rename, mode 0600) to `/var/lib/canopy-host/host-update/<updateId>.json`:
  `{state:'running', step, updatedAt}` as each step starts, then
  `{state:'done', code, host, image, detail, updatedAt}`. `current` in that
  directory holds the update id while it runs and is removed at the end. Every
  run ends with a `done` status, including a crash (`failed`) or an unreadable
  payload (`invalid`, written as `invalid-request.json`).
- `updateWorkspaceInPlace` returns `{code, host, image}`, each step
  `{code, detail?}`, `code` being the worse of the two:
  `current` < `updated` < `rolled-back` < `failed`; `invalid` and
  `refresh-required` come from step (a) and skip (b). Steps reported:
  `download`, `gateway`, then `gateway-ready` or `rollback` for (a); `image`
  for (b).
  - (a) `updateHostInPlace`, only when the installed revision or archive hash
    differs:
    1. download to `/opt/canopy-host.download.tgz` and check the SHA-256;
    2. refuse when the archive's `package-lock.json` hash differs from the
       installed one (that needs a full refresh);
    3. unpack to `/opt/canopy-host.next`, move `node_modules` across, move the
       current tree to `/opt/canopy-host.prev`, rename `.next` into place;
    4. copy the units, `systemctl restart canopy-host`, wait for the
       management readiness check (2 min);
    5. on failure restore `.prev`, restart, report the failure.
  - (b) asks the gateway over `/srv/canopy/host-state/host-admin.sock`
    (`POST /v1/owner-image {image}`, mode 0600, never behind Caddy), which runs
    `DockerWorkspaces.updateOwnerImage`: no change when the owner container
    already runs that image; otherwise stop members, stop the owner, resume it
    onto the release image through `upgradeRuntimeImage`, and restart the
    previous container if the new one is not ready.
  - The runner is its own transient unit, so the recovery agent's
    `ProtectSystem=strict` does not apply to it; the agent itself only needs to
    write the payload file and read `/var/lib/canopy-host/host-update`.

**CI (this repo).**
- `workspace-image.yml`, after `:stable` promotion on `main`: assume the
  role, upload the archive write-once, then `POST /api/releases`.
- `release.yml`, on a `v*` tag: `POST /api/releases/activate` for the tag's
  commit, polling up to 30 minutes for the image workflow to register it.

**App (this repo).** The one-time "older Canopy host" error becomes the update
notice in part 3: **Update workspace** calls the control plane's
`update-host` operation (owner) after a confirmation that terminals and agents
restart and files are kept, asks again when other people are connected (by
count: the `others-connected` error has no names), polls the operation for up
to 20 minutes showing `context.updateStep` (downloading, restarting the
workspace host, updating the workspace, rolling back), shows `last_error` when
it fails, and reconnects when it finishes. A member sees "Ask the workspace
owner to update it." (the list has no owner name).

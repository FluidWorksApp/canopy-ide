# Prebuilt management hosts

Normal Lightsail hibernation deletes compute and retains the dedicated workspace
storage disk. Stopped Lightsail compute remains billable, so this process does
not keep stopped machines as a speed shortcut.

The source supports a prebuilt **management host**, separate from the public
workspace Docker image. It removes OS, Node and dependency installation from the
resume path. It does not establish a sub-60-second startup result: provider
creation, disk attachment and connection readiness still need live measurement.

## Factory and release

Run the manual **Prebuilt management host** GitHub Actions workflow with reviewed
JSON configuration, or explicitly invoke:

```sh
node scripts/host-factory/cli.mjs --execute reviewed-factory.json ready-catalog.json
```

This command creates temporary, billable factory compute. Configure a dedicated
OIDC factory role as `CANOPY_HOST_FACTORY_ROLE_ARN` in the
`management-host-factory` GitHub environment. Restrict that environment to reviewed
release code. No role, policy, cloud resource or snapshot is created merely by
checking in this source.

The non-secret configuration requires:

- `region`: Singapore, US East or Ireland's existing region ID.
- `architecture`: `amd64`, and `sourceBundle`: `medium_3_0` (the smallest supported
  workspace bundle; larger snapshots cannot be used to provision smaller plans).
- `revision`, `runtimeSha256`, `lockSha256`: the exact approved archive revision,
  archive checksum and remote-host `package-lock.json` checksum.
- `runtimeBucket`, optional `runtimeRegion`: the existing private runtime bucket.
  The default object key is `releases/<revision>/workspace-host.tar.gz`.
  Optional `runtimeKey` may select a reviewed immutable hotfix archive beneath
  that exact `releases/<revision>/` prefix, using a single safe `.tar.gz` filename.
  Its `runtimeSha256` must match the active verified archive. Never overwrite an
  existing canonical archive to publish a hotfix; keep its filename/checksum
  distinct and preserve the manifest's base source and host revision provenance.
- `image`: the tested immutable public Canopy workspace image digest.
- `nodeVersion`, `nodeSha256`: an exact Node 22 release and its verified official
  Linux x64 archive checksum.
- `dockerVersion`, `caddyVersion`: exact Ubuntu package versions, never `latest`.

The factory refuses hosts with another attached disk or workspace configuration.
It installs pinned dependencies, verifies archive/lock/Node hashes, performs an
isolated Docker smoke and a real loopback HTTP gateway smoke, then removes the
public smoke image. It never exports or reloads a multi-gigabyte Docker cache on
normal resume: that cache already lives on the retained workspace disk.

Before snapshotting it removes temporary gateway keys/state, user data, signed
URLs, cloud-init state/logs, SSH host keys and authorized keys, local credentials,
Docker root data and TLS certificate state. Docker, containerd and Caddy are
stopped and disabled. Fresh per-workspace user data must perform the existing
boot fence and storage mount before any Docker service is started.

Snapshots are created only after both smokes and sanitization pass and the builder
is provider-observed stopped. Preparation shares a 30-minute observation deadline.
A verified snapshot still pending at that deadline or a later observation outage
is preserved. The CLI exits with status 2, emits a private non-secret job handoff,
and publishes no ready catalog. Its stopped builder remains billable until the
same job is finalized; the workflow retains the handoff artifact.

Use the original reviewed config and that handoff to observe the same snapshot:

```sh
node scripts/host-factory/cli.mjs --finalize reviewed-factory.json ready-catalog.json ready-catalog.json.pending.json
```

The workflow also accepts the pending-job JSON in its optional `handoff` input.
Finalization creates no compute, key or snapshot. It checks the exact release,
job ownership and snapshot proof, then removes only its stopped builder and key.
A ready catalog is emitted only after independent reads confirm both are absent.
Pending asynchronous cleanup can be finalized again using the same handoff.
Other failures retain the existing scoped cleanup behavior; foreign resources are
never deleted. A cleanup failure cannot publish a ready catalog.

The workflow publishes the verified catalog artifact only after successful
cleanup. Setting `CANOPY_HOST_SNAPSHOTS_JSON` to that reviewed catalog activates
selection for its region. This is an explicit configuration promotion, not an
automatic production change. Repeat independently per supported region.

## Launch validation

Before creating a workspace instance, the provider reads the configured snapshot
and verifies exact ARN/name, region, available state, Ubuntu blueprint, source
bundle, architecture and factory release tags. Attached user disks, duplicate
or mismatched tags, unverified proof and a runtime checksum different from the
active release fail closed. A permission error never silently falls back to a
cold instance. Unconfigured regions retain the existing cold-bootstrap path.

The bootstrap must additionally validate `/opt/canopy-host/factory.json`, actual
Node/package versions and the immutable dependency lock before skipping install
steps. A marker alone is not an installation proof. Display cold versus prebuilt
startup based on that checked result; never advertise a measured 60-second result
before live evidence exists.

## Managed-compute IAM addition (review and apply separately)

The existing managed role does not yet have snapshot launch permissions. Scope
creation to the selected snapshot ARN. `GetInstanceSnapshot` does not support
resource-level permissions, so its read-only metadata access needs `Resource: "*"`
with the selected region condition. This grants no snapshot deletion or export.
See the [Lightsail authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_lightsail.html).
Substitute the actual account/region/ARN below:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "lightsail:GetInstanceSnapshot",
      "Resource": "*",
      "Condition": {
        "StringEquals": {"aws:RequestedRegion": "REGION"}
      }
    },
    {
      "Effect": "Allow",
      "Action": "lightsail:CreateInstancesFromSnapshot",
      "Resource": "arn:aws:lightsail:REGION:ACCOUNT:InstanceSnapshot/SNAPSHOT-ID",
      "Condition": {
        "StringEquals": {"aws:RequestTag/managed-by": "canopy", "aws:RequestedRegion": "REGION"},
        "StringLike": {"aws:RequestTag/canopy-workspace": "ws-*"}
      }
    }
  ]
}
```

Keep existing private `releases/*` object permissions unchanged. The separate
factory role needs create/read/stop/delete instance, temporary SSH access, and
create/read/delete snapshot actions scoped to its region and resources tagged
`managed-by=canopy-host-factory`; creation requires that request tag. It also needs
`CreateKeyPair`, `GetKeyPair` and `DeleteKeyPair` for this job's tagged
`canopy-factory-key-*` resource. The factory installs that temporary key on only
its builder, verifies provider host keys, and deletes the key after builder
cleanup. It does not download or use the account-wide default SSH key. Private
key material is kept in private temporary files and never enters user data,
snapshot metadata or the published catalog. Key cleanup failure blocks catalog
publication. Completed cloud-init without the smoke marker fails promptly and
cleans up instead of waiting for the global deadline. It needs
only GetObject on the private `releases/*` runtime prefix. Do not give these factory
controls or credentials to development containers.

## Validation

```sh
node --test scripts/host-factory/build.test.mjs packages/control-plane/lib/host-snapshot.test.mjs
node --test tests/host-snapshot-provider.test.mjs # companion website repository
```

These checks use injected/mock AWS adapters. They verify success ordering,
failed/uncertain cleanup, foreign-resource refusal, integrity/architecture/bundle
mismatches and permission errors. They do not prove a real snapshot can launch or
that resume is under 60 seconds. Factory execution, IAM activation and live timing
are separate remaining steps.

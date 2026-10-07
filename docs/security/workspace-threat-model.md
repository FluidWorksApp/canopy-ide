# Workspace and Teams security implementation

Status: implementation in progress, not release approval.

## Trust boundaries

A development container is hostile. Every environment variable, runner token,
credential file and response inside it is under the developer's control. A runner
token can identify traffic within that container, but cannot establish trusted
health, usage, membership or management authority.

The control plane owns identity, membership, infrastructure lifecycle and billing.
The host management service runs outside development containers. Its Docker
access is effectively host-administrator access and must never be mounted or
forwarded into them. Separate container homes alone are insufficient if credentials
or an execution service are shared across members.

## Inspected current implementation

- Account operations currently authorize the workspace owner. Team workspace
  grants must remain disabled until member-specific execution is implemented.
- Source supports short-lived member-bound claims and online authorization.
  Owner session issuance remains separate; team execution is not enabled yet.
- Gateway lives in a host systemd service; developer runner is in Docker.
  Docker socket and host configuration are not among the configured user mounts.
  This source observation is not proof of the deployed mount configuration.
- Existing IM encrypts each client-to-host transport. The relay host handles
  decrypted Chat frames. It is NOT sender-to-recipient encryption against a
  malicious relay host. Managed IM needs authenticated end-to-end envelopes.
- Runtime activity reports are user-controlled. They must not become billing
  evidence or authorization inputs. External activity/health validation remains
  necessary before claiming hostile-container resilience.

## Implemented in this pass

- Removed account-API plaintext message send/read implementation; requests fail
  closed. Existing database tables were retained, not destructively purged.
- Stream tickets carry the originating credential fingerprint and expiry.
  Gateway rechecks active streams every second and disconnects expired/revoked
  grants. Tickets remain single-use.
- Terminal input may travel on the session's stream socket. The gateway offers
  it (`hello` frame) only when the stream's principal holds the same grant the
  HTTP input route requires (drive scope; for shared sessions a live interact
  grant on a collaboration shell), re-evaluates that grant with the per-second
  stream check, and refuses input from view-only streams by closing them.
  Socket batches are size-limited (16 KiB), paced (64 KiB/s, 200 frames/s),
  backlog-bounded (128 KiB per socket) and deduplicated with HTTP resends by
  (principal, session, queue id, sequence).
- Host service crash restart budget: five starts in 120 seconds. Intentional
  systemd stop does not trigger Restart=on-failure. This is NOT redundancy,
  and does not yet provide hang detection or external recovery.

- Deployment source now includes all runtime dependencies and Docker COPY inputs.
- New container bridges have a reserved host interface prefix. A host-owned
  firewall blocks their access to host services, metadata and private networks.
  This is not deployed or verified with actual packets yet. Existing bridges
  require migration before they receive this protection; do not enable sharing
  on them based on the new source alone.

- Elastic resource observations now come from host kernel cgroup counters,
  bound to the Docker-inspected container ID and PID. No measurement script
  executes inside the development container. Unverified session activity stays
  unknown, preventing automatic shrink based on a forged idle response.
  This change has source tests but still requires live-host verification.

## Remaining gates

Local evidence added 2026-10-04: trusted project permissions are resolved per
project and intersected with the host catalog. Docker rejects changed mount
permissions on reuse. `smoke-project-sharing.mjs` verified shared source reads,
kernel-enforced read-only writes, and private homes with disposable containers.
`smoke-member-revocation.mjs` verified the host lease monitor stops one revoked
member without stopping a second container. Member containers do not auto-restart;
host startup stops unleased member containers before accepting requests. The
startup sweep is unit-tested, not yet verified on a deployed Linux host. These
checks do not cover project migration, credential brokering or IDE connection
renewal, and shared connections remain disabled pending those gates.

1. Member-bound tokens and online revocation, including propagating membership
   changes to host authorization. Current in-memory principal removal tests are
   not a deployed control-plane revocation test.
2. Isolated member runtimes with exact authorized project mounts and personal
   credentials; explicit shared credential execution grants.
3. Authenticated device keys, sender-recipient encrypted IM, durable endpoint
   replay counters/deduplication, peer discovery and opaque relay fallback.
4. Independent health and resource observations, bounded hang recovery and
   desired-state/generation fencing that honors intentional shutdown.
5. Hostile-container integration tests: credentials, forged responses, replay,
   cross-workspace authority, billing integrity, kill/hang and revoked access.
6. Verify updated binaries, real host configuration and two member sessions.

Gateway redirect validation: requests to the untrusted runner/native runtime now use redirect:error. A real loopback adversarial test returns HTTP 307 pointing at a separate simulated host endpoint; both gateway routes reject it and that endpoint receives zero requests. All six gateway tests pass. This closes redirect-based host request redirection; it does not establish complete runtime isolation or scoped project sharing.

Real Docker validation (2026-10-04): after removing the unused older canopy-workspace:0.1.0 build artifact and unused build cache, canopy-workspace:validation ran the disposable smoke-isolation.sh successfully. Actual engine checks cover private home/project volumes between two containers, absent Docker socket/host config, UID 1000, zero effective capabilities, no-new-privileges, non-writable installed runtime directory, memory.max=256 MiB and memory.swap.max=192 MiB, and survival of one member when the other is killed. Docker Desktop uses cgroupfs; aggregate systemd slice and real host network firewall checks are still outstanding. This is not evidence of complete shared project/credential brokering or redundancy.

Migration recovery checkpoint (2026-10-04): offline migration now requires a
host-owned, fsynced journal before checkpointing or replacing containers. Journal
creation is exclusive, mode 0600, with parent directory sync. Readback is bounded,
rejects symlinks and concurrent changes, and reports an incomplete final record.
Read-only recovery assessment compares the durable configuration with inspected
container identities and ownership; published configuration is not mistaken for
an unfinished replacement merely because the final journal write was interrupted.
Nine focused tests pass, including disk-write failure, rollback, interrupted
journal writes, conflicting ownership and publication-before-final-record. The
operator command, recovery execution and live-host migration remain outstanding.

Preservation smoke checkpoint (2026-10-04): both `smoke-owner-checkpoint.mjs`
and `smoke-project-migration.mjs` passed against the locally built
`canopy-workspace:integration-validation` image. Disposable Docker containers
proved writable-layer file preservation, an unchanged clean member image,
retention of the original container, and matching migrated project content with
the source mounted read-only. Test resources were removed by the harness. These
results do not establish recovery of the user's existing workspace or authorize
removing its original container or volumes.

Release verification checkpoint (2026-10-04, local only):

- The offline `inspect-migration.mjs` command now exists. It reads configuration,
  durable journal records, and Docker identities without mutating containers.
- Gateway startup reads `$CANOPY_HOST_STATE/migrations` and quarantines interrupted
  owner replacements before accepting requests. Completed records must agree with
  configuration and inspected container identities. Corrupt evidence fails closed.
- Cached owner/member connections and CPU/memory resizing cannot bypass migration
  quarantine. The remote-host suite passed 149 tests at this checkpoint.
- A subsequent publication-failure regression covers an atomic configuration rename
  followed by a failed durability confirmation. Both containers remain preserved and
  access is quarantined; automatic rollback cannot contradict the saved configuration.
  Fourteen focused migration tests passed after that change.
- Operational migration orchestration, live Linux host enforcement, explicit shared
  credential execution, and deployed two-member adversarial verification remain
  incomplete. These local results do not establish production security or redundancy.
- No runtime archive has been uploaded to the deployment bucket. Automatic approval
  review requires explicit user authorization for that upload. The existing user
  container has not been replaced or restarted by these release checks.

### Member Git attribution checkpoint — 2026-10-05

The trusted member-access endpoint now resolves Git name/email from the authenticated
member's account after checking the current access epoch and scope. The management
gateway overwrites request-supplied attribution for IDE commits and new terminal
sessions. Terminal sessions receive only the four Git author/committer variables;
Git repository config is not rewritten. Missing or malformed identity fails closed.
This provides per-member defaults and gateway-bound commit attribution. It does not
prevent a user with shell access from deliberately overriding Git authors, and it
must not be used as cryptographic proof of commit authorship.

Focused tests include forged request identity, absent trusted identity, environment
injection, invalid author headers, and a real Git commit showing independent author
and committer attribution while preserving repository-level identity. Shared Git
and agent credential execution is still incomplete. No live runtime was restarted
or deployed for these changes; existing terminal sessions retain their original
environment until the runtime is updated and new sessions are launched.

### Runtime readiness checkpoint — 2026-10-05

Gateway `/open` now probes the user runtime's authenticated terminal service before
reporting `connected`. Observation has a two-second timeout, refuses redirects,
bounds the response to 64 KiB, and validates a session-list shape. A hung process,
refused connection, invalid response, or oversized response cannot pass readiness.
This is an operational liveness check only: replies from the user runtime confer
no management permissions and never determine authoritative billing.

External automatic recovery is not complete. Owner containers still use the existing
Docker restart policy; durable bounded restart budgets and intentional-runtime-stop
handling must be added before claiming that recovery requirement. Provider-confirmed
machine shutdown already has a separate external observation path. No running VM
or container was touched in this checkpoint.

### Explicit resume and crash policy checkpoint — 2026-10-05

New owner and member runtimes use Docker `on-failure:3`, replacing the owner's
unbounded `unless-stopped` policy. Reuse validates the bounded retry policy. A stopped
container cannot be started by ordinary reads, streams, or background heartbeat
opens; only an explicit, authorized `/open` resume can start it. The IDE sends resume
intent when opening a workspace/project or deliberately retrying the connection.
Its periodic heartbeat does not send that intent. A viewer cannot request resume.

These are bounded consecutive crash retries, not redundancy or a durable rolling
recovery budget. Docker retry behavior, long-running hangs, and external supervision
still require live engine/host verification and further implementation. Existing
containers using the older policy are rejected for reuse until a controlled policy
update, rather than silently altering them while user agents run. No live container
policy was changed in this checkpoint.

### Trusted hang supervision checkpoint — 2026-10-05

The host runtime supervisor now observes registered runtimes independently of user
processes. Three failed probes sustained for 30 seconds precede recovery, with a
60-second cooldown and at most three durable reservations per container/configuration
identity. Reservation files live in host-owned storage outside developer mounts;
failed Docker actions still consume their reservation, and corrupt state blocks
recovery. Recovery signals only a still-running, owned container; it does not manually
start an exited container or replace user volumes. Member revocation disables the
Docker restart policy before stopping the runtime to cover daemon restart races.

Managed owner recovery additionally requires a fresh, short-lived trusted control-plane
policy check for the current workspace generation and running desired state. The
read-only policy credential cannot be used as a runtime control credential. New
bootstrap configurations include this authority and generation. Legacy managed
configurations without it cannot perform automatic owner hang recovery. This is
bounded recovery, not redundancy; user-runtime health replies remain untrusted for
billing, identity, and authorization.

The user authorized VM setup on 2026-10-05. Read-only SSM inspection found the original
home/project mounts preserved and root disk full; data storage has free capacity.
Automatic review again rejected private S3 runtime-bundle upload until the user
specifically approves its payload and destination. A specific approval question is
pending. No source has been uploaded or runtime activated by this checkpoint.

### Live VM runtime activation — 2026-10-05

The user specifically approved uploading the 739101-byte runtime archive to the
private `canopy-runtime-703671915771` bucket, at
`runtime-updates/20261005-runtime.tar.gz`, then separately approved restarting the
existing workspace container and host management service. The downloaded archive
passed SHA256 verification (`0ffd3d201b5a4e7a24f3e4f00612f09a0d03fbef60dce61b0c28b558ddfb35eb`).
Runtime backups remain locally on the VM data disk and agent configuration backups
remain in the existing home volume. Only identified generated Node core dumps in
`/var/lib/apport/coredump` were removed; root free space is now 28 GB.

SSM activation verification `860463d4-8e2b-4e33-bb9b-ec46a600a27b` passed:
the exact original container ID and all four mounted volumes were preserved;
Claude and Codex live health both report installed CLIs, owned hooks and owned MCP;
unauthenticated native access receives 401; trusted-host attach and authenticated
runtime readiness pass. Both compiled hooks also emitted synthetic events in a
temporary home. Restart policy is now `on-failure:3`. This is an in-place update of
this legacy EC2 container, not a rebuilt base image or deployment of the website
control-plane APIs. Full sharing/security and IDE visual parity remain separate
unfinished work.

### Trusted project catalog and cold-start readiness — 2026-10-05

The management gateway now exposes a read-only project catalog from host configuration.
Catalog reads do not invoke Docker open or the untrusted native runtime. Member responses
are intersected with current project grants; the control-plane administrative view is
further restricted to projects the caller may delegate. Only project/component IDs and
labels are returned, excluding paths, account configuration and credentials. Invalid
or duplicate identities fail closed. IDE grant checkboxes preserve saved selections
when catalog loading is unavailable and keep team/direct-person edits independent.
These source changes do not replace the missing shared-credential broker or activate
sharing on a host that has not completed migration/isolation gates.

Production image upgrades previously invoked a one-shot readiness check while the
real-engine smoke test used its own retry loop. The implementation and smoke now use
the same waitForRuntimeReady helper: a monotonic 30-second deadline, bounded HTTP
observations, and bounded poll intervals. A delayed service can become ready; a hung
service cannot extend the deadline. Focused real-loopback regressions cover delayed
startup and hangs. All 216 combined runtime/control-plane unit tests pass. Actual
Linux validation passed for both architectures in image pipeline run 37256322886
for commit 7c20a0c, including the real-container upgrade smoke. This does not
establish live two-member credential isolation or completion of the sharing broker.
No VM was created or resurrected while the owner's restore-or-keep-off choice remains
pending after the manual AWS Console deletion.

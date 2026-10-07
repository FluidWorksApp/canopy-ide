# Organizations, teams, workspace access, and IDE chat

User correction, 2026-10-04. This supersedes the earlier standalone-team and website-conversation UX. Implementation is incomplete.

## Product model

- An organization owns workspaces and has people. Organization membership alone grants no workspace access by default.
- A team is a reusable group of organization members. A person may belong to multiple teams.
- A workspace can be shared with multiple teams and directly with individual people. A team can have different roles on multiple workspaces.
- Workspace ownership and billing belong to the owning account/organization. Adding teams or opening another IDE connection does not duplicate machine billing.
- Personal workspaces stay personal until explicitly moved/shared; do not silently migrate ownership or increase access for existing data.

Example: Engineering has Develop on Product and View on Analytics. Support has View on Product. Priya belongs to both teams and has Develop on Product through Engineering. Removing Engineering's grant leaves View through Support. The access screen must show these sources.

## Permissions

Organization roles govern people, teams, ownership and billing. Team maintainers manage that team's membership; they do not automatically administer every workspace the team can use.

Workspace roles are View, Develop, Admin. Owner is an ownership relationship, not an assignable team role. Use the strongest applicable role for the same resource/action. Removing a grant recomputes effective access from remaining grants. Show the source of inherited access rather than a misleading single mutable role.

Project scope, Git access, agent accounts and shared sessions remain explicit grants. Membership must never imply access to another person's credential files. Do not combine a broad read grant with a narrow write grant into broad write access: resolve each permission for its specific resource. Personal Git identity and CLI accounts remain the default, including commit attribution.

The control plane resolves access from current organization membership, team membership, direct grants and team-to-workspace grants. Gateway authorization must use that same result, including revocation, before issuing or accepting short-lived member sessions. Do not expose access controls that only update UI metadata.

## UX placement

### IDE

Use the existing Teams and Chat entry in the activity rail. Team channels and people open the existing conversation-tab workflow. Do not create a second chat product inside Account Settings or a team-management form.

Teams rail: organization/team selection, team channels, direct messages, unread state, and a small Manage action. Conversation tab: recognizable header, message history, delivery state, and composer anchored at the bottom. Keep the connection machinery out of the ordinary flow. Signing in discovers the user's teams; no manual relay/proxy setup.

Workspace Share: People and Teams search; current access; role per grant; explicit project/Git/agent/session sharing controls; effective-access explanation. Team settings show Members and Workspaces. Both directions edit the same access records.

### Website

Account, billing, organization people, team membership, invitations, workspace inventory and access management only. No conversations, message lists, chat composer, chat placeholder or chat polling. Website management must use the same access APIs as the IDE.

## Backend entities

organization; organization_member; team with organization_id; team_member; workspace with organization_id; workspace_member for direct grants; workspace_team_access for team grants. Team/workspace relationships are many-to-many, with roles and resource grants on the relationship. Keep compatibility during explicit migration of existing personal workspaces and teams.

Existing peer device discovery and encrypted relay are backend infrastructure for IDE chat. Their existence does not require or authorize a website chat surface. Identity keys stay on the IDE device; relays carry authenticated ciphertext. Live membership and device revocation gate both relay and direct transport.

## Acceptance checks

- No chat UI or message requests on website Teams page.
- One team accesses two workspaces with different roles; one workspace has two teams.
- Direct plus team grants resolve correctly; removing one source preserves only remaining access.
- Organization removal cuts all team-derived access; unrelated organization IDs cannot be attached.
- Combining scoped grants never widens write or credential access.
- Existing IDE conversation tabs handle team chat and DMs; no duplicate clients/transcripts per tab or project.
- Existing workspace owner/billing/data remain unchanged by migration.
- Visual checks at desktop and narrow widths: alignment, hierarchy, focus, empty/loading/error states.
- Deployed permission tests, two-device messaging and actual UI verification are required before completion.

## Research

GitHub groups organization members into teams and grants repository access independently to teams and individuals. Adapt repository access to workspace access; do not copy unrelated GitHub features or imply a team owns a workspace.

- https://docs.github.com/en/organizations/organizing-members-into-teams/about-teams
- https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/managing-team-access-to-an-organization-repository
- https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization

## Implementation checkpoint

- Website conversation surface removed; management-only page built and checked at desktop/mobile with synthetic fixtures.
- IDE directory opens account conversations through existing chat subtabs, with a shared transport per account/team. Installed-app and two-device verification remain outstanding.
- Additive organization/team-grant migration, scoped access resolver, and transactional team-grant mutation are present in `packages/control-plane`. Seven focused authorization tests pass, including scoped grants, organization removal, outsider mutation, and foreign-team rejection.
- These new access modules are not wired into live API/gateway authorization yet. Migration is not applied. Organization creation/membership management, explicit workspace attachment, grant UI, parent-organization move guards, and database-backed concurrency/revocation tests remain required before enablement.

Organization operations are now routed through the authenticated `/api/teams` POST handler (organization-list/create/detail/invite/accept/team-create/team-member-add/member-remove/workspace-attach), alongside workspace-team-grant/revoke. The organization schema remains unapplied; these operations must not be advertised as available until migration and database integration validation complete. Twelve focused module tests pass. Organization invitations use the existing email delivery path; invitation acceptance UI and organization-aware team/peer membership enforcement remain outstanding.

Database checkpoint: additive organization migration applied to the dedicated Canopy database after two successful rollback-only integration runs. Test covers invitation acceptance, team-member addition, owner workspace attachment, scoped grants and organization removal using synthetic accounts. The website now includes the retained test `tests/organizations.integration.mjs`. Team directory and peer relay query `active_team_member`, requiring live organization membership. Existing personal team/workspace ownership is unchanged. UI and full workspace/gateway authorization remain outstanding; do not treat schema/API readiness as complete sharing support.

IDE organization settings checkpoint: Settings > Teams now renders OrganizationSettings (account-backed organization picker/create, invitation acceptance, people/invite/remove with inline confirmation, team create and member assignment). No chat composer appears there. Three focused UI interaction tests pass alongside the two Teams directory tests; TypeScript build passes. Installed-app visual review, workspace grant controls, richer team details/removal, and website organization management remain pending.

Workspace sharing UI checkpoint: IDE managed workspace detail includes WorkspaceSharing, with explicit organization attachment, team role grant/update, and confirmed revocation. `workspace-team-list` exposes current grants and eligible teams only to workspace access administrators. Focused UI test confirms selected role and personal Git/agent defaults; TypeScript passes. Member connection remains owner-only in operations, so this is not complete shared-workspace access. Next required step is isolated member runtime issuance plus authorization across listing, operations, gateway and project scope, followed by two-user end-to-end tests.

Capacity provisioning checkpoint: `provision-capacity.mjs` creates deterministic systemd slices with aggregate memory, CPU and 75% swap limits, validates all workspace inputs before mutation, and publishes cgroup configuration only after systemd reports active. New-workspace bootstrap invokes it; existing Docker containers are deliberately not moved/recreated. Nine capacity/member-runtime tests pass plus bootstrap/installer syntax checks. Actual Linux systemd/Docker enforcement and a new runtime artifact upload are required before deployment. Existing artifacts do not contain the new provisioning module; do not deploy bootstrap alone.

Live authorization checkpoint: member access now resolves direct and team grants, with a grant-derived credential version bound to permissions, grant versions, organization/team join epochs and machine generation. Organization and team re-additions update their membership epoch. Rollback-only database test proves removal denies access and rejoining does not revive old credentials; refreshed credentials can be issued from current access. Partial-project grants fail closed for whole-runtime execution until scoped mounts exist. Sixteen focused module checks passed. This updates authorization validation, not the outstanding member-token issuance/runtime provisioning deployment.

Discovery checkpoint: workspace GET now uses authorized direct/team discovery and emits access sources plus owner/control flags. IDE displays shared workspaces and hides stop/manage-access controls where unauthorized; connection remains explicitly pending until isolated member issuance is enabled. Database integration proves authorized discovery and disappearance on organization removal; UI test proves no owner-only stop control on a shared workspace. Website build and IDE TypeScript passed. No deployed runtime or member connection completion is implied.

Chat lifecycle checkpoint: explicit account sign-out clears shared transports, transcripts, receipts and team directory, rejects late packets, and invalidates pending directory refreshes. Successful account sign-in also clears old transports. React effect replay no longer permanently stops a freshly mounted chat. Seven focused session/account/directory tests and TypeScript pass. Runtime shared-project mounts remain absent; this review did not enable member connection issuance.

Real-engine validation started: Docker Desktop launched and confirmed Docker 29.2.1, cgroup v2, cgroupfs. `docker build --tag canopy-workspace:validation packages/remote-host` remains active in exec session 59905, last observed downloading desktop/browser packages. Poll that same handle before restarting. Added `smoke-isolation.sh` for disposable containers/volumes: checks private home/project separation, absent management/socket mounts, 256 MiB RAM plus 192 MiB swap, and survival of one container when another is killed. Script syntax passes; real smoke execution waits for image completion. Docker Desktop uses cgroupfs, so systemd slice provisioning still requires separate Linux systemd validation. AWS default and deployer profiles both returned no Lightsail instances in ap-southeast-1 during read-only discovery.

Browser crypto verification: `node scripts/validation/peer-storage.mjs` passed using real headless Chromium and an isolated synthetic profile. Concurrent windows preserve one IndexedDB identity, private keys remain non-exportable across reload, replay insert is unique across windows/reloads, and authenticated encrypted round-trip succeeds without plaintext in envelope. This is Chromium evidence, not yet the installed macOS WebKit IDE or two-device WebRTC verification. Workspace Docker build exec 59905 remains active, now installing developer tools; keep polling the existing build handle.

Real transport checkpoint: `scripts/validation/peer-direct.mjs` passed with two actual Chromium WebRTC endpoints. Established direct channel delivered an encrypted message and receipt without increasing relay requests; forcibly closing peer connections then delivered a second message and receipt through encrypted relay. Directory/relay are synthetic fixtures, so this does not prove deployed account authentication or internet NAT traversal. Twenty gateway/policy/Docker/authority tests also pass (loopback permission required). Image build 59905 is still live, observed installing Python developer-tool dependencies; do not restart solely because build is slow.

Website validation checkpoint: shared cards no longer expose owner edit/delete controls or deduct shared-machine usage from the viewer's remaining-time estimate. Resize confirmation now uses the branded dialog with explicit interruption/preservation copy. Production website build passes. Real Chromium synthetic-fixture check covers resize cancellation (no mutation), confirmation (one resize), absence of native dialogs, shared controls, and owner-only remaining-time calculation.

Container validation checkpoint: workspace image build completed all Dockerfile instructions but failed extracting the resulting image due to Docker disk exhaustion. Removed 3.136 GB of unused build cache only; disposable isolation smoke still failed during image extraction. No runtime-isolation pass is claimed. Existing containers, images and volumes were preserved; smoke cleanup removed its disposable resources. DMG remains pending completion and validation of the implementation.

IDE chat identity checkpoint: team channel sender labels now resolve from the authenticated peer directory instead of the generic Teammate label. Directory supplies current member IDs/names only, without email fields; session sign-out clears the directory and ignores late updates. Four focused client/session/chat-view tests pass, TypeScript passes, and the real Canopy database rollback-only peer test confirms directory scope plus existing identity/replay/revocation enforcement. Installed-app verification remains outstanding.

Live local routing repair: user screenshot exposed /api/teams returning JavaScript (HTTP 200 text/javascript) while /api/me returned proper JSON. Config touches did not update the daemon's stale routing. Verified PID/cwd, restarted only that website dev server, and confirmed /api/teams now returns HTTP 401 application/json without authentication. Inspected the user's real signed-in Chrome tab: Teams renders the authenticated empty state with no parser error. Added dev bridge file watching and a friendly non-JSON response guard. Previous mocked browser fixtures did not cover this route failure.

Team roster work: organization details now include per-team member rosters; IDE expandable team rows show names/roles and confirmed team-only removal. Backend removal checks organization admin authority, team organization ownership and preserves team-owner protection. Real database regression coverage for this new removal branch remains pending.

Organization management validation: real database rollback-only integration now proves team-specific removal preserves organization membership and alternate viewer grants, denies execution after downgrade, and invalidates old tokens across removal/rejoin. Owner removal and non-admin changes are rejected. Pending organization invitations are visible only to administrators, can be withdrawn in IDE settings, are scoped to the selected organization, and cannot be accepted after withdrawal. Expanded integration passes; four organization UI tests and TypeScript pass. Installed-app visuals and deployment remain outstanding.

Account-bound UI checkpoint: OrganizationSettings and WorkspaceSharing clear cached details, invitations, selected teams and pending confirmations when the account changes. Request generations discard late responses after account changes, unmount and workspace selection changes; mutations cannot publish old-account success into the new view. Successful sign-in now emits the same account-change notification as sign-out. Ten focused account/organization/sharing UI tests and TypeScript pass, including delayed old-account and old-workspace response cases. This is client state isolation, not a substitute for backend authorization or deployed verification.

Direct person sharing checkpoint: IDE workspace sharing now has organization-person grants alongside team grants, independently selected roles, private Git/agent defaults and confirmed direct-access removal. New transaction-based workspace-person-grants API applies workspace authorization, owner protection, organization membership, delegation restrictions, access-version increments and audit records. Real database rollback integration verifies unauthorized/outsider rejection, listing/revocation and preserved team access after direct revocation. Connection issuance/runtime scoped mounts remain unfinished; no member-runtime readiness is claimed.

Website organization management checkpoint: /teams now uses organization APIs for organization selection/creation, people invitations and removals, pending-invitation withdrawal, reusable team creation, member rosters and add/remove actions. People/Teams sections share one management layout and site dialogs. Existing personal teams remain available at /personal-teams and are filtered by organization_id; no silent migration. No website chat was added. Chromium synthetic-fixture validation exercised adding a person to a team, checked absence of chat and narrow overflow, and captured desktop/mobile layouts; desktop and mobile captures were inspected. Production build passed before final label/filter adjustments; subsequent final build is tracked separately. Real authenticated creation/invitation was not performed against user data.

Container image validation unblocked: reclaimed unused build artifacts/cache without deleting user containers or volumes. Real-engine member isolation smoke now passes, including RAM plus 75% swap and capability restrictions. Offline unprivileged image check verified Node/Python/Git, Chromium, Rust/Cargo, GTK/WebKit/ALSA libraries and successfully compiled/executed a tiny Rust program. Linux systemd aggregate capacity, host firewall and full shared-member runtime remain pending. No disk-space blocker remains for this completed smoke check.

Chat continuity checkpoint: account/team-scoped IndexedDB history stores the latest 500 messages encrypted with a non-exportable per-account AES-GCM key. Context-bound authentication rejects tampered records; key creation and message writes handle concurrent windows. Session restore first verifies the current account ID, and invalidated sessions cannot publish late history. Restored outgoing messages say Saved on this device rather than making a new delivery claim. Real Chromium validation covers concurrent writes, reload, account/team separation and ciphertext tampering, alongside existing identity/replay checks; session tests cover wrong-account restoration and TypeScript passes. Receipt persistence, unread state, installed WebKit validation and deployed two-device checks remain outstanding.

Broad build/test checkpoint: cargo check passes after moving vendor-specific credential validation from client_mode into the profiles adapter (three existing compiler warnings remain). Full IDE suite ran 4,090 tests: 4,089 passed; the sole architecture test failure was corrected and all four architecture tests pass on rerun. Full remote-host suite passes 87/87 after fixing acceptance of empty account-pool IDs. Linux default-profile and invalid-pool checks pass with the patched native source mounted read-only into a disposable container; the stored validation image itself predates that patch and must be rebuilt before release. These checks are not a DMG or deployed runtime completion claim.

2026-10-04 local release checkpoint: encrypted account/team-scoped unread IDs and
delivery receipts now persist with chat history. The isolated Chromium storage
validation covers reload, account/team separation, ordered state writes and
ciphertext tampering. The full IDE suite passes 4,109 tests across 384 files after
workspace-browser screenshot capture and remote chunked image saving were added.
These results do not verify installed WebKit, cross-window live message refresh,
late receipts after restarting the sender, or two-device WebRTC/relay behavior.

Member connection issuance now compares the freshly read access generation with
the workspace generation whose sharing readiness was attested. A stale attestation
cannot issue credentials for a recreated machine. All 36 control-plane tests pass.
Operational migration tooling, live member runtime provisioning, shared credential
execution grants and production multi-user verification remain incomplete.

### Terminal responsiveness checkpoint — 2026-10-04

Local changes reserve a separate bounded HTTP admission lane for terminal input,
so four slow workspace requests cannot hold up typing. Pending contiguous output
frames are combined into bounded parser batches; all bytes and geometry/reset/gap
boundaries are preserved. The full IDE suite passed 4,118 tests and the application
TypeScript check passed. A server-screen regression also feeds 5,000 spinner
updates and verifies restoration produces the final screen in under 1 KiB rather
than replaying the animation history.

These results do not establish live latency or background WebKit behavior. The VM
and its active agent remain untouched at the user's request. Deployment of the
remote runtime and a live foreground/background terminal check remain pending.
The local DMG including these client changes completed successfully. Its checksum and mounted application signature passed verification; the installer was opened without replacing the running IDE.

### Permission management and account loading — 2026-10-05

Admin delegation now saves project and resource grants within the actor's own
administrative scopes for both teams and people. Viewer/developer grants cannot
widen administrative authority; account/session sharing permissions remain bound
to the same project scopes. The website API uses the same implementation. The
IDE submits the admin's delegated project IDs rather than unconditional all-project
access. Forty-one control-plane tests pass, including actual mutation/audit paths.

Account settings retains the last authenticated account and balance in renderer
memory between openings, clears it on account changes, refreshes it in the
background, and shows a shimmer on initial account/balance loading. Identity and
four icon actions (workspaces, teams, usage history, sign out) share one header,
with hover/focus labels. These edits are local source changes; no VM update or
new deployment is implied. Footer telemetry parity remains under implementation.

### Footer telemetry implementation — 2026-10-05

The remote native handler now implements `claude_session_stats` with incremental
transcript parsing and a whitelist of the current member's own Claude transcript
roots. It returns only model and numeric counters. Remote Codex plan usage now
filters the requested session rather than selecting another rollout's plan.
The shared IDE footer falls back to agent usage by exact active session ID,
provider and account profile when no Claude transcript or OpenCode store binding
exists. Missing/unsupported data clears that session's cached statistics; it
never substitutes another tab's model or tokens. Forty-five focused account/footer
tests, application typechecking, and all 155 remote-host tests pass. The running
VM remains unchanged, so its old native handler still requires deployment.

### Sharing policy editing checkpoint — 2026-10-05

IDE workspace sharing now shows each team/person grant's project scope, Git policy,
agent policy, and session visibility. Edit actions select the existing grant and
role. Saving a role change preserves that exact grant's resource permissions instead
of silently resetting them to personal Git/agents and private sessions. New grants
still default to personal accounts and private sessions, bounded by the administrator's
project scope. Six interaction tests and the app TypeScript check pass. Selecting
new shared resources and executing them through a secure credential broker remain
incomplete; this checkpoint does not establish live shared credentials.

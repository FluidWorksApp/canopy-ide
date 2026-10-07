# Workspace controls release — 2026-10-05

Desktop: signed local ARM64 DMG, notarization intentionally skipped. Stop and Delete are exposed during managed startup and on expanded floating progress. Stop preserves storage. Delete requires the exact workspace name and owner permission. Both cancel pending automatic IDE connection. Externally managed host connections can be removed from this Mac without deleting the host or its files.

Server changes: `lib/canopy/lifecycle.mjs` permits a confirmed Stop/Delete to supersede pending or failed resume only between provider steps, under the worker's advisory lock. `lib/canopy/reconciler.mjs` can stop a first-time startup before storage has been created. Existing retained storage remains protected. Synthetic interruption and reconciler tests: 11 passed. IDE checks: 21 focused tests and TypeScript passed. Website local build passed.

Production deployment was explicitly approved and completed. Vercel deployment `dpl_BxDSbpQuMPunfEGXP1XVLaUKduCD` reports READY and is aliased to https://canopyide.dev. It includes the existing account/team/workspace APIs and the lifecycle recovery patches. The prepared runtime/image configuration is active for subsequent provisioning. Earlier automatic approval review required this explicit production authorization, which was received before publishing.

Prepared production environment:
- Public image: `ghcr.io/fluidworksapp/canopy-workspace:sha-3c56be2ab4fbbdcd2bf7c27f63602350b78a7352`.
- Manifest digest: `sha256:89427cc925c10d6b872402ab6557e1467b5cf9adc7c8a42f77fe1eb15ff96096`.
- Trusted runtime: private encrypted bucket `canopy-runtime-703671915771`, key `runtime-releases/3c56be2ab4fbbdcd2bf7c27f63602350b78a7352/workspace-host.tar.gz` (84,656 bytes).
- Runtime checksum: `0e388479d96c789c3153fcae8732727f88836dee42ae42f16c5e39ecfefa366a`.

The public image is anonymously accessible on AMD64 and ARM64. FluidWorksApp's public package creation restriction was restored; other package visibility was not changed. Stable-channel promotion/main merge and live VM restart validation remain separate unfinished work.

Machine Works recovery diagnosis: provider VM was running, but cloud-init failed because the older runtime archive omitted `network-isolation.sh`. Host/gateway services never started. Repair installed the checksum-verified CI host bundle while refusing to interrupt running containers, preserved the retained disk and host key, backed up old host modules, restored network/host/Caddy services, and verified the authenticated HTTPS gateway. The temporary SSH firewall rule was removed. Workspace container readiness remains a separate live verification.

Additional release fixes: bootstrap changes the script mode directly instead of attempting a same-file install; readiness explicitly resumes a retained stopped runtime; server preparation stages have 15-minute no-progress deadlines (five minutes for secure connection) and Retry clears the prior stage deadline. IDE Retry reuses the failed durable operation. Website Stop remains available while preparing. Focused checks now cover 22 IDE tests and 16 server tests.

Final local DMG rebuilt with Retry preparation, signature and hdiutil checksum verified, and opened. The retained legacy container restart policy was corrected from unless-stopped to on-failure:3; its container identity and all mounts were verified unchanged. A subsequent new-image readiness attempt failed; its outcome cannot establish a usable workspace. AWS CloudTrail records manual Chrome DeleteInstance at 2026-10-05T02:10:03Z, during recovery. The provider VM is now absent; the data disk remains available and unattached. Database still retains the workspace in error with a failed resume. No new VM was created after observing the intentional external deletion; restore-versus-keep-off clarification is pending.


### Approved production activation — 2026-10-05

Deployment `dpl_Ha2cAuuEKBFitbWbyDN7WYu6p4Dv` is READY and aliased to canopyide.dev.
The clean build has no TypeScript diagnostics. Public workspace page returns 200;
Teams API returns JSON 401 without authentication. The project catalog API is included.
New setup configuration pins image `sha256:adf350a03a49d0323d1db8a26f03b181e8f5be1d3d9472f9ca5a8deaf53cb026`
and host archive `runtime-releases/7c20a0c51603112b4b25a3a4575ea57b571a1156/workspace-host.tar.gz`
with checksum `12f63135cf5f49a609f982ff4c4205bc35e1eaf6117954774f68e0f85c1d448e`.
Both architectures and real-container upgrade smoke passed run 37256322886.
Machine Works remains off pending owner intent after manual deletion; this deployment
does not prove a recovered VM or complete shared credential brokering.


### Owner/member current release activation — 2026-10-05

Deployment `dpl_6z24ihsFwMypsKdrpddT58tYG5SS` is READY and aliased to canopyide.dev,
with no TypeScript diagnostics. Public workspace page returns 200; unauthenticated
runtime policy POST returns 401. Image pipeline 37258999089 passed both architecture
and real candidate smoke checks. The active image is
`sha256:870ea99fa18a33e3ccb4da187ab409ac02fe72ee6520b03b61bc6d038e55ac58`;
matching private host archive is
`runtime-releases/fc3ac9a68fa6c41e86a6687bf0b3f18c56f5fa0e/workspace-host.tar.gz`,
SHA256 `3719f19ed54d3903a5762a1b6e8a7c719e7375ccda024f0ca4626fbe81ac66a9`.
New hosts use fresh externally authorized immutable release selection on explicit
owner/member resume. Running containers are not upgraded; member containers never
inherit the owner's private writable checkpoint. No VM was recreated or restarted.
The experimental broker/vault modules remain local and are not in this release.


### Broker and management connection activation — 2026-10-05

Deployment dpl_4isiyHJe5tUjLdFBEcC45N2VTFQu is READY and aliased to canopyide.dev.
Workspace page returns 200 and unauthenticated management-connect returns 401.
Active runtime image is sha256:808730f568d04ba286ac5605e019b82c8f83332b6f93998db21e043197734b99.
Private host archive runtime-releases/516263c39cff23fb24d2a3fcf30d18d5aae3a4ab/workspace-host.tar.gz
is 92,348 bytes, AES256 encrypted, with SHA256
1dcf460451d577c3be7709c28f2e46f338d941a9330d5fbd91fc26a7b687ac24.
No VM was recreated or restarted. CLI integration and real multi-user verification
remain open; activation is not proof of working end-user CLI sharing.

# Enabling project sharing

Member connections require `sharing_generation` to match the workspace generation.
Granting a team or person access alone never enables unverified member execution.

The owner opens Enable workspace sharing in the IDE, selects projects and their
saved components, and confirms the interruption of every running agent, terminal
and job. Candidate paths are declarations from the owner, rather than authority
obtained from an untrusted runtime. The management service validates IDs, labels,
relative paths and destination overlaps, verifies aggregate capacity and the
host network-isolation service, and durably journals the interruption intent
before stopping the owner container.

During setup the gateway refuses workspace execution and new streams, and health
recovery is disabled. The migration helper copies selected non-Git component
folders from the old project volume into dedicated project volumes. For Git
components it preserves their complete repository root and history, deduplicates
components in the same repository and maps component paths into the copied root.
The IDE explains that a repository can contain folders beyond the selected
components. The source stays read-only. Git directories and linked-worktree common
metadata must resolve within the original project volume; external Git directories
fail before copying. Linked worktrees within project storage are copied and their
metadata links are rebound to the new runtime paths. Git object alternates require
an independent repository copy first and fail clearly rather than losing history.
Before publication, destination Git configuration is parsed with Git's include
expansion disabled and an isolated environment. Known authentication settings,
credential helpers, transport commands, auth headers and credential URL rewrites
are removed. HTTP remote userinfo and auth query parameters are stripped; canonical
SSH and SCP remotes keep their required SSH username. Author name/email and Git
objects, refs and commit history are preserved. Internal included configs and
copied worktree configs are sanitized; external includes and embedded credential
references fail before copying. Local hooks, reflogs and known/referenced
credential-store files are excluded from destination Git metadata. Source metadata
and owner-controlled working-tree files remain untouched; this does not scan or
rewrite arbitrary project content or historical commits for secrets.
It keeps an owner image checkpoint and the stopped original container. It verifies
the replacement and publishes private management configuration atomically before
reporting ready. A prepared capacity group becomes the owner's active group only
in the published replacement configuration. Failed or uncertain operations are
quarantined and retain durable recovery evidence; files are never deleted.

The owner then asks the account service to activate sharing. That service generates
a random challenge and verifies the exact workspace endpoint, provider instance
and generation. It requests a management-service readiness attestation. The host
requires a committed project catalog, no migration quarantine, aggregate capacity,
active network isolation and a ready runtime, and checks external lifecycle intent
before signing a 30-second proof with the private management key.

The proof has version 1, purpose `sharing-ready`, workspace ID, generation,
instance name, 64-hex-character nonce, catalog hash and expiration. Its signature
is HMAC-SHA256 over the base64url JSON payload; the returned form is
`payload.signature`. This proof cannot authenticate as a management or member
credential. The account service sets `sharing_generation` only after authenticating
the owner and independently checking the live provider and unchanged database
generation and desired state. A copied old proof or recreated machine cannot
activate a new generation.

These are source paths backed by synthetic unit and loopback tests. No user data
has been migrated and no deleted workspace has been recreated for this work.

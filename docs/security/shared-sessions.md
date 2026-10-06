# Shared terminal sessions

Workspace owners can explicitly publish a running personal terminal for viewing,
or create a collaboration shell for a selected shared project. Publications are
held by the management service, receive an unguessable UUID, expire after one
hour, and are discarded when the management service restarts.

Personal terminal publication requires confirmation that both current output and
bounded replay were checked for private information. Its members cannot send
input, resize it, stop it, or invoke its native runtime. Existing owner terminal
interaction is refused even if a member has an interaction grant: it would expose
the owner's home, credentials and unrelated projects through shell execution.

Collaboration shells run in a distinct runtime derived from the publication UUID.
They have one project mount, a separate home/network, an empty account pool and
the public runtime image. The owner checkpoint and personal account volumes are
excluded. No provider keys or personal CLI sign-ins are installed in these shells.
They are shared shell execution environments; Git commands typed into this shell
use its shared shell identity. Personal author identity and CLI sign-ins belong in
the member's private runtime, where authenticated Git attribution is enforced.

Session viewing and interaction are independently aggregated from the grants that
explicitly supplied them, preserving their project scope. Interaction also needs
write access to the project. Management checks membership on each input request
and stream admission and every second on active streams. Revoke/expiry while an
authority request is pending also fails closed. Session IDs and runtime metadata
are hidden from members, who receive publication IDs only. Runtime JSON responses
are capped at 64 KiB and cannot define permission policy.

Revocation immediately removes access and then awaits shutdown of a collaboration
runtime. Failed shutdown is reported and retained for retry by the host timer.
Unknown member runtimes are suspended during gateway startup. Shared-runtime
automatic recovery checks publication lifetime and the parent's external desired
state, so an intentional workspace stop cannot trigger recovery.

The IDE shared-session panel uses the active remote connection and never starts
a workspace when opened. It loads the trusted project catalog, shows view-only or
interaction state, and closes terminal output when an account changes, a
publication disappears or access fails. Tests cover project boundaries, failed
shutdown, stale publication IDs, downgrade to read-only, denied owner-terminal
control and revocation of an established stream using synthetic local servers.

Viewer-only members use the explicit View shared sessions connection action. It
obtains a short-lived member credential for an already running, generation-verified
workspace and does not create or open a personal runtime. The credential preserves
the real current member scope: a viewer receives view, while a developer retains
drive. View does not permit shell input, spawning, editing or desktop control.
Credentials are cached only until thirty seconds before expiration, scoped to the
panel's account/workspace epoch and refreshed through the account service. The
host remembers freshly authenticated presented credentials, bounded to 512
entries and pinned to workspace, member, access version and scope, so active shared
streams can use a valid newer credential without requiring a personal runtime.
It never mints or extends a credential; current membership is still checked on
each stream authorization interval. Closing the client stops those renewals.

Source implementation and synthetic tests are complete for these paths. No live
VM or real member credentials have been used for multi-user validation.

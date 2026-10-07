# Automatic idle shutdown boundary

Development-container `workspace_activity` responses do not authorize
infrastructure shutdown. Containers can fabricate activity, and an owner's
runtime cannot report other members' work reliably.

The management gateway exposes owner-only `POST /idle-attestation`. It inspects
Docker directly, scans every Canopy-labeled container on the host, and refuses
idle status while a container runs, pauses, restarts, has an uncertain state or
has a daemon policy that could restart a crashed process. Active member,
collaboration, CLI, viewer, stream, migration and pending-operation registries
also prevent a positive proof. No user-runtime HTTP response is consulted.

A positive proof has version 1, purpose `workspace-idle`, workspace ID, generation,
instance name, a server-issued 64-hex nonce, `idle: true` and a 30-second expiration.
The management service signs its base64url JSON with HMAC-SHA256. The proof cannot
authenticate as an owner, member, sharing-activation or runtime-policy credential.

The scan and a short reservation run under the Docker resource lock. While the
reservation is active, gateway operations, cached opens, queued starts, direct
ensures and automatic recovery cannot restart workspace or member containers.
The reservation expires after thirty seconds; repeated checks cannot silently
extend it. The external account service must independently confirm no active
connection leases, verify provider identity and the proof, and request shutdown
under its workspace row lock. Billing stops only after provider-confirmed shutdown.

This deliberately reports a running runtime as busy even when its user processes
appear idle. A richer trusted host process observer is still pending. Explicit
owner Stop/Hibernate controls continue to express intentional shutdown directly.

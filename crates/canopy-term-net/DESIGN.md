# canopy-term-net: transports

The session protocol (hello/attach, the caller-supplied spawn key, protocol
version check) is one thing. A `Transport` only delivers a byte stream whose
peer identity the transport itself proved. The version check and the spawn key
live above this crate and behave identically on every transport; nothing here
reads or interprets session bytes.

## Transports

| Transport | Module | Identity | Status |
| --- | --- | --- | --- |
| Local unix socket | `local_unix` (unix only) | `LocalUser(uid)` from SO_PEERCRED / getpeereid | implemented, reference + test double |
| Windows named pipe | not built | user SID of the pipe client | planned counterpart, documented in `local_unix` |
| iroh (QUIC, dial by key) | `iroh_transport` (feature `iroh`, default) | `Device(key)` from the TLS handshake | implemented |
| tailscale-rs | none | tailnet node identity | spike only, see below |
| Cloudflare | none | n/a | planned, subprocess, public sharing only |

The local transport stays its own transport. Network transports sit beside it
and never reuse its trust rule.

## Threat model

**What an authenticated peer may do.** An allowlisted device is a full peer of
the session host: it can spawn processes (argv, cwd, environment) as the host
user, attach to and read any session's output, send input, resize, and kill.
That is equivalent to a shell as the host user. There is no per-session scoping
at this layer. Pair only devices you would give a login. Narrower roles
(read-only attach) belong in the session protocol, not in the allowlist, and
are not designed yet.

**What it may not do.** An unauthenticated or unknown peer reaches no session
code: on iroh the link is closed straight after the handshake and no stream is
accepted, so no request bytes are read. The refusal is per key and is
re-checked on every new stream, so removing a key stops its next stream
(streams already open keep running until closed; closing them on removal is a
follow-up). An authenticated peer cannot impersonate another: the key is the
TLS identity, not a field in a message.

**In scope.** Passive and active network attackers (QUIC with TLS 1.3, peer key
pinned by dialing it), unknown devices, guessing a pairing code, stale pairing
offers, a malicious peer sending garbage after the preface (the transport only
moves bytes).

**Out of scope here.** A compromised paired device (revoke its key), a
compromised host user account, denial of service by a paired device, traffic
analysis, relay operators seeing metadata (who talks to whom, volumes) though
not content.

**Dialer side.** Dialing a key authenticates the host to the dialer. The dialer
pins the host key learned from the pairing payload; a changed host key is a
different host, not a warning.

**Pairing** (`pairing`, pure logic). The host creates a one-time offer. The
payload carries the host key and a 16 character code (80 bits). The joiner
dials, the transport proves the joiner key, and `redeem` adds that proven key,
never one the joiner claims. Single use, expiry, a global failure budget that
burns all live offers (5 wrong codes), constant-time comparison, redacted
`Debug`, and no logging anywhere in the crate. The pairing exchange itself is
not yet wired to a network ALPN: when it is, it must use its own ALPN that is
open only while an offer is live, so the main session ALPN keeps refusing
strangers.

**Allowlist storage.** `Allowlist` is an in-memory shared set with a text file
form (one 64 hex key per line, written atomically, mode 0600). Public keys are
not secret; the file is the access policy, so it must not be writable by other
users. The file lives in the per-user profile directory next to the host's own
data; the caller chooses the path. A malformed line is an error, never skipped.

**Device key storage.** The iroh secret key is the device identity. It must be
generated once and stored in the OS keychain or a 0600 file in the profile
directory. This crate takes a `SecretKey` and does not persist it. Tests use
generated throwaway keys only.

**Key rotation.** A device rotates by generating a new key and pairing again,
then the old key is removed from every allowlist (`Allowlist::remove`; the next
stream is refused). There is no in-band key migration on purpose: a key change
is a new identity and goes through a human-approved pairing. Revoking a lost
device is removal of its key from each host.

## Why unix peer-uid checks do not carry over a network

SO_PEERCRED and getpeereid are answered by the kernel about a process on the
same machine, over a socket whose path is protected by file permissions. A
network peer has no uid the host can verify: a uid in a message is just a
claim, and the same number means a different user on another machine. Network
identity has to be cryptographic, so network transports authenticate a key and
use an allowlist of keys. Conversely a device key must never be mapped to
`LocalUser`, and the local transport must never accept a network connection.
`PeerIdentity` keeps the two kinds distinct so code that matches on it cannot
confuse them.

## iroh specifics

- One QUIC link per peer, cached; `connect` opens a new bidirectional stream
  (cheap). A dead cached link is dropped and redialed once.
- ALPN `canopy-term/session/1` for the session protocol.
- Address string: `<64 hex key>[@ip:port[,ip:port]]`. Without socket addresses
  the n0 discovery and relay are used (`IrohOptions { bind: None }`); the
  loopback options disable relay and discovery and bind only 127.0.0.1.
- A four byte stream preface is written on connect so `accept` returns when a
  peer connects, not when it first speaks (a QUIC stream is invisible to the
  peer until its opener writes).
- Read deadline errors are `io::ErrorKind::TimedOut` (`TIMEOUT_KIND`), the same
  as the local transport, and a timed-out read loses no bytes.
- The handshake finishes before the allowlist check, so a refused dialer's
  `connect` can succeed and its first read then fails. The acceptor never
  opens a stream for it.
- Minimum Rust 1.91 (iroh 1.4.1). Built with `default-features = false` plus
  `tls-ring`; without a crypto provider an endpoint cannot be created.

## Cloudflare plan (later, public sharing only)

Cloudflare is for sharing a session with someone who has no paired device, such
as a read-only link. It is not an authentication path for paired devices.
Plan: drive `cloudflared` as a subprocess (a quick tunnel to a local listener
the user explicitly starts), never link a Cloudflare client into the host. The
listener it exposes is a separate, read-only protocol surface with its own
unguessable token and expiry, not the session ALPN and not the allowlist. The
tunnel dies with the subprocess; the app shows when it is running. Nothing to
build until the share UI exists.

## tailscale-rs

Spike only; it is not in this tree. Compile probe: the `tailscale` crate 0.7.1
(tailscale-rs, "work in progress", BSD-3-Clause, MSRV 1.92) was added as a
dependency with an empty module and linked: the `Terminal crates` job compiled
it and passed on ubuntu-latest, macos-15 and windows-2022. That is compile
only: nothing was connected, no login, no auth key, no tailnet.

It is not kept in the tree for two reasons found by the probe. It adds about
156 packages to the lock, including `dyn-eq` (MPL-2.0, outside the MIT, Apache,
BSD policy), and its lockfile contents tripped the repository's secret scanner
(a false positive on a crypto crate's name). Adding it back needs a licence
decision and a scanner-safe lock, so it is a separate change. It must stay out
of the default feature set, tests must be loopback only, and nothing may run
`tailscale up`, login, serve or funnel. A tailnet transport would authenticate
by node identity from the tailnet and still use an allowlist of node
identities. The probe patch is kept outside the repository.

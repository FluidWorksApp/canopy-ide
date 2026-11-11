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
| Tailscale CLI + TCP | `tailscale`, `tailnet_tcp` | stable node id + user id (or tags), from `whois` | implemented, see below |
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

## Installed Tailscale (CLI) transport

Decision: use the Tailscale the user already has installed, through its command
line client. `tailscale-rs` is dropped (its compile probe passed on all three
OSes but it brought MPL-2.0 code, 156 packages and a lock the secret scanner
flags). Bundling a Tailscale build is a later step.

**Commands.** `CliCommand` is an enum, `Version`, `StatusJson`,
`WhoisJson(IpAddr)`, `Ip4`, and its `argv()` is the only place a command line is
built. `up`, `login`, `logout`, `serve`, `funnel` and `set` cannot be
expressed, and the one caller value is a typed address, so no peer-supplied
string reaches a command. Output is read from stdout only; stderr is drained and
discarded, which tolerates the version-mismatch warning a Homebrew CLI prints
against the app's daemon. Raw output is never logged (it holds tailnet names).
The real runner closes stdin, drains both pipes on threads, enforces a deadline
and kills and reaps on timeout. CLI location is a pure function (macOS app
bundle, then `PATH`, then the usual Linux and Windows install paths).

**States.** `TailnetState`: `NotInstalled`, `DaemonUnreachable`, `NeedsLogin`,
`NeedsMachineAuth`, `Stopped`, `Starting`, `Running`, `TooOld(version)`,
`Unknown(state)`. Only a backend state of exactly `Running` maps to `Running`;
`NoState`, `InUseOtherUser` and anything unrecognised are `Unknown`. The state
is judged from stdout JSON whatever the exit code.

**Identity and the allowlist.** A peer is identified by the stable node id plus
the user id, never by node or login name (display values that can be renamed):

- `tailnet:user/<stable node id>/<user id>`
- `tailnet:tagged/<stable node id>/<sorted tags>` for nodes owned by ACL tags,
  which have no real user (workspace containers are likely tagged). Its own
  kind, so a user entry never authorises a tagged node. Retagging changes the
  entry, so a retagged node is refused until re-approved.

These sit in the same `Allowlist` as device keys but in a separate namespace
(`tailnet:` prefix), so they can never collide with a 64 hex iroh key. A whois
answer with neither tags nor a real user is an error and a refusal.
**Tailnet membership is not authorisation**: the identity must also be in the
allowlist, on both the accepting and the dialing side.

**Fail closed.** Accept decides from the peer's socket address alone, so no
byte is read before the decision. A whois error, timeout or empty answer is a
refusal. Only successful whois answers are cached (30 seconds, keyed by
address), and the allowlist is consulted on every use, so removing an entry
takes effect at once.

**Listener.** Binds only the node's own tailnet addresses from the status, only
while running, and never an unspecified address. With no tailnet interface
(userspace-mode `tailscaled`) the bind fails with `NoTailnetInterface` and does
not widen. Dialing resolves names from the status peer list, not system DNS,
and refuses addresses the tailnet does not list.

**Verified by CI (fake CLI, anonymised fixtures, loopback only).** Argv per
command, CLI location per OS, each state, unknown backend states, version
comparison, status and whois parsing including nulls, missing fields and
malformed JSON, the real runner against `/bin/sh` for large output and
timeout (unix), bind refusals, refusal of an unknown peer and of a whois
failure, echo for an allowlisted peer, name and address dialing, read
deadline, whois caching and revocation.

**NOT verified.**
- The minimum version (1.60.0) is a conservative floor, not taken from the
  changelog.
- JSON field names come from Tailscale's Go sources and a keys-only listing of a
  live `whois --json`. Real `status --json` shapes across versions are
  unchecked.
- Inbound connections to a userspace-mode daemon (they need the daemon's
  forwarding, not an OS listener).
- Behaviour on a real tailnet: peer reachability, ACLs, tagged-node whois,
  MagicDNS names, key expiry.
- The real runner and CLI location on a real install (only exercised against
  `/bin/sh` and a missing path).
- Official Tailscale download signing and checksums: unverified, and belong to
  the later bundling step.

**Manual test list (two real machines on a tailnet).**
1. Each machine: `NotInstalled` (rename the CLI), `NeedsLogin`, `Stopped`,
   `Running`; check the state the code reports.
2. Machine A listens, machine B dials by short name, full name and address;
   both allowlisted: session works.
3. B not in A's allowlist: refused, no session bytes.
4. Remove B from A's allowlist while connected: B's next connection is refused.
5. Tagged node as B: entry kind `tagged`; a `user` entry for the same node
   must not work.
6. Homebrew CLI against the app daemon: version warning present, still works.
7. Userspace-mode `tailscaled` as A: bind reports `NoTailnetInterface`.
8. Disconnect Tailscale mid-session: the connection errors, no panic.

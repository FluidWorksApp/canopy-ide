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
never one the joiner claims. Single use, expiry, constant-time comparison,
redacted `Debug`, and no logging anywhere in the crate. Wrong codes are counted
per proven peer key (5, then a 10 minute lock, with at most 64 keys tracked), so
one peer cannot lock another out; a key's attempts after its lock count nowhere,
so no single key can reach the global backstop (25 wrong codes across all keys
burns every live offer). Minting an offer resets no counter, so a UI that
refreshes offers on a timer would not refill an attacker's budget: offers are
minted only on an explicit user action. Locks lapse by the clock. A full
tracking table never blocks a correct code. Residual: many distinct keys
together can still reach the global cap, which burns live offers and makes the
host mint new ones; that is a nuisance, not a way to pair. The pairing exchange
itself is not yet wired to a network ALPN: when it is, it must use its own ALPN that is
open only while an offer is live, so the main session ALPN keeps refusing
strangers.

**Allowlist storage.** `Allowlist` is an in-memory shared set with a text file
form (one 64 hex key per line). A save writes a temp file beside the target with an
unpredictable name, `create_new` (so a planted symlink is never followed), mode
0600 from creation, fsyncs it, then renames; the directory is fsynced best
effort on unix. A poisoned lock (a thread panicked holding it) fails closed:
nothing is allowed, `add` errors and `save` refuses, until restart. Public keys
are not secret; the file is the access policy, so it must not be writable by other
users: `Allowlist::load` refuses (on unix) a file that is not a regular file owned by
the current user or root, or that is group or world writable. The file lives in the per-user profile directory next to the host's own
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
- ALPN `canopy-term/session/1` for the session protocol. It is advertised only
  after an explicit `listen()`; before that the endpoint only dials out, and
  `accept()` is an error.
- Accepted streams wait in a bounded queue (64); when it is full a new stream
  is dropped, never queued without bound. Refusal notices have their own small
  cap (8) so strangers cannot crowd out admitted peers.
- The allowlist is checked when the link comes up, for every new stream, and
  again after the stream preface; a revoked key's link is closed. A watcher also
  re-checks every live link each second (`REVOCATION_INTERVAL`), so removing a key
  ends the sessions already running over its link within about a second, not only
  its next stream. The close is abrupt: the peer's reads and writes fail.
- At most 256 incoming connections are handled at once (`MAX_LINKS`); past that
  the handshake is refused and no task is spawned.
- `LocalUnix::bind` creates the socket under a umask of 0o177 (restored before it
  returns, binds serialised) so it never exists with a wider mode than 0600, not
  even briefly. The umask is process wide: a file another thread creates in those
  few microseconds gets a stricter mode, which is harmless. A failed descriptor
  dup in `split` makes both halves return that error; it never panics.
- `LocalUnix` only unlinks its socket on drop if the path still holds the same
  inode it bound. Allowlist saves are serialised and read the list once.
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

**Out of scope: hosted workspaces.** Workspace containers do not run
`tailscaled`, so hosted workspaces are not a tailnet target and nothing here is
specific to them. Tagged-node support exists only because a tagged node has no
real user and must not be mistaken for one; it is not a workspace feature.

**Commands.** `CliCommand` is an enum, `Version`, `StatusJson`,
`WhoisJson(IpAddr)`, `Ip4`, and its `argv()` is the only place a command line is
built. `up`, `login`, `logout`, `serve`, `funnel` and `set` cannot be
expressed, and the one caller value is a typed address, so no peer-supplied
string reaches a command. Output is read from stdout only; stderr is drained and
discarded, which tolerates the version-mismatch warning a Homebrew CLI prints
against the app's daemon. Raw output is never logged (it holds tailnet names).
The real runner closes stdin, drains both pipes on threads, enforces a deadline
(2 seconds for `whois`, which sits on the accept path), kills and reaps on
timeout, and collects output with a deadline too, so a grandchild holding a
pipe cannot hang it.

**Which binary.** The CLI decides who is authorised, so it must not be one an
attacker planted. Only fixed install paths are tried (macOS app bundle,
Homebrew, `/usr/local/bin`; Linux `/usr/bin`, `/usr/local/bin`; Windows
Program Files); `PATH` is not consulted at all. The candidate is canonicalised
once and the absolute path kept, so nothing re-resolves it at spawn. On unix
the resolved file must be owned by root OR the current user, and not group or
world writable. Root covers pkg, App Store and distribution packages; the
current user covers a drag-installed app and a user-owned Homebrew prefix. A
binary owned by the current user is no stronger than that user's account,
the same trust boundary as the local socket transport. Anything else is
`InstallProblem::Untrusted` (via `ProcessRunner::locate()`, so a UI can say
"untrusted install" rather than "not installed"); `installed()` returns `None`.
The file's (device, inode) is recorded and re-checked (not a symlink, owner and
mode) immediately before every spawn; a replaced binary is not run. The tiny
window between that check and the spawn is not closed (no portable fexecve),
which is why the file must be unwritable to everyone else. Parent directories
are not checked: `/Applications` is group-writable on macOS by design.
The child runs with an EMPTY environment (no `TS_SOCKET`, `LD_PRELOAD`,
`DYLD_*`, proxy variables or `PATH`), only a fixed `PATH` on unix and
`SystemRoot`/`windir` on Windows. A non-default `TS_SOCKET` therefore does not
work; that is deliberate. Whether the CLI needs anything more on a real macOS
or Linux install (for example `HOME`) is UNVERIFIED and is the first thing the
manual test checks. Windows has no ownership check; the Program Files paths
are admin-writable only. The CLI version is checked once, when a transport is
created, and `Probe` carries it.

**States.** `TailnetState`: `NotInstalled`, `DaemonUnreachable`, `NeedsLogin`,
`NeedsMachineAuth`, `Stopped`, `Starting`, `Running`, `TooOld(version)`,
`Unknown(state)`. Only a backend state of exactly `Running` maps to `Running`;
`NoState`, `InUseOtherUser` and anything unrecognised are `Unknown`. The state
is judged from stdout JSON whatever the exit code.

**Identity and the allowlist.** A peer is identified by the stable node id plus
the user id, never by node or login name (display values that can be renamed):

- `tailnet:user/<stable node id>/<user id>@<tailnet domain>`
- `tailnet:tagged/<stable node id>/<sorted tags>@<tailnet domain>` for nodes owned by ACL tags,
  which have no real user. Its own kind, so a user entry never authorises a tagged node. Retagging changes the
  entry, so a retagged node is refused until re-approved.

The user id has no leading zeros. The trailing `@<tailnet domain>` (the node's DNS
domain, such as `example.ts.net` or a Headscale base domain) binds the entry to the
tailnet it was approved on: stable ids and user ids are only unique within one
tailnet or control server, so after switching account or control server the same
numbers could name a different machine. The accepting side reads its own tailnet
from the status and admits a peer only if whois places the peer in that same
tailnet and the entry carries it, so an entry recorded elsewhere, a node shared in
from another tailnet, and an entry with no `@<domain>` at all (unbound; it parses
so it can be listed and removed, but authorises nothing) never match. If this
machine's tailnet cannot be read, everything is refused. The domain is a tailnet
name: it is kept out of logs and fixtures use only invented names. A caller that
builds an entry from a fresh whois answer should use
`TailnetIdentity::allowlist_entry()`, which includes it. A source that is this
machine (one of its own tailnet addresses, or whois naming this node) is refused.

These sit in the same `Allowlist` as device keys but in a separate namespace
(`tailnet:` prefix), so they can never collide with a 64 hex iroh key. A whois
answer with neither tags nor a real user is an error and a refusal.
**Tailnet membership is not authorisation**: on the ACCEPTING side the
identity must also be in the allowlist. The DIALING side needs no allowlist
entry (connecting out is the user's own act); instead `whois` on the address
must return the same stable node id the status listed for that node, so an
address cannot be swapped for another machine's. This machine's own addresses
are never dialed. Dialing only reaches nodes in this machine's own tailnet: a node
shared in from another tailnet is never matched by short name, full name or address
(so it can neither be reached through, nor make ambiguous, a name that is also a
local one), and whois must place the address in the same tailnet.

**An entry authorises a machine, not a person.** whois names the node that owns
the source address. Anyone using that machine (another account on a shared
computer, a process of any user) is that identity. A node that routes more than
its own addresses (a subnet router or exit node: `AllowedIPs` beyond its own
host addresses, or any `PrimaryRoutes`) is refused, because connections through
it could come from any machine behind it; so is a source address that whois
attributes to a node but that is not one of the node's own `Addresses`. A whois
answer with `AllowedIPs` missing, null or empty is an error too: on the wire it may
mean "same as Addresses", but absence is not evidence that the node routes nothing.

**Fail closed.** Accept decides from the peer's socket address alone, so no
byte is read before the decision. A source address outside the tailnet ranges
is refused before any lookup. A whois error, timeout or empty answer is a
refusal. Successful answers are cached 10 seconds and failures 5 seconds, keyed
by address. The short positive cache bounds how long a retag or a reassigned
address keeps a stale identity, at the cost of one CLI spawn per expiry for a
busy peer. The allowlist is consulted on every use, so removing an entry takes
effect at once for new connections, and a sweep every 250 ms shuts down any live
connection whose entry has been removed (or whose tailnet is no longer this
machine's), so removal ends running sessions within about a quarter of a second.
The shutdown is abrupt: the peer's reads and writes fail. (On Windows a read already blocked on the server side is not woken by the shutdown; the peer sees it at once and the server's reader ends when the peer closes.) The tailnet's own view of
the peer (a retag, a deleted node) is decided at admission and not re-checked while
the connection lives; the tailnet stops carrying packets its ACLs forbid.

Whois runs on four worker threads fed by a bounded queue (64); a full queue drops
the connection unread, and a source address may have at most 8 connections waiting
in it at once, so one address cannot fill it. The lookup budget is split into
lanes of 60 spawns per minute each: known peers (listed in the status, with a
stable id the allowlist holds), every other source, and dialing. A flood of unknown
addresses can therefore exhaust only its own lane; known peers and dials keep
theirs. A peer that has never been seen and arrives during such a flood waits for
the next window. Refusals and failed lookups are rate limited per source address
(20 per minute) but never for known peers, so a transient whois failure cannot lock
an approved peer out. A full cache evicts its single oldest entry; a flood of
addresses never empties it. This machine's own view (addresses, node id, tailnet,
peer list) is read from `status --json` at most once per 10 seconds, one spawn at a
time. The result channel is bounded (64) too, so no queue grows without limit.

**Listener.** Binds only the node's own tailnet addresses from the status, only
while running, never an unspecified address, and only addresses inside
Tailscale's ranges (100.64.0.0/10, fd7a:115c:a1e0::/48): the status is not
trusted enough to choose an arbitrary address. Loopback is allowed only by a
test-only constructor. With no tailnet interface
(userspace-mode `tailscaled`) the bind fails with `NoTailnetInterface` and does
not widen. Dialing resolves names from the status peer list, not system DNS,
and refuses addresses the tailnet does not list.

**Verified by CI (fake CLI, anonymised fixtures, loopback only).** Argv per
command, CLI location per OS, each state, unknown backend states, version
comparison, status and whois parsing including nulls, missing fields and
malformed JSON, the real runner against `/bin/sh` for large output, timeout
and a grandchild holding the pipe (unix), fixed install paths only, the owner/mode trust rule (root or
the current user), re-check before spawn, empty child environment, bind refusals including
addresses outside the tailnet ranges, refusal of an unknown peer, of a whois
failure and of a subnet router, echo for an allowlisted peer through the
worker pool, name and address dialing (no allowlist entry needed; a whois id
mismatch, whois failure and the machine's own address refused),
the per-lane lookup budgets (a stranger flood leaves a known peer and a dial
working), the per-source queue cap, oldest-first eviction, tailnet binding (an entry
for another tailnet, an unbound entry, a moved machine, a shared-in peer, an
unknown own tailnet), this machine refused as a source, name resolution that never
reaches a shared-in node, `AllowedIPs` required, user ids without leading zeros,
read deadline, positive and negative caching, rate limiting, revocation of live
connections (allowlist removal and a tailnet switch), a too-old CLI, and redacted
`Debug`.

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
- The ownership check against real installs on Linux (only the pure rule and
  files in a temp directory are tested);
- That the CLI works with the empty environment on real installs; a full worker queue dropping connections (not exercised).
- Official Tailscale download signing and checksums: unverified, and belong to
  the later bundling step.

**Manual test list (two real machines on a tailnet).**
1. Each machine: `NotInstalled` (rename the CLI), `NeedsLogin`, `Stopped`,
   `Running`; check the state the code reports.
2. Machine A listens, machine B dials by short name, full name and address;
   both allowlisted: session works.
3. B not in A's allowlist: refused, no session bytes. A dials B with B's
   allowlist irrelevant on A's side: dialing out works with an empty list.
4. Remove B from A's allowlist while connected: B's running connection is closed
   within about a second and its next connection is refused.
5. Tagged node as B: entry kind `tagged`; a `user` entry for the same node
   must not work.
6. Homebrew CLI against the app daemon: version warning present, still works.
7. Userspace-mode `tailscaled` as A: bind reports `NoTailnetInterface`.
8. Disconnect Tailscale mid-session: the connection errors, no panic.

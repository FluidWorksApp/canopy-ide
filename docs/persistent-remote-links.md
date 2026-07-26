# Persistent remote links — a lightweight router on canopy.dev

Research note, not yet a commitment to build. Goal: **one stable URL per Canopy
install**, claimed once and bound to that IDE forever, reachable from anywhere,
with no per-user DNS work and no dependency on `trycloudflare.com`.

## 1. Where we are today

| Piece | File | What it gives us |
|---|---|---|
| Portal (Canopy Remote) | `src-tauri/src/portal.rs` | axum HTTP+WS on `0.0.0.0:6680`, serves the baked SPA, `POST /remote/auth` (6-digit PIN → bearer), `/remote/ws` (snapshots, pty attach/input/kill/spawn), `/team/ws` (relay ingress) |
| Public link | `src-tauri/src/tunnel.rs` | spawns `cloudflared`/`ngrok`/`tailscale`, scrapes stdout for the URL, QUIC→http2 watchdog |
| Machine identity | `src-tauri/src/relay.rs` (`mod identity`) | long-term Ed25519 key at `~/.canopy/relay-identity`, TOFU pinning, signed session binding |
| Public address | `src-tauri/src/punch.rs` | STUN discovery, used for the port-forward URL |

The gap is entirely in the second row. `cloudflared --url` mints a **quick
tunnel**: a fresh random `*.trycloudflare.com` hostname on every start, gone when
the process dies. Everything downstream of it — QR codes, saved bookmarks, links
pasted into Slack, a phone that had the portal open — breaks on every restart.
The portal itself is already stable and already speaks a protocol that survives
reconnects, so **nothing in `portal.rs` needs to change** for this work.

Two things persistence forces us to fix, called out early because they are
design constraints, not follow-ups:

- **A permanent URL is a permanent attack surface.** A 6-digit PIN
  (`gen_pin()`) behind a 2s tarpit is defensible for a URL that lives 40 minutes
  and is unguessable; it is thin for `sam-mbp.remote.canopy.dev` that answers
  forever. See §7.
- **The edge sees plaintext.** Any hostname-routing edge must terminate TLS, so
  it can read portal traffic. That is the same trust position `cloudflared` puts
  us in today — but today it's Cloudflare's problem, and after this it's ours.

## 2. The one idea that makes this cheap

**Do not touch DNS per user.** The instinct is "claim a URL → write a Route 53
record". Don't: that buys API rate limits, propagation delay, TTL debugging, and
a record set that grows without bound.

Instead: **one wildcard record, forever**, and all the dynamism lives in a
process. DNS answers every `*.remote.canopy.dev` query with the same edge IP;
the edge decides at request time which live tunnel a hostname belongs to. That
is exactly how Cloudflare Tunnel works (`*.trycloudflare.com` is one wildcard;
`cfargotunnel.com` routing happens in their edge), and it's why a 300-line
router can imitate it.

```
browser ──TLS──▶ edge (canopy-edge)  ◀──persistent WSS── Canopy (your Mac)
   slug.remote.canopy.dev                                 outbound only,
   Host: slug.…      │                                    no port forward
                     └── routing table: slug → live connection → yamux stream
                                                              └─▶ localhost:6680
```

## 3. Route 53 setup (concretely)

Assuming `canopy.dev` is a hosted zone you already own:

| Name | Type | Value | Why |
|---|---|---|---|
| `edge.remote.canopy.dev` | A | Elastic IP of the edge box | the thing that actually exists; every other name is an alias of it |
| `*.remote.canopy.dev` | A | same EIP (or ALIAS to `edge.…`) | every user's link, one record, never edited |
| `claim.remote.canopy.dev` | A | same EIP | the claim/bind endpoint (§5) |
| `_acme-challenge.remote.canopy.dev` | TXT | written by ACME | wildcard certs require DNS-01 (§4) |

Notes that will bite otherwise:

- Route 53 wildcards match **any** depth (`a.b.remote.canopy.dev` matches), but
  wildcard **certificates** cover exactly one label. So slugs must be
  single-label: `amber-pine-42.remote.canopy.dev`, never `sam/mbp` or
  `mbp.sam.remote…`.
- Put the wildcard under a dedicated `remote.` label, not at the zone apex.
  `*.canopy.dev` would swallow every future subdomain (docs, api, status) the
  moment one is missing.
- A wildcard record does **not** shadow explicit records at the same level —
  `edge.remote` and `claim.remote` win over the wildcard. That's why they're
  listed separately.
- TTL 60s on the wildcard while you're single-region, so a failover/IP change is
  a minute, not an hour. Optionally add a Route 53 health check on
  `edge.…/healthz` and a secondary failover record once there's a second box.

## 4. TLS: three ways, pick one

The edge needs a valid cert for `*.remote.canopy.dev`, renewed forever, without
per-slug issuance (Let's Encrypt caps ~50 certs/week per registered domain — a
wildcard sidesteps this entirely, one cert covers every user).

**A. Own process terminates, ACME DNS-01 via Route 53** — recommended start.
ACM won't export private keys for public certs, so if your Rust process holds
the socket it needs Let's Encrypt. Either in-process (`rustls-acme` /
`instant-acme` + a Route 53 TXT writer) or, less code to own, **Caddy in front**:

```caddyfile
*.remote.canopy.dev, claim.remote.canopy.dev {
  tls { dns route53 }          # xcaddy build --with .../caddy-dns/route53
  reverse_proxy localhost:8080 # canopy-edge; Caddy passes WS upgrades through
}
```
Cost: one instance. Caddy owns cert lifecycle; the router owns routing.
IAM for the DNS-01 principal: `route53:ChangeResourceRecordSets` +
`ListHostedZonesByName` + `GetChange`, scoped to that one hosted zone.

**B. ALB terminates with an ACM wildcard** — no ACME code at all, free
auto-renewing cert, ALB natively proxies WebSockets and preserves `Host`.
Two settings matter: idle timeout must be raised from 60s (max 4000s) and the
client should ping anyway, because ALB will still cut an idle control
connection. Costs ~$16–20/mo of ALB before any traffic, and you inherit ALB's
request semantics. Right answer once the edge is more than one instance.

**C. NLB in TCP/TLS mode** — needed later for the QUIC/WebTransport path
(`preview.rs`/portal phase 2): NLB has UDP listeners but won't terminate QUIC,
so the router terminates it itself with `quinn` and advertises `Alt-Svc`. Not
phase 1.

## 5. Claim-and-bind: the URL lifecycle

This is the part that reuses the pattern we already have (a code shown in the
IDE, proven over the wire) rather than inventing accounts.

1. **Mint.** Canopy `POST claim.remote.canopy.dev/v1/slugs` with its Ed25519
   public key (`identity::local().pubkey_hex` — the key already on disk at
   `~/.canopy/relay-identity`). Edge replies with a reserved slug (readable
   triple, `amber-pine-42`, or `<hostname>-<4 random>` if free), a one-time
   claim code, and a 10-minute expiry. Nothing is public yet.
2. **Claim.** The desktop shows the URL plus a 6-digit code (same affordance as
   the team join code). Opening `https://claim.…/c/<code>` — or entering the
   code in the portal — commits the binding `slug → pubkey` in the edge's
   store. Unclaimed reservations expire and the slug returns to the pool.
3. **Connect.** On every start, Canopy dials `wss://edge.…/v1/tunnel`. Edge
   sends a nonce; Canopy signs `"canopy-edge:" || nonce || slug` with the same
   key; edge verifies against the stored pubkey and installs
   `slug → this connection` in its routing table. **No long-lived bearer token
   exists to be stolen** — same reasoning as the relay's session binding
   (`derive(&key, None, b"canopy-relay identity-binding")`).
4. **Persist.** The binding is a row (SQLite on the box is genuinely enough at
   this scale; DynamoDB if you want the edge stateless). Reboots, IP changes,
   Wi-Fi → tethering, laptop sleep: the socket reconnects and the *same URL*
   comes back. That is the whole feature.
5. **Rebind / revoke.** New machine or wiped `~/.canopy`: the key changes, so
   the slug is orphaned. Needs an owner-level escape hatch — either an account
   (email magic link) or a recovery code printed at claim time. Ship the
   recovery code first; it's one column, not an identity system.
6. **Offline.** Slug bound but no live connection → the edge serves a branded
   "this Canopy is offline" page (hold the request ~5s first, so a reconnecting
   laptop doesn't show an error page to someone who clicked a second too early).

## 6. The router itself

`canopy-edge`, a single Rust binary. Two listeners, one map:

```rust
type Routes = Arc<DashMap<String /*slug*/, TunnelHandle>>;
```

- **Tunnel listener** (`/v1/tunnel`): authenticates per §5.3, then runs **yamux
  over the WebSocket**. Streams, backpressure and cancellation come for free
  instead of being hand-rolled over a frame header.
- **Public listener** (everything else): read `Host`, strip
  `.remote.canopy.dev`, look up the slug, open a yamux stream, and reverse-proxy
  the request down it with hyper. `Upgrade: websocket` is handled the same way
  any hyper reverse proxy handles it — upgrade, then bidirectional copy — so
  `/remote/ws` and `/team/ws` need no special case.
- **Canopy side**: for each inbound yamux stream, connect to `127.0.0.1:6680`
  and pump bytes. The tunnel is deliberately **not HTTP-aware** — the existing
  axum portal keeps serving its own routes, its own PIN, its own SPA, unchanged.

Client changes in Canopy are small and shaped like what's already there:
`TunnelState { running, provider, url, message }` is the right shape already,
so `provider: "canopy"` becomes a fourth arm — except instead of spawning a
child and scraping stdout, an in-process task holds a reconnecting WS
(exponential backoff + jitter, ping every 20s). Delete no code: quick tunnels
stay as the zero-setup option.

Rough size: ~700 lines for the edge, ~300 in `tunnel.rs`, ~1 screen of claim UI.
A working phase 1 is days, not weeks — the hard parts (auth, portal protocol,
identity keys) already exist.

## 7. What persistence obliges us to add

- **Raise the portal credential.** A permanent public hostname plus a 6-digit
  PIN is ~10⁶ guesses against an endpoint that answers forever. Either move the
  gate to the edge (account login, then the edge injects nothing — the portal
  PIN stays as second factor), or lengthen the PIN and add per-IP exponential
  backoff at the edge on top of the existing 2s tarpit.
- **Rate-limit and bot-wall at the edge**, since the router is now the front
  door for everyone. Cheap: token bucket per IP per slug.
- **Say plainly in the UI that the edge terminates TLS.** `portal.rs`'s doc
  comment is already honest about the team relay's trust model; hold that line.
- **Egress is the real bill.** Terminal text is nothing; preview screenshots and
  file transfer are not. EC2 egress is ~$0.09/GB, whereas a **Lightsail** bundle
  includes multiple TB — for a byte-pushing service that's the bigger lever than
  instance size.

## 8. Cheaper paths, if the point is to validate the UX this week

| Path | Persistent URL on our domain? | Cost to us | Why not just this |
|---|---|---|---|
| **frp** self-hosted (`subdomainHost = remote.canopy.dev`, `vhostHTTPSPort = 443`) | yes, today, zero code | one box | shared static `auth.token`, and the *client* asserts its own subdomain — any install can claim any slug. No per-user binding. Great **spike**, not a product. |
| **rathole** | yes | one box | same trust model as frp, fewer features, faster |
| **Pangolin + Newt** (WireGuard-based, self-hosted, dashboard + ACME + access control) | yes | one box | a whole platform to operate and skin; worth reading for its access-control model |
| **Cloudflare named tunnels** on a delegated zone (`remote.canopy.dev` NS → Cloudflare, rest of `canopy.dev` stays in Route 53) | yes, free, no infra | $0 | each user needs a tunnel + token provisioned in *our* CF account via API, and we stay dependent on CF — but this is by far the fastest route to "the link doesn't change" |
| **Tailscale Funnel** | no — `*.ts.net`, their identity | $0 | persistent, but not our domain and requires a tailnet per user |

My read: spike with **frp** for a day to feel the UX with a stable hostname, and
if the shape holds, build `canopy-edge` — because the claim-and-bind step (§5) is
the actual product surface, and none of the off-the-shelf servers will do it the
way we want.

## 9. Phased plan

1. **Phase 0 — spike (1 day).** t4g.small + EIP + the Route 53 records in §3 +
   Caddy wildcard cert + frp. Point one Canopy at it. Confirm: portal loads,
   `/remote/ws` survives, sleep/wake keeps the URL.
2. **Phase 1 — `canopy-edge` (days).** yamux tunnel, slug table, sign-in-with-
   identity-key, offline page, `provider: "canopy"` in `tunnel.rs`, claim UI.
3. **Phase 2 — hardening.** Edge auth, rate limits, recovery codes, structured
   logs + `/healthz` + Route 53 health check, systemd + reconnect-on-deploy.
4. **Phase 3 — scale/latency.** ALB or a second region behind failover records;
   QUIC/WebTransport listener for the preview path.

## Sources

- [Cloudflare Tunnel routing](https://developers.cloudflare.com/tunnel/routing/) · [DNS records for tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/) · [subdomains outside Cloudflare](https://developers.cloudflare.com/dns/manage-dns-records/how-to/subdomains-outside-cloudflare/)
- [Delegating a Route 53 subdomain to Cloudflare](https://community.cloudflare.com/t/delegate-route53-subdomain-to-cloudfare/852882)
- [frp custom subdomain](https://gofrp.org/en/docs/features/http-https/subdomain/) · [frp](https://github.com/fatedier/frp) · [awesome-tunneling list](https://github.com/TamirGaltus/awesome-tunneling-p2p) · [open-source Cloudflare Tunnel alternatives, 2026](https://ossalt.com/guides/best-open-source-alternatives-cloudflare-tunnels-2026)
- [Pangolin as a self-hosted tunnel](https://leewc.com/articles/self-hosted-cloudflared-tailscale-alternative-pangolin/)
- [ALB WebSocket config and idle timeout](https://websocket.org/guides/infrastructure/aws/alb/) · [ALB attributes (idle timeout 1–4000s)](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html) · [host-based routing](https://oneuptime.com/blog/post/2026-02-12-host-based-routing-application-load-balancer/view)
- [Route 53 wildcard matching](https://repost.aws/questions/QUaeXOjv0CR6KbbvWKNMmPgA/route53-only-route-single-level-on-wildcard-subdomain) · [ACM + Route 53 wildcard certs](https://dev.to/aws-builders/easily-register-ssl-certificates-on-aws-with-route-53-and-aws-certificate-manager-24j1)

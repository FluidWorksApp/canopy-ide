# Canopy remote edge

Gives each signed-in Canopy user a stable `https://<handle>.remote.canopyide.dev` that reaches their
desktop Canopy through one tunnel WebSocket. Node 22, no framework; `ws` is the only dependency.

```
browser ── https ──> Caddy (*.DOMAIN, edge.DOMAIN; TLS) ──> edge 127.0.0.1:8080 <── wss /v1/tunnel ── desktop
```

## Behaviour

- `GET /healthz` → `200 ok` on any host; not rate limited.
- `edge.<DOMAIN>/v1/tunnel`: WebSocket upgrade with `Authorization: Bearer <tunnel token>`. Bad token → `401`.
  A new connection for a handle closes the old one with code `4001`, reason `replaced`. The edge sends text
  `{"t":"hello","handle","url"}`, pings every 20 s and drops a tunnel after 60 s without any frame or pong.
- Binary frames `[type:u8][stream:u32 BE][payload]`: `0x01 OPEN` (edge→desktop, JSON `{"auth","ip"}`),
  `0x02 DATA`, `0x03 END` (half-close), `0x04 RESET`. Edge-chosen odd, increasing stream ids. Each stream is
  one raw HTTP/1.1 connection; the edge opens one stream per browser request (it sends `Connection: close`)
  or per WebSocket upgrade. No per-stream flow control: a slow stream can stall the others.
- `<handle>.<DOMAIN>`:
  - `/_canopy/auth?ticket=` → single-use ticket for this handle → host-only `canopy_remote` cookie
    (`Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`) → `302` to the ticket's `ret`. Otherwise `403`.
  - `/_canopy/signout` → clears the cookie, `302 /`.
  - `/team/ws` → proxied with `auth:"none"`, no cookie needed.
  - Anything else needs a `canopy_remote` cookie for this handle, else `302
    <AUTH_ORIGIN>/remote/<handle>?ret=<path+query>` (WebSocket upgrades get `401`).
  - Desktop not connected → waits up to 5 s for it, then a `503` "This Canopy is offline" page.
  - 60-request burst, 20/s refill per client IP → `429`.
- Forwarded requests keep `Host`, lose hop-by-hop headers and the `canopy_remote` cookie, and get
  `X-Forwarded-For: <client ip>` and `X-Forwarded-Proto: https`. The client IP is the rightmost
  `X-Forwarded-For` entry when the peer is loopback (Caddy), otherwise the socket address.

`test-client.mjs` is a minimal desktop side of the protocol; the tests use it to serve an `http.Server`
over tunnel streams.

## Test

```
npm test --workspace @canopy/remote-edge
```

## Deploy (AWS)

1. EC2 instance with an Elastic IP, ports 80 and 443 open. Install Node 22+.
2. Route53, in the zone that holds `canopyide.dev`: `A *.remote.canopyide.dev → <EIP>` (this also covers
   `edge.remote.canopyide.dev`).
3. Caddy with the Route53 DNS provider (wildcard certificates need DNS-01):
   `xcaddy build --with github.com/caddy-dns/route53`, install the binary as `/usr/bin/caddy` with the
   standard `caddy.service` unit and `/etc/caddy`.
4. Give the instance an IAM role for DNS-01 limited to the zone. Caddy uses the default AWS credential chain.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["route53:ListHostedZonesByName", "route53:ListHostedZones"], "Resource": "*" },
       { "Effect": "Allow", "Action": ["route53:GetChange"], "Resource": "arn:aws:route53:::change/*" },
       { "Effect": "Allow", "Action": ["route53:ListResourceRecordSets"], "Resource": "arn:aws:route53:::hostedzone/<ZONE_ID>" },
       {
         "Effect": "Allow",
         "Action": ["route53:ChangeResourceRecordSets"],
         "Resource": "arn:aws:route53:::hostedzone/<ZONE_ID>",
         "Condition": {
           "ForAllValues:StringEquals": {
             "route53:ChangeResourceRecordSetsNormalizedRecordNames": ["_acme-challenge.remote.canopyide.dev", "_acme-challenge.edge.remote.canopyide.dev"],
             "route53:ChangeResourceRecordSetsRecordTypes": ["TXT"]
           }
         }
       }
     ]
   }
   ```

5. Copy this directory to the instance and run `sudo ./install.sh`. The first run writes
   `/etc/canopy-remote-edge.env` (root:canopy-remote-edge, 0640) and stops:

   ```
   CANOPY_REMOTE_EDGE_SECRET=<same value as the website, at least 32 characters>
   CANOPY_REMOTE_DOMAIN=remote.canopyide.dev
   CANOPY_REMOTE_AUTH_ORIGIN=https://canopyide.dev
   ```

   Fill in the secret and run it again. It installs `/opt/canopy-remote-edge`, the
   `canopy-remote-edge` systemd unit (listens on `127.0.0.1:8080`), and, when Caddy is present,
   `/etc/caddy/Caddyfile` plus a `caddy.service` drop-in that sets `CANOPY_REMOTE_DOMAIN`.
6. Check: `curl https://edge.remote.canopyide.dev/healthz` → `ok`; logs in `journalctl -u canopy-remote-edge`.

A restart drops tunnels (desktops reconnect on their own); cookies stay valid because they are signed, not
stored. Used ticket nonces live in memory, so run a single edge instance.

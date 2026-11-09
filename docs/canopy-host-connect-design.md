# A lightweight Canopy host for any machine

Status: step 0 is built (Canopy as a T3 Code client: `src/t3connect/`, `src-tauri/src/t3_client.rs`); steps 1 to 4 are proposals.

The goal: one small `canopy-host` program that runs on any Linux VM (or a Mac or
Linux box) and can be reached from the Canopy app in whichever way suits the
user: SSH, Tailscale, a Cloudflare tunnel, the local network, or a Canopy
account (the managed path, like T3 Connect). The same program runs on our
managed VMs.

This copies T3 Code's connection design (pingdotgg/t3code, MIT; `docs/internals/remote.md`,
`environment-auth.md`, `t3-connect.md`, `docs/user/remote-access.md`), adapted
to Canopy's gateway.

## How T3 Code does it

T3 Code separates **how a client reaches a machine** from **who the client is**.

- **One server, many routes.** The machine runs one server. LAN, Tailscale, SSH
  and T3 Connect are only different ways to reach it, not different products.
- **Auth belongs to the server, never the route.**
  - A device pairs once with a one-time code. The code is exchanged for a scoped
    session (bearer, or DPoP-bound to the client's key).
  - The pairing URL keeps the secret in the `#fragment`, so it is never sent to a
    hosted page.
  - WebSockets use short-lived tickets.
- **Tailscale needs nothing special.** `t3 serve --tailscale-serve` runs
  `tailscale serve` to get an `https://machine.tailnet.ts.net` address. The
  device then pairs as usual.
- **T3 Connect is a broker, not a proxy.** It has three parts:
  - The user signs in with a cloud account (Clerk), on the host too. A headless
    host signs in by device code: open a link on any device and approve a short
    code.
  - The relay gives each machine its own Cloudflare Tunnel and hostname.
    `cloudflared` runs on the host, pinned and auto-updated.
  - To connect, the relay asks the machine to mint a one-time bootstrap
    credential bound to the client's key. The client then talks **directly** to
    the machine through its tunnel. The relay never sees the session token or the
    traffic.
- **Headless setup is one command.** `t3 up` asks "T3 Connect, local network, or
  both" and installs a background service.
  - In LAN mode the server listens on all interfaces. It drops any connection
    whose peer isn't loopback, private or tailnet, so a VPS's public IP stays
    closed.
- **Clients keep a list of routes per machine.**
  - The client uses the first route that answers. It first checks that the route
    answers as the same machine id, so a token never goes to the wrong host.
  - Routes the machine reports, such as its LAN and tailnet addresses, are
    learned automatically.
  - While on a slower route, the client keeps checking the faster ones and moves
    back when one works.
- **SSH can start the server as well as forward a port.** The desktop downloads
  the server to `~/.t3/runtime` on first connect.

## What Canopy has today

- **Self-hosted host** (`packages/remote-host/install.sh`):
  - Needs root, Docker, systemd, Node 22 and a prebuilt workspace image.
  - The gateway listens on `127.0.0.1:8787` only, so you reach it through your
    own SSH forward.
  - Tokens are created once by `init.mjs` (demo principals `alice` and `bob`)
    and stored hashed in `host.json`. You paste the endpoint and token into the
    app.
  - There is no pairing and no tunnel, and revoking access means editing
    `host.json`.
- **Managed workspaces:**
  - canopyide.dev hands out `https://<id>.workspaces.canopyide.dev` and
    5-minute HMAC tokens (`policy.mjs` `managedSession`).
  - The app signs in with a device flow (`/api/device` in `client_mode.rs`).
- **Tunnels and relay exist, but only for other features:**
  - `tunnel.rs` (cloudflared, ngrok, Tailscale funnel) and `canopy_link.rs` /
    `packages/remote-edge` expose the desktop's phone portal.
  - The relay carries team mesh messages.
  - None of these reach a remote host.
- **There is a seam for a non-Docker backend.** The gateway asks `workspaces.open(workspace)`
  for a runtime `{url, token}` (`gateway.mjs:103`). `DockerWorkspaces` is the
  only implementation. `runner.mjs` is a plain Node server, but it hard-codes
  `/home/agent`, `/workspace` and display `:99`.

## Proposal

### 1. One `canopy-host` program, two backends

- **Docker backend:** today's managed host, unchanged.
- **Process backend:** a new `ProcessWorkspaces` with the same `open()` shape.
  - It runs `runner.mjs` as the installing user, in a folder such as
    `~/.canopy-host/workspaces/<id>`.
  - No root, no Docker and no image are needed.
  - The work is making the runner's paths configurable (home, workspace root,
    display, browser profile).
  - The trade-off: no container isolation, so agents run as that user, exactly
    as T3's server does.

Install, as T3 does with `npx t3` / `t3 up`:

```sh
npx canopy-host up            # or: curl -fsSL https://canopyide.dev/host.sh | sh
```

`up` asks how devices should reach this machine (any combination):
- Canopy account
- Tailscale
- Cloudflare tunnel
- Local network
- SSH only

It then installs a user-level service: `systemd --user` on Linux, `launchd` on a
Mac.

### 2. Pairing replaces hand-edited tokens

This copies T3's pairing.

- `canopy-host pair [--view|--drive]` prints a link and a QR code
  in T3's shape, `https://<host>/pair#token=<one-time code>`.
- The app exchanges the code at T3's `POST /oauth/token` (token exchange) for a
  session token with that scope. `policy.mjs` already has view, drive and admin scopes.
- The host stores only a hash of the token, plus a label and a last-used time.
  - `canopy-host sessions` lists sessions.
  - `canopy-host revoke <id>` revokes one.
- A code works once and expires after 10 minutes.
- Exchanging a code can narrow its scope but never widen it.
- Streams keep using the existing one-use tickets (`policy.mjs` `Tickets`).
- `GET /.well-known/t3/environment` (no auth) returns the host id, version and
  capabilities, so a client can check it reached the right machine before
  sending a token.

### 3. Routes, all through the same auth

| Route | What `canopy-host` does | Notes |
|---|---|---|
| SSH | nothing new | The app could also start the host over SSH, as T3 does. |
| Local network | listens on `0.0.0.0`, but only accepts loopback, private and `100.64.0.0/10` peers | This is T3's rule. HTTP is allowed only there, as T3 does. |
| Tailscale | runs `tailscale serve --https=443 http://127.0.0.1:8787` | Gives an HTTPS name with no certificate work. |
| Cloudflare | runs `cloudflared tunnel --url http://127.0.0.1:8787` (quick tunnel) or a named tunnel with the user's own token | Reuses the process handling in `tunnel.rs`. A quick tunnel's URL changes on each restart, so it suits trying things out. |
| Canopy account | device-code sign-in on the host. canopyide.dev allocates a per-host tunnel and hostname, then brokers a one-time bootstrap credential | The T3 Connect equivalent, described below. |

The app's `remoteEndpoint()` rule (HTTPS, or HTTP on loopback) widens to allow
HTTP on private and tailnet addresses, but only for a host that was paired over
HTTP.

### 4. The managed path, like T3 Connect

canopyide.dev already has accounts, a device flow and `*.workspaces.canopyide.dev`.
What it lacks is a broker for hosts the user owns.

1. **Link the host to an account.** `canopy-host up --account` runs a device-code
   sign-in, like T3's Clerk device grant, and registers the host's public key
   with the account.
2. **Give it a hostname.** canopyide.dev allocates a Cloudflare Tunnel and a
   hostname such as `<host>.hosts.canopyide.dev`, and returns a connector token.
   `canopy-host` runs a pinned `cloudflared` with it.
3. **Connect.** The app, signed in to the same account, lists the account's hosts.
   - To connect, canopyide.dev asks the host, through its tunnel, to mint a
     one-time bootstrap credential bound to the app's key.
   - The host signs its answer, and canopyide.dev checks the signature before
     passing the credential on.
   - The app then pairs directly with the host.
   - canopyide.dev never holds the session and never carries the traffic.
4. **Managed VMs** run the same program with the account route turned on, so
   there is one host codebase.

Copy T3's operational rules too:
- A sleeping laptop's tunnel is reclaimed and recreated later under the same
  hostname.
- The broker never follows redirects and only ever targets the loopback origin
  it allocated.

### 5. Client: a route list per host

- Saved connections in `client_mode.rs` become `{hostId, routes: [...], session}`
  instead of one `endpoint`.
- Try routes in order, check `/.well-known/t3/environment` first, and learn the LAN and
  tailnet addresses the host reports.
- While on a later route, check earlier ones every minute and when the network
  changes, as T3's supervisor does.
- Port this logic from T3's `packages/client-runtime/src/connection/driver.ts`
  and `supervisor.ts`.

## Talking to T3 Code machines directly

A T3 Code machine needs no account to connect to. The account (T3 Connect) and
Tailscale only make its URL reachable from another network. The connection
itself is a URL plus a one-time pairing code, and works over any network that
reaches the machine: the same LAN, Tailscale, a Cloudflare tunnel, or a T3
Connect hostname. So Canopy can be a T3 Code client with no T3 login.

The protocol, from T3's `packages/contracts` and `packages/client-runtime`:

1. **Pairing link:** `t3 pair` prints `https://<host>/pair#token=<code>`. The
   code is in the fragment, so it never reaches a web server.
2. **Check the machine:** `GET /.well-known/t3/environment` (no auth) returns
   `{environmentId, label, platform, serverVersion, capabilities}`.
3. **Redeem the code:** `POST /oauth/token`, form-encoded:
   - `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
   - `subject_token=<code>`
   - `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`
   - `requested_token_type=urn:ietf:params:oauth:token-type:access_token`
   - optional `scope` and `client_label`

   The answer is `{access_token, token_type: "Bearer", expires_in, scope}`.
   A DPoP-bound token is optional.
4. **Open the socket:** `POST /api/auth/websocket-ticket` with the bearer token
   gives a short-lived ticket. Then open `wss://<host>/ws?...` with it.
5. **Call methods:** Effect RPC with JSON serialization. The server has
   `projects.listEntries`, `projects.readFile`, `projects.writeFile`,
   `projects.searchContents`, `terminal.open`, `terminal.attach`,
   `terminal.write`, `terminal.resize`, `terminal.close`, `filesystem.browse`,
   the thread and orchestration methods, and the preview stream (already ported,
   `/api/preview-stream/ws`) and device hub routes.

What this means for Canopy:

- **Canopy app → T3 Code machine** (works today on T3's side):
  - Add "Connect to T3 Connect protocol supported machine" in Canopy and paste a pairing link.
  - Canopy redeems the code, keeps the token in the keychain, and connects over
    whatever URL the link names.
  - The desktop (`src-tauri/src/t3_socket.rs`) mints the ticket, opens the
    `/ws` socket and owns it; the webview only exchanges text messages with it
    over a Tauri channel. That keeps the ticket and URL out of JS, and lets
    plain `ws://` LAN and tailnet machines work without widening the CSP,
    whose `connect-src` allows `ws:` only to loopback.
  - Canopy's file tree, editor and terminals map to the `projects.*` and
    `terminal.*` methods. The streamed browser and devices reuse the ports
    already in Canopy, which speak T3's stream formats.
  - The client's main work is an Effect RPC JSON client for those methods,
    which can use T3's own `@t3tools/contracts` schemas (MIT).
- **T3 Code apps → a Canopy host:**
  - `canopy-host` answers T3's pairing shape: `/.well-known/t3/environment`,
    `/oauth/token` and `/api/auth/websocket-ticket`.
  - Then a T3 pairing link and the Canopy pairing link are the same thing, and
    one host works with either app.
  - The full `/ws` RPC is only needed if T3 apps should drive Canopy work. That
    part is larger, so it comes later.
- **Networks stay interchangeable.** LAN, Tailscale (`tailscale serve`) and a
  Cloudflare tunnel only produce the URL in the pairing link. A Canopy account
  route, like T3 Connect, is an optional extra way to get that URL, never a
  requirement.

## One protocol for every channel

Direction: everything Canopy sends between machines should use T3's protocol, so
Canopy keeps up with T3's changes instead of keeping a second stack. Today, only
the T3 client (`src/t3connect/`) uses it. Canopy's own channels each have their
own transport.

| Channel | Today | On T3's protocol |
|---|---|---|
| Shells | `/sessions/N/stream` WebSocket with base64 output (`RemoteTerminal.tsx`) | `terminal.open`, `terminal.attach`, `terminal.write`, `terminal.resize`, `terminal.close` over `/ws` |
| Files | `/v1/workspaces/{id}/...` HTTP | `projects.listEntries`, `projects.readFile`, `projects.writeFile`, `projects.searchEntries` |
| Agent browser | `/browser/stream`, already T3's wire format | `/api/preview-stream/ws` path and T3's ticket use |
| Devices | expo-device-hub through `devicehub_proxy.rs`, already T3's routes | T3's media tickets (`/api/auth/websocket-ticket/:use`) |
| Agents and engines | runner `/sessions`, harness SSE (`stream.rs`) | T3's orchestration methods (threads, turns, events) |
| Auth | static bearer tokens and managed HMAC tokens | pairing code → `/oauth/token`, scoped sessions, websocket tickets |
| Slack, apps, mesh | relay v2 envelopes | T3's MCP endpoint and peer links |

How to get there:
- `canopy-host` serves T3's `/.well-known/t3/environment`, `/oauth/token`,
  `/api/auth/*` and `/ws`.
- Canopy's remote surfaces move one channel at a time onto `T3RpcClient`. The
  client already handles any Effect RPC group and is carried by the desktop's
  socket (`t3_socket.rs`).
- Order: auth and files first, then terminals, the browser and devices (already
  in T3's formats), agents next, and the relay last.
- T3's method shapes live in one file (`src/t3connect/contracts.ts`), so
  following a T3 release means updating that file.

Methods T3 doesn't have yet, such as Canopy's mesh or notes, go in a separate
`canopy.*` method group on the same socket, so they never collide with T3's
names.

## Other T3 pieces worth taking later

- **Peer links:** agents on one machine work in another through its MCP server
  (`docs/internals/remote.md`, "Peer links").
- **Outside-agent OAuth:** Claude Code or ChatGPT driving a Canopy host through
  MCP with a scoped, revocable grant (`environment-auth.md`).
- **Guest links:** read-only access to one session through an HMAC link, with no
  account needed.
- **Server update handoff:** replacing the host process without dropping the
  tunnel (`docs/internals/server-updates.md`).
- **Load balancing** new work across several connected hosts.

## Suggested order

0. Canopy as a T3 Code client: pairing-link redeem, keychain storage, and the
   `projects.*` and `terminal.*` RPCs. This lets Canopy open any T3 Code machine
   reachable over LAN, Tailscale or Cloudflare, with no login.

1. Make the runner's paths configurable, then add `ProcessWorkspaces` and
   `canopy-host up` with the SSH and local-network routes.
2. Add pairing, `/.well-known/t3/environment`, and session list and revoke, replacing
   `init.mjs` tokens. Managed HMAC tokens keep working.
3. Add Tailscale and Cloudflare routes (wrappers around their CLIs), and the
   client route list.
4. Add account linking and the broker on canopyide.dev (the T3 Connect
   equivalent). This step needs server work outside this repo
   (`packages/control-plane` plus the website).

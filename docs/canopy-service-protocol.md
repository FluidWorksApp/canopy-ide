# Canopy service protocol

Companion to [canopy-service-design.md](canopy-service-design.md). This is the
wire contract between the pieces; the design doc says why. All HTTP is HTTP/1.1
with JSON bodies over Unix sockets unless stated. Every limit below is a hard
cap enforced by the receiver.

## 1. Processes and paths (cloud host)

| Piece | Where | Identity |
| --- | --- | --- |
| `canopy-serviced` (Rust, `crates/canopy-service`) | host systemd unit `canopy-service.service`, user `canopy-service`, group `canopy-host` | owns `/var/lib/canopy-service` (0700) |
| Admin socket | `/run/canopy-service/admin.sock`, mode 0660, group `canopy-host` | filesystem permission is the credential; only the gateway (`canopy-host` user) connects |
| Agent socket, per workspace | host `/run/canopy-service/ws/<workspaceId>/ctx.sock` (dir 0755, socket 0666) | bind-mounted read-only into that workspace's container at `/run/canopy-ctx/` |
| Stores, per workspace | `/var/lib/canopy-service/ws/<workspaceId>/{mesh,notes,research,attention,inbox,keys}` | never mounted into containers |
| Relay credential, per workspace | `/run/canopy-relay/<workspaceId>/relay-credential` (dir 0750, file 0640, `canopy-host:canopy-host`) | written by the gateway; read by the service (primary group `canopy-host`) |

Host install (`packages/remote-host/install-service.sh`, shipped in the host
release archive): binary `/usr/local/lib/canopy-service/canopy-serviced`
(root-owned, sha256 bound to `workspace-release.json` `serviceBinaries`),
unit `canopy-service.service` (`Type=simple`; `ExecStartPost` waits up to 10 s
for `GET /admin/health`, and the unit is ordered `Before=canopy-host.service`;
`RuntimeDirectoryPreserve=yes`). The daemon runs with no arguments and reads
`CANOPY_SERVICE_STATE=/var/lib/canopy-service`,
`CANOPY_SERVICE_RUNTIME=/run/canopy-service`,
`CANOPY_SERVICE_RELAY_DIR=/run/canopy-relay` and, on managed hosts,
`CANOPY_SERVICE_RELAY_URL` (from `/etc/canopy-service/env`). Control-plane
verify keys: `$CANOPY_SERVICE_STATE/access-keys.json`
(`{"<kid>":"<b64 raw Ed25519 public key>"}`, 0600). Managed hosts bind retained
storage over the state directory (`BindPaths=/srv/canopy/service-state:/var/lib/canopy-service`).

The daemon must chmod `admin.sock` to 0660 (group `canopy-host`), unlink and
re-create `ctx.sock` *inside* an existing `ws/<workspaceId>` directory, and never
remove that directory (not on `DELETE`, not on shutdown): running containers
bind the directory, so a new directory is invisible to them.

Agent PTYs get `CANOPY_CTX_SOCKET=/run/canopy-ctx/ctx.sock` and
`CANOPY_CTX_TOKEN=<terminal credential>`. `canopy-hook --mcp` prefers
`CANOPY_CTX_SOCKET` over `CANOPY_CTX_PORT` (same ancestor-walk rule as the port)
and sends the identical HTTP request over the Unix socket.

## 2. Agent API (agent socket)

Same paths, request bodies and response shapes as the desktop bridge
(`src-tauri/src/context.rs`), authenticated by `Authorization: Bearer <terminal
credential>`. The service serves:

`GET /ctx/identity`, `GET /ctx/tools`, `GET|POST /ctx/claims`, `POST /ctx/mesh`,
`POST /ctx/notes`, `POST /ctx/research`, `POST /ctx/action` for kinds
`job_done`, `task_named`, `notify`, `mesh_send`, `message_agent` (ptyId/name
targets only), `close_session`; `POST /ctx/ask` (ask_user/confirm, §5);
`POST /ctx/browser` (forwarded to the runner, §4).

Every other route or action kind answers **503** with body
`{"error":"unavailable","reason":"no-ide"|"laptop-only"|"not-implemented","message":"..."}`
— never a hang. `GET /ctx/tools` returns the same tool list the desktop
advertises (the hook's list is fixed at startup; `listChanged` stays false).

Project resolution: a cloud workspace is one project. `project` arguments that
name any other project answer 400. Its id is `ws:<workspaceId>`, its name the
workspace name supplied at registration, its root `/workspace`.

## 3. Admin API (admin socket, gateway → service)

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /admin/health` | — | `{ready:true,version}` |
| `PUT /admin/workspaces/{ws}` | `{name, ownerUserId, runnerUrl, runnerToken}` | `{agentSocketDir}` (must be `/run/canopy-service/ws/{ws}`); idempotent, later PUTs replace `runnerUrl`/`runnerToken`; creates stores and the agent socket. `runnerUrl` is `null` on the first PUT, made before `docker run` so the bind source exists; until a PUT supplies it, delivery and browser answer 503 `not-ready`. The gateway re-PUTs every 30 s, which also re-registers after a service restart |
| `DELETE /admin/workspaces/{ws}` | — | closes the agent socket; stores are kept |
| `POST /admin/workspaces/{ws}/terminals` | `{requestId, agent?, name?, task?}` | `{token}` — minted before spawn |
| `POST /admin/workspaces/{ws}/terminals/{requestId}/bind` | `{sessionId, pid}` | `{}` — after the runner returns |
| `DELETE /admin/workspaces/{ws}/terminals/{requestId}` | — | revokes the credential (terminal exit) |
| `PUT /admin/workspaces/{ws}/access` | signed access snapshot (§6) | `{revision}`; rejects rollback and bad signatures |
| `GET /admin/workspaces/{ws}/stream?cursor=<epoch>:<seq>` | — | SSE, §5 |
| `POST /admin/workspaces/{ws}/query` | `{store, action, args}` | same JSON the desktop's Tauri command returns for that store/action (reads only) |
| `POST /admin/workspaces/{ws}/actions` | `{kind, ...}` with the acting user in `actor` | user actions: `answer` (ask_user), `attention_ack`, `notes_write`, `research_write` |
| `GET /admin/device` | — | `{deviceId, keys:{agreement,signing}}` public JWKs of this host's relay device |

The gateway is the only admin client. It authenticates IDE users with its
existing workspace access checks and passes `actor` (user id) on actions.
Only owner runtimes get the socket mount and credentials; member and
collaboration runtimes are separate containers without it. A container created
before the service existed keeps running without the mount (reported as
`no-mount`) until it is next recreated; any other `/run/canopy-ctx` mount is
configuration drift. When the service cannot be reached, a spawn proceeds
without harness environment and its response carries
`harness:{available:false, reason, message}`.

The admin client bounds every call (5 s; 15 s for query/actions; 4 MiB
responses) and reports `unavailable`, `timeout`, `rejected` (with the service's
status and body) or `invalid-response`.

### 3.1 Gateway routes for the IDE

All under `/v1/workspaces/{id}`, with the gateway's existing authentication:

| Route | Grant | Proxies to |
| --- | --- | --- |
| `GET /harness/status` | view | the gateway's own availability report |
| `GET /harness/stream?cursor=` | view; bearer, or `?ticket=` from `POST /ticket {stream:"/harness/stream"}` | `GET /admin/workspaces/{id}/stream` (SSE bytes verbatim) |
| `POST /harness/query` `{store, action, args}` | view | `POST .../query` |
| `POST /harness/actions` `{kind, ...}` | drive (`sessions:interact`) | `POST .../actions`, `actor` set by the gateway, never the body |

Streams are re-authorized every second, like terminal streams; revocation
ends the response and the service subscription. A subscriber more than 4 MiB
behind is cut and reconnects without a cursor. Harness streams do not count as
activity for idle shutdown.

### 3.2 Gateway → control plane (host credential)

Purpose-bound tokens in the runtime-policy shape: `Authorization: Bearer
<b64url(claims)>.<b64url(HMAC-SHA256(managedSession.key, payload))>`, claims
`{version:1, kind, workspaceId, generation, expires}` with `expires ≤ now+120 s`.

| Kind | Call |
| --- | --- |
| `workspace-access-snapshot` | `GET /api/workspace-access-snapshot?workspace=<id>`; the body (≤ 64 KiB, `{payload, signature}`) is forwarded verbatim to `PUT .../access` every 60 s |
| `peer-host-registration` | `POST /api/peers {action:"register-host", deviceId, keys:{agreement,signing}, workspaceIds:[id]}`, device from `GET /admin/device`, once per gateway start until accepted |
| `peer-relay` | not sent by the gateway: written every 60 s (raw token, no newline) to the relay credential file for the daemon's relay client |

Endpoints default to the origin of `managedSession.runtimePolicyUrl`;
`managedSession.accessSnapshotUrl` / `peersUrl` override them.

## 4. Service → runner (terminal delivery, browser)

The service reaches the container runner with the `runnerUrl` and
`runnerToken` from registration (the gateway's own channel).

- Delivery: `POST {runnerUrl}/sessions/{id}/input` with
  `{data, expectPid}`. The runner refuses with 409
  `{error:"Terminal generation changed", pid}` when the live child's pid
  differs or `expectPid` is not an integer (`TerminalTarget.generation` = pid,
  `instance` = `remote-<ws>`). Without `expectPid` the route is unchanged.
  Body then `\r` 250 ms later, serialized per target.
- Spawn: unchanged route; the gateway adds `harness:{token}` to spawn args and
  the runner exports `CANOPY_CTX_SOCKET`/`CANOPY_CTX_TOKEN` when present.
- Browser: `POST {runnerUrl}/browser` `{op, args}` → JSON result, ops mirroring
  the desktop's `/ctx/browser` contract, executed against the container's
  Chromium over CDP. 30 s deadline.
  Ops: `navigate` → `{url,title}`; `resize` → `{url,width,height,reset}`;
  `screenshot` → `{image,mimeType,url,width,height}`;
  `snapshot|click|type|point|eval|console|network` → the desktop picker's
  `data` (the same `preview_picker.js` runs in the page). Validation errors
  400, `screenshot` with `scope:"ide"` 503, deadline 504, an image without the
  browser 503 `not-implemented`; errors are `{error}`. One headless page per
  workspace runtime, profile `/home/agent/.canopy/browser-profiles/agent-tools`,
  ops serialized; `url`/`project` selectors are ignored (there is one page).

## 5. Stream and attention

SSE events, JSON `data`:

- `snapshot` `{cursor, stores:{mesh, notes, research, attention}}` — sent first,
  and whenever the cursor is unknown, from another epoch, or older than the
  replay window.
- `change` `{cursor, store, scope, id}` — ordered; `cursor` = `<epoch>:<seq>`;
  epoch changes on every service start. Replay window: last 4096 events.
- `resnapshot` `{}` — the subscriber is too slow; reconnect without a cursor.

Attention items persist under `attention/`: `{id, kind:"fyi"|"question",
title, body, choices?, deadlineMs?, createdMs, resolution?:{answer, actor, atMs}
| {expired:true}}`. `POST /ctx/ask` creates a question and blocks up to its
deadline (default 10 min, max 1 h) then returns `{answer}` or
`{expired:true,message:"no user present"}`. Timeout is never confirmation.

## 6. Relay v2 and authority (phase 3)

Envelope `version: 2` adds `to.workspace` (uuid, required for mesh/job
traffic) and `kind` (`chat|mesh|job|job-status`), both inside the signed
header. `expires - created` must be `300000` for `version: 1` and in
`(0, 604800000]` for `version: 2` workspace traffic. Unknown versions are
rejected. Relay caps: 200 queued per sender (existing), 1000 envelopes and
32 MiB per recipient device.

Host devices register with `kind:"host"` and `workspaceIds`, authenticated by
the host's existing control-plane credential, never by a user session. The
directory returns `{kind, workspaceIds}` per device.

Access snapshot (signed by the control plane, Ed25519, key id in `kid`):

```json
{ "v":1, "kid":"...", "workspaceId":"...", "serviceDevice":"...",
  "revision":42, "issuedAt":0, "expiresAt":0, "teamDelivery":false,
  "ownerUserId":"...",
  "principals":[{"userId":"...","sessionsInteract":true,"projects":"all"}] }
```

Delivery rule in the service: same account as owner → deliver; principal with
`sessionsInteract` and `teamDelivery:true` → deliver; otherwise refuse with a
sender-visible reason. Expired snapshot ⇒ only the owner is delivered.
`teamDelivery` defaults to false; the owner enables it per workspace.

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

### 6.1 Envelope v2 wire format

Workspace ids are control-plane ids (`ws-<uuid>`); `to.workspace` names the
workspace the traffic concerns in both directions (a host's `job-status` reply
carries the job's workspace).

```text
{version:2, id, kind, from:{team,user,device}, to:{team,user,device,workspace?},
 created, expires, ephemeral, iv, ciphertext, signature}
header  = JSON.stringify([2, id, [from.team,from.user,from.device],
                          [to.team,to.user,to.device,to.workspace ?? null],
                          kind, created, expires, ephemeral.x, ephemeral.y, iv])
signed  = JSON.stringify([header, ciphertext])      // ECDSA P-256 SHA-256, IEEE-P1363, base64
key     = HKDF-SHA256(ECDH(ephemeral, recipient.agreement), salt "canopy-im-v1", info header)
cipher  = AES-256-GCM(key, iv(12 bytes), aad header)
```

`kind` is one of `chat|mesh|job|job-status`; `to.workspace` is required for
`mesh`, `job` and `job-status` and must match `^[A-Za-z0-9_-]{1,128}$`. With
`to.workspace`, `expires - created` is in `(0, 604800000]`; without it the
envelope keeps the 300000 ms rule. Version 1 is unchanged. Plaintexts:

| Envelope kind | Payload |
| --- | --- |
| `chat` | `{kind:"message"\|"receipt"\|"signal", ...}` (person chat stays on v1) |
| `mesh` | `{kind:"mesh", message:{id, text, target:{ptyId}\|{name}, replyTo?, created}}`; a refusal comes back as `{kind:"mesh-status", status:{messageId, state:"refused", detail, created}}` |
| `job` | `{kind:"job", job:{id, title, brief, workspace, created, target?:{ptyId}\|{name}}}` |
| `job-status` | `{kind:"job-status", status:{jobId, state, detail, created}}`; a refused job is `state:"declined"` |

A shared test vector with throwaway keys lives at
`src/teamMessaging/fixtures/relay-v2-vector.json` (test-only; never real keys).

### 6.2 Host credential and peer actions

Hosts authenticate with the managed workspace key they already hold
(`managedSession.key`, the control plane's `workspaceSecret(workspaceId)`), using
the same token shape as `/api/runtime-policy`:
`base64url(JSON claims) "." base64url(HMAC-SHA256(key, base64url-claims))`,
claims `{version:1, kind, workspaceId, generation, expires}` (`expires` in Unix
seconds, at most 120 s ahead). `kind` names the purpose and a token is accepted
only for it: `workspace-access-snapshot` (snapshot), `peer-host-registration`
(`register-host`), `peer-relay` (`poll`, `ack`, `directory`, `relay`). The
workspace's current `generation` must match, which fences a replaced host.
Endpoints default to `managedSession.runtimePolicyUrl`'s origin; the control
plane also issues `managedSession.accessSnapshotUrl` and `peersUrl`.

`POST /api/peers` with `Authorization: Bearer <host token>` accepts:

| Action | Body | Result |
| --- | --- | --- |
| `register-host` | `{deviceId, keys:{agreement,signing}, workspaceIds:[workspaceId]}`; `workspaceIds` must equal the token's workspace. Optional `{created, proof}` (proof signs `JSON.stringify(["canopy-host-device-v1", workspaceId, deviceId, created, ax, ay, sx, sy])`) is verified when present | `{registered:true}`; the device is owned by the workspace owner, `kind:"host"`, and becomes the only host device serving that workspace (a previous host loses it and is revoked once it serves none) |
| `poll` | `{deviceId}` | `{envelopes:[{id, envelope, sender:{id,userId,kind,workspaceIds,publicKeys}}]}` (≤100) — only v2 envelopes whose `to.workspace` is the token's workspace, across all teams |
| `ack` | `{deviceId, ids}` | `{acknowledged:true}` — only that workspace's envelopes |
| `directory` | `{deviceId, teamId}` | `{members, devices}`; devices carry `kind` and `workspaceIds` |
| `relay` | `{deviceId, teamId, recipientDevice, envelope}` (v2, `to.workspace` = token workspace) | `{queued:true}` |

Host devices are not team members: their team operations are authorized
through the workspace owner's active membership of `teamId`, and the token's
workspace must be in the device's `workspaceIds`. A host relays only to a user
who currently has access to the workspace.

User-session `directory` returns `devices` (user devices, `kind:"user"`) and
`hosts`: host devices owned by team members, with `workspaceIds` narrowed to
workspaces the caller can access (hosts with none are omitted). A user may relay
to a host device only for a workspace that host serves and the user can access;
user poll rows carry the same `sender` object. Per-recipient caps are 1000
envelopes and 32 MiB, checked under the recipient device's row lock (`429`).

### 6.3 Access snapshot wire form

`GET /api/workspace-access-snapshot?workspace=<id>` with the host token returns,
as the whole body (≤ 64 KiB), `{"payload":"<base64 of the exact UTF-8 JSON
snapshot bytes>","signature":"<base64 Ed25519 over those bytes>"}`. Verify the
signature before parsing. The daemon's verify keys are `{"<kid>":"<base64 raw
32-byte Ed25519 public key>"}`; `GET /api/workspace-access-snapshot?keys=1`
(no auth) returns exactly that map, and
`node scripts/access-signing-public-key.mjs` prints it from
`CANOPY_ACCESS_SIGNING_KEY`/`CANOPY_ACCESS_SIGNING_KID` (website repo).
`expiresAt - issuedAt` is 15 minutes; refresh every 5 minutes. `projects` is
`"all"` or the sorted project ids where a single grant allows
`sessions:interact`. `revision` is `workspace.access_revision`, bumped by
database triggers on every grant, team/organization membership, ownership,
organization move, deletion or `team_delivery` change.

## 7. Service implementation notes (`crates/canopy-service`)

What `canopy-serviced` does where the sections above leave a choice open.

- **Credentials.** `POST .../terminals` returns `{token, ptyId}`. `ptyId` is a
  service-assigned number, stable per `requestId`. Re-minting an unbound
  `requestId` replaces its token, and bind is idempotent for the same
  `{sessionId, pid}`. Only SHA-256 hashes of tokens are stored
  (`ws/<ws>/terminals.json`, 0600). At startup and whenever `runnerUrl`
  changes, the service keeps a credential only if the runner's `GET /sessions`
  still lists that `id` with the same `pid` and a null `exitCode`. Unbound
  credentials older than 10 minutes are dropped. Revocation releases the
  terminal's claims.
- **Agent API.** `/ctx/identity` adds `workspace` and `project`. In
  `/ctx/tools`, `supportedTools` is the desktop list verbatim (a test pins it
  to `context.rs`). `disabled` holds the laptop-only device and vault tools,
  and `supportedActions` lists the kinds in §2. `POST /ctx/ui` with
  `op:"ask"|"confirm"` is served the same as `/ctx/ask`, so an unchanged hook
  works. Every other `/ctx/ui` op answers 503. The ask body is
  `{op?, question | action+detail, options?, timeoutMs?, requestId?}`. A
  retry with the same `requestId` rejoins the caller's own question. Answers
  are `{answer, id}`, plus `accepted` for confirm, which is true only for
  `true`, `"accept"`, `"accepted"`, `"yes"` or `"allow"`. `close_session` acts
  on the credential's own terminal. It sets `closeRequestedMs` and publishes
  `mesh`/`terminals`/`close`; the gateway stops the session. `job_done` records
  the outcome on the terminal, raises an fyi and settles any relay job
  delivered to that terminal. Mesh item paths are container paths, so only
  their shape is checked. Notes `attach` answers a clear 400 until container
  file reads are routed through the runner.
- **Delivery ledger.** `ws/<ws>/inbox/service.sqlite` moves each delivery
  through `queued → writing → written → submitted | failed | uncertain`. After
  a restart, `queued` deliveries run (nothing was typed yet). `writing` and
  `written` become `uncertain` with an fyi and are never typed again.
- **Stream and query.** A `change.store` is always one of
  `mesh|notes|research|attention`. Claims, terminals, deliveries, jobs, inbox
  and access are `scope`s under `mesh`. The snapshot's `mesh` store is the
  message list. `query` answers `{items:[...]}` for `list` on `mesh`
  (messages), `notes`, `research` and `attention`, using the same rows as the
  snapshot. It also answers for `claims`, `terminals` (never token hashes),
  `deliveries`, `jobs`, `inbox` and `outbox`, plus `mesh` `severed`/`claims`/
  `claim_history` and `access` `get`. Actions need `actor`. A second `answer`
  gets 409 with the winning `resolution`.
- **Access.** A bad signature, an unknown `kid`, or a different
  `workspaceId`/`serviceDevice` gets 400. A lower revision, or the same
  revision with a different payload, gets 409. Resending the same revision and
  payload is idempotent. The snapshot is persisted in `ws/<ws>/access.json`.
  With no snapshot, only the owner is delivered.
- **Relay.** The service polls each registered workspace with that
  workspace's own credential. It trusts the poll row's `sender` keys only when
  they match `from.user` and `from.device`, then verifies and decrypts. The
  dedupe key is crypto.ts's replay id
  (`[[from],[to],id]`). The inbox row, the job row and any status or refusal
  outbox row are committed in one transaction before the ack. Malformed,
  misaddressed and unverifiable envelopes are acked without a reply. A job
  must name a `target`, or it is declined. Job states go out as
  `accepted` (admission), `started` (Return submitted), `done`/`blocked`
  (`job_done`) and `failed`. A locally `uncertain` delivery goes out as
  `failed` with an explanation. A mesh message that was admitted but could not
  be delivered is answered with `mesh-status` `state:"failed"`. Outgoing
  envelopes are v2 from `{user: ownerUserId, device: host}` with
  `to.workspace` set to this workspace. Outbox rows retry until 7 days.
  `GET /admin/device?workspace=<id>&created=<ms>` adds the `register-host`
  `proof`.

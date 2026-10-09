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
| `PUT /admin/workspaces/{ws}` | `{name, ownerUserId, runnerUrl, runnerToken}` | `{agentSocketDir}`; idempotent; creates stores and the agent socket |
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

## 4. Service → runner (terminal delivery, browser)

The service reaches the container runner with the `runnerUrl` and
`runnerToken` from registration (the gateway's own channel).

- Delivery: `POST {runnerUrl}/sessions/{id}/input` with
  `{data, expectPid}`. The runner refuses with 409 when the live child's pid
  differs (`TerminalTarget.generation` = pid, `instance` = `remote-<ws>`).
  Body then `\r` 250 ms later, serialized per target.
- Spawn: unchanged route; the gateway adds `harness:{token}` to spawn args and
  the runner exports `CANOPY_CTX_SOCKET`/`CANOPY_CTX_TOKEN` when present.
- Browser: `POST {runnerUrl}/browser` `{op, args}` → JSON result, ops mirroring
  the desktop's `/ctx/browser` contract, executed against the container's
  Chromium over CDP. 30 s deadline.

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

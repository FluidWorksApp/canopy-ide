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

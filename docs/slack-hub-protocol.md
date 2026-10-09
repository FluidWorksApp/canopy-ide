# Slack hub protocol

Canopy is the single Slack app and the single place Slack talks to. Slack's
events, button clicks and installs land on canopyide.dev; the control plane
decides whose companion a message is for and queues it; the signed-in Canopy
desktop collects it, runs the companion turn and hands the reply back for the
control plane to post. Nobody handles a Slack token outside the control plane.

## 1. The Slack app (registered once by FluidWorks)

| Setting | Value |
| --- | --- |
| Event Subscriptions request URL | `https://canopyide.dev/api/slack-events` |
| Bot events | `app_mention`, `message.im` |
| Interactivity request URL | `https://canopyide.dev/api/slack-interact` |
| OAuth redirect URL | `https://canopyide.dev/api/slack-oauth` |
| Bot scopes | `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `users:read` |
| Sign in with Slack (OpenID) scopes | `openid`, `profile` |
| Public distribution | on |

Deploy env: `CANOPY_SLACK_CLIENT_ID`, `CANOPY_SLACK_CLIENT_SECRET`,
`CANOPY_SLACK_SIGNING_SECRET`, `CANOPY_SLACK_TOKEN_KEY` (32 random bytes,
base64; AES-256-GCM key for stored bot tokens). Without them every Slack route
answers 503 `{"error":"Slack is not configured"}` and the desktop shows
"Slack is not available yet".

## 2. Identity

A Slack user counts as a Canopy user only through a **verified link**: the
`(slack_team_id, slack_user_id)` Slack itself returned to an OAuth flow that
the signed-in Canopy user started. Never an email match, never a typed id.

- **Install** (adds the bot to a Slack workspace and links the installer):
  `oauth.v2.access` → store the bot token (encrypted) for `team.id`, link
  `authed_user.id` to the Canopy user who started it.
- **Link** (a teammate in an already-installed workspace): Sign in with Slack
  (`openid.connect.token`) → link the id token's
  `https://slack.com/user_id` + `https://slack.com/team_id`.

Both start from the desktop: `POST /api/slack {action:"install-url"|"link-url"}`
with the device bearer returns Slack's own authorize URL (`oauth/v2/authorize`
for install, `openid/connect/authorize` with the state nonce as the OpenID
`nonce` for link) carrying an HMAC-signed `state` = `{kind, userId, nonce,
expires(≤10 min)}`. The state key is HMAC-SHA256(`CANOPY_SLACK_TOKEN_KEY`,
`"canopy-slack-oauth-state:v1"`), a secret Slack never holds. Both redirect to
`/api/slack-oauth`, which verifies the state, consumes the nonce (single-use,
even when the person cancels), exchanges the code and shows a page ending "You
can close this tab and return to Canopy." Link requires the team to be
installed already. One Slack identity links to one Canopy user; a
Canopy user may link one identity per Slack team. `unlink` removes the
caller's links.

## 3. Routing an event

`/api/slack-events` verifies `X-Slack-Signature` (v0, HMAC-SHA256 over
`v0:{timestamp}:{raw body}`, timestamp within 5 minutes, constant-time
compare), answers `url_verification`, dedupes on `event_id`, and answers 200
within Slack's 3 s. It keeps only `message` in an IM with no `subtype`/`bot_id`
and `app_mention`; the bot's own messages are dropped.

1. **Sender** = the linked Canopy user for `(team_id, event.user)`. Unlinked →
   one reply per Slack user per 6 h: "Link your Slack in Canopy (Settings →
   Companion → Slack) to talk to your companion here." Nothing is queued.
2. **Target**: in an `app_mention`, the first other `<@U…>` mention that is a
   linked Canopy user in that team is the target; otherwise the sender. A DM
   always targets the sender.
3. **Authority** for target ≠ sender: the sender must hold a grant on a
   workspace the target owns that allows `connect` and `sessions:interact`
   (complete per-grant evaluation, `workspace-service-access.mjs`), and that
   workspace must have `team_delivery = true`. Otherwise the sender gets
   "<target> hasn't allowed teammates to message their companion." Nothing is
   queued.
4. Queue a `slack_inbox` row for the target: `{id, kind:"message",
   senderLabel, senderRole:"me"|"teammate", channelType:"im"|"channel",
   text (mentions of the bot removed, ≤ 8000 chars), created}` plus the
   server-only routing (`team, channel, thread_ts` — a channel mention
   answers in its thread, a DM inline). Rows expire after 24 h; at most 200
   undelivered per target (oldest dropped with a reply to their sender).

## 4. Desktop API: `POST /api/slack` (device bearer)

| `action` | Body | Result |
| --- | --- | --- |
| `status` | — | `{configured, installs:[{team, teamName}], linked:[{team, teamName, slackUser}]}` |
| `install-url` / `link-url` | — | `{url}` |
| `unlink` | `{team?}` | `{unlinked:n}` |
| `poll` | — | `{items:[...]}` ≤ 20, oldest first; each leased for 120 s to this device |
| `ack` | `{ids}` | `{acknowledged:n}` — only the caller's rows |
| `reply` | `{id, text}` | `{posted:true}` — posts in the item's thread (≤ 39 000 chars); acks the item; a second reply is 409 |
| `approval` | `{id, proposalId, summary, project?, detail?}` | `{posted:true}` — Approve/Deny buttons in the item's thread |
| `approval-cancel` | `{proposalId, accepted}` | `{}` — answered in Canopy; the Slack message says so |

`ack` only stops redelivery: `reply` and `approval` keep working on an acked
item until it expires (24 h). `approval` fields: `summary` 1–300 chars (it is
not called `action`, which already names the request), `project` ≤ 128 and
`detail` ≤ 2000, both optional or null.

`poll` items are `kind:"message"` (§3) or `kind:"answer"` `{proposalId,
accepted, by}` for an approval clicked in Slack. Item ids and proposal ids
match `^[A-Za-z0-9_-]{8,64}$`. Every action is scoped to the caller's own rows.

## 5. Approvals

`/api/slack-interact` verifies the signature like events. For a
`block_actions` press on an approval it looks up the pending approval by the
button value: the presser must be the **target's own linked identity** (the
owner of the companion). Anyone else gets an ephemeral "Only <owner> can
approve." via `response_url`. A valid press records the answer once (first
wins), queues a `kind:"answer"` item for the target, and updates the message
("Approved by …" / "Denied by …"). Pending approvals expire after 15 minutes
as denied: a later press marks the message "Expired; treated as denied" and
queues `{proposalId, accepted:false, by:"expiry"}`.

## 6. Desktop rules (unchanged from the Socket Mode version)

One companion turn at a time, after the user's own; a `[Slack: …]` envelope
naming the sender and whether they are the owner; no IDE spotlight; Slack
approval races the panel's chip and the first answer wins; a turn that ends
with a question open cancels it as denied.

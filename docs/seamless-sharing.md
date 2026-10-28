# Seamless team connection and sharing

Goal (founder, 2026-10): when someone is signed in to Canopy, connecting to
teammates, team sessions and sharing should just work, with nothing to
generate. Canopy hosts the URLs, and they are readable enough to paste or
remember.

This document maps what existed before this change, what is now automatic,
the URL formats, the endpoints and schema added, and what still needs
deploying outside this repository.

## 1. Where a link, code, PIN or invite was needed (before)

| Surface | Code | What the user had to do | Account-backed? |
|---|---|---|---|
| Team chat, presence, DMs (account) | `src/teamMessaging/background.ts`, `session.ts`, `client.ts`; `packages/control-plane/lib/peer-messaging.mjs` (`/api/peers`); `teams.mjs` (`/api/teams`) | **Nothing.** `startBackgroundTeams()` (App.tsx) already joins every team the account belongs to on sign-in. | Yes |
| Self-hosted team relay | `src-tauri/src/relay.rs` (`relay_host_start`, `relay_regenerate_code`, `relay_connect`), `src/components/TeamPanel.tsx` `RelayTeamPanel` | Host shares an address/tunnel URL and a 7-digit SPAKE2 join code; others type both. | No |
| Canopy Remote (drive your own agents from a phone/browser) | `src-tauri/src/portal.rs` (`/remote/auth`, 6-digit PIN), `tunnel.rs`, `canopy_link.rs`, `packages/remote-edge/` | Signed in: turn it on; the link is `https://<handle>.remote.canopyide.dev`, opened by signing in to Canopy (no PIN, no tunnel). Signed out: tunnel URL or QR plus the PIN. | Yes when signed in |
| Account workspaces (managed VMs) | `src/remoteExecution/ManagedWorkspaces.tsx`, `/api/workspaces`, `/api/operations` (`connect`) | Nothing for owners or people granted access: they appear in the switcher, and a member's open waits for the owner's host to prove member isolation, then connects. | Yes |
| Saved remote connections (self-hosted hosts) | `execution_remote_*`, Settings → Remote access | Paste an endpoint and token. | No |
| Shared agent sessions | `src/components/LiveSessions.tsx` (was `SharedSessionsPanel.tsx`), gateway `/shared-sessions` (`packages/remote-host/gateway.mjs`), `/api/operations` `shared-session-connect` | Open the workspace's details, open "Shared sessions", **click "View shared sessions"**, pick the session. No way to point a teammate at one session. | Yes, but manual |
| Workspace sharing "like a document" | `WorkspaceSharing.tsx`, `workspace-team-grants.mjs`, `workspace-person-grants.mjs`, `workspace-organization-grants.mjs` | Grant a team or person a role. No URL to send them. | Yes |
| Organization / team / workspace invitations | `organizations.mjs`, `teams.mjs`, `invitation-url.mjs`, `invitation-email.mjs`, `workspace_invitation` | Admin invites an email; invitee follows the emailed link and accepts. | Yes (one-off, by design) |
| Chat messages, plans, handoffs, reports | `src/teamMessaging/*`, chat cards (`cardSchema.ts`), `ShareDialog.tsx` | Could be shared *into* chat, but there was no link *to* a message. | E2E, device-local |
| Hosted domains | `https://canopyide.dev` (website + `/api/*`, `client_mode.rs`), `https://<ws-id>.workspaces.canopyide.dev` (one gateway per workspace host, `gateway.mjs`, `NativeWorkspaceHost.ts`) | Workspace hosts are named by opaque id (`ws-<uuid>`). | — |

Other findings:

- **Who serves the control plane.** `packages/control-plane/lib` is library
  code. It is mounted as HTTP endpoints by the canopyide.dev website, a
  separate repository/deployment (`schema.sql`: "canopy-website compute_plan";
  `docs/product/organizations-teams-workspaces.md`: "`/api/teams` POST
  handler", "website `tests/organizations.integration.mjs`"; `auth.mjs` reads
  `VERCEL_URL`). No workflow in this repo deploys it, and control-plane tests
  are not in CI here; postgres tests skip unless `CANOPY_SYNTHETIC_DATABASE_URL`
  points at the validation database. The website keeps its own copies under
  `lib/canopy/`, and those are what is deployed. The readable-link modules are
  kept identical in both repositories. The member-sharing modules are not:
  the website's `workspace-sharing.mjs` (attested readiness per start) and its
  `member-connection.mjs`, `member-resume.mjs` and `workspace-discovery.mjs`
  replaced the `sharing_generation` gate that the copies here still use.
- **Sign-in state in the desktop.** The account device token lives in the OS
  credential store (`client_mode.rs` `account_token`, item
  `app.causeconnect.canopy.account`). Every account call goes through
  `canopy_account_request` with a fixed route allowlist to
  `https://canopyide.dev`. Settings → Accounts / the Teams panel's account
  button (`AccountSettings.tsx`) shows the email and signs in or out; both emit
  `canopy:account-changed`, which every account-bound cache clears on.
  `secure_store.rs` keeps it, and saved workspace connections, in the macOS
  Keychain, Windows Credential Manager or the Linux Secret Service (GNOME
  Keyring, KWallet, KeePassXC). Only on a Linux desktop with no Secret Service
  does it fall back to a ChaCha20-Poly1305 file under
  `~/.local/share/app.causeconnect.canopy/credentials` (0600 in a 0700
  directory, key bound to the machine id and user), and it logs that choice
  with the path. Sign-in, sign-out and workspace credential renewal behave the
  same on all three. Linux *workspace* mode is unaffected: there, `canopy_account_request`
  and `clipboard_write_text` are `LOCAL_UI` commands
  (`NativeWorkspaceHost.ts`) that run on the desktop showing the IDE.
- **End-to-end encryption already rides on the account.** Each device
  registers a P-256 agreement and signing key, proven by signature
  (`peer-messaging.mjs` `registrationProof`). The team directory
  (`active_team_member`, which requires live organization membership) hands
  out members' public device keys, and messages are sealed per recipient
  device. The relay stores only signed ciphertext with ids. So no typed join
  code is needed to key a team conversation: membership *is* the key
  distribution, and removing someone from the team stops it.
- **Deep links.** `canopy://…` is parsed in `src/deepLinks.ts` and routed in
  `App.tsx` `followDeepLink`. The scheme reaches the app from notifications, in-app
  cards and the CLI (`canopy 'canopy://…'`, `src-tauri/src/cli.rs`), and from
  the browser: `tauri-plugin-deep-link` registers it with the OS
  (`plugins.deep-link.desktop.schemes` in `tauri.conf.json`), so the website's
  **Open in Canopy** launches the app, or raises the running one.

## 2. What is now automatic when signed in

- **Team messaging and presence**: unchanged and already automatic (above).
  What changed is that the join-code relay no longer appears in the signed-in
  flow. The Teams panel shows "No account? Connect with a join code" only when
  signed out, when teams can't be loaded at all (an office LAN with no route to
  Canopy, the relay's original use), or while a relay session is already running
  (`TeamPanel.tsx`, `TeamHub` `onAccount`). Join codes and the Remote PIN
  remain for people without accounts.
- **Shared sessions**: opening "Shared sessions" connects for viewing by itself
  (viewing never starts the workspace). The button remains only as a retry.
- **Links, with no generation step**: "Copy link" is a single click on:
  - a workspace: its Overview ("Link for teammates") and the header switcher
    ("Copy workspace link" for the active account workspace);
  - a shared agent session: each row in Team → Live now, and the Share sheet
    copies it as it shares;
  - a team chat message, including posted plans, handoffs and reports (cards):
    right-click → Copy link.

  The first copy asks the control plane for the thing's link, and every later
  copy returns the same URL. Results are cached in memory per account.
- **Opening a link**: paste it into SpotSearch (⌘K → "Open workspace / shared
  session / team message"), click it in chat, or run
  `canopy https://canopyide.dev/acme/api`. The app resolves it for the
  signed-in account, then:
  - a workspace opens through the normal resume-and-connect (or shows its details);
  - a shared session opens Team → Live now with that session showing;
  - a message opens its conversation and scrolls to it, if this device still
    has it in its encrypted history (latest 500 messages); otherwise the
    conversation opens.

  In a browser, the link page shows a signed-in person with access what the
  link is: the workspace, session or conversation, its team, and when it was
  last opened or shared (never contents), with **Open in Canopy** and a
  download link. A workspace or session itself opens in the desktop app.
- **Managing links**: Settings → Account → Links lists the links you made,
  plus those on workspaces you own and in teams you own or administer, with
  Copy, Open and Revoke (revoke shows only where you may).
- **Teammates' workspaces**: a member opening a workspace link resumes it if
  their grant can edit, then waits while the owner's host proves member
  isolation for this start (`connectionPending` from workspace discovery) and
  connects by itself. Sharing turned off or a failed check shows the reason.

## 3. URL formats

```
https://canopyide.dev/<team>/<workspace>                    workspace
https://canopyide.dev/<team>/<workspace>/s/<session-slug>   shared agent session
https://canopyide.dev/<team>/t/general/<word-slug>          team channel message / plan / handoff
https://canopyide.dev/<team>/t/dm/<word-slug>               direct message (both participants only)
```

Examples: `canopyide.dev/platform/api-server`,
`canopyide.dev/platform/api-server/s/fix-login-bug-27`,
`canopyide.dev/platform/t/general/quiet-otter-41`.

- `<team>` is a namespace handle: the team name slugified (`Platform Eng` →
  `platform-eng`), suffixed on collision (`platform-eng-2`). Names the website
  uses itself (`api`, `teams`, `support`, `downloads`, `sign-in`, `s`, `t`, …;
  `RESERVED_HANDLES`) get `-team`. A personal workspace lives under the
  person's handle (`alice-example/notes`). A workspace shared with a team uses
  the first team through which the person copying it sees it. One thing has
  one live link: whoever copies it next gets the same URL.
- `<workspace>` is the workspace name slugified, suffixed on collision.
- `<session-slug>` is the session's title slugified plus a two-digit suffix
  (`fix-login-bug-27`), or a word slug when the title has nothing readable in it.
- `<word-slug>` is `adjective-noun-NN` (`quiet-otter-41`) from a curated list
  of 1,163 words (`readable-words.mjs`). The words are lowercase, three to
  eight letters, common and non-offensive, with one obvious spelling. The list
  excludes homophones and heteronyms (`EXCLUDED_WORDS`, enforced by test).
  That gives about 26 million combinations per channel. Slugs are deterministic
  in (target, attempt), and collisions retry with the next attempt.
- Links are permanent until revoked. A revoked path is never reissued.

**Why paths and not `<team>.canopyide.dev`.** Workspace hosts today are
`<ws-id>.workspaces.canopyide.dev`: one gateway per workspace VM, with no
database and no knowledge of teams (`gateway.mjs` hard-codes that pattern).
Only the canopyide.dev website has the account session (`principal.mjs`) and
the database to resolve and authorize a link, so the resolver belongs there.
Team subdomains would need a wildcard record and certificate at the zone apex
(`*.canopyide.dev`). `docs/persistent-remote-links.md` §3 explains why that is
a bad idea: an apex wildcard swallows every future subdomain the moment one is
missing, and it adds a wildcard cert and DNS-01 for no routing benefit. The
path form needs no DNS or certificate change. The parsers on both sides already
accept `https://<team>.canopyide.dev/<path>` as an alias, so adding team
subdomains later only adds a redirect.

Readable URLs *resolve to* the canonical workspace identity; they never replace
it. Connections still use `https://<ws-id>.workspaces.canopyide.dev` and the
identity checks in `NativeWorkspaceHost.ts`, `accountWorkspace.ts` and
`workspaceTabs.ts` are unchanged, so Linux workspace mode and
`packages/remote-host` are untouched.

## 4. Security model

- A link is a **name, not a credential**. Every resolve re-reads current access:
  - workspace links: `workspaceAccess` + `allowsWorkspaceAccess(view)`;
  - session links: additionally `sessionAccess(grants).view` must cover the
    session's project (`maySeeSession`). Personal develop rights do not turn into
    the right to watch a session. The workspace owner always may;
  - message links: `active_team_member`, and for DMs only the two participants.
- People without access get **404, the same as for a link that doesn't exist**.
  A revoked link returns 410 only to people who could otherwise open it.
- Creating a link requires the same access as opening it. Revoking requires
  being able to open it, plus being its creator, the workspace owner, or an
  owner/admin of the team whose namespace holds it.
- **Message links store ids only** (`teamId`, `messageId`, DM participants).
  Bodies never enter the account database (`teams.mjs` refuses them). The
  message is found in the opener's local encrypted history.
- `POST /api/links` mutations require `mayMutate()` (device token or same-origin
  browser), the same cross-site rule as other account mutations.

## 5. Endpoints and schema added (in this repo)

- `packages/control-plane/readable-link-schema.sql` (additive):
  - `link_namespace(handle PK, team_id UNIQUE, user_id UNIQUE)`, with exactly one owner;
  - `readable_link(id, namespace, path, kind, target jsonb, target_key, workspace_id, team_id, created_by, created_at, revoked_at, revoked_by)`
    with `UNIQUE(namespace, path)` across revoked rows, and a partial
    `UNIQUE(namespace, target_key) WHERE revoked_at IS NULL` so a copy is idempotent.
- `packages/control-plane/lib/readable-links.mjs`:
  - `readableLinkAction(db, user, input)`, with actions:
    - `{action:'ensure', kind:'workspace', workspaceId, teamId?}`
    - `{action:'ensure', kind:'session', workspaceId, projectId, publicationId, title}`
    - `{action:'ensure', kind:'message', teamId, peer|null, messageId}`
      → `{link:{url, kind, created}}`
    - `{action:'resolve', url}` → `{link:{url, kind, target, about}}`, where
      `about` is `{teamName, activity:'opened'|'shared', activityAt}`
    - `{action:'list'}` → `{links:[{url, kind, target, about, createdAt, mine, canRevoke}]}`
    - `{action:'revoke', url}` → `{revoked:true}`

    The caller wraps each action in a transaction. Namespace rows are locked
    `FOR UPDATE` to serialize allocation.
  - pure helpers: `parseReadableUrl`, `readableUrl`, `slugify`, `wordSlug`,
    `sessionSlug`, `workspaceSlug`, `handleCandidate`, `pathKind`,
    `maySeeSession`, `RESERVED_HANDLES`.
- `packages/control-plane/lib/readable-link-route.mjs`, the framework-free website side:
  - `linksApi(db, user, body, {mayMutate})` for `POST /api/links` (`resolve`
    and `list` read; `ensure` and `revoke` need `mayMutate`);
  - `readableRequestDecision(db, user, url)` for `GET /<team>/<path…>`. It returns
    `302 → /sign-in?next=…` when signed out, `200` with
    `openInApp: canopy://link?url=…`, or `404`/`410`;
  - `readableLinkPage(decision)`, a minimal escaped HTML page (no script) built
    from `linkSummary(link)`.
- `packages/control-plane/lib/readable-words.mjs`, the wordlist.
- Desktop:
  - `src-tauri/src/client_mode.rs`: `/api/links` added to the account route allowlist.
  - `src-tauri/src/secure_store.rs`: the per-platform credential store.
  - `src-tauri/src/cli.rs` `install_deep_links`: OS scheme registration and
    routing (macOS Apple events wait for the frontend on a cold start; Windows
    and Linux arrive in argv, through the single-instance plugin when running).
  - `src/components/ReadableLinksSettings.tsx` (Settings → Account → Links).
  - `src-tauri/src/cli.rs`: `canopy https://canopyide.dev/…` becomes
    `canopy://link?url=…`.
  - `src/readableLinks.ts`, `src/deepLinks.ts` (`link` kind and chat `message`),
    `App.tsx` routing, `spotSources.ts` (`canopy-link` source), and
    `CopyLinkButton`, `LiveSessions`/`ShareTerminalSheet`, `WorkspaceSelector`/`WorkspaceMenu`,
    `AccountChatView` and `TeamPanel`.

Tests: `readable-words.test.mjs`, `readable-links.test.mjs`,
`readable-link-route.test.mjs`, `readable-links.postgres.test.mjs` (real
Postgres; skips without the validation database), `src/readableLinks.test.ts`
(including parity with the control-plane parser and reserved names),
`LiveSessions.test.tsx`, `ShareTerminalSheet.test.tsx`, `TeamPanel.account.test.tsx`,
`ReadableLinksSettings.test.tsx`, `WorkspaceSelector.link.test.tsx`,
`ManagedWorkspaces.test.tsx` (member waits for sharing), `cli.rs`
`readable_links_become_deep_links` and `os_links_wait_for_the_frontend_then_route_directly`,
and `secure_store.rs` file-store tests.

## 6. To deploy

None of this needs new secrets. These steps are outside this repository.

1. **Database (canopy control DB).** Apply
   `packages/control-plane/readable-link-schema.sql` after `schema.sql`,
   `team-schema.sql` and `organization-schema.sql` (it references `team`,
   `"user"` and `workspace`). It is additive and idempotent. Validate first with
   the rollback-only test:
   `CANOPY_SYNTHETIC_DATABASE_URL=postgres://canopy_validation@127.0.0.1:55461/… node --test packages/control-plane/lib/readable-links.postgres.test.mjs`.
2. **Website (canopyide.dev, separate repo).**
   - `POST /api/links`: `user = await principal(req)`, then in a transaction
     `linksApi(client, user, body, {mayMutate: mayMutate(req, user)})`. Map
     `error.code` to the HTTP status, as `/api/teams` does.
   - A catch-all page route for `/<handle>/<path…>`, registered **after** every
     real top-level route: `readableRequestDecision(client, await principal(req), fullUrl, {signInPath: '<the site's sign-in path>'})`.
     Redirect on 302. On 200/404/410, render the site's own page or
     `readableLinkPage(decision)`. Send `Cache-Control: private, no-store` and
     `X-Robots-Tag: noindex`.
   - Before adding any new top-level website route, add its name to
     `RESERVED_HANDLES` in both `readable-links.mjs` and `src/readableLinks.ts`
     (a test keeps them identical). If a team already holds that handle, rename
     it first.
   - Pass `origin` matching the deployment. `linksApi` and
     `readableRequestDecision` default to `https://canopyide.dev`, so on a Vercel
     preview (`*.vercel.app`) `parseReadableUrl` rejects the preview host unless
     the adapter passes `{origin: 'https://' + req.headers.host}` there. Only do
     that for preview deployments: production must keep the canonical origin.
   - Optional: set `CANOPY_PUBLIC_URL` only if links should use another public
     HTTPS origin. The default is `https://canopyide.dev`, validated by
     `invitationPublicOrigin`.
3. **Desktop release.** Ship the app with these changes. The installers
   register `canopy://` (macOS bundle URL types, Windows registry, Linux
   `.desktop` `MimeType=x-scheme-handler/canopy`); an AppImage registers itself
   on first run. Older apps reject `/api/links` locally ("Invalid account
   request") and are otherwise unaffected.
4. **No DNS or certificate changes** are needed for the path form. If team
   subdomains are wanted later, add a `*.canopyide.dev` record and certificate
   (DNS-01) that point at the website, and 301 `https://<team>.canopyide.dev/<p>`
   to `https://canopyide.dev/<team>/<p>`. Exclude `workspaces` and every
   existing subdomain. The parsers already accept that form.

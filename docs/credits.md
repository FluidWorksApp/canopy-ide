# Credit management

Cloud workspaces are paid for from the owner's account balance, in US dollars, charged per minute of running time (and per GiB-month for a stopped workspace's saved snapshot). This document covers what happens as that balance runs down, how access is restored, and how to deploy and operate it.

Code:

- `packages/control-plane/lib/credit-policy.mjs`: every threshold, the start gate and the `credit_exhausted` error
- `packages/control-plane/lib/credit-enforcement.mjs`: reminder notices, pausing compute, the sweep, admin grants, credit requests and the `/api/credits` summary
- `packages/control-plane/lib/credit-email.mjs`: email templates
- `packages/control-plane/lib/credit-purchase.mjs`: Add funds (Stripe Checkout parameters, amount limits, crediting a paid checkout)
- `packages/control-plane/lib/credit-admin.mjs`: the admin allowlist, admin grants and the low-balance account list
- `packages/control-plane/credit-schema.sql`: tables (additive, idempotent)
- `packages/control-plane/scripts/grant-credit.mjs`: operator CLI
- `src/credits.ts`, `src/components/CreditNotice.tsx`: desktop status, warnings, errors and Add funds

These are reference copies of the deployed modules in the website service (`lib/canopy/` in canopy-website), kept identical apart from doc links. The website also has the HTTP handlers (`api/credits.ts`, `api/credits/checkout.ts`, `api/stripe/webhook.ts`, `api/admin/credits/*`), `lib/canopy/stripe-client.mjs` and the metering hooks. Its operator guide is `docs/credits-and-readable-links-rollout.md`.

## Policy

Balances belong to a user (`credit_account.user_id`). A workspace bills its owner, including time a shared member resumes. Organizations and teams have no balance of their own today, so every threshold applies to the owner's personal balance.

| Balance | Status | What happens |
|---|---|---|
| below $5 | `low` | "Running low" email, in-app warning, amber banner on Settings → Account |
| $0 or less | `zero` | "Out of credit" email, in-app warning, banner shows the running time left before the pause |
| −$5 or less | `final` | "Final notice" email: workspaces pause at −$10 |
| −$10 or less | `paused` | No workspace can start, resume, retry or resize. Running workspaces are hibernated. "Workspaces paused" email with the amount that restores access |
| less than one billing interval above −$10 | (start buffer) | A workspace can't start, resume, retry or resize unless the balance covers its first five-minute billing interval above −$10 at its plan's rate |

The constants are `LOW_USD`, `ZERO_USD`, `FINAL_USD` and `CUTOFF_USD` in `credit-policy.mjs`. The desktop mirrors them in `src/credits.ts` and uses the server's `policy` when `/api/credits` sends it, so the app and the API can deploy in either order.

Pausing only blocks compute. Files, snapshots, installed tools, settings, the account, sign-in, teams and messaging are untouched. Nothing is deleted because of a balance: the pause uses the normal hibernate operation, which verifies storage is retained before compute is removed. Stopping and deleting a workspace are never blocked.

Each reminder is sent once per crossing. When the balance recovers past a level (a grant, or a new plan's included balance), that level re-arms, and the next crossing sends it again. If several levels are crossed at once, for example a debit that jumps from $20 to −$12, only the most severe email is sent.

### Billing policies

- **Saved storage while paused** is set by `CANOPY_PAUSED_STORAGE_BILLING`. `charge` (the default) keeps charging snapshots and retained disks while the account is paused. It is the cost of keeping the user's files, and it can take a paused balance further below −$10. `hold` skips those charges while the account is at or below −$10 in `enforce` mode. The skipped time is never billed later, so the amount needed to resume stays put. Data is never deleted to stop a charge.
- **Start buffer.** Running time is debited in five-minute intervals (`BILLING_INTERVAL_SECONDS`). The start gate refuses a start unless the balance is at least −$10 plus one interval at the plan's hourly rate (the target plan for a resize). So a workspace that starts is never paused by its own first debit. For the Standard plan ($0.0696/h) that is −$9.99. A plan with charging off only needs to be above −$10. The refusal carries `minimumUsd`, and the desktop shows it.
- **The hibernate window isn't billed.** When a debit or the sweep requests a credit pause, metering bills running time only up to that request: the creation time of the pending hibernate whose context has `creditPause`. The minute or two until compute actually stops is free. If the lifecycle defers a pause because another operation is in flight, billing continues until the sweep requests it.

## Enforcement points

All writes use the existing lock order, workspace row first, then `credit_account`. Usage metering already takes locks in that order, so enforcement cannot deadlock with a debit, and a debit that crosses the cutoff while a start is in flight is either seen by the start gate or sees the start's operation and hibernates it.

1. **Start gate**: `requestOperation` (lifecycle.mjs) calls `assertComputeAllowed` right after the workspace row lock and the idempotent-replay check. For `resume`, `retry`, `resize` and `grow-storage` it locks the owner's `credit_account` row. It throws `CreditExhaustedError` at or below the cutoff, or below the start buffer (the lifecycle passes the plan's rate as `usdPerHour`). That is HTTP 402 with body `{error, code:'credit_exhausted', balanceUsd, cutoffUsd, shared, minimumUsd?}`. Every start path goes through `requestOperation`: the Workspaces UI, a shared member's resume (told only that the owner must add credit, never the owner's balance), management-health auto-repair, and retry. Creating a workspace does not start compute (`desired_state` defaults to `stopped`), so creation is not gated; its first start is.
2. **Debit path**: `enforceAfterDebit(client, {userId, workspaceId})` runs in the metering transaction right after the balance update, for running time and for retained disks (snapshot storage records notices only). It records crossed notices and, at or below the cutoff, requests hibernate for the debited workspace (inside a savepoint, so a refused lifecycle request never undoes the debit). When two workspaces of one owner are debited at the same moment, the account lock serializes them; the one whose debit crosses the cutoff pauses itself and the sweep pauses the other.
3. **Sweep**: `enforceCreditPolicy(pool, {send})` runs from the existing one-minute reconcile cron, after metering. It refreshes notices for balances below $5 or with open notices, hibernates any running managed workspace whose owner is at or below the cutoff, and delivers pending reminder emails. It is idempotent and safe to run concurrently (`SKIP LOCKED` throughout).

`CANOPY_CREDIT_ENFORCEMENT` switches the rollout: `notify` (the default, also for unknown values) records notices and sends the low, zero and final emails but never blocks or pauses (and never sends "paused"); `enforce` does all of the above; `off` disables everything. Accounts already below the cutoff are paused only after an operator sets `enforce` on purpose.

## Reminder emails

`credit_notice` is both the once-per-crossing record and the email outbox. A partial unique index allows one open notice per user and level. Emails are sent after the debit commits, by the sweep, through the existing SES sender (`lib/canopy/email.mjs` in the control plane): rows are claimed with a ten-minute lease, retried up to five times, and never sent once more than three days old. A failed send never rolls back a debit.

Templates (plain text and HTML, in the sign-in and invitation style) state the exact balance, the −$10 pause point, what happens next and how to get more credit: Add funds when it is configured, otherwise Request more credit. Render them locally with:

```js
import {creditNoticeEmail} from './packages/control-plane/lib/credit-email.mjs';
console.log(creditNoticeEmail({level:'paused', balanceUsd:'-64.48', supportEmail:'support@example.com'}).text);
```

Configuration (control plane environment):

| Variable | Purpose |
|---|---|
| `CANOPY_SES_REGION`, `CANOPY_SES_ACCESS_KEY_ID`, `CANOPY_SES_SECRET_ACCESS_KEY` | Existing SES credentials, already used for sign-in and invitations |
| `CANOPY_BILLING_FROM` | Optional sender for credit emails; falls back to `CANOPY_AUTH_FROM` |
| `CANOPY_SUPPORT_EMAIL` | Where "Request more credit" goes; also named in reminders as a contact. Without it the desktop request is recorded but no email is sent |
| `CANOPY_CREDIT_ENFORCEMENT` | `notify` (default), `enforce` or `off` |
| `CANOPY_PAUSED_STORAGE_BILLING` | `charge` (default) or `hold`; see Billing policies |
| `CANOPY_CREDIT_PURCHASE_ENABLED`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Add funds; all three are needed. Without them the API reports `paymentsEnabled:false` |
| `CANOPY_ADMIN_EMAILS` | Comma-separated emails allowed to use the admin credit routes |

Without a from address `creditMailer` returns no sender and notices stay queued, so nothing is lost while email is unconfigured. Tests use `recordingMailer()`.

## Getting credit back

1. **Add funds** (when the server has Stripe configured). Settings → Account → **Add funds**: choose $10, $25, $50 or $100, or another amount from $5 to $500. The desktop calls `POST /api/credits {action:'checkout', amountUsd}`, which creates a Stripe Checkout Session (`POST /api/credits/checkout` is the same for other clients). It then opens the hosted payment page in the browser. Stripe takes the card and emails the receipt. After payment the browser lands on `/workspaces?funds=added`. The signed webhook `POST /api/stripe/webhook` (checked with `STRIPE_WEBHOOK_SECRET` on the raw body) handles `checkout.session.completed` or `checkout.session.async_payment_succeeded`. It credits what Stripe charged through `grantCredit`, with ledger key `purchase:<session id>` and actor `stripe:<event id>`. A redelivered event credits nothing more. The desktop polls `/api/credits` every three seconds, for up to fifteen minutes, until `purchases` lists the session. It then shows the new balance. The account page also refreshes on focus and every ten seconds. Only sessions tagged `metadata.purpose='canopy-credit'` are credited, and a deleted account is acknowledged without credit (refund it in Stripe). Setup steps are in the website rollout doc.
2. **Request more credit.** Offered when Add funds isn't configured, and beside it while the balance is low. `POST /api/credits {action:'request-credit', note?}` records a `credit_request` (one per user per day; a repeat returns the open request) and emails `CANOPY_SUPPORT_EMAIL` with the balance and a ready-to-run grant command.
3. **An admin grants.** Over HTTP, signed in with an email in `CANOPY_ADMIN_EMAILS`: `POST /api/admin/credits/grant {email|userId, amountUsd, reason, requestKey?}`. The ledger actor is `admin:<email>`. `GET /api/admin/credits/accounts?below=-10` lists accounts below a balance, lowest first. Each row has what it needs to restore access, its running workspaces and any open request. The schema has no admin role (roles exist only inside teams and organizations), so the allowlist is the guard. Or from a checkout of the control plane with `CANOPY_DATABASE_URL` set:

   ```sh
   node scripts/grant-credit.mjs --email sam@example.com --amount 60 --reason "Preview top-up" --dry-run
   node scripts/grant-credit.mjs --email sam@example.com --amount 60 --reason "Preview top-up"
   ```

   Each grant writes one `credit_ledger` row (`kind='grant'`, `actor` recorded, `event_key='admin-grant:<request key>'`) and moves the balance under the account lock. It clears reminders the new balance recovers past and closes the user's open credit requests. Pass `--request-key` (or `requestKey`) to make a retry a no-op. A negative amount records a correction (`kind='adjustment'`), for example after a refund made in Stripe. The output says whether workspaces are still paused.

Neither a payment nor a grant starts a workspace: the user resumes when ready, and the start gate allows it once the balance clears the start buffer. To restore access from −$64.48 the user needs at least $54.49 (a little more to start a charged plan).

## Desktop

- Settings → Account shows the balance, a banner for `low`, `zero`, `final` and `paused` (with the exact amount that restores access), spend per workspace over the last 30 days (`usageByWorkspace`, or the existing `sessions` from older servers), **Add funds** when the server sends `paymentsEnabled:true` with `purchase` limits, and Request more credit otherwise (and while the balance is low).
- Starting a workspace that the control plane refuses with `credit_exhausted` shows "Workspace paused: out of credit" with the balance (and, for a start-buffer refusal, the balance it needs), Request more credit and Add funds or view balance, instead of a generic startup error. Shared members see that the owner must add credit. A refusal from the header switcher is also posted to notifications.
- While managed workspaces are in use the app checks `/api/credits` at most every five minutes and posts a non-blocking notification once per crossing into a worse level.

## Control plane wiring

The deployed control plane is the website service (Vercel; `lib/canopy/`, `api/`, `database/`), not this repository, and the wiring is live there:

- `lib/canopy/lifecycle.mjs` calls `assertComputeAllowed` with the plan's rate.
- `metering.mjs` and `disk-metering.mjs` call `enforceAfterDebit` after each debit, and `snapshot-metering.mjs` calls it for notices.
- `metering.mjs` bills running time only up to a pending credit pause (`creditPauseRequestedAt`). The two storage meters check `storageChargeHeld`.
- `api/reconcile.ts` runs `enforceCreditPolicy` every minute.
- `api/operations.ts` passes the structured 402 body through.
- `api/credits.ts` serves the summary (with `paymentsEnabled`, `purchase` and `purchases`), `request-credit` and `checkout`.
- `api/credits/checkout.ts`, `api/stripe/webhook.ts` and `api/admin/credits/{grant,accounts}.ts` serve Add funds and the admin routes.
- `database/credit-schema.sql` is in `database/ORDER`. Add funds and the admin routes need no schema change.

`packages/control-plane` here is a reference copy. Its `credits.mjs` and `schema.sql` predate the move to dollar columns (`balance_usd`, `amount_usd`). The credit modules are written against the deployed column names and match the website's copies. When changing one, change both.

The rollout order, environment variables and Stripe webhook setup are in the website's `docs/credits-and-readable-links-rollout.md`. In short: apply `credit-schema.sql`, deploy in `notify`, grant or contact the accounts below −$10, then switch to `enforce`. Add funds turns on separately, once the Stripe secrets and `CANOPY_CREDIT_PURCHASE_ENABLED=true` are set.

## Tests

- `packages/control-plane/lib/credit-policy.test.mjs`: thresholds, amount to restore, modes, the start gate's lock order, structured error and start buffer, the paused-storage policy, debit hook modes, grant validation, email rendering and escaping. `credit-purchase.test.mjs`: purchase limits, checkout parameters, crediting a paid checkout once, admin grants and the account list. Run with `node --test packages/control-plane/lib/*.test.mjs`. CI does not run the control-plane tests today.
- In the website: `tests/credit-billing.test.mjs` (metering stops at the pause request, hold, the disk hook, the start buffer through `requestOperation`), `tests/credit-purchase.test.mjs` (the checkout and webhook handlers, with real Stripe signatures from `stripe.webhooks.generateTestHeaderString`), `tests/credit-admin.test.mjs`, and `tests/credit-enforcement.integration.mjs` against Postgres.
- `packages/control-plane/lib/credit-enforcement.postgres.test.mjs`: against real Postgres with the deployed schema: once-per-crossing notices and email supersession, two concurrent debits crossing the cutoff, the sweep, the start gate, request rate limiting, grant idempotency and ledger rows, and the summary. It runs when `CANOPY_SYNTHETIC_DATABASE_URL` points at the synthetic validation database (127.0.0.1:55461, user `canopy_validation`) with the control plane's `database/ORDER` applied, and `CANOPY_SYNTHETIC_PG_PACKAGE_JSON` names a `package.json` that can resolve `pg`.
- `src/credits.test.ts`, `src/components/AccountSettings.test.tsx`, `src/remoteExecution/ManagedWorkspaces.test.tsx`: banner states, refusal parsing (including `minimumUsd`), once-per-crossing warnings, the request action, Add funds (checkout, browser, polling until credited, custom amounts, the unconfigured fallback) and the start refusal message.

# Credit management

Cloud workspaces are paid for from the owner's account balance, in US dollars, charged per minute of running time (and per GiB-month for a stopped workspace's saved snapshot). This document covers what happens as that balance runs down, how access is restored, and how to deploy and operate it.

Code:

- `packages/control-plane/lib/credit-policy.mjs`: every threshold, the start gate and the `credit_exhausted` error
- `packages/control-plane/lib/credit-enforcement.mjs`: reminder notices, pausing compute, the sweep, admin grants, credit requests and the `/api/credits` summary
- `packages/control-plane/lib/credit-email.mjs`: email templates
- `packages/control-plane/credit-schema.sql`: tables (additive, idempotent)
- `packages/control-plane/scripts/grant-credit.mjs`: operator CLI
- `src/credits.ts`, `src/components/CreditNotice.tsx`: desktop status, warnings and errors

## Policy

Balances belong to a user (`credit_account.user_id`). A workspace bills its owner, including time a shared member resumes. Organizations and teams have no balance of their own today, so every threshold applies to the owner's personal balance.

| Balance | Status | What happens |
|---|---|---|
| below $5 | `low` | "Running low" email, in-app warning, amber banner on Settings → Account |
| $0 or less | `zero` | "Out of credit" email, in-app warning, banner shows the running time left before the pause |
| −$5 or less | `final` | "Final notice" email: workspaces pause at −$10 |
| −$10 or less | `paused` | No workspace can start, resume, retry or resize. Running workspaces are hibernated. "Workspaces paused" email with the amount that restores access |

The constants are `LOW_USD`, `ZERO_USD`, `FINAL_USD` and `CUTOFF_USD` in `credit-policy.mjs`. The desktop mirrors them in `src/credits.ts` and uses the server's `policy` when `/api/credits` sends it, so the app and the API can deploy in either order.

Pausing only blocks compute. Files, snapshots, installed tools, settings, the account, sign-in, teams and messaging are untouched. Nothing is deleted because of a balance: the pause uses the normal hibernate operation, which verifies storage is retained before compute is removed. Stopping and deleting a workspace are never blocked.

Each reminder is sent once per crossing. When the balance recovers past a level (a grant, or a new plan's included balance), that level re-arms, and the next crossing sends it again. If several levels are crossed at once, for example a debit that jumps from $20 to −$12, only the most severe email is sent.

### Decisions to revisit

- **Saved-snapshot storage keeps charging while paused.** It is the cost of keeping the user's data, and it is small. It can take a paused balance further below −$10, which raises the amount needed to resume. Deleting data to stop the charge is never done.
- **The cutoff is the same for starting and for stopping.** A workspace may start at −$9.99 and will be paused at its first debit past −$10. A start margin (for example, refuse starts below −$9) would be a one-line change in `assertComputeAllowed`.
- **Time between the hibernate request and compute actually stopping is still charged** (usually a minute or two). Debits stop once the workspace leaves `ready`.

## Enforcement points

All writes use the existing lock order, workspace row first, then `credit_account`. Usage metering already takes locks in that order, so enforcement cannot deadlock with a debit, and a debit that crosses the cutoff while a start is in flight is either seen by the start gate or sees the start's operation and hibernates it.

1. **Start gate**: `requestOperation` (lifecycle.mjs) calls `assertComputeAllowed` right after the workspace row lock and the idempotent-replay check. For `resume`, `retry`, `resize` and `grow-storage` it locks the owner's `credit_account` row and throws `CreditExhaustedError` at or below the cutoff: HTTP 402, body `{error, code:'credit_exhausted', balanceUsd, cutoffUsd, shared}`. Every start path goes through `requestOperation`: the Workspaces UI, a shared member's resume (told only that the owner must add credit, never the owner's balance), management-health auto-repair, and retry. Creating a workspace does not start compute (`desired_state` defaults to `stopped`), so creation is not gated; its first start is.
2. **Debit path**: `enforceAfterDebit(client, {userId, workspaceId})` runs in the metering transaction right after the balance update. It records crossed notices and, at or below the cutoff, requests hibernate for the debited workspace (inside a savepoint, so a refused lifecycle request never undoes the debit). When two workspaces of one owner are debited at the same moment, the account lock serializes them; the one whose debit crosses the cutoff pauses itself and the sweep pauses the other.
3. **Sweep**: `enforceCreditPolicy(pool, {send})` runs from the existing one-minute reconcile cron, after metering. It refreshes notices for balances below $5 or with open notices, hibernates any running managed workspace whose owner is at or below the cutoff, and delivers pending reminder emails. It is idempotent and safe to run concurrently (`SKIP LOCKED` throughout).

`CANOPY_CREDIT_ENFORCEMENT` switches the rollout: `enforce` (default) does all of the above; `notify` records notices and sends the low, zero and final emails but never blocks or pauses (and never sends "paused"); `off` disables everything.

## Reminder emails

`credit_notice` is both the once-per-crossing record and the email outbox. A partial unique index allows one open notice per user and level. Emails are sent after the debit commits, by the sweep, through the existing SES sender (`lib/canopy/email.mjs` in the control plane): rows are claimed with a ten-minute lease, retried up to five times, and never sent once more than three days old. A failed send never rolls back a debit.

Templates (plain text and HTML, in the sign-in and invitation style) state the exact balance, the −$10 pause point, what happens next and how to get more credit. Render them locally with:

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
| `CANOPY_CREDIT_ENFORCEMENT` | `enforce` (default), `notify` or `off` |

Without a from address `creditMailer` returns no sender and notices stay queued, so nothing is lost while email is unconfigured. Tests use `recordingMailer()`.

## Getting credit back

Adding funds is not available during the preview, so credit is restored in two steps.

1. **The user asks.** Settings → Account → **Request more credit**, also offered on the paused-workspace message. `POST /api/credits {action:'request-credit', note?}` records a `credit_request` (one per user per day; a repeat returns the open request) and emails `CANOPY_SUPPORT_EMAIL` with the balance and a ready-to-run grant command.
2. **An operator grants.** From a checkout of the control plane with `CANOPY_DATABASE_URL` set:

   ```sh
   node scripts/grant-credit.mjs --email sam@example.com --amount 60 --reason "Preview top-up" --dry-run
   node scripts/grant-credit.mjs --email sam@example.com --amount 60 --reason "Preview top-up"
   ```

   This writes one `credit_ledger` row (`kind='grant'`, `actor` recorded, `event_key='admin-grant:<request key>'`), moves the balance under the account lock, clears reminders the new balance recovers past and closes the user's open credit requests. Pass `--request-key` to make a retried command a no-op; a negative `--amount` records a correction (`kind='adjustment'`). The output says whether workspaces are still paused. A grant never starts a workspace: the user resumes when ready, and the start gate allows it as soon as the balance is above −$10. To restore access from −$64.48 the user needs at least $54.49.

There is no admin HTTP route; the control plane has no admin role today, and the CLI against the database is the guarded path. `grantCredit` is the function to call if one is added.

**Payment provider extension point.** No payment integration exists. When one is added, the API sets `paymentsEnabled:true`, the desktop shows "Add funds" where the comment in `AccountSettings.tsx` marks it, and a successful payment calls `grantCredit` with the payment id as the request key.

## Desktop

- Settings → Account shows the balance, a banner for `low`, `zero`, `final` and `paused` (with the exact amount that restores access), spend per workspace over the last 30 days (`usageByWorkspace`, or the existing `sessions` from older servers) and Request more credit.
- Starting a workspace that the control plane refuses with `credit_exhausted` shows "Workspace paused: out of credit" with the balance, Request more credit and View balance, instead of a generic startup error. Shared members see that the owner must add credit. A refusal from the header switcher is also posted to notifications.
- While managed workspaces are in use the app checks `/api/credits` at most every five minutes and posts a non-blocking notification once per crossing into a worse level.

## Control plane wiring

The deployed control plane is the website service (Vercel; `lib/canopy/`, `api/`, `database/`), not this repository. `packages/control-plane` here is a reference copy of some of its modules; its `credits.mjs` and `schema.sql` predate the move to dollar columns (`balance_usd`, `amount_usd`), and the new modules are written against the deployed column names. To deploy:

1. Copy `credit-policy.mjs`, `credit-email.mjs` and `credit-enforcement.mjs` to `lib/canopy/`, `credit-schema.sql` to `database/`, and `scripts/grant-credit.mjs` to `scripts/` (change its imports to `../lib/canopy/…`).
2. `lib/canopy/lifecycle.mjs`: import `assertComputeAllowed` from `./credit-policy.mjs` and add, right after the idempotent `existing` request return and before the `retry` branch:

   ```js
   await assertComputeAllowed(client,userId,input.action,{shared:requesterId!==userId});
   ```

3. `lib/canopy/metering.mjs`, in `meterWorkspace` after the `credit_account` balance update:

   ```js
   if(inserted.rows.length)await enforceAfterDebit(client,{userId:w.owner_id,workspaceId:id});
   ```

   and in `snapshot-metering.mjs` after its balance update, notices only (the workspace is already stopped):

   ```js
   if(inserted.rows.length)await enforceAfterDebit(client,{userId:w.owner_id,workspaceId:null});
   ```

   Import it in both files: `import {enforceAfterDebit} from './credit-enforcement.mjs';`. `credits.mjs`'s `debitCredits` has no callers in the deployed service, so it needs no hook. A pause that the lifecycle refuses is deferred to the sweep and never aborts the metering transaction, which debits every running workspace at once.

4. `api/reconcile.ts`, after metering:

   ```ts
   import {enforceCreditPolicy,creditMailer} from '../lib/canopy/credit-enforcement.mjs';
   import {sendEmail} from '../lib/canopy/email.mjs';
   // …
   const credit=await enforceCreditPolicy(pool,{send:creditMailer({sendEmail,from:process.env.CANOPY_BILLING_FROM??process.env.CANOPY_AUTH_FROM})});
   // include `credit` in the JSON response
   ```

   The route has `maxDuration: 60`. The sweep handles up to 100 accounts and 100 workspaces and sends up to 20 emails per run; lower `limit` (on `enforceCreditPolicy` and `deliverCreditNotices`) if the cron ever approaches the limit.

5. `api/operations.ts`, in the final `catch`, pass the structured body through so the desktop can show the balance:

   ```ts
   const body=typeof (error as {toJSON?:()=>unknown}).toJSON==='function'?(error as {toJSON:()=>unknown}).toJSON():{error:typeof code==='number'?(error as Error).message:'Workspace action could not be started'};
   return res.status(typeof code==='number'?code:500).json(body);
   ```

   Older desktops still read `error`, which holds the full message.

6. `api/credits.ts`: spread `await creditSummary(pool,user.id)` into the GET response (keep the existing fields), and accept POST:

   ```ts
   import {mayMutate} from '../lib/canopy/principal.mjs';
   import {creditSummary,requestMoreCredit,deliverCreditRequest,creditMailer} from '../lib/canopy/credit-enforcement.mjs';
   import {sendEmail} from '../lib/canopy/email.mjs';
   // GET: res.json({...existingFields,...await creditSummary(pool,user.id)})
   // The handler currently answers 405 to anything but GET; handle this first.
   if(req.method==='POST'&&req.body?.action==='request-credit'){
    if(!mayMutate(req,user))return res.status(403).json({error:'Origin not allowed'});
    const client=await pool.connect();let result;
    try{await client.query('BEGIN');result=await requestMoreCredit(client,{userId:user.id,note:req.body.note});await client.query('COMMIT');}
    catch(error){await client.query('ROLLBACK');const code=(error as {code?:number}).code;return res.status(typeof code==='number'?code:500).json({error:typeof code==='number'?(error as Error).message:'Credit request could not be sent'});}
    finally{client.release();}
    const emailed=await deliverCreditRequest({send:creditMailer({sendEmail,from:process.env.CANOPY_BILLING_FROM??process.env.CANOPY_AUTH_FROM}),supportEmail:process.env.CANOPY_SUPPORT_EMAIL,result});
    return res.json({requested:true,duplicate:!result.created,requestedAt:result.request.created_at,emailed});
   }
   ```

7. Add `credit-schema.sql` to the end of `database/ORDER` and apply it (idempotent).

### Rollout

Accounts are already below the cutoff (one shows −$64.48). With `enforce`, the first sweep after deploy hibernates their running workspaces and emails them. Recommended order:

1. Apply `credit-schema.sql`.
2. Deploy with `CANOPY_CREDIT_ENFORCEMENT=notify` and `CANOPY_SUPPORT_EMAIL` set. Reminders start; nothing is blocked.
3. List affected accounts: `SELECT u.email, a.balance_usd FROM credit_account a JOIN "user" u ON u.id=a.user_id WHERE a.balance_usd <= -10 ORDER BY a.balance_usd;` Grant credit or contact them.
4. Switch to `enforce` (unset the variable). The next minute's sweep applies the cutoff.

Release the desktop update in any order; older servers simply don't send the new fields.

## Tests

- `packages/control-plane/lib/credit-policy.test.mjs`: thresholds, amount to restore, modes, the start gate's lock order and structured error, debit hook modes, grant validation, email rendering and escaping. Run with `node --test packages/control-plane/lib/*.test.mjs`. CI does not run the control-plane tests today.
- `packages/control-plane/lib/credit-enforcement.postgres.test.mjs`: against real Postgres with the deployed schema: once-per-crossing notices and email supersession, two concurrent debits crossing the cutoff, the sweep, the start gate, request rate limiting, grant idempotency and ledger rows, and the summary. It runs when `CANOPY_SYNTHETIC_DATABASE_URL` points at the synthetic validation database (127.0.0.1:55461, user `canopy_validation`) with the control plane's `database/ORDER` applied, and `CANOPY_SYNTHETIC_PG_PACKAGE_JSON` names a `package.json` that can resolve `pg`.
- `src/credits.test.ts`, `src/components/AccountSettings.test.tsx`, `src/remoteExecution/ManagedWorkspaces.test.tsx`: banner states, refusal parsing, once-per-crossing warnings, the request action and the start refusal message.

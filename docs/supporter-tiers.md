# Supporter tiers (July 2026)

Canopy takes donations through a Stripe Payment Link. This document records how
a donation becomes a tier, how a tier becomes a label on an issue, and what a
tier weighs when we decide what to build next — plus the two pieces that
deliberately live outside this repo.

The short version: **Stripe is the money and the ledger, GitHub is only the
identity.** Everything else follows from that.

## Why not read sponsorships from GitHub

GitHub Sponsors exposes current state — `sponsorEntity`, `tier`, `createdAt`,
`privacyLevel`, `isOneTimePayment` — and no transaction history whatsoever.
There is no ledger API and no aggregate totals, so "who has given how much" is
unanswerable through it; you could only start snapshotting monthly and would
still never recover the past. Stripe already holds every charge, retroactively.

The credentials make the same point from the other side. The default
`GITHUB_TOKEN` is refused on every sponsorship field, and GitHub Apps have no
sponsorship permission at all, so an Action that read sponsors would need a
classic PAT — an account-level credential — sitting in a repo secret. Reading
tiers from our own store avoids that entirely.

## The store

Two files, both in `.github/supporters/`:

**`tiers.json`** — the tiers, their labels, and their weights. Weight is a
property of the tier, not a constant in the workflow, so retuning the policy is
a data edit. Also carries the decay policy (below).

**`supporters.json`** — the join itself, one entry per person:

```json
{
  "login": "octocat",
  "tier": "gold",
  "visibility": "public",
  "recurring": true,
  "since": "2026-06-01",
  "lastPaymentAt": "2026-07-01",
  "lapsedAt": null,
  "lifetimeUsd": 300
}
```

`login` matching is case-insensitive and tolerates a leading `@`. `lifetimeUsd`
is not used for labelling — it is the field that answers "who gave how much",
which only Stripe can populate.

The file is hand-editable and works today. When the webhook receiver ships it
serves the same JSON over HTTPS; set the `SUPPORTERS_URL` repo variable (and
`SUPPORTERS_TOKEN` if it needs auth) and the committed file becomes a fallback
for when that fetch fails. A stale tier beats no tier, so a failed fetch falls
back rather than erroring.

## Labels

`.github/workflows/supporter-labels.yml` runs on `issues: opened` and
`pull_request_target: opened`, resolves the author against the store and applies
one `supporter:*` label, removing any other one it manages. Label names are
plain ASCII — unicode emoji in label names is known to fail — and the labels are
created on first use, so there is nothing to set up by hand.

`pull_request_target` is used rather than `pull_request` because a fork PR's
token is read-only and could not label anything. The job never checks out or
runs the PR head; it reads the base ref's script and store, and takes only the
author's login from the event.

**Privacy.** A supporter marked `"visibility": "private"` never gets a label.
Labelling them would publish a sponsorship they chose to keep private. They keep
their weight — the label is recognition, the weight is prioritisation, and only
one of them is public.

**Decay.** How long entitlement outlives payment is a policy choice, so it is
data (`tiers.json` → `policy`), with these defaults:

- a one-time supporter keeps their tier for **365 days** after their last payment;
- a lapsed subscription keeps its tier for **30 days** after `lapsedAt`.

## Weights

`weightFor()` in `scripts/supporter-labels.mjs` returns the active tier's
weight: bronze 1, silver 2, gold 4 — the standard revenue-weighted pattern,
where a request with fewer supporters behind it can outrank one with more. It is
exported so a ranking pass over 👍 reactions can use it without duplicating the
decay and tier rules; nothing consumes it yet.

Weighting is an input to prioritisation, not a promise about it. If it ever
becomes actual authority over the roadmap rather than a signal, that policy
needs stating publicly before the first time it decides something.

## Deliberately not here

**Comment tags — dropped, not deferred.** There is no way to badge a supporter's
comments. `author_association` is a fixed enum (`OWNER`, `MEMBER`,
`COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIMER`, `FIRST_TIME_CONTRIBUTOR`,
`MANNEQUIN`, `NONE`) with no sponsor value and no extension point, and GitHub
renders no sponsor badge in comment threads. The only workarounds are a bot
replying to every comment, a bot editing other people's comment bodies, or a
browser extension only some readers install. Issue labels plus a supporters page
deliver the recognition without fighting the platform.

**The Stripe custom field — a Dashboard change, no code.** Payment Links support
custom fields; a required "GitHub username" text field returns its value in the
`checkout.session.completed` webhook. Adding it starts accumulating the join
from the next donation, and nothing here works without it. The value is
self-declared and unverified — acceptable at current volume, and hardened later
with GitHub OAuth before checkout or an emailed claim token, if it stops being.

**The webhook receiver — `canopy-website`, not this repo.** It belongs beside
`api/crash.ts` as `api/stripe-webhook.ts`: that project already has the Vercel
deploy, the HTTPS origin and the secret handling. Two things to get right there
— Stripe's signature verification needs the **raw** request body, so the parsed
`req.body` that `crash.ts` relies on will fail it; and the project has no
datastore of any kind today, which is the one genuinely missing piece of
infrastructure in this whole design.

**Polar.sh — the buy-instead-of-build alternative.** It solves the identity join
natively (donors authenticate with GitHub), does issue funding and automated
benefits, and is a supported `FUNDING.yml` platform, for 5%. It would replace
the store, the receiver and the Dashboard field. It would not replace the
retroactive Stripe ledger, which is why this design keeps Stripe.

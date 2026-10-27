## Plans before work, and reviews that start from intent

### Agents start from a plan, not just a prompt

When you hand work to an agent through Canopy (**Run as task** from search or
any "Ask an agent…" box, a one-off task, a ticket's **Start work** or its task
run), the brain first writes a one-screen plan:

- **Goal**: what done looks like, in plain words.
- **Decisions**: the choices that matter and that the agent would otherwise
  guess, such as "pages or infinite scroll?". Each one has options and a
  recommendation.
- **Expected to touch**, **Done when** (the acceptance checks) and **Won't do**.

How much the plan asks of you depends on what could go wrong:

- **Small, low-risk work** starts right away. "Started with a plan" appears in
  the corner, and **Show plan** opens it.
- **Riskier work** waits for you. That means medium or high risk, a large
  change, or anything touching sign-in and permissions, data and migrations,
  billing, CI, build config or lockfiles. Pick an answer for each decision or
  write your own, edit the checks, then press **Approve & start**. **Don't
  start** cancels the work. **Start without a plan** skips planning at any
  point.

When the agent starts, its brief opens with the goal, your decisions, the
acceptance checks and what it won't do. If it then hits a choice the plan didn't
cover, it is told to ask you instead of guessing, and your answer is added to
the plan as a decision "asked while working".

**Share plan to team** posts the plan to team chat. Teammates can read it,
discuss it in its thread, and press **Approve plan…** or **Ask for changes…**.
An approval in chat counts on your machine too. If the agent was waiting on the
plan, it starts when your Canopy sees the approval in the chat. (Your Canopy
must be signed in to that team chat.)

Plans are kept in the project ledger with a status: waiting for approval,
approved, in progress, done or not started. Each plan is linked to the agent
session that ran it.

**When the brain is used:** once each time you dispatch work, on the main
model, under the feature name `plan`. If no brain is connected, it is signed
out or over budget, or planning takes too long, the agent starts from your
brief and a one-line note says so.

**Turn it off:** Settings → **Plan before an agent starts**.

### Review: intent and evidence first, then the diff

An agent's tab and a pull request's tab now open on **Intent & evidence**,
read top to bottom:

1. **The plan**: the goal and the decisions that were made.
2. **What changed against the plan**: the brain's summary. It covers how the
   change differs from the plan, files the plan didn't mention, and acceptance
   checks the change doesn't appear to meet.
3. **Proof receipt**: the receipt for this run, when one exists. Otherwise it
   says "No receipt yet".
4. **Risk map**: changed files, riskiest first. Sign-in and permissions, data,
   migrations and money always come first, marked **high · read lines**,
   whatever the brain says. Click a file to jump to its diff. The diff below
   uses the same order.

If a change is bigger than your slice budget, the review says so. **Ask the
agent to split this** sends the brain's split suggestion to the agent's
terminal. On a pull request, this only works when the agent that raised it is
running in this window.

**Track record**: the review also shows how this kind of work has gone in this
repo, for example "Track record for test-addition in this repo: 12 proven,
0 reverted". The brain gives each plan one of these kinds: dependency-bump,
copy-change, test-addition, bugfix, feature, refactor or infra. The counts come
from proof-receipt verdicts and a revert check. The revert check is a guess:
Canopy looks for "Revert" commits that name commits the agent's run made. A kind
with 10 or more proven runs, no reverts and no contradicted receipts shows as
**eligible for auto-merge**. This is only a recommendation; Canopy never merges
anything by itself.

**When the brain is used:** once for each change you review, on the main
model, under the feature name `review`. Results are cached, so the same plan
and diff are never summarized twice. Without a brain, the plan, the receipt
and the path-based risk map still show.

**Turn it off / tune it:** Settings → **Intent & evidence review**. Untick
automatic summaries to get a **Summarize against the plan** button instead.
The same setting sets the most changed lines allowed in one reviewable slice
(default 400).

### For other features: what a plan entry contains

- Ledger kind `plan`. Before the agent runs, `ref` is `{kind: "plan", id:
  <planId>}`. Once the agent's first turn is seen, `ref` becomes
  `{kind: "session", id: <sessionId>}`. `data.planId` stays the same through
  every status change.
- `data.acceptance` (a string array) holds the plan's acceptance checks. Proof
  receipts should check a run against this field.
- Other fields in `data`: `goal`, `decisions[]`, `touches[]`, `wontDo[]`,
  `risk`, `size`, `taskClass`, `sessionId`, `ptyId`, `baseHead` and
  `commits[]`. Each item in `decisions[]` has `question`, `options`,
  `recommended`, `why`, `answer` and a `source` of `plan` or `mid-run`.

# The PR tab, redesigned: review and get reviewed, end to end

Research + design for `src/components/PrView.tsx`. Goal: everything a PR needs
between "opened" and "merged" happens on this one tab, with agents doing the
labour and the human keeping every outward-facing decision.

**Status: built.** All five phases landed together — the capability matrix in §3
is what the code actually calls, and §9 records what each phase became. Kept as a
document because the *ordering* in §4–§7 is the argument for why the tab is shaped
the way it is, and because §3 is the map anyone extending it will need.

## 1. What actually happens in a PR

Two roles, and today's tab serves neither completely. The stages below are the
whole surface area; the last column is where Canopy stands today.

**Author**

| Stage | What it needs | Today |
|---|---|---|
| Open it | title/body from the real diff | ✅ `raisePrTask` |
| Self-review before humans look | a private pass, nothing posted | ❌ |
| Get the right reviewers on it | request review, CODEOWNERS | ⚠️ teammate-over-relay only |
| Keep it green | CI failures, conflicts, base drift | ⚠️ conflicts only |
| Answer feedback | address / push back / reply / resolve | ⚠️ one-shot task, blind |
| Re-request after pushing | dismiss-stale → ask again | ❌ |
| Land it | method, auto-merge, delete branch | ✅ merge, ⚠️ no auto-merge |
| Not lose the tail | out-of-scope comments → tickets | ❌ |

**Reviewer**

| Stage | What it needs | Today |
|---|---|---|
| Triage | size, risk, is it green, does it need me | ⚠️ header only |
| Understand | description, commit-by-commit, per-file progress | ⚠️ description + flat diff |
| Verify claims | read callers, run tests, run the app | ❌ |
| Comment | **inline** threads, batched into one review, nit vs blocking | ❌ top-level body only |
| Decide | approve / comment / request changes | ✅ (with confirm) |
| Re-review | only what changed since last time | ❌ |
| Close out | resolve threads | ❌ |

Two findings from the research worth designing *for*, not around:

- **Latency is the metric.** Time-to-first-response is the strongest team-level
  predictor of velocity; the target everyone quotes is under 24h. So the page's
  job is to make the *first* pass fast, not to make an exhaustive one possible.
- **Size drives everything else.** ~200 lines is the recommended change size;
  halving PR size roughly halves review latency, and comment usefulness falls as
  size grows. A big PR needs *triage help*, not a longer scroll — which is why
  the risk-ranked review map below matters more than any diff-rendering tweak.

And from the tool landscape: what won a head-to-head of Copilot / Cursor BugBot /
CodeRabbit was **summarisation that cut reviewer cognitive load**, not finding
count. BugBot's edge is precision (~0.9 comments per PR, nearly all
runtime-relevant). Both point the same way: **few, verified, well-ranked
findings, and a map of the change**. Noise is the failure mode.

## 2. What Canopy can do that none of them can

Every hosted reviewer sees a diff over HTTP. This tab sits on the machine with
the checkout, the toolchain, the LSP, the terminals and the browser:

1. **Run it.** Check the branch out in a worktree (`prWorktree`, already there),
   start the dev server, open the changed route in the preview, screenshot it.
   Visual review of a UI PR is a thing no hosted bot can do.
2. **Prove it.** Run the tests. Write a failing test first. `canopy_diagnostics`
   / `canopy_references` answer "does this compile" and "who calls this" without
   a network round trip.
3. **Delta review.** The local checkout has every commit, so "what changed since
   my last review" is a `git diff <sha>..HEAD` — no API needed.
4. **Steerable, not a black box.** The agent runs in a visible terminal you can
   interrupt, in a worktree that can't touch your shared checkout.
5. **Fix locally, then push.** A hosted reviewer suggests; this one can apply,
   verify, and push — and, uniquely, *apply a suggested change* even though
   GitHub has no API for the "Commit suggestion" button (§3).

## 3. Capability matrix — what the API actually permits

This is what makes or breaks the design, so it's stated before the UI. `gh`
covers the coarse verbs; **review threads exist only in GraphQL** (they are not
in REST at all), and `gh` has no native command for them (cli/cli#12419), so the
thread half of the page is `gh api graphql`.

| Capability | How | Notes |
|---|---|---|
| Read everything in one call | `gh api graphql`: `body`, `comments`, `reviews`, `reviewThreads`, `files`, `statusCheckRollup` | one round trip per refresh; `reviewThreads` carries `isResolved`, `isOutdated`, `path`, `line`, `diffSide` |
| Post **inline** comments, batched | `addPullRequestReview(threads:[…])` | one review, N threads — the pending-review model; not possible through `gh pr review` |
| Reply on a thread | `addPullRequestReviewThreadReply` | |
| Resolve / unresolve | `resolveReviewThread` / `unresolveReviewThread` | needs Contents: read+write on a fine-grained token |
| Per-file "viewed" | `markFileAsViewed` / `unmarkFileAsViewed` | shares state with github.com's own checkbox |
| Suggested changes | author by writing a ` ```suggestion ` fence in the body | **applying** one has no API — but the fence text is in the comment body, so we apply it to the file locally and commit. (Copilot's separate "Suggest" changesets aren't exposed by any API — those we can only link out to.) |
| Request reviewers | `gh pr edit --add-reviewer` | |
| Dismiss a stale review | `dismissPullRequestReview` | |
| Draft ↔ ready | `gh pr ready` / `convertPullRequestToDraft` | |
| Sync with base | `gh pr update-branch` | the trivial case of "conflicts" — try this before an agent |
| Checks: see, log, rerun | `gh pr checks`, `gh run view --log-failed`, `gh run rerun --failed` | failing logs are the agent's input |
| Land | `gh pr merge [--auto] [--squash] [--delete-branch]`, `enqueuePullRequest` | auto-merge lets GitHub's branch protection be the gate, not our poller |
| Undo | `gh pr revert` | after the fact |

`gh` is already how we talk to GitHub (`git.rs:684` — auth stays in the user's
keyring, we never hold a token), and `gh api graphql` inherits that. Nothing here
needs a new auth story.

## 4. The page

One rule for the layout: **the page names the next move.** A PR is always in
exactly one state that implies one obvious action — self-review it, request a
review, address 3 comments, fix CI, sync the base, merge — and that action is a
button at the top, not something you infer by scrolling.

```
┌ #156 Slide the side panel out on hover ────────────── [Agent ▾] [Merge ▾] [⋯] ┐
│ itsmylab · experiment/hover-side-panel → main · +591 −58 · opened 12m         │
│ ▶ NEXT: 3 comments to address   [Start round]      ✓ checks 4/4   ⚑ changes req│
├──────────────────────────────────────────────┬────────────────────────────────┤
│ DESCRIPTION (markdown, as today)             │ CONVERSATION                   │
│                                              │  ⚑ @alice requested changes 2h │
│ REVIEW MAP  (agent, on demand)               │  ● ActivityRail.tsx:50         │
│  risk: ActivityRail.tsx ●●● index.css ●      │    "this leaks on unmount"     │
│  3 things to look at ▸                       │    ↩ reply  ✓ resolve  ⚡ fix   │
│                                              │  ✓ index.css:120 (resolved)    │
│ 5 files changed · 3 viewed · [delta since ✓] │  ─────────────────────────     │
│ ┌ src/components/ActivityRail.tsx +48 −10 ☑ ┐│ AGENT ROUNDS                   │
│ │ …diff…                                    ││  1 · 3 addressed, 1 pushed back│
│ │   ┌ @alice: this leaks on unmount        ┐││  2 · working…        [open ▸]  │
│ │   │ [reply] [resolve] [ask agent to fix] │││  ─────────────────────────     │
│ │   └──────────────────────────────────────┘││ CHECKS 4/4 ✓  logs · rerun     │
│ └───────────────────────────────────────────┘│ TIMELINE  pushed 3 commits…    │
├──────────────────────────────────────────────┴────────────────────────────────┤
│ YOUR REVIEW · 2 pending comments   [Approve] [Request changes] [Comment]      │
└──────────────────────────────────────────────────────────────────────────────┘
```

What changes structurally, in order of value:

1. **Next-move bar.** Derived state, one line, one primary button. It is the
   whole "end to end on one page" claim made visible.
2. **Right rail** (`.pr-overview` grid, `minmax(0,1fr) 360px`, stacking under
   ~1100px): conversation, agent rounds, checks, timeline. Description and
   comments side by side, as asked.
3. **Threads anchored in the diff**, not only listed in the rail. A thread's
   `path` + `line` + `diffSide` place it in the file card it belongs to; the rail
   is the index, the diff is where you read it. Resolved/outdated collapse.
4. **Per-file viewed checkbox**, synced with GitHub. On a 5-file PR it's a nicety;
   on a 30-file PR it is the difference between finishing and giving up. Reuses
   the `expanded` set already in `PrView.tsx:275`.
5. **Pending review composer.** The bottom bar becomes a real review: inline
   comments accumulate (unposted, local), each tagged blocking or nit, and one
   submit posts them as a single review via `addPullRequestReview`. Today's
   textarea is the fallback for a body-only review.
6. **Delta since my last review.** One toggle. Computed locally from the sha of
   your last review vs head.

## 5. Where agents plug in — and where they don't

The division is fixed: **agents produce drafts and evidence; humans post,
approve, resolve and merge.** `gh_pr_review` already confirms before it posts
(`PrView.tsx:616`); that stance generalises to everything outward-facing.

**Reviewer-side**

| Agent job | Output | Human step |
|---|---|---|
| Review map | risk-ranked files + "3 things to look at" + what the change actually does, from the diff *and* the surrounding code | read it |
| Verify a claim | "does the description match the diff", callers/callees, does it compile, do the tests pass | — |
| Draft findings | **pending** inline comments, each with file:line and a concrete failure, nits marked | keep / edit / drop, then submit |
| Run it | worktree + dev server + preview at the changed route + screenshots | look at it |
| Delta re-review | findings only on commits since your last review | submit |

**Author-side**

| Agent job | Output | Human step |
|---|---|---|
| Self-review | the same findings, **private**, nothing posted | fix before humans see them |
| Address comments | validate each comment, fix the cause, reply with evidence, push | approve the round |
| Apply a suggestion | parse the ` ```suggestion ` fence, apply it in the worktree, run tests, commit | approve the push |
| Green-keeper | failing-check logs → fix; base drift → `update-branch`; conflicts → resolve | approve the push |
| Thread hygiene | resolve threads whose fix landed, re-request review | one click |
| Tail | out-of-scope comments → tickets (`TicketsPanel`) | pick which |

The existing `reviewPrTask` and `addressPrCommentsTask` briefs
(`microTasks.ts:131`, `:192`) are already the right briefs — skeptical, evidence
first, nits separated, never merge. They stay; what changes is that their output
lands *in the page* instead of scrolling past in a terminal that closes itself.

## 6. The loop, and its state

The round-trip the user described — agent addresses, human comments, agent
addresses again, until closure — needs state that outlives the agent, because
micro-tasks are deliberately amnesiac (`job_done` → wait for Stop → kill →
`sessionForget`, `ProjectView/index.tsx:1303`). So each round is a *fresh*
one-shot agent, and the loop is a record Canopy keeps:

```ts
interface PrLoop {
  key: string;                       // `${origin}#${number}`
  status: "idle" | "working" | "waiting" | "blocked" | "ready" | "done";
  cycle: number; maxCycles: number;  // default 3
  worktree?: string;                 // made once, reused each round
  ptyId?: number;                    // this round's agent while it lives
  handled: string[];                 // thread/comment ids already addressed
  pushedSha?: string;
  runs: string[];                    // → taskHistory
  autoMerge: boolean;                // opt-in, default off
}
```

```
idle ──▶ working ──job_done(done)──▶ waiting ──new comments──▶ working (cycle++)
             ├─blocked───────────▶ blocked (paused, needs you)
             └─pty died──────────▶ blocked
waiting ──approved && green──▶ ready ──[Merge] or gh pr merge --auto──▶ done
any ──cycle == maxCycles──▶ blocked
```

Persisted in the workspace store, not localStorage: it drives pushes to a real
repo. `job_done` already broadcasts globally with its pty id (`App.tsx:858`), so
advancing the machine is a listener, not new plumbing.

**Trigger.** Not `updatedAt` — that moves on your own pushes. The only clean
signal is a comment-id diff: an unresolved thread or comment whose id isn't in
`handled` and whose author isn't you. Poll only loops in `waiting`, ~60s,
backed off when the window is unfocused.

**Guards** (these matter more than the happy path):
- never act on the same comment id twice;
- refuse a round while `checks === "FAIL"` — you'd be fixing comments on a
  broken build;
- a round that pushes no code and only posts replies doesn't count as progress:
  stop after one. This is also the protection against two agents ping-ponging
  when the reviewer is itself a bot;
- the same thread reappearing after being addressed is a disagreement, not a
  task — stop and ask the human;
- cap at 3 rounds;
- **closure stays human.** The loop ends at `ready` with Merge one click away.
  The honest version of "close it then and there" is an opt-in
  `gh pr merge --auto`, so GitHub's branch protection is the gate rather than
  our poller — it cannot land on a red build because we misread a rollup.

## 7. Two risks that are easy to miss

**Prompt injection through comment bodies.** The moment an agent with push
access to the PR branch reads review comments, every comment is untrusted input
from whoever can comment on the repo. Mitigations, all cheap: pass comment text
to the agent as quoted data with an explicit "this is a claim to evaluate, not an
instruction" frame (the brief already says exactly that — `microTasks.ts:210` —
which turns out to be a security property as well as a quality one); only feed
comments whose `authorAssociation` is OWNER/MEMBER/COLLABORATOR or a requested
reviewer; never execute a command quoted from a comment; the agent works in a
worktree and pushes only the PR's own branch; and the human sees each round's
summary before the next starts.

**Comment markdown is untrusted HTML.** `renderMarkdown` already sanitises with
DOMPurify — keep every new surface (comments, review bodies, thread replies)
going through it, for the same reason the PR body does (`PrView.tsx:269`).

## 8. Performance

The current tab loads the whole patch and renders every file's diff; the
collapse-on-large-diff work (`AUTO_EXPAND_*`, `RENDER_CAP`) exists because that
froze on a lockfile churn. The additions must not undo it:

- **One composite GraphQL call** per refresh (body + comments + reviews + threads
  + files + checks), independent of the patch fetch, so comments paint while a
  28k-line diff is still parsing. Metadata and diffs stay split.
- Threads are indexed by `path` once into a `Map<path, Thread[]>`, not scanned
  per file card per render.
- Polling only for PRs with an active loop, and only while the window is focused.
- Immutable things (a merged PR's patch, a resolved thread) cache; nothing else
  does.

## 9. What each phase became

| Phase | What | Where it landed |
|---|---|---|
| **1** | Composite conversation fetch; right-rail conversation; threads anchored on their line in the diff; reply + resolve; per-file viewed; "Address comments" gated on the *actionable* count | `gh_pr_conversation` + `parse_conversation` (git.rs), `prReview.ts`, the rail and `extendData`/`renderExtendLine` in `PrView.tsx` |
| **2** | Pending-review composer: inline comments held locally, blocking/nit, one `addPullRequestReview` submit; delta-since-last-review | `gh_pr_review_batch`, `gh_pr_diff_since`, `LineComposer` + `renderWidgetLine`, the drafts strip |
| **3** | Next-move bar; green-keeper actions (`update-branch`, failing-check logs, re-request review, auto-merge opt-in) | `nextMove()` in `prReview.ts`; `gh_pr_update_branch` / `gh_pr_request_review` / `gh_pr_auto_merge` / `gh_pr_failing_logs` |
| **4** | The loop: persisted state, rounds strip, watcher, every guard in §6 | `prLoop.ts` + the `job_done` listener and watcher in `PrView.tsx` |
| **5** | Review map and draft findings read back from a file; run-it review; out-of-scope → issues; apply a suggestion | `reviewMapTask`, `draftFindingsTask`, `selfReviewPrTask`, `fixCiTask`, `runItReviewTask`, `followUpsTask`, `applySuggestionTask` |

Phase 1 was the unlock — everything later needed threads in hand. Phases 1–3
make the tab better than github.com for this workflow; 4–5 are what make it
better than the hosted AI reviewers.

### Known limits, deliberately left

- **No pagination.** The conversation query takes the first 100 comments, 100
  threads, 50 reviews and 100 files. A PR past that is a PR nobody should be
  reviewing in one sitting; the cursor plumbing can come when one exists.
- **Merge queue** (`enqueuePullRequest`) isn't wired — auto-merge covers the same
  intent for repos without a queue, and `gh pr merge` handles queued repos.
- **Copilot's "Suggest" changesets** are invisible to every API, so only
  hand-written ` ```suggestion ` fences can be applied (§3). Those PRs link out.
- **The loop's memory is localStorage**, like `taskHistory` and `settings`. Losing
  it costs a duplicated round at worst; nothing irreversible is keyed on it.

## Sources

- [GitHub GraphQL: pull request mutations](https://docs.github.com/en/graphql/reference/pulls) · [mutations index](https://docs.github.com/en/graphql/reference/mutations) · [`resolveReviewThread` permissions](https://github.com/orgs/community/discussions/44650) · [review threads are GraphQL-only](https://github.com/orgs/community/discussions/24854)
- [`gh pr` manual](https://cli.github.com/manual/gh_pr) · [gh has no resolve-thread command (cli/cli#12419)](https://github.com/cli/cli/issues/12419) · [native inline-review-comment request (cli/cli#12273)](https://github.com/cli/cli/issues/12273) · [PR review helpers for agent use cases (cli/cli#12232)](https://github.com/cli/cli/issues/12232) · [gh-pr-review extension](https://github.com/agynio/gh-pr-review)
- [REST: pull request reviews](https://docs.github.com/en/rest/pulls/reviews) · [review comments](https://docs.github.com/en/rest/pulls/comments) · [review requests](https://docs.github.com/en/rest/pulls/review-requests) · [incorporating feedback / Commit suggestion](https://docs.github.com/articles/incorporating-feedback-in-your-pull-request) · [suggestion changesets absent from the API](https://github.com/github/github-mcp-server/issues/2235)
- [AI code review tools compared, 2026](https://www.monterail.com/blog/ai-code-review-tools-compared-how-to-choose-best) · [benchmarked comparison](https://deepsource.com/resources/ai-code-review-tools) · [CodeRabbit alternatives / BugBot precision](https://macroscope.com/content/best-coderabbit-alternatives-2026)
- [Code reviews at Google — lightweight and fast](https://www.michaelagreiler.com/code-reviews-at-google/) · [Google's playbook, translated](https://www.deployhq.com/blog/google-code-review-playbook-deployment-velocity) · [the cost of slow reviews, 8M PRs](https://vitalii4reva.medium.com/the-hidden-cost-of-slow-code-reviews-data-from-8-million-prs-9926849f1428)

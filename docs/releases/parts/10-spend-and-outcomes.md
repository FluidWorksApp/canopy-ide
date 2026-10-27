## Spend and outcomes: see whether agent work is paying off

**What you see**

- **Budgets on every agent tab.** Next to an agent's cost in its tab header there
  is now a budget button. Click it to set a dollar budget for that session, or
  write "Budget $5" anywhere in a prompt. A plan's budget applies to the
  session working on it. At 80% the button turns amber and Canopy tells you.
  At 100% Canopy pauses the agent: it presses Esc in the agent's terminal (the
  same thing you would do), and asks you to raise the budget. Nothing is lost.
  Raise the budget and tell the agent to continue. If Canopy cannot reach the
  agent's terminal, you get a clear "over budget" notice instead.
- **Prototype sessions have a cap.** Agent sessions in Build (prototype)
  projects stop at $10 by default when no other budget applies, so a prototype
  left running overnight cannot run up a large bill. You can change or remove
  the cap in Settings.
- **A new Outcomes panel** (chart icon in the side rail, in the Work group)
  shows what agent work in this repository cost and what came of it:
  - total agent spend, and **cost per merged change**;
  - **receipts proven**: the share of proof receipts that came back "proven";
  - **reverted**: sessions whose files were later undone with `git revert`;
  - **reworked in a week**: sessions whose files another session edited again
    within 7 days;
  - **time in review**: how long PRs raised by agents waited between being
    opened and being merged;
  - a breakdown by task class, CLI, person or week, spend by week, spend by
    plan, and what Canopy's own brain features cost.
- **The brain's weekly insight** sits at the top of the panel. For example:
  "Dependency bumps: 14 proven, 0 reverted. Consider auto-merge. UI features:
  40% reworked within a week. Require plans." It is listed as what's working,
  what to watch, and what to try.

**When the brain is used**

- Only for the weekly insight (feature `outcomes`, on the brain's cheaper
  background model). Canopy asks at most once a day per repository, skips the
  call when the numbers have not changed, and asks again when you press
  Refresh. The brain sees totals and rates only. It never sees code, file
  names, prompts or PR titles.
- Budgets, spend records and every number in the panel are counted without
  the brain.

**Privacy**

Everything is counted on your computer from the project ledger, your
checkout's git history and Canopy's record of which session raised which PR.
Nothing is sent to Canopy.

**How to turn it off**

Settings → Agents has four new items next to "CLI updates":
- **Session budget**: a default budget for every session (empty means none).
- **Prototype session cap**: empty means none.
- **At the budget**: turn off "Pause the agent" if you only want warnings.
- **Spend & outcomes**: turn off "Let the brain write a weekly insight" to
  see the numbers without the brain's summary.

**Known limits**

- Spend is saved at the end of each agent turn. That is the closest thing to
  "the session ended", because a session can always take another prompt.
- A PR counts as merged once your checkout has its merge commit
  ("Merge pull request #12" or a squash commit ending in "(#12)"). A rebase merge
  that leaves no PR number in any commit is not detected.
- "Person" is the CLI account that ran the session, because the ledger is
  kept on each computer.

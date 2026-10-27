## Rules your agents can't ignore

Write a rule in plain words — "Never touch the migrations folder", "Don't install moment", "Ask before publishing to npm" — and Canopy turns it into a check it runs **before** an agent's action, not a line in a file the agent may skip.

**What you see**

- **Agent instructions → Rules & gates.** Each rule shows exactly one badge: **Enforced**, **Needs your approval**, **Suggestion only**, or **Guidance**, plus who it applies to (this project or your team) and how many times it has blocked an agent.
- **Compile.** When you add an enforced rule, the brain reads it (and can look around the repository to find the real folder names) and proposes a gate from a small, fixed menu: protected paths, blocked commands, protected tests, allowed or banned packages, allowed hosts, or "ask a person first". You see it as a sentence — "Agents can't create, change or delete files matching migrations/" — can edit its values, and nothing is enforced until you click **Approve gate**. If no mechanical check could enforce a rule ("write clear names"), the brain says so and it is labelled **Suggestion only**.
- **Blocked actions, in the agent's terminal.** When a rule stops something, a card appears over that agent's terminal: "Canopy blocked: this changes a protected file (migrations/0003.sql) — team rule 'Never touch migrations/'", with **Allow once** and **Edit rule**. The agent is told the same, in the rule's own words, and asked not to work around it.
- **Things that can't be undone always ask you.** Dropping database data, deleting folders outside the project, force-pushing main or a release branch, `git reset --hard` over uncommitted work, deleting volumes or buckets, `terraform destroy`, production deploys and moving money (Stripe, payment APIs) are paused for every agent, rule or no rule. You get a question with **Approve once** / **Deny**; approving lets that exact command run once, within 10 minutes, and tells the agent to go ahead. The undo-turn timeline marks a turn that ran one of these **can't be undone**.
- **Untrusted web content.** Once a session has fetched web pages, Canopy can keep secrets (`.env` files, saved passwords) and outbound writes (`git push`, POSTs, GitHub writes) away from it for the rest of that session. Default: warn only. Switch to **Block** in the Rules panel.
- **Shrink your instruction files.** Next to each project instruction file (CLAUDE.md, AGENTS.md, …) is **Suggest which lines should become enforced gates**. The brain picks out the hard rules; adding one creates the rule (ready to approve) and can remove that line from the file.
- Guidance rules (and rules waiting for approval) are given to agents as a short list when a session starts, instead of growing an instruction file.

**When the brain is used.** Only when you click **Add and compile** / **Compile** / **Recompile**, or **Suggest which lines should become enforced gates** — feature `gates`, main tier, one call each. Enforcement itself never calls the brain: the hook checks each tool call against the approved gates locally, in a few milliseconds, even when Canopy isn't open.

**Where it works.** Enforced in Claude Code sessions on your computer and in Linux cloud workspaces (the approved rules are written into the workspace, where its hook runs), and in Antigravity. Other agent CLIs get the rules as guidance: their hooks can't refuse a tool call yet. Host and shell-path checks are best effort — they read the command line, not everything a program might do.

**How to turn it off.** Delete or **Pause** a rule, or switch it to **Guidance**. The untrusted-content rule defaults to warn-only. The irreversible-action check is always on by design; each one costs a single click to approve.

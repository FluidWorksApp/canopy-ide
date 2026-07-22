# Canopy v0.2.4

**Start a project from a git URL, review pull requests that actually render, and a git surface that stops leaking its own plumbing.**

## Clone a repo straight into a project

- When you create a project, you no longer have to clone by hand first. Paste a **git URL** and hit **Clone** — pick where it lands, and the cloned working tree is added as a directory like any other, with its own file tree, terminals and run commands. It uses your existing git credentials (helpers / SSH keys); nothing new to configure, and a private URL that needs auth fails with git's own message instead of hanging.

## Pull requests you can actually read

- **Rendered descriptions.** A PR body now renders as markdown — headings, tables, code, links — instead of raw `##` text. It goes through the sanitizing renderer, since a PR body is authored by whoever opened it.
- **Big diffs don't freeze the app.** Opening a large PR used to peg the CPU and stick on "Loading diff…" while it tried to syntax-highlight tens of thousands of lines at once. Now files collapse by default on large PRs, each diff mounts only when you expand it, highlighting is skipped on big files, and lockfile-scale files are left to open on GitHub. Small PRs still open fully inline. A summary bar adds Expand / Collapse all.

## A git surface that reads like a human wrote it

- **Branches panel: one row per branch.** No more `main`, `origin/main`, and a bare `origin` all listed for the same thing. Local and remote fold into a single row that says, in plain words, whether it's **not pushed**, **on GitHub** (click to check it out), or in sync. The current branch pins to the top.
- **Loose ends: real cleanup.** You can now delete a merged branch — per row, or a **Clean up N** bulk button — and integration branches (main, develop, and the repo's base) are never offered for deletion, however "merged" they read. It only ever removes branches whose commits already live on the base.

## Under the hood

- The release script opens the release PR itself now, instead of pushing a branch and leaving you to open the PR by hand.
- README: Windows notes and refreshed screenshots.

---

*Local-first as ever — no server, no account, no telemetry.*

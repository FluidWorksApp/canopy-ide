# Canopy v0.2.8

**The Agent Workspace now always shows the session that's actually in front of you — never a stale one from a previous run — and the phone terminal reads like a phone.**

## Agent Workspace — the right session, every time

- **No more "No changes by this agent" on an agent that's clearly working.** Opening an agent's workspace could bind to a *different, already-ended* session that happened to reuse the same terminal slot from an earlier launch — so you'd see that dead session's files (or none) instead of the live agent's real diff. The workspace now identifies the session by who is genuinely running in the terminal, so its journal, commits and diff are the ones you're looking at.
- **Survives restarts and restores.** Terminal slot numbers get reassigned every time the app relaunches, which is exactly what used to cause the mix-up. The workspace now binds by session identity — from the live agent's own events, and from the resume command that names the session outright — so a resumed conversation resolves correctly even before it emits its first event, whatever slot it lands in.
- **Fails safe instead of guessing.** In the rare case where a session can't be identified yet, the workspace shows an empty, repo-scoped view rather than confidently attaching an unrelated session's changes.
- **The "This agent" pane now actually draws its diffs.** Each journaled edit is shown as a real before/after diff — the cards were rendering blank; they now paint like every other diff in the app, superseded edits included.
- **A file's edits read as one real diff.** Instead of a stack of fragments each numbered from 1, the agent's edits to a file are stitched into a single diff with real line numbers, gaps between edits, and GitHub-style expand-context controls to reveal the surrounding lines.

## Review the diff and send comments to the agent

- **Comment on any line, route it to the agent.** Hover a line in any diff pane, click the "+", and leave a comment. Comments collect as drafts (with checkboxes) and persist across closing the workspace; when you're ready, send the selected ones — or all of them — to the agent as a single review. It's typed into the agent's live terminal, or the session is resumed first if it had ended.

## Remote portal — a terminal that fits your phone

- **Long lines wrap instead of running off-screen.** The phone terminal used to shrink the whole grid to cram a desktop-width layout onto the screen, dropping text to an unreadable size. It now holds a legible font and fits the grid to the device, so output soft-wraps down the screen and stays readable.
- **Your desktop shell is left alone.** The portal sizes only its own view — it no longer reshapes the shared PTY, so viewing an agent from your phone can't reflow the same session on your desktop.

---

*Local-first as ever — no server, no account, no telemetry. Team and remote sessions run on your own machine and only leave your network when you explicitly open a public link.*

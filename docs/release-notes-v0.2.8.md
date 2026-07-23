# Canopy v0.2.8

**The Agent Workspace now always shows the session that's actually in front of you — never a stale one from a previous run.**

## Agent Workspace — the right session, every time

- **No more "No changes by this agent" on an agent that's clearly working.** Opening an agent's workspace could bind to a *different, already-ended* session that happened to reuse the same terminal slot from an earlier launch — so you'd see that dead session's files (or none) instead of the live agent's real diff. The workspace now identifies the session by who is genuinely running in the terminal, so its journal, commits and diff are the ones you're looking at.
- **Survives restarts and restores.** Terminal slot numbers get reassigned every time the app relaunches, which is exactly what used to cause the mix-up. The workspace now binds by session identity — from the live agent's own events, and from the resume command that names the session outright — so a resumed conversation resolves correctly even before it emits its first event, whatever slot it lands in.
- **Fails safe instead of guessing.** In the rare case where a session can't be identified yet, the workspace shows an empty, repo-scoped view rather than confidently attaching an unrelated session's changes.

---

*Local-first as ever — no server, no account, no telemetry. Team and remote sessions run on your own machine and only leave your network when you explicitly open a public link.*

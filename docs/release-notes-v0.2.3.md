# Canopy v0.2.3

**Ship and review from inside Canopy** — the GitHub PR panel grew real merge actions, agents now report a true lifecycle, and files move over the team relay even behind NAT.

## Pull requests, end to end

- **See what a PR actually is.** Every PR row now shows its `head → base` branches and when it was raised (relative age, with the exact timestamp on hover) — no more opening GitHub to find out.
- **Know if it's really mergeable.** CI checks roll up to a single passing / failing / running state with a "3/4 checks passed" tooltip, plus a conflict flag, so "approved, ready to merge" means it.
- **Merge without leaving the app.** Squash, merge commit, or rebase — plus **Close** and **Mark ready** for drafts. Every one is outward-facing, so it's always confirmed, and the merge dialog warns on conflicts, failing checks, or requested changes.

## Agents that tell you what they're doing

- **A real lifecycle.** Sessions report **working / waiting / idle / ended** straight from their hooks, so the panel shows a state dot (only *working* pulses) instead of guessing from a stale process — plus a tally of subagents that finished this turn.
- **Answer permission prompts from the panel.** Approve or deny a Claude/Codex permission prompt without switching tabs — Deny sends Escape, which can never miscount into "yes, don't ask again".
- **Auto-hibernation (off by default).** Over a per-project cap, the stalest *finished* agents (never one mid-turn) get their terminal reclaimed to free memory; each stays resumable from **Restorable**.

## Team relay: send files, not just messages

- **Direct-first file transfer.** Send a file to a teammate over the relay; it tries a direct peer link and, when NAT blocks that, tunnels through the relay host. Each chunk is ChaCha20-Poly1305 sealed and SHA-256 checked on arrival, with backpressure so a slow disk throttles the network instead of ballooning memory.
- **Collaboration visibility.** Clearer indicators for what's shared and who's following, with tab-UX polish across live sessions.

## Reliability

- **A crash can't black out the whole app.** A render error is now caught by an error boundary that shows a recoverable "Reload this panel" fallback — your terminals, sidebar and status bar keep running — and reports the cause to the log instead of leaving a blank window.
- **Restorable sessions behave.** "Forget" now sticks (a forgotten agent session stops resurfacing unless it's genuinely used again), and resuming an already-open session focuses its tab instead of stacking duplicates.
- **Run tabs stop lying.** A restarted run can no longer flash a red "failed" while its dev server is happily running.

---

*Local-first as ever — no server, no account, no telemetry.*

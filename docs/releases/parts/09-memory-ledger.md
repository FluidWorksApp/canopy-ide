## Team memory you can audit

Canopy now keeps a **team memory**: the decisions, constraints, conventions and facts your agents should know, each with who recorded it, the session it came from, who it applies to, and when it stops being trusted.

**What you see**

- A new **Team memory** icon (a bookmark) in the left rail, beside Research. Its badge counts entries waiting for your review.
- After an agent finishes work, the brain reads what was asked, the agent's final message and the files it changed, and suggests up to three things worth remembering — for example *"Tenant isolation uses Postgres row-level security, not app checks — because app checks were missed twice."* Most turns teach nothing durable, and then nothing is suggested.
- Each entry shows, in plain language: what to remember and why, who it applies to (just you, this project, the whole team), who noticed it and in which session (with a link back to that terminal while it is open), how old it is and when it expires.
- **Approve**, **Edit**, **Reject**, **Reconfirm** (keeps it for another full period) and **Expire now**. Filter by kind or audience, search, or switch between *To review*, *In use* and *All*.
- **Quarantine.** If the session had read something from outside the team — a web page, the browser, a tracker ticket, pull request comments — its suggestions are marked *Quarantined*, say what was read, and need a deliberate **Approve anyway**. Text from outside can try to plant instructions; nothing quarantined is ever shown to an agent.
- **Contradictions.** When a new suggestion disagrees with something already approved, both entries say so ("Contradicted by session 77bb1234") and you can **Approve and replace** the old one in one click. Entries close to expiry ask **Reconfirm?**.
- Agents check team memory before deciding something durable, using a new `canopy_memory` tool that only ever returns entries a person approved and that have not expired. They can suggest an entry with `canopy_memory_propose`; it lands in your review list and is never approved automatically.
- Optional: **Update the instruction file from approved memory** writes a short, clearly marked "Team memory" section into your project's AGENTS.md / CLAUDE.md. Nothing outside the markers changes, and personal entries are left out.

**When the brain is used**

- After agent turns, on the background tier: at most once per agent session every 10 minutes, plus once when the session ends, covering everything since the last time.
- One extra background call when a new suggestion shares its topic with an approved entry, to check for contradictions. No overlap, no call.
- No brain connected, signed out or over budget: nothing new is suggested, the panel says so in one line, and approved memory keeps working.

**Turning it off**

Settings → Agents → **Team memory**: switch off *Suggest team memory after agents work*, change how many days facts and decisions are trusted (90 and 180 by default), or choose *Don't learn from those sessions at all* to skip sessions that read outside content instead of quarantining them. The two agent tools can be switched off individually in Settings → Agents → tools.

## Every agent knows what every other agent just did

When several agents work on the same code at once, they used to find out about
each other's changes at merge time. Now Canopy tells them while they work.

**What you see**

- When an agent finishes a change, Canopy works out which of your other running
  agents it could affect: agents working in the same files, files they have
  claimed or edited in the last half hour, and files that use a function or type
  the change renamed or edited (when a language server is already running for
  that code). Agents in other worktrees of the same repository count too.
- Your brain reads the change and the other agent's task, and writes that agent
  a short note: what changed and why it matters to it. The note arrives in the
  other agent's terminal as a message from the Canopy workspace, naming the
  files. If the brain decides the change doesn't affect an agent, it sends
  nothing.
- You see it too: a notification like "Told Ben's agent: Ana's agent changed
  checkout.ts", with the note itself. A note flagged as a likely conflict comes
  through as a warning.
- **Hotspots.** Some files nearly every change passes through: route tables,
  registries, config, the app's wiring. Canopy finds them from the last 30 days
  of git history, from files agents have collided on before, and from file
  names. When two agents touch the same hotspot within half an hour, Canopy
  claims it for the agent that just edited it and warns both, so they stop
  writing the same file at once. This works even when no brain is connected.
- **Team board.** Agents page, **board** view: every agent running across your
  open projects, what each one is doing, its status, the files it holds and is
  touching, its latest receipt if there is one, and the last note it was sent.
  Below that: the full list of what agents were told, each repository's
  hotspots (with **Edit list** to set your own), and, after you press **Check
  now**, the agents running in your cloud workspaces.

**When the brain is used**

One background brain call per finished agent turn, and only when that turn
overlaps another running agent. All the overlapping agents are judged in the
same call. The same change is never judged twice. Calls are metered under the
`awareness` feature, so the daily and per-feature budgets apply.

**Turning it off**

Settings → Agents → **Tell agents about each other's changes**, or the switch
at the top of the board. Off means no notes, no hotspot claims and no brain
calls. To set a repository's hotspots yourself, use **Edit list** on the board.
Your list then replaces the inferred one.

**Limits**

- Desktop only for now. In a cloud workspace the board still shows what is
  running, but agents are not told about each other's changes.
- Teammates' cloud agents appear on the board, but Canopy can't see which files
  they are touching, so they don't get notes.
- Overlap is only found for agents whose CLI reports its edits to Canopy.
  Changes an agent makes through shell commands aren't seen.

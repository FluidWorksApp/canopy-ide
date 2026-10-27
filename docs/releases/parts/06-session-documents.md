## Sessions you can read, and hand to someone else

Every agent session can now be opened as a **document**. In an agent's tab, press **Open as document**; for a finished session, open **Agents → Past sessions** and press **Document** on its row.

The document shows:

- **Summary**, written by your brain: what the session set out to do, what it actually did, and where it stands now.
- **Goal**: the session's plan if one was made, otherwise the first thing you asked.
- **Timeline**: each turn's prompt, the files that turn changed, and its proof receipt (passed, failed, partly done) when one was filed.
- **Decisions and why**: what the agent chose, the reason, and the options it turned down.
- **Open questions**, next steps and risks.
- **Files changed**: every file the session edited, and how many of its edits are still in the code ("lines from this session"), plus any pull requests it opened.

**Hand off…** turns the session into a packet someone else can pick up: where the work stands, the decisions and their reasons, constraints, open questions, next steps, the files, the latest receipt, and how to resume. You see the whole packet, and can edit it, before it goes anywhere. Then you can:

- **Copy as markdown** to paste anywhere.
- **Send to a teammate** in team chat. It arrives as a hand-off card. The teammate presses **Take over** and starts an agent of their own from it, in the project they choose.
- **Continue in a new agent**: start a fresh agent from the packet, on your brain's CLI or any other one you have installed. The agent checks the code against the packet before it changes anything.
- **Resume the original session** with the CLI's own resume, from the past-sessions list.

**Private by default.** Only you can see a session document. Nothing is shared until you choose where the packet goes, and team chat shows you the exact message first, with a warning if anything in it looks like a password or token. Packets you write are saved privately in the project's history.

**When the brain is used**

- The summary is written in the background, with the cheaper model, the first time you open a session's document and again after each new turn. Reopening a document with no new turns costs nothing. **Refresh** rewrites it on demand.
- The hand-off packet is written with your main model, and only when you press **Write hand-off packet**.
- With no brain connected, signed out, or over budget, the document still shows every fact from Canopy and says in one line why there is no summary.

**Settings → Agents → Session documents**

- **Write a summary when a session document opens** (on by default). Turn it off and summaries are written only when you press **Write summary**.
- **Add Agent-Session trailers to commits** (off by default). When it is on, commits made from the Changes panel get an `Agent-Session: <agent>/<session id>` line for each agent session whose edits they contain, so a line of code can be traced back to the conversation that wrote it.

Working on a session live with a teammate is still done through **Shared sessions** in a cloud workspace. The document links to it there.

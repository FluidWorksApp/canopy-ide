# Canopy v0.2.6

**Drive your agents from your phone, and see exactly what each one changed — even when they share a checkout.**

## Canopy Remote — your agents, from a phone browser

- **Open a browser, run your agents.** Canopy now serves a control panel you can reach from your phone: watch every running agent live, read its terminal, type into it, answer its questions, and start new ones — without touching your desk. It's an embedded server that reuses the same commands the desktop app does, so what you see remote is what's really happening locally.
- **Pair in seconds, share only when you mean to.** A PIN and a QR code pair a device on your own network; a one-click public link (with a tunnel picker) opens it beyond it when you want, and a scope toggle keeps it to a single project or across everything. Liveness is robust now — agents no longer read as offline while they're clearly working.
- **Spawn agents remotely.** Start a new agent from the phone and it runs headless on your machine, then **attaches to a real desktop tab** the moment you're back — no orphaned sessions. Offline agents keep their history and can be resuscitated from the same list.
- **Built for the small screen.** A mobile-first redesign, a display-only terminal with one clean input, and tightened settings (PIN/QR sizing, connect address, copy/refresh) make it usable one-handed.

## Agent Workspace — who did it, and what they changed

- **The workspace always matches the agent in the terminal.** It now reads identity from the live process, so opening a Codex terminal shows *Codex* — never a leftover Claude session that happened to reuse the terminal. The workspace button and its full branch/diff/commit/PR view appear for **every** agent CLI now, not just the ones that report through hooks.
- **See only the changes that agent made — even on a shared checkout.** Git can't tell whose uncommitted edit is whose when several agents share one checkout, so Canopy records it: every edit an agent makes is journaled as it happens, keyed to that terminal. A new **"This agent"** view shows just that agent's own hunks — and when two agents touch the same file, each edit is honestly flagged *live* or *superseded*. The shared working tree is still there, split into this agent's files and a folded "other changes in this checkout."
- **No pile-up.** The per-agent change log is a sidecar of the session; forgetting a session removes it too. Works for every hooked CLI — Claude Code, Codex, OpenCode, aider, oh-my-pi.

## Keep your CLIs current, the right way

- **Updates that match how you installed.** Agent-CLI update commands now route by install source rather than a hardcoded registry — a Homebrew-managed CLI upgrades with `brew`, and everything else falls back to the CLI's own updater. The version badge points you at the command that will actually work.

## Smoother from the first launch

- **Install missing prerequisites in one click.** Canopy detects when Git or Node/npm aren't present and offers to install them for you, on every platform, so a fresh machine gets to a working agent faster. Docs cover the prerequisites for macOS, Windows and Linux.
- **A calmer tab strip.** Agent tabs now carry a single status dot instead of a second tiny per-agent glyph — less noise, the same at-a-glance state.

## Fixes

- **Dictation runs everywhere, on one path.** A single unified ONNX Runtime strategy across macOS, Windows and Linux (Intel and ARM), with the Intel-Mac and Linux/ALSA build paths sorted and the Windows ONNX packaging fixed in CI.
- An empty dictation model id now resolves to the default instead of reading as "Unknown model".
- The Intel-Mac release build no longer breaks on an invalid config comment.

---

*Local-first as ever — no server, no account, no telemetry. Canopy Remote runs on your own machine and only leaves your network when you explicitly open a public link.*

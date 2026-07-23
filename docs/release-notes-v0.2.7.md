# Canopy v0.2.7

**Voice dictation that loads in a second instead of hanging, team sessions on one endpoint, and an agent workspace you can read at a glance.**

## Voice dictation — fixed, fast, and honest about hardware

- **Press ⌘D and it just transcribes.** Dictation used to stall on "Starting dictation…"; it now loads its on-device model in about a second and drops the text at your cursor — a terminal, the editor, a commit message, an agent prompt. Under the hood it moved to ONNX Runtime 1.24, which clears a startup deadlock in the previous runtime.
- **It can't hang anymore.** The one genuinely slow step — loading a several-hundred-MB speech model on first use — is now time-bounded, so a wedged load surfaces as a clear, actionable error instead of an endless spinner.
- **Intel Macs get the IDE, not a broken feature.** There's no compatible on-device speech runtime for Intel macOS, so those builds ship *without* dictation rather than a version that can only fail — the Settings tab and the hotkey hide themselves there. Apple Silicon, Windows and Linux keep full dictation.

## Team sessions, on one endpoint

- **Relay and remote now share a single door.** Hosting a teammate and reaching your own agents from a phone travel the same server endpoint over WebSocket — one LAN URL or tunnel, two PIN-gated routes. The old QUIC transport is retired, which makes public links and tunnels (Cloudflare, ngrok) behave predictably.
- **Join over a link.** Internet team sessions ride the shared endpoint, so a teammate joins straight from a link — no separate transport to punch through.

## Agent Workspace — the whole session at a glance

- **A full-screen view from a right-edge handle.** Open any agent into a glass overlay that shows just its work: its branch and worktree, uncommitted diff, the commits it added, and the files it touched — with formatted file-card headers instead of bare paths.
- **Now with the numbers.** The workspace surfaces each agent's tokens, cost, turns, model and live state, with honest counts, a single banner, tidier actions, and an evident close button. On a shared checkout it still shows only that agent's own changes.

## About, support & legal

- **A proper About dialog.** A new About window with Terms, Privacy and Support links, plus a Support item in the Help menu — so getting help or reading the policies is one click, not a hunt.

## Smaller touches

- **Remote from your phone, steadier.** The remote portal's session no longer expires after 12 hours, its terminal is legible on a phone instead of shrinking to a few pixels, and your Reach + tunnel-provider choice persists between sessions.
- **Busy shells stay open.** A shell doing real work no longer auto-closes out from under you.
- **A clearer pane bar.** The active shell/run rail expands and takes precedence, and inactive tab sections dim so the active one is unmistakable.
- **Tidier settings.** Dropped the Process-guard tab and the Opening-context option; one-line descriptions throughout.

---

*Local-first as ever — no server, no account, no telemetry. Team and remote sessions run on your own machine and only leave your network when you explicitly open a public link.*

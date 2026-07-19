<h1 align="center">Canopy</h1>

<p align="center">
  <b>A local-first, memory-light desktop IDE for driving code with agents.</b><br>
  Run Claude Code, Codex, Aider and friends in a first-class terminal — and see
  <i>what changed</i> and <i>what's running</i>, in one native window.
</p>

<p align="center">
  <a href="https://github.com/FluidWorksApp/canopy-ide/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/FluidWorksApp/canopy-ide?sort=semver&label=download"></a>
  <a href="./LICENSE.md"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey">
  <img alt="No Electron" src="https://img.shields.io/badge/no-electron-brightgreen">
</p>

<p align="center">
  <img src="docs/screenshots/session.png" alt="An agent running in a Canopy terminal, with a live panel showing every session in the project" width="900">
</p>

## What is Canopy?

Canopy is a desktop IDE built around a simple bet: the best interface for coding
with AI is the **agent's own CLI**, in a real terminal — not a chat box bolted
onto an editor. So Canopy makes the terminal first-class, then wraps it with the
two things a terminal can't show you on its own: **what changed** (live diffs
against git) and **what's running** (every agent session, its branch, its task,
its footprint).

It's **local-first and offline**: there's no server, no account, no telemetry.
Every native thing — terminals, language servers, file watchers — runs as a
child process of the app. And it's **light**: no Electron, no VS Code fork, no
extension host. The whole app, with several agents running, sits in a fraction
of the memory a browser tab would.

Built for people who let agents do the typing and want to stay in control of the
result.

## Highlights

- **Agent-native terminal.** Full TUI support — `claude`, `vim`, `htop`, `tmux`
  all just work. A launcher starts any agent CLI (Claude Code, Codex, Amp, Aider,
  Gemini, OpenCode, oh-my-pi) and offers an install command for the ones you don't have.
- **Diff-first.** When an agent edits a file under you, you get a side-by-side
  diff — never a silent reload. A git-backed Changes panel groups everything
  touched, by component.
- **Multi-project, multi-component.** Open several projects at once; each project
  spans as many labeled directories (frontend, backend, …) as you like, with
  search, terminals and git scoped per project.
- **Session awareness.** See every agent session across the project — its branch,
  the last thing you asked it, CPU/memory, and the port it's listening on.
- **A real editor.** Monaco with TypeScript diagnostics, plus native viewers for
  Markdown (incl. Mermaid), HTML, PDF, spreadsheets, Jupyter notebooks and images.

## A closer look

**Start however you want to work.** Open a project and pick a plain shell or any
agent CLI — Canopy never hands you a terminal you didn't ask for.

<img src="docs/screenshots/launcher.png" alt="The launcher grid: Shell, Claude Code, Codex, Aider, Gemini, and more" width="820">

**Review every change.** A built-in Git panel — branches, worktrees, PRs, and
staged/unstaged changes with side-by-side diffs. Commit without leaving the app.

<img src="docs/screenshots/git.png" alt="The Git panel with a side-by-side diff" width="820">

**Browse and edit alongside your agents.** The file tree spans every component of
the project; open files as sub-tabs next to the terminals running your agents.

<img src="docs/screenshots/files.png" alt="The file tree beside a running Claude Code session" width="820">

## Install

Grab the newest build from the [**releases page**](https://github.com/FluidWorksApp/canopy-ide/releases/latest):

| Platform | File | Updates |
|---|---|---|
| macOS (Apple Silicon / Intel) | `.dmg` | in-app auto-update |
| Linux | `.AppImage` | in-app auto-update |
| Linux | `.deb` / `.rpm` | via your package manager |

The macOS build is signed and notarized. Prefer to build it yourself? See below.

## Build from source

Prerequisites: **Rust** (stable) and **Node 20+**. For TypeScript language
features, either `npm i -g typescript-language-server typescript` or have them in
the opened project's `node_modules`.

```sh
npm install
npm run tauri dev      # development, with hot reload (or: npx tauri dev)
npm run tauri build    # production bundle (.app / installer)
```

The first `tauri dev` compiles the Rust core and takes a few minutes; subsequent
runs are fast and the frontend hot-reloads.

## Using Canopy

- **Projects are the entry point.** Create one (＋), name it, and add one or more
  labeled component directories. Projects persist in `~/.canopy/projects.json`.
  Open several at once — top tabs switch projects, and the side panel, terminals
  and file sub-tabs are all scoped per project. The File menu also offers explicit
  *Open Project…*, *Save Project As…*, and *Open / Save Workspace* for moving a
  setup between machines or committing it to a repo.
- **The terminal is the hero.** Opening a project opens the launcher rather than a
  bare shell. Pick a shell or an agent; the terminal starts `cd`'d into the
  project. ⌫ clears scrollback; ↺ hard-resets. Scrollback is capped (10k lines,
  configurable in `localStorage` `canopy.settings`).
- **Run commands** (per component, in project settings) launch into the **RUNS
  rail** — kept apart from shells because they're services, not sessions. Each
  reports real state: a pulsing dot while live, a green check when a one-shot
  finishes, or a red exit code when it fails.
- **Quick Open (`Cmd+P`) and Find in Files (`Cmd+Shift+F`)** search every
  component of the project by default; chips scope to a single component.
- **Diff-first.** A file changed on disk gives you a side-by-side diff — Accept
  disk version / Keep mine — never a silent reload. The Changes tab lists
  everything git sees as changed, grouped by component.
- **Agents tab.** Agent CLIs detected inside your terminals, with CPU/memory
  (runaway guard) and kill buttons, plus a file-based hook bridge: any CLI hook
  system can append JSON lines to `~/.canopy/agent-events.jsonl` and they show up
  live. Claude Code hooks install automatically at boot, and only fire for
  terminals Canopy spawned.

### Keyboard shortcuts

VS Code-standard where an equivalent exists. All scoped to the active window and
visible project — `Cmd+W` closes a tab, never the app.

| Shortcut | Action |
| --- | --- |
| `Cmd+P` | Quick Open file (fuzzy) |
| `Cmd+Shift+F` | Find in Files |
| `Cmd+N` / `Cmd+O` | New project / Open project folder |
| `Cmd+Shift+O` / `Cmd+Shift+S` | Open / Save workspace file |
| `Cmd+T` | New terminal |
| `Cmd+W` | Close tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Cmd+Shift+W` | Close project |
| `Cmd+B` | Toggle sidebar |
| `Cmd+Shift+Enter` | Focus mode (`Esc` exits) |
| `Cmd+Q` | Quit |

## Contributing

Contributions are welcome — issues, ideas, and pull requests. Canopy is a small,
readable codebase and a good project to hack on.

**Get set up:** follow [Build from source](#build-from-source) above, then run
`npm run tauri dev`.

**Before you open a PR,** these should all pass:

```sh
npm run typecheck    # tsc -b (the root tsconfig is solution-style; this is the real check)
npm run lint         # oxlint
npm run build        # tsc -b && vite build
cargo build --manifest-path src-tauri/Cargo.toml
```

**Where things live:**

| Path | What |
|---|---|
| `src/` | React + Vite frontend (components, IPC wrappers, editor) |
| `src-tauri/src/` | Rust core — `pty.rs`, `lsp.rs`, `fsx.rs`, `git.rs`, `agents.rs` |
| `src-tauri/src/bin/canopy_hook.rs` | the agent-hook helper (a second binary) |
| `packages/ui/` | shared UI primitives (`@canopy/ui`) |
| `scripts/` | sidecar build + release tooling |
| `SPEC.md` | the full product spec |
| `RELEASING.md` | how signed releases are cut |

**House style:** match the surrounding code. Comments explain *constraints and
why*, not *what* — the codebase leans on this heavily, and it's part of what
keeps it approachable. Keep native process ownership in Rust; the frontend never
spawns anything itself.

## Architecture

```
┌────────────────────────── Tauri (Rust core) ──────────────────────────┐
│  pty.rs     portable-pty sessions; reader+flusher threads per PTY;    │
│             batched raw-byte streaming over ipc::Channel; ack-based   │
│             backpressure; process-group kill on teardown              │
│  lsp.rs     LSP subprocesses over stdio; Content-Length framing       │
│             parsed in Rust; JSON messages over a Channel              │
│  fsx.rs     workspace registry (multi-root scope allowlist), fs       │
│             commands, notify watchers → fs:change events              │
│  agents.rs  sysinfo process-tree monitor → pty:stats; hook bridge     │
│             tail → agent:event                                        │
└──────────────────────────────┬────────────────────────────────────────┘
                        commands + channels/events
┌──────────────────────────────┴───────────────────────── WebView ─────┐
│  React + Vite. xterm.js fed directly from the channel — no output    │
│  buffered in JS. Monaco via @codingame/monaco-vscode-editor-api so   │
│  monaco-languageclient shares the same API instance; LSP transport   │
│  is a custom MessageReader/Writer over Tauri IPC.                    │
└───────────────────────────────────────────────────────────────────────┘
```

Design rules:

- **Rust owns all native processes** (PTYs, LSP servers, watchers). JS never spawns.
- **Raw bytes end-to-end** on the PTY path; no filtering or normalization.
- **Bounded memory**: xterm scrollback capped; the PTY reader pauses when the
  WebView is behind (ack window, default 2 MB) so the kernel backpressures the
  child instead of ballooning heap.
- **Clean teardown**: closing a tab kills the whole process group and reaps the
  child; app exit kills everything.

## Dependency justification

| Dependency | Why |
|---|---|
| `portable-pty` | cross-platform PTY (the terminal core) |
| `notify` | fs watching for the diff-first workflow |
| `sysinfo` | process-tree stats for the runaway guard / agent detection |
| `libc` (unix) | process-group SIGKILL on teardown |
| `@xterm/*` | terminal renderer + required addons |
| `monaco-editor` → `@codingame/monaco-vscode-editor-api` | monaco build compatible with monaco-languageclient 10.x |
| `monaco-languageclient` + `@codingame/monaco-vscode-standalone-languages` | LSP client + monarch grammars |
| `react-resizable-panels` | the three resizable panes |
| `marked` | markdown rendering (small, sync) |
| `mermaid` | diagram blocks in markdown (lazy-loaded) |
| `xlsx` (SheetJS, cdn dist) | spreadsheet parsing (lazy-loaded) |
| `@tauri-apps/plugin-dialog` | native folder picker |

## License

Canopy is open source under the [MIT License](./LICENSE.md) — free to use,
modify, and distribute, including commercially.

Third-party components keep their own licenses — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md). Notably, Canopy bundles
jschardet (LGPL-2.1-or-later) as a separately replaceable chunk.

Copyright 2026 Cause Connect Pte Ltd.

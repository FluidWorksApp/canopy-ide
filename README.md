# canopy

A local-first, memory-light desktop IDE built for **vibe coding**: you drive changes
through agent CLIs (Claude Code, Codex, aider, …) in a first-class terminal, and the
IDE shows you *what changed* (diffs) and *what's running* (agents).

No Electron. No VS Code fork. No extension host. No server — fully offline.
Everything native runs as a child process of the app. See [SPEC.md](./SPEC.md) for the
full product spec.

## Build & run

Prerequisites: Rust (stable), Node 20+. For TypeScript language features:
`npm i -g typescript-language-server typescript` (or have them in the opened
project's `node_modules`).

```sh
npm install
npm run tauri dev      # development (or: npx tauri dev)
npm run tauri build    # production bundle (.app / installer)
```

## Using it

- **Projects are the entry point**: create one (＋), name it, and add one or more
  labeled component directories (frontend, backend, …). Projects persist in
  `~/.canopy/projects.json`. Open several at once — **top tabs switch projects**,
  and everything (side panel, terminals, file sub-tabs) is scoped per project.
  The **File menu** adds explicit *Open Project…* (any folder), *Save Project As…*,
  and *Open / Save Workspace* — export/import on top of the auto-persistence, for
  moving a setup between machines or committing it to a repo. Importing a
  workspace merges into what you have rather than replacing it.
- **The terminal is the hero**: opening a project opens the **launcher** — it does
  not hand you a shell you didn't ask for. Pick a shell or an agent CLI; the
  terminal starts `cd`'d into the project. Full TUI support — run `claude`, `vim`,
  `htop`, `tmux` directly. The
  ＋▾ menu launches agent CLIs (Claude Code, Codex, Amp, Aider, Gemini, OpenCode,
  oh-my-pi) and offers the install command for ones you don't have — an empty
  project shows the same launchers as a grid. ⌫ clears scrollback; ↺ hard-resets.
  Scrollback is capped (10k lines, configurable in localStorage
  `canopy.settings`).
- **Run commands** (per component, defined in project settings) launch into the
  **RUNS rail** on the right of the tab strip — kept apart from shells and agents
  because they're services, not sessions. Each reports real state: a pulsing dot
  while live (with restart/stop), a green check when a one-shot finishes, or a
  red exit code when it fails. The tab stays open after exit so the output is
  still readable; re-run reuses the same tab.
- **Quick Open (`Cmd+P`) and Find in Files (`Cmd+Shift+F`)** search **every
  component of the project** by default. Chips at the top scope to a single
  component, and each result is tagged with the component it came from, with its
  path shown relative to that component.
- **The status tray** shows the git branch, running agents, model, tokens and
  estimated cost, plus the app's own CPU and memory. That figure covers the Rust
  core, language servers, terminals and everything they spawned — it excludes the
  WebView, because macOS runs it in system-owned WebKit processes parented to
  `launchd` that can't be attributed back to us. The tooltip says so rather than
  quietly under-reporting.
- **Files open as sub-tabs** inside the project, next to its terminals. `Cmd/Ctrl+S`
  saves. TypeScript files get diagnostics/hover/completion/go-to-def via a local
  `typescript-language-server`.
- **Diff-first**: when a file changes on disk underneath you (an agent edited it),
  you get a side-by-side diff — Accept disk version / Keep mine — never a silent
  reload. The **Changes** tab lists everything touched this session.
- **Native viewers**: Markdown (incl. Mermaid), HTML, PDF, XLSX/CSV, Jupyter
  notebooks, and images render natively; toggle Source/Preview in the tab bar.
  Try the files in `demo/`.
- **Agents** tab: agent CLIs detected inside your terminals, with CPU/memory
  (runaway guard) and kill buttons; plus a file-based hook bridge — any CLI hook
  system can append JSON lines to `~/.canopy/agent-events.jsonl` and they
  show up live. Claude Code hooks are installed automatically at boot.
  Because those hooks live in the *global* `~/.claude/settings.json`, they fire
  for every claude on the machine — so the hook only writes when `$CANOPY`
  is set (exported by PTYs we spawn) and stamps `$CANOPY_PTY` onto each event.
  Agents you run outside the app never appear here, and each event is attributed
  to the exact terminal tab that raised it.

## Keyboard shortcuts

VS Code-standard where an equivalent exists. All scoped to the active window and
the visible project — `Cmd+W` closes a tab, never the app.

| Shortcut | Action |
| --- | --- |
| `Cmd+P` | Quick Open file (fuzzy) |
| `Cmd+Shift+F` | Find in Files (literal, case-insensitive) |
| `Cmd+N` / `Cmd+O` | New project / Open project folder |
| `Cmd+Shift+O` / `Cmd+Shift+S` | Open / Save workspace file |
| `Cmd+T` | New terminal |
| `Cmd+W` | Close tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Cmd+Shift+W` | Close project |
| `Cmd+B` | Toggle sidebar |
| `Cmd+Shift+Enter` | **Focus mode** — everything but the active terminal drops away; project tabs and the tab strip slide back when you hover the top edge. `Esc` exits. |
| `Cmd+Q` | Quit |

Focus mode is our take on VS Code's Zen Mode. Its `Cmd+K Z` chord isn't
reproducible — Tauri accelerators don't support chords — hence `Cmd+Shift+Enter`.

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
│  React + Vite. xterm.js (WebGL→DOM fallback) fed directly from the   │
│  channel — no output buffered in JS. Monaco via                      │
│  @codingame/monaco-vscode-editor-api (aliased as monaco-editor) so   │
│  monaco-languageclient shares the same API instance; LSP transport   │
│  is a custom MessageReader/Writer over Tauri IPC.                    │
└───────────────────────────────────────────────────────────────────────┘
```

Design rules:

- **Rust owns all native processes** (PTYs, LSP servers, watchers). JS never spawns.
- **Raw bytes end-to-end** on the PTY path; no filtering or normalization.
- **Bounded memory**: xterm scrollback capped; PTY reader pauses when the WebView
  is behind (ack window, default 2 MB) so the kernel PTY buffer backpressures the
  child instead of ballooning heap.
- **Clean teardown**: closing a tab kills the whole process group and reaps the
  child; app exit kills everything; a fresh page reaps sessions orphaned by
  webview reloads.

## Dependency justification

| Dependency | Why |
|---|---|
| `portable-pty` | cross-platform PTY (the terminal core) |
| `notify` | fs watching for the diff-first workflow |
| `sysinfo` | process-tree stats for the runaway guard / agent detection |
| `libc` (unix) | process-group SIGKILL on teardown |
| `@xterm/*` | terminal renderer + required addons |
| `monaco-editor` → `@codingame/monaco-vscode-editor-api` | monaco build compatible with monaco-languageclient 10.x (stock monaco + @monaco-editor/react cannot pair with it) |
| `monaco-languageclient` + `@codingame/monaco-vscode-standalone-languages` | LSP client + monarch grammars |
| `react-resizable-panels` | the three resizable panes |
| `marked` | markdown rendering (small, sync) |
| `mermaid` | diagram blocks in markdown (lazy-loaded on first use) |
| `xlsx` (SheetJS, cdn dist) | spreadsheet parsing (lazy-loaded) |
| `@tauri-apps/plugin-dialog` | native folder picker |

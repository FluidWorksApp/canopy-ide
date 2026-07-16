# Canopy — Product Spec

A local-first, memory-light desktop IDE built for **vibe-coding**: you drive changes through
agent CLIs (Claude Code, Codex, etc.) in a first-class terminal, and the IDE's job is to show
you *what changed* (diffs) and *what's running* (agents) — not to be a heavyweight editor.

No server, no VS Code fork, no Electron, no extension host. Everything runs locally as child
processes of the app. Target idle footprint: 60–150 MB.

## Stack (fixed)

- **Shell**: Tauri v2 (Rust core + native OS WebView)
- **Frontend**: React + Vite + TypeScript (no SSR)
- **Editor**: monaco-editor + @monaco-editor/react
- **Terminal**: @xterm/xterm + addon-fit, addon-webgl (canvas fallback), addon-unicode11,
  addon-web-links, addon-serialize
- **PTY**: portable-pty (Rust), spawned by the Tauri core
- **LSP**: monaco-languageclient bridging to local LSP subprocesses over stdio
  (v1: typescript-language-server). Adding a language = registering one more subprocess.
- **FS watching**: notify (Rust)

## Core principles

1. **Rust core owns all native processes** — PTYs, LSP servers, watchers. WebView is pure UI.
   No process spawning from JS.
2. **Raw byte passthrough** on the PTY stream, both directions. No filtering/normalizing.
3. **Bounded memory everywhere** — scrollback caps, backpressure on PTY reads, clean teardown
   (no zombie processes, leaked threads, or unbounded buffers).
4. **Fully offline** — no network/server dependency.
5. **Minimal dependencies** — every added library is justified in the README.

## Feature areas

### 1. Rich terminal (priority #1)
- Full TUI support: alternate screen, SGR mouse reporting, bracketed paste, 256-color +
  truecolor, cursor shape/visibility. Must pass the "Claude Code / vim / htop / tmux" test.
- WebGL renderer with canvas fallback.
- Resize: fit() → send cols/rows to PTY (debounced ~50 ms) → SIGWINCH.
- Heavy-output robustness: Rust coalesces PTY reads into batched IPC chunks (8–16 ms);
  frontend feeds xterm's own write buffer, never accumulates output in JS arrays.
- Backpressure: bounded outstanding-bytes window with frontend acks; the Rust reader pauses
  (kernel PTY buffer applies pressure to the child) rather than ballooning heap.
- Configurable scrollback cap (default 10,000 lines). Explicit clear-scrollback + hard reset.
- Per-PTY runaway guard: monitor child process tree CPU/memory, surface + kill from UI.
- Multiple independent terminal sessions (tabs), each sized and torn down independently.

### 2. Diff-first ("vibe coding") workflow
- The IDE watches the workspace; when files change externally (i.e., an agent edited them),
  changes surface as **diffs** (Monaco diff editor), not silent buffer reloads.
- A **Changes** panel lists files modified during the session; clicking shows old → new.
- If the workspace is a git repo, diffs can baseline against git; otherwise baselines are
  the last content the IDE saw.

### 3. Native file rendering (viewer registry)
Opening a file picks a renderer by type; raw-source view is always available as a toggle:
- **Markdown** — rendered natively, incl. Mermaid diagrams / plots in fenced blocks
- **Jupyter notebooks (.ipynb)** — cells + outputs rendered read-only
- **HTML** — live preview (sandboxed iframe)
- **PDF** — native render (WKWebView's built-in PDF via blob URL)
- **Excel (.xlsx/.csv)** — sheet grid render
- Everything else — Monaco with correct language mode.

### 4. Agent management
- Detect agent CLIs running inside IDE terminals (claude, codex, aider, gemini, …) by
  inspecting each PTY's child process tree.
- **Agents panel**: list running agents across all projects/terminals with CPU/mem,
  and manage them (kill, jump to their terminal).
- **Hook bridge**: a generic, file-based event bridge (`~/.canopy/agent-events.jsonl`)
  that any CLI's hook system (Claude Code hooks, Codex hooks, …) can append to; the IDE
  tails it and surfaces events (tool use, file edits, completions) in the UI. Works with any
  platform that can run a shell command as a hook — no network required.

### 5. Project-centric, terminal-hero UX (NOT a VS Code clone)
- **Projects are the entry point.** A project = a name + one or more *labeled
  component directories* (frontend, backend, …). Projects persist in
  `~/.canopy/projects.json` and survive restarts.
- No project open → welcome screen. **No terminal exists without a project.**
- **Top tabs = open projects** (multiple at once, switchable). Everything below the
  tab — side panel, terminals, files — is scoped to that project.
- **The terminal is the hero**: opening a project immediately opens a terminal
  `cd`'d into its first component. Each component header offers "terminal here".
- Files open as **sub-tabs within the project**, next to its terminal sub-tabs.
  Terminals stay mounted (TUIs keep running) while browsing files or projects.
- Side panel per project: Components (labeled trees), Changes, Agents.

### 6. Agent CLI launcher
- The new-terminal menu lists popular agent CLIs (Claude Code, Codex, Amp, Aider,
  Gemini CLI, OpenCode) with installed-state detected via the login shell.
- Installed → one click launches it in a project terminal. Not installed → one
  click opens a terminal running the appropriate install command.

## v1 delivery order
1. Scaffold Tauri v2 + React + Vite ✅
2. PTY command/event bridge (riskiest) → pass the full-TUI test
3. Monaco editor + file tree + save (Cmd/Ctrl+S)
4. TypeScript LSP over stdio bridge
5. Diff-first change tracking + Changes panel
6. Viewer registry (MD → HTML → PDF → XLSX → ipynb)
7. Agents panel v1 (process-tree detection) + hook bridge
8. Multi-project workspace registry

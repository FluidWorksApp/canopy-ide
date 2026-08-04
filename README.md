<h1 align="center">Canopy</h1>

<p align="center">
  <b>A local-first desktop workspace for running coding agents and reviewing their work.</b><br>
  Real agent CLIs, terminals, diffs, previews, tasks, tickets, and project context
  in one native window.
</p>

<p align="center">
  <a href="https://github.com/FluidWorksApp/canopy-ide/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/FluidWorksApp/canopy-ide/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/FluidWorksApp/canopy-ide/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/FluidWorksApp/canopy-ide?sort=semver&label=download"></a>
  <a href="./LICENSE.md"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey">
  <img alt="No Electron" src="https://img.shields.io/badge/no-electron-brightgreen">
</p>

<p align="center">
  <a href="https://canopyide.dev/"><b>Website</b></a> ·
  <a href="https://github.com/FluidWorksApp/canopy-ide/releases/latest">Download</a> ·
  <a href="./docs/architecture.md">Documentation</a> ·
  <a href="https://github.com/FluidWorksApp/canopy-ide/discussions">Discussions</a> ·
  <a href="https://github.com/FluidWorksApp/canopy-ide/issues/new/choose">Issues</a>
</p>

<p align="center">
  <img src="docs/screenshots/launcher.png" alt="Canopy launcher with shells, coding-agent CLIs, and resumable sessions" width="900">
</p>

> [!NOTE]
> Canopy is under active pre-1.0 development. This README follows `main`, which
> may contain features newer than the latest downloadable release. Interfaces
> and platform behavior may change between releases.

## What is Canopy?

Canopy is built around a simple idea: the best interface for a coding agent is
often the agent's own CLI in a real terminal, not another chat box embedded in
an editor. Canopy keeps that terminal first-class and adds the context a terminal
cannot provide by itself: what changed, what is running, what needs your
attention, and how the work relates to branches, tickets, previews, and other
agents.

Canopy is **local-first and offline-capable**. Projects, workspace state, notes,
research, session context, and search indexes stay on your machine. There is no
required Canopy account and no telemetry. Agent CLIs and optional integrations
such as GitHub, Linear, public Remote links, and Internet team sessions may use
their own network services. Remote access is off by default.

It is a native Tauri application, not an Electron app, VS Code fork, or extension
host. Rust owns PTYs, language servers, filesystem watchers, local services, and
process teardown; React owns the project workspace and presentation.

## The workflow

1. **Launch or resume an agent.** Start a shell or installed coding CLI in the
   current checkout, an isolated worktree, and the CLI account profile you want.
2. **See what needs you.** Agent lifecycle, questions, completed tasks,
   reminders, and team messages flow into project-aware attention surfaces.
3. **Review the work.** Inspect files, commits, diffs, branches, pull requests,
   usage, and process resources from the agent's workspace.
4. **Run and preview it.** Start configured services, open detected URLs, annotate
   page elements, capture scoped screenshots, and send feedback to an agent.
5. **Keep the next step.** Search everything with SpotSearch, save a thought,
   research a question, or run a focused background task without losing context.

## Highlights

- **Real agent terminals.** Full PTY and TUI support for shells, `vim`, `htop`,
  `tmux`, Claude Code, Codex CLI, Amp, Aider, Antigravity, OpenCode, oh-my-pi,
  and custom CLIs. Canopy reports the integration and resume capabilities each
  CLI actually supports instead of assuming parity.
- **Parallel work without checkout collisions.** Work in the current checkout or
  isolated Git worktrees. Canopy tracks which branch lives where, allocates
  workspace ports, prepares ignored configuration, and surfaces loose ends for
  explicit cleanup.
- **Agent Workspace and diff-first review.** Join session evidence with Git to
  see edited files, uncommitted changes, commits, branch state, pull requests,
  checks, and side-by-side diffs. External edits never silently replace an open
  buffer.
- **One Companion across projects.** Ask for workspace-wide status, summaries,
  code orientation, past work, and navigation. Authority is explicit: Answer
  only, Ask first, or Act automatically. The Companion does not silently become
  another code-editing agent.
- **SpotSearch and durable follow-up.** Search actions, tabs, files, symbols,
  content, branches, servers, tickets, PRs, notes, research, task history,
  terminal output, and past agent conversations. A typed request or pasted
  image can become a one-shot task, research run, or scratchpad note.
- **Capture, investigate, then act.** Notes hold ideas, screenshots, attachments,
  reminders, and links. Research jobs preserve findings and sources without
  changing code. Background tasks report progress and leave searchable history;
  code-changing custom tasks hand work off through an isolated draft PR.
- **Preview what agents build.** Open detected dev servers, inspect console and
  network activity, annotate elements, and capture viewport, full-page, or
  region screenshots. Agents can drive previews through scoped browser tools.
  On macOS, the persistent native browser keeps site logins; other platforms use
  the loopback preview engine. Agent browser activity can stay visible in a
  read-only picture-in-picture view where the native browser is available.
- **Git, PRs, and issues in the IDE.** Manage branches, worktrees, staged and
  unstaged changes, reviews, and pull requests. Read GitHub Issues and Linear
  tickets with their conversation, comment or change supported states, and
  start work with a new or already-running agent.
- **Canopy Remote.** Enable a PIN-protected phone/browser interface when you need
  it. Attach to terminals, launch or resume agents, inspect changes, tickets,
  PRs, research, servers, instructions, tools, and usage over your LAN or an
  optional Cloudflare, ngrok, or Tailscale tunnel.
- **Encrypted team collaboration.** One Canopy hosts and teammates join by code.
  Chat, exchange files and review requests, share a project, or co-edit a file.
  LAN sessions connect to the host directly; Internet sessions can use the same
  optional tunnel as Remote. Team payloads remain end-to-end encrypted, and the
  owner of a shared file remains its only disk writer.
- **Profiles, MCP, and controlled credentials.** Isolate supported CLI accounts
  without Canopy reading their tokens. Register Canopy tools with coding agents,
  discover and inspect MCP servers across CLI configurations, and use a local
  browser vault that can fill a login without revealing its password to an
  agent. Plaintext agent reads are opt-in.
- **A real editor and native viewers.** Monaco diagnostics and code intelligence
  sit beside offline rendering for Markdown with Mermaid, HTML, JSON/JSONC,
  spreadsheets and CSV, `.docx`, PDF, images, and Jupyter notebooks.
- **On-device dictation.** Use a configurable hotkey or push-to-talk gesture to
  insert speech into terminals, the editor, commit messages, or agent prompts.
  Models and transcription stay on the machine. Intel macOS builds do not
  include dictation.
- **Resource-aware by design.** See CPU, memory, ports, working time, and usage
  where a CLI exposes it. Token accounting currently supports Claude Code,
  Codex, and oh-my-pi. Hibernation preserves resumability; manual cleanup scans
  dependency installs, build output, and caches without deleting automatically.

## A closer look

### Run several agents and know what each one is doing

The Agents rail combines live PTY evidence, process stats, session history, and
CLI integration signals. It shows lifecycle, project, component, branch, last
prompt, resource use, and whether the session needs you.

<img src="docs/screenshots/agents.png" alt="Agents rail with several sessions, lifecycle indicators, branches, and shared context" width="380">

### Review one agent as a complete unit of work

Agent Workspace joins the session to its checkout, files, commits, diff, branch,
and pull request so review happens in context rather than across terminal tabs.

<img src="docs/screenshots/agent-workspace.png" alt="Agent Workspace showing branch state, pull request, commits, edited files, and a live diff" width="900">

### Keep Git and issue work beside the code

The Git surface handles changes, branches, worktrees, diffs, and loose ends.
GitHub Issues and Linear tickets can be read and acted on without leaving the
workspace, then handed to a new or running agent.

<img src="docs/screenshots/git-diff.png" alt="Side-by-side Git diff with stage, discard, and open-file actions" width="820">

<img src="docs/screenshots/issue.png" alt="Issue detail in Canopy with status, conversation, worktree, and agent handoff" width="820">

### Work with a team without a central Canopy service

The host's Canopy is the encrypted relay. Teammates can chat, transfer files,
request reviews, and collaborate on shared code while the file owner retains
authority over disk writes.

<img src="docs/screenshots/team-relay.png" alt="Team panel with relay status, members, transfers, and review requests" width="380">

## Privacy and security boundaries

- No required Canopy account and no telemetry.
- Workspace and Canopy-owned knowledge stay local under the opened projects and
  `~/.canopy`.
- Agent CLIs remain separate tools and may use their own accounts and networks.
- Remote is off by default. Anyone with the current PIN can drive its permitted
  surface, so stop or rotate it when finished.
- Public Remote and Internet team traffic may traverse the tunnel provider you
  select; team payloads are end-to-end encrypted.
- Filesystem commands are scoped to registered workspace roots.
- Browser-vault fill avoids exposing a password to an agent. Plaintext reads
  require an entry to be explicitly marked readable and still pass approval.
- Security vulnerabilities must be reported privately through the
  [Security Policy](./SECURITY.md), not a public issue.

## Install

Download from [**canopyide.dev**](https://canopyide.dev/) or install on macOS:

```sh
brew install --cask fluidworksapp/tap/canopy
```

Direct links always point to the newest release:

| Platform | Download | Notes and updates |
|---|---|---|
| macOS - Apple Silicon | [`Canopy-macos-arm64.dmg`](https://github.com/FluidWorksApp/canopy-ide/releases/latest/download/Canopy-macos-arm64.dmg) | signed, notarized, in-app updates |
| macOS - Intel | [`Canopy-macos-intel.dmg`](https://github.com/FluidWorksApp/canopy-ide/releases/latest/download/Canopy-macos-intel.dmg) | signed, notarized, no dictation, in-app updates |
| Linux - AppImage x86_64 | [`Canopy-linux-x86_64.AppImage`](https://github.com/FluidWorksApp/canopy-ide/releases/latest/download/Canopy-linux-x86_64.AppImage) | in-app updates |
| Linux - Debian/Ubuntu x86_64 | [`Canopy-linux-x86_64.deb`](https://github.com/FluidWorksApp/canopy-ide/releases/latest/download/Canopy-linux-x86_64.deb) | update through your package manager |
| Linux - Fedora/RHEL x86_64 | [`Canopy-linux-x86_64.rpm`](https://github.com/FluidWorksApp/canopy-ide/releases/latest/download/Canopy-linux-x86_64.rpm) | update through your package manager |
| Windows - x86_64 | [`Canopy-windows-x86_64-setup.exe`](https://github.com/FluidWorksApp/canopy-ide/releases/latest/download/Canopy-windows-x86_64-setup.exe) | installer is currently unsigned and may trigger SmartScreen; in-app updates |

See [GitHub Releases](https://github.com/FluidWorksApp/canopy-ide/releases)
for the canonical release notes and version history.

## Quick start

1. Open Canopy and create a project.
2. Add the directory or directories that make up the project, such as frontend,
   API, worker, or mobile app.
3. Open the launcher and start a shell or an installed coding-agent CLI.
4. Use Agents to inspect the session or reopen past work.
5. Review edits from Changes or Agent Workspace.
6. Add run commands for development servers and open them in Preview.
7. Press SpotSearch to find work or start a task, research entry, or note.
8. Optionally enable Remote or Team only when you need them.

## Runtime prerequisites

Canopy itself runs after installation, but its Git and agent workflows rely on
tools installed on your machine:

- **Git** for branches, worktrees, diffs, and pull-request workflows.
- **Node.js 18+ with npm** for agent CLIs distributed through npm.
- Provider-specific tools where applicable, such as Python/pip for Aider or the
  Antigravity installer. The launcher shows the exact install command for a
  missing built-in CLI.

**macOS**

```sh
xcode-select --install     # Git, or use: brew install git
brew install node          # Node.js and npm
```

**Windows**

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
```

Open a new terminal afterward so `PATH` includes the new tools.

**Linux - Debian/Ubuntu**

```sh
sudo apt update && sudo apt install -y git nodejs npm
```

For a newer Node release, use
[NodeSource](https://github.com/nodesource/distributions).

## Keyboard shortcuts

Canopy asks you to choose a shortcut profile during onboarding: **Canopy**,
**VS Code**, **JetBrains**, or **Sublime Text**. The in-app Help dialog always
shows the active profile for the current platform.

The compact table below shows high-frequency commands in the default Canopy
profile:

| Action | macOS | Windows / Linux |
|---|---|---|
| New tab or launcher | `⌘N` | `Ctrl+N` |
| SpotSearch | `⌘K` | `Ctrl+Shift+K` |
| Quick Open | `⌘P` | `Ctrl+Shift+P` |
| Find in Files | `⇧⌘F` | `Ctrl+Shift+F` |
| New terminal | `⌘T` | `Ctrl+T` |
| Close tab | `⌘W` | `Ctrl+Shift+W` |
| Jump to tab | `⌘1…9` | `Ctrl+1…9` |
| Jump to project | `⌥1…9` | `Alt+1…9` |
| Previous / next tab | `⌃⌘←` / `⌃⌘→` | `Ctrl+PgUp` / `Ctrl+PgDn` |
| Toggle sidebar | `⌘B` | `Ctrl+Shift+B` |
| Focus mode | `⇧⌘Enter` | `Ctrl+Shift+Enter` |
| Dictation | `⌘D` | `Alt+D` |

Every chord is defined once in
[`shared/shortcuts.json`](./shared/shortcuts.json) and resolved for profile,
platform, application surface, and terminal collisions.

## Documentation

| Guide | Purpose |
|---|---|
| [Contributing](./CONTRIBUTING.md) | development setup, house style, tests, and pull requests |
| [Architecture](./docs/architecture.md) | system structure, runtime flows, boundaries, and state authority |
| [Core Rust System](./docs/core-rust-system.md) | native services, processes, security, persistence, and shutdown |
| [Contributor Integration Guide](./docs/contributor-integrations.md) | choose the existing bus, registry, or adapter |
| [Contribution Playbooks](./docs/contributions/README.md) | step-by-step recipes for each contribution type |
| [Testing and Coverage](./docs/testing-and-coverage.md) | frontend, Rust, structural, fuzz, CI, and coverage expectations |
| [Agent Integration Parity](./docs/agent-parity.md) | verified capabilities and limitations by coding CLI |
| [Security Policy](./SECURITY.md) | private vulnerability reporting and supported versions |
| [Release Process](./RELEASING.md) | versioning, signing, packaging, and publication |
| [GitHub Releases](https://github.com/FluidWorksApp/canopy-ide/releases) | canonical release notes and version history |

The same architecture documentation can be generated for the GitHub Wiki with
`npm run wiki:build`; see [Publishing the GitHub Wiki](./docs/wiki-publishing.md).

## Build from source

Developer prerequisites are **Rust stable** and **Node.js 20+**.

```sh
npm install
npm run tauri dev      # development build with hot reload
npm run tauri build    # production bundle or installer
```

Tauri builds the `canopy-hook` sidecar and Canopy Remote before starting or
packaging the desktop application. The first Rust build takes a few minutes;
subsequent frontend changes hot-reload quickly.

## Contributing

Issues, ideas, documentation, themes, integrations, tests, and pull requests are
welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), then choose the
[contribution playbook](./docs/contributions/README.md) closest to your change.

Canopy follows test-first development. Before opening a pull request, run:

```sh
npm run typecheck
npm run lint
npm run test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features
```

The main code boundaries are:

```text
src/                         desktop React application
src-tauri/src/               Rust native core
src-tauri/src/bin/           canopy-hook sidecar
shared/                      browser-safe desktop/Remote models and UI
portal/                      embedded Canopy Remote application
packages/ui/                 independently buildable UI package
scripts/                     build, release, license, and Wiki tooling
docs/                        architecture, testing, and contribution guides
```

Rust owns native processes and privileged resources. Shared code must remain
browser-safe. Comments explain constraints and why, not what the next line does.

## Support and community

- Ask usage questions, share workflows, and discuss ideas in
  [GitHub Discussions](https://github.com/FluidWorksApp/canopy-ide/discussions).
- Report reproducible bugs or request features through the
  [issue forms](https://github.com/FluidWorksApp/canopy-ide/issues/new/choose).
- Read and follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
- Help fund continued development through
  [Sponsor Canopy](https://canopyide.dev/support).

There is no separate public roadmap today. Planning and proposals happen in
Issues and Discussions; shipped changes are recorded in GitHub Releases.

## Security

Do not report vulnerabilities in public issues. Follow
[SECURITY.md](./SECURITY.md) to use GitHub private vulnerability reporting or the
security contact listed there.

## Author

Canopy was created by
[Shoaib Ameer](https://www.linkedin.com/in/shoaib-ameer-169a649/).

## License and acknowledgements

Canopy is open source under the [MIT License](./LICENSE.md). You may use, modify,
and distribute it, including commercially, under those terms.

Third-party components retain their own licenses. See
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md), generated from the resolved
Rust and npm dependency trees and shipped inside the application bundle.

Copyright 2026 Cause Connect Pte Ltd.

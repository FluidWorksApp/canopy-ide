# Canopy baseline (as of 2026-10-26)

Read-only scan of the repo at `main` (HEAD e3083299, v0.4.5). Describes what exists; does not evaluate. "Shipped" = in README/release notes/doc marked built with code present. "Designed/partial" = doc says proposal or incomplete.

## 1. What the app is
- Local-first, offline-capable desktop IDE "for running coding agents and reviewing their work". The agent's own CLI in a real terminal is treated as "the best interface for a coding agent" and stays central. MIT, pre-1.0 (v0.4.5), macOS/Windows/Linux, no required account, no telemetry.
- Stack: Tauri v2 (not Electron/VS Code fork), React/Vite/TS UI, Rust core (PTYs, LSPs, watchers, git/gh, tunnels), Monaco + xterm.js. Remote portal SPA, `canopy-hook` sidecar, Rust crates `canopy-core`/`canopy-service`, Node packages remote-host (cloud workspace host), control-plane (accounts, orgs, teams, credits, Slack hub, peer relay), chrome-stream, agent-hook, ui. Website/control plane on canopyide.dev.
- Also built in: native viewers (Markdown+Mermaid, HTML, JSON, CSV, docx, PDF, images, notebooks), on-device dictation, shortcut profiles, SpotSearch over files/symbols/tabs/PRs/tickets/notes/research/terminal output/past agent conversations, clipboard history, password vault that fills logins without exposing them to agents, resource stats, hibernation, disk cleanup, Android tooling via adb, DB connection UI.

## 2. How users get AI
- Main model: bring your own CLI + subscription. Canopy runs real agent CLIs in PTYs (Claude Code, Codex CLI, Amp, Aider, Antigravity, OpenCode, oh-my-pi, custom). Users sign in through each CLI. CLI account profiles keep multiple accounts separate without Canopy reading tokens. Plan-usage chip and token/cost tray (full for Claude Code, partial for others).
- Cloud workspaces: Anthropic/OpenAI subscription OAuth credentials can be vaulted and refreshed; shared accounts bind a team's Claude/Codex/GitHub account per project (live shared-credential brokering not fully verified).
- Integration: hooks installed for every launcher CLI; Canopy MCP tools (browser, preview, servers, LSP, notes, research, mesh, claims, tickets, reviews, spawn agent, ask user) registered for Claude, Codex, Antigravity, OpenCode, Amp.
- Built-in LLM features all drive an external agent CLI (Canopy ships no model of its own): Companion (one app-wide agent across projects; status, summaries, recall, navigation; authority levels Answer only / Ask first / Act automatically; memory), background and micro tasks (custom tasks hand off as isolated draft PRs), research jobs, headless Build runner (Claude full, Codex partial).

## 3. Agent orchestration
- Shipped: parallel agents in an Agents rail (lifecycle, branch, last prompt, resources, needs-attention); restored tabs/split panes; current checkout or isolated worktrees with per-workspace ports and loose-end cleanup; per-agent edit attribution on shared checkouts via hook edit journals; resumable sessions and session digests; agents spawn agents; agent mesh (messages, path claims, roster); since v0.4.4 jobs sent to agents in other workspaces, other machines, or teammates' machines (teammate jobs need approval; routing state in IDE memory); workflow runs (saved multi-step definitions, durable SQLite, steps can ask the user, resumable); attention surfaces and notification center.
- Designed/partial: `canopy-serviced` daemon to move harness state (mesh, notes, research, jobs, companion) off the laptop so cloud agents keep working when it closes. Only phase 1 (mesh/claims extracted into canopy-core) started. Durable inboxes and offline teammate delivery still design-only.

## 4. Build vs Engineer (non-engineer surface)
- v0.4.0 introduced two modes. Build: guided chat builder (intent parsing → project setup → live preview; automatic checkpoints, verification, repair, route recovery, server health, inferred checks; package/service setup; secret scan; Supabase/Firebase migration plans; gated deploy requiring typed phrase + configured provider + fresh verification; mascot). Engineer: full IDE (terminals, diffs, git). Build requires a CLI with structured runner (Claude yes, Codex partial).

## 5. Team and collaboration
- Shipped: LAN/Internet team relay (host + join by code; E2E-encrypted chat, file transfer, review requests, project sharing). Account-based team chat (channels, DMs, E2E encrypted, WebRTC direct + relay, receipts, unread, notifications, P2P attachments; handoff/agentChat wire chat to agents). Organizations/teams/workspace sharing "like a document" (view/edit; per-area toggles for projects, agent sessions, accounts, agents, git). Shared sessions panel.
- Partial: two-device verification, live member runtime provisioning, shared-credential execution.
- Collaborative editing v1: one plain-text file, owner + one peer, OT over relay, remote cursor; no multi-file, undo, reconnect, LSP.
- Slack (0.4.5): shared Canopy Slack app; mentions/DMs route to the user's Companion on their desktop and reply in Slack; owner-only approval buttons with 15-minute expiry.

## 6. Review and PR (shipped)
- Agent Workspace overlay per agent (branch, worktree, diff, commits, touched files, tokens/cost/model); line comments batched and sent to the agent as one review.
- PR tab: inline threads, viewed state, pending review, re-review since last, next-move bar (update branch, failing CI logs, re-request, auto-merge), persisted agent review loop, risk-ranked review map, draft findings, private self-review, fix CI, "run it" review that drives the UI with screenshots, out-of-scope → issues, apply suggestions.
- CodeRabbit-parity: opt-in automatic private review per head SHA, repo review policy, learnings, custom checks, linked-issue verdicts, stacked draft fix PRs. GitHub only; nothing posted without confirmation.
- PRs dashboard/watching; tickets (GitHub Issues, Linear; Jira/GitLab mentioned) can be handed to agents.

## 7. Remote and cloud
- Canopy Remote: PIN-protected phone/browser portal over LAN or tunnel.
- Managed cloud workspaces (since 0.4.0): Docker on provider VMs, same IDE mounted remotely, all CLIs + Chromium + on-demand desktop, start/stop/hibernate, 50 GB–1 TB, sizes up to 16 CPU/64 GB, credit billing. External hosts supported.
- Remote parity gaps: full Build, all LSPs, full git UI, structured Companion, hook bridges. PTYs don't survive VM end; no failover; no hostile-tenant isolation.

## 8. Browser and preview (shipped)
- Dev server preview, console/network inspection, element annotations sent to agents, screenshots, agent browser tools, persistent native browser (macOS), picture-in-picture of agent's browser, remote Chromium streaming, RUNS rail.

## 9. Memory, notes, research (shipped)
- Project-scoped notes (agents read/write), durable research jobs with sources, task history, session digests, past conversations searchable, Companion memory, agent-memory settings, instruction-file management. In cloud, notes/research still depend on the desktop bridge.

## 10. MCP and integrations
- MCP server discovery/inspection across CLI configs; Canopy MCP suite; GitHub, Linear, tunnels, Slack.

## Summary
- Shipped: terminals/agents, worktrees, review overlay, PR tab + AI review loop, Companion, notes/research/tasks, workflows, Build mode, preview/browser, Android, dictation, vault, remote portal, cloud workspaces, orgs/teams/sharing, encrypted team chat with files, v1 co-editing, Slack via Companion, cross-workspace agent jobs.
- Partial: shared-credential brokering, remote parity, co-editing beyond one file.
- Designed only: canopy-serviced daemon (headless cloud agents with notes/research/mesh while laptop closed, durable offline inbox, host browser, laptop daemon mode).
- Notable architectural fact: Canopy has no intelligence of its own. Every AI capability is delegated to an external agent CLI the user installs and signs into; the IDE works without any model connected.

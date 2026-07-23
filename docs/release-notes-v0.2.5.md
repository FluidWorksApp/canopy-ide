# Canopy v0.2.5

**See exactly what each agent did, dictate anywhere with a hotkey, and know what your CLIs are costing you.**

## Open an agent's workspace

- **Click a running agent, see its work — not just its terminal.** Every row in the Agents panel now opens a workspace tab for that session: the branch it's on, its uncommitted changes, the commits it added, and the pull request raised from its branch — with full diffs, side-by-side or unified. Commit rows hand off to the same commit view History uses; the PR card opens the same PR view. The `term #n` chip still jumps you to the terminal.
- **No new bookkeeping, and it survives a rebase.** The view joins what the hooks already record about a session against git at the moment you open it, so nothing is persisted to go stale — it works whether the agent runs in an isolated worktree or shares your checkout, and it says so plainly when a session has ended, lost its directory, is working straight on `main`, or was never inside a repo.

## Dictate into any field

- **Press a hotkey and talk.** ⌘D on Mac (Alt+D elsewhere, rebindable) starts dictation in any terminal, editor, or text field; press again to insert the transcription at your cursor. It's fully local speech recognition over ONNX Runtime — no cloud, no account — and runs on macOS, Windows and Linux, Intel and ARM.
- **Pick the model that fits.** Parakeet v3 (25-language multilingual) is the default; SenseVoice (CJK + English) and Moonshine Base (fast English) are one click away. Models download on demand into `~/.canopy/models` and load only when first used. Settings → Dictation has the shortcut capture, per-model install/remove with live download progress, and a language hint for the multilingual models.

## Know what your agents cost

- **Token and cost statistics across every CLI.** A new Statistics panel — opened from a chip beside the cost in the status bar — totals token usage and estimated spend across every session Canopy knows, broken down by CLI, by model, and per session. Claude Code, Codex and oh-my-pi are read from their own transcripts; oh-my-pi's own reported cost is used directly, everything else is estimated from a shared pricing table. CLIs with no machine-readable local usage (amp, aider, opencode) are shown as untracked so the mix stays honest.

## A calmer, clearer Agents panel

- **First-run walkthrough.** A fresh install no longer drops you into an empty window — a dismissable welcome intro appears once the workspace loads and offers to create your first project. There's a "Replay the welcome walkthrough" link in Help if you want it again.
- **Answer questionnaires without leaving the panel.** When an agent asks a multi-step question, you can now answer it inline from its card — the panel drives the (possibly multi-step) terminal form for you.
- **Right-click to clean up.** Branches, worktrees and PRs now have context menus for deleting/removing them, right where you see them.
- **Smaller cues that stay put.** The row for the terminal tab you're on is highlighted, the "runaway?" badge survives a hover, reported-file chips are shortened, and the hook-setup nudge only shows when hooks really aren't set up.

## Fixes

- **Codex config no longer gets corrupted.** Appending the notify hook to `config.toml` could mangle it; it now writes cleanly.
- The cross-CLI usage popup no longer reflows or clips as numbers update.
- Forgetting an oh-my-pi session now sticks instead of reappearing.
- CLI update badges tell you when an agent CLI has a newer version available.

---

*Local-first as ever — no server, no account, no telemetry.*

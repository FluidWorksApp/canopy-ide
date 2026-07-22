// First-run walkthrough. Static, offline, instant — same contract as
// HelpDialog. A centered carousel of a few slides; Skip is always reachable,
// Esc closes, and the last slide hands off to "New project" so the very next
// thing after the intro is the actual entry point.
import { useState } from "react";
import { useEscape } from "../useEscape";

interface OnboardingProps {
  /** Called when the walkthrough is dismissed any way (Skip, Esc, Done). */
  onClose: () => void;
  /** Called instead of onClose when the user finishes and wants to start. */
  onCreateProject: () => void;
}

interface Slide {
  icon: string;
  title: string;
  body: React.ReactNode;
}

const SLIDES: Slide[] = [
  {
    icon: "🌳",
    title: "Welcome to Canopy",
    body: (
      <>
        A local-first, memory-light IDE for coding with agents. No server, no
        account, no telemetry — terminals, language servers and file watchers
        all run on your machine. Here are the ten things worth knowing first.
      </>
    ),
  },
  {
    icon: "▚",
    title: "The terminal is the hero",
    body: (
      <>
        The best interface for an AI agent is its own CLI, in a real terminal. A
        launcher starts any of them — <code>claude</code>, Codex, Amp, Aider,
        Gemini, OpenCode, oh-my-pi — with full TUI support, so{" "}
        <code>vim</code>, <code>htop</code> and <code>tmux</code> just work.
      </>
    ),
  },
  {
    icon: "🎯",
    title: "One place for every agent",
    body: (
      <>
        The <strong>Agents</strong> panel is the single point to manage them
        all. Every session across the project, its branch and CPU/memory in one
        list — and anything that needs you (a question, a permission prompt)
        surfaces as a card you answer right there, with a badge on the tab.
      </>
    ),
  },
  {
    icon: "♻️",
    title: "Sessions survive anything",
    body: (
      <>
        Close a tab, quit the app, or crash — it doesn't matter. Canopy tracks
        every agent session and offers to <strong>Restore</strong> it with its
        history intact, so you can resume any time. Each is listed with what you
        last asked it, whether it's still alive, and where it was running.
      </>
    ),
  },
  {
    icon: "⇄",
    title: "Diff-first, never a silent reload",
    body: (
      <>
        When an agent edits a file under you, you get a side-by-side diff —{" "}
        <strong>Accept</strong> the disk version or <strong>keep yours</strong>.
        A git-backed Changes panel groups everything touched, by component.
        Nothing lands without you seeing it.
      </>
    ),
  },
  {
    icon: "📁",
    title: "Multi-project, multi-component",
    body: (
      <>
        A <strong>project</strong> spans as many labeled directories as you like
        — frontend, backend, docs. Open several projects at once; search,
        terminals and git are scoped per project, and terminals keep running as
        you switch. Create one with <code>⌘N</code>.
      </>
    ),
  },
  {
    icon: "🔀",
    title: "Git & PRs, built in",
    body: (
      <>
        Branches, worktrees, pull requests, and staged/unstaged changes with
        side-by-side diffs — a full Git panel. Review and commit without ever
        leaving the app.
      </>
    ),
  },
  {
    icon: "🎫",
    title: "Your tickets, in the IDE",
    body: (
      <>
        Pull <strong>Linear</strong> and <strong>GitHub Issues</strong> into a
        rail beside the code. Open one, read it inline, then <em>Start work</em>{" "}
        — Canopy spins up a worktree on its branch and launches your agent with
        the ticket as context. No auto-commit, no auto-PR; that stays yours.
      </>
    ),
  },
  {
    icon: "🤝",
    title: "Team collaboration, peer-to-peer",
    body: (
      <>
        One person hosts — their Canopy <em>is</em> the relay — and teammates
        join with a code. Chat, request <strong>PR-based reviews</strong>, share
        a whole project, and co-edit files live. There's no server in the
        middle: everything is <strong>end-to-end encrypted</strong>, host to
        peer.
      </>
    ),
  },
  {
    icon: "📊",
    title: "See what's actually running",
    body: (
      <>
        Run commands and dev servers launch into the <strong>RUNS</strong> rail
        as services — each with a live status dot and its own CPU/memory — while
        the active model, token usage and session cost sit in the status bar.
      </>
    ),
  },
  {
    icon: "📄",
    title: "Open anything, install nothing",
    body: (
      <>
        Markdown (with Mermaid), CSVs, spreadsheets, Word docs, PDFs, images and
        Jupyter notebooks all render natively — plus a real Monaco editor with
        TypeScript diagnostics. No extensions, no marketplace, no config.
      </>
    ),
  },
  {
    icon: "🪶",
    title: "That's the tour",
    body: (
      <>
        Light enough to run several agents in a fraction of a browser tab's
        memory, and entirely yours — offline, local-first, private. Open Help
        (<code>?</code>) any time to replay this. Ready to start?
      </>
    ),
  },
];

export function Onboarding({ onClose, onCreateProject }: OnboardingProps) {
  const [step, setStep] = useState(0);
  useEscape(onClose, true);

  const last = step === SLIDES.length - 1;
  const slide = SLIDES[step];

  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div
        className="confirm onboarding"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Welcome to Canopy"
      >
        <button className="onboarding-skip" onClick={onClose} title="Skip the intro">
          Skip
        </button>

        <div className="onboarding-slide">
          <div className="onboarding-icon" aria-hidden>
            {slide.icon}
          </div>
          <div className="set-head onboarding-title">{slide.title}</div>
          <p className="onboarding-body">{slide.body}</p>
        </div>

        <div className="onboarding-dots" role="tablist" aria-label="Walkthrough progress">
          {SLIDES.map((s, i) => (
            <button
              key={s.title}
              className={`onboarding-dot ${i === step ? "onboarding-dot-on" : ""}`}
              aria-label={`Go to slide ${i + 1}: ${s.title}`}
              aria-selected={i === step}
              role="tab"
              onClick={() => setStep(i)}
            />
          ))}
        </div>

        <div className="onboarding-actions">
          <button
            className="btn"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            Back
          </button>
          {last ? (
            <button
              className="btn btn-accent"
              onClick={onCreateProject}
              title="Close the intro and create your first project"
            >
              Create a project
            </button>
          ) : (
            <button className="btn btn-accent" onClick={() => setStep((s) => s + 1)}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

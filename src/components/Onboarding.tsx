// First-run walkthrough. Static, offline, instant — same contract as
// HelpDialog. A centered carousel of a few slides; Skip is always reachable,
// Esc closes, and the last slide hands off to "New project" so the very next
// thing after the intro is the actual entry point. Each slide carries a small
// animated mock of the *actual* panel it describes — real labels, rows, status
// colours and buttons, with a cursor that moves in, clicks, and the result
// reveals — so the copy stays to a title and one line. All CSS-driven, no deps;
// prefers-reduced-motion stops the motion and shows the resting state.
import { useState } from "react";
import { useEscape } from "../useEscape";
import { Button, Select } from "./ui";
import { formatHotkey, getSettings, updateSettings } from "../settings";
import { format, SHORTCUT_PROFILES, type ShortcutProfile } from "../shortcuts";

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
  /** Animated mock of the relevant screen. */
  mock: React.ReactNode;
}

/** Shared pointer: an arrow that follows the scene's --cx/--cy vars, plus a
 *  click ripple at the target. Both animations share the scene's --dur. */
function Cursor() {
  return (
    <>
      <div className="ob-cursor" aria-hidden>
        <svg viewBox="0 0 12 12" width="15" height="15">
          <path className="ob-cursor-arrow" d="M1 1 L1 10 L3.5 7.5 L5.5 11 L7 10 L5 6.7 L8.5 6.7 Z" />
        </svg>
      </div>
      <div className="ob-click" aria-hidden />
    </>
  );
}

/** A framed mini-screen: window chrome, a body, and the shared cursor.
 *  `vars` sets the cursor start (--cx0/--cy0) and target (--cx1/--cy1). */
function Scene({
  vars,
  chrome,
  children,
}: {
  vars: React.CSSProperties;
  chrome?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ob-scene" style={vars} aria-hidden>
      <div className="ob-chrome">
        <i />
        <i />
        <i />
        {chrome && <span>{chrome}</span>}
      </div>
      <div className="ob-body">{children}</div>
      <Cursor />
    </div>
  );
}

/** A CLI brand chip — a coloured square with a glyph, standing in for the
 *  real SVG marks the app uses. */
function Logo({ bg, glyph, fg = "#fff" }: { bg: string; glyph: string; fg?: string }) {
  return <span className="ob-logo" style={{ background: bg, color: fg }}>{glyph}</span>;
}

const SLIDES: Slide[] = [
  {
    icon: "⌨",
    title: "Keep your muscle memory",
    body: "Start with the shortcuts you already know.",
    mock: (
      <Scene chrome="keyboard shortcuts" vars={{ "--cx0": "248px", "--cy0": "22px", "--cx1": "150px", "--cy1": "67px" } as React.CSSProperties}>
        <div className="ob-col" style={{ gap: 5 }}>
          <div className="ob-row"><span className="grow">Canopy</span><span className="ob-chip">terminal-first</span></div>
          <div className="ob-row"><span className="grow">VS Code</span><span className="ob-mono">Ctrl+P</span></div>
          <div className="ob-row"><span className="grow">JetBrains</span><span className="ob-mono">Ctrl+Shift+N</span></div>
          <div className="ob-row"><span className="grow">Sublime Text</span><span className="ob-mono">Ctrl+P</span></div>
        </div>
      </Scene>
    ),
  },
  {
    icon: "✳",
    title: "Agents are the hero",
    body: "Natively manage your coding CLIs.",
    mock: (
      <Scene chrome="new project" vars={{ "--cx0": "240px", "--cy0": "24px", "--cx1": "78px", "--cy1": "44px" } as React.CSSProperties}>
        <div className="ob-cards">
          <div className="ob-card"><Logo bg="#2a2e42" glyph="›_" fg="#c9d1d9" /><span>Shell</span></div>
          <div className="ob-card sel"><Logo bg="#d97757" glyph="✳" /><span>Claude Code</span></div>
          <div className="ob-card"><Logo bg="#10a37f" glyph="◇" /><span>Codex CLI</span><span className="ob-card-badge">install</span></div>
          <div className="ob-card"><Logo bg="#f34e3f" glyph="A" /><span>Amp</span></div>
          <div className="ob-card"><Logo bg="#3b6fd6" glyph="»" /><span>Aider</span><span className="ob-card-badge">install</span></div>
        </div>
        <div className="ob-term ob-reveal">
          <span className="ob-mono muted">$ claude</span>
          <span className="ob-mono" style={{ color: "var(--ok)" }}>▍ ready</span>
        </div>
      </Scene>
    ),
  },
  {
    icon: "♻️",
    title: "Sessions and projects",
    body: "Every session and project, side by side.",
    mock: (
      <Scene vars={{ "--cx0": "60px", "--cy0": "22px", "--cx1": "168px", "--cy1": "12px" } as React.CSSProperties}>
        <div className="ob-ptabs">
          <span className="ob-ptab ob-taboff">canopy</span>
          <span className="ob-ptab ob-tabon">banana-app</span>
          <span className="ob-ptab-add">＋</span>
        </div>
        <div className="ob-cmphead">COMPONENTS</div>
        <div className="ob-cmp">▾ FRONTEND</div>
        <div className="ob-tree">├ src/App.tsx</div>
        <div className="ob-row ob-reveal" style={{ marginTop: 6 }}>
          <Logo bg="#d97757" glyph="✳" />
          <span className="grow ob-mono" style={{ overflow: "hidden", whiteSpace: "nowrap" }}>"add auth to the api"</span>
          <span className="ob-btn">Resume</span>
        </div>
      </Scene>
    ),
  },
  {
    icon: "🔀",
    title: "Git, PRs and issues",
    body: "Branches, diffs and tickets, built in.",
    mock: (
      <Scene chrome="Git" vars={{ "--cx0": "250px", "--cy0": "24px", "--cx1": "60px", "--cy1": "96px" } as React.CSSProperties}>
        <div className="ob-branchbar">
          <span className="ob-branch">⎇ fix/onboarding</span>
          <span style={{ color: "var(--ok)" }}>↑2</span><span className="muted">↓0</span>
          <span className="grow" /><span className="ob-chip">Push</span>
        </div>
        <div className="ob-gittabs"><span className="sel">Changes 2</span><span>Branches</span><span>PRs</span><span>Issues</span></div>
        <div className="ob-gfile"><span className="ob-gcode ok">M </span>src/App.tsx</div>
        <div className="ob-gfile"><span className="ob-gcode ok">M </span>src/index.css</div>
        <div style={{ position: "absolute", right: 9, bottom: 8 }}><span className="ob-btn">Commit 2</span></div>
      </Scene>
    ),
  },
  {
    icon: "🎙️",
    title: "Dictate, don't type",
    body: "Speak your prompts. Local, offline.",
    mock: (
      <Scene chrome="dictation" vars={{ "--cx0": "60px", "--cy0": "24px", "--cx1": "40px", "--cy1": "44px" } as React.CSSProperties}>
        <div className="ob-row" style={{ alignItems: "flex-start", minHeight: 34 }}>
          <span className="ob-mono ob-type" style={{ "--tw": "168px" } as React.CSSProperties}>add error handling to the parser</span>
        </div>
        <div className="ob-dictpill">
          <span className="ob-recdot" />
          <span>
            Listening —{" "}
            <span className="ob-mono">{formatHotkey(getSettings().dictationHotkey)}</span> inserts,
            Esc cancels
          </span>
        </div>
        <div className="ob-chip muted" style={{ position: "absolute", right: 9, bottom: 8 }}>Parakeet v3 · on-device</div>
      </Scene>
    ),
  },
  {
    icon: "🤝",
    title: "Your team, anywhere",
    body: "Join by code, drive agents from your phone, send a file.",
    mock: (
      <Scene chrome="Team" vars={{ "--cx0": "60px", "--cy0": "24px", "--cx1": "244px", "--cy1": "98px" } as React.CSSProperties}>
        <div className="ob-row" style={{ border: "none", background: "none", padding: "2px 0" }}>
          <span className="ob-dot ok" /><span style={{ color: "var(--ok)" }}>Hosting — you are the relay</span>
        </div>
        <div className="ob-code">123 4567</div>
        <div className="ob-card2" style={{ marginTop: 4 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--text)" }}>
            <span className="ob-lmark" style={{ background: "var(--accent)" }} />Review PR #42<span className="grow" />
            <span className="ob-btn">Open</span><span className="ob-chip">Dismiss</span>
          </div>
        </div>
      </Scene>
    ),
  },
  {
    icon: "🔎",
    title: "One search for everything",
    body: (
      <>
        <span className="ob-mono">{format("spot-search")}</span> finds anything, anywhere.
      </>
    ),
    mock: (
      <Scene chrome={format("spot-search")} vars={{ "--cx0": "250px", "--cy0": "22px", "--cx1": "120px", "--cy1": "58px" } as React.CSSProperties}>
        <div className="ob-row" style={{ borderColor: "var(--accent)" }}>
          <span className="ob-mono ob-type" style={{ "--tw": "96px" } as React.CSSProperties}>auth</span>
        </div>
        <div className="ob-row ob-reveal" style={{ marginTop: 5 }}>
          <Logo bg="#d97757" glyph="✳" /><span className="grow">"add auth to the api"</span><span className="ob-chip">session</span>
        </div>
        <div className="ob-row ob-reveal" style={{ marginTop: 4 }}>
          <span className="ob-mono grow">src/auth.rs</span><span className="ob-chip">file</span>
        </div>
        <div className="ob-row ob-reveal" style={{ marginTop: 4 }}>
          <span className="grow">Auth rewrite — what we decided</span><span className="ob-chip">note</span>
        </div>
      </Scene>
    ),
  },
  {
    icon: "📓",
    title: "Research and scratchpad",
    body: "Findings and parked thoughts — run from here.",
    mock: (
      <Scene chrome="Research" vars={{ "--cx0": "60px", "--cy0": "24px", "--cx1": "250px", "--cy1": "50px" } as React.CSSProperties}>
        <div className="ob-head">RESEARCH<span className="ob-badge">2</span></div>
        <div className="ob-row">
          <span className="ob-tid">0008</span>
          <span className="grow">why the tab dot and the tile disagree</span>
          <span className="ob-chip" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>implemented</span>
        </div>
        <div className="ob-subhead" style={{ marginTop: 6 }}>SCRATCHPAD</div>
        <div className="ob-row ob-reveal">
          <span className="ob-tid">0005</span>
          <span className="grow">bring the rail tooltips back</span>
          <span className="ob-btn">Hand to an agent</span>
        </div>
      </Scene>
    ),
  },
  {
    icon: "🪶",
    title: "That's the tour",
    body: "Local-first — nothing leaves your machine.",
    mock: (
      <Scene vars={{ "--cx0": "250px", "--cy0": "22px", "--cx1": "150px", "--cy1": "80px" } as React.CSSProperties}>
        <div className="ob-col" style={{ justifyContent: "center", alignItems: "center", height: "100%", gap: 10 }}>
          <div style={{ fontSize: 20 }}>🪶</div>
          <div className="ob-btn" style={{ padding: "6px 14px", fontSize: 11 }}>Create a project</div>
        </div>
      </Scene>
    ),
  },
];

export function Onboarding({ onClose, onCreateProject }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState<ShortcutProfile>(
    () => getSettings().keymapProfile,
  );
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
          <div className="onboarding-mock">{slide.mock}</div>
          <div className="set-head onboarding-title">
            <span aria-hidden>{slide.icon}</span> {slide.title}
          </div>
          <p className="onboarding-body">{slide.body}</p>
          {step === 0 && (
            <Select
              width="lg"
              aria-label="Keyboard shortcut profile"
              value={profile}
              onChange={(e) => {
                const next = e.target.value as ShortcutProfile;
                setProfile(next);
                updateSettings({ keymapProfile: next });
              }}
            >
              {SHORTCUT_PROFILES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} — {option.description}
                </option>
              ))}
            </Select>
          )}
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
          <Button
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}>
            Back
          </Button>
          {last ? (
            <Button variant="accent"
              onClick={onCreateProject}
              title="Close the intro and create your first project">
              Create a project
            </Button>
          ) : (
            <Button variant="accent" onClick={() => setStep((s) => s + 1)}>
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

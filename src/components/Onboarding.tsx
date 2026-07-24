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
    icon: "🌳",
    title: "Welcome to Canopy",
    body: "A local-first IDE for coding with agents.",
    mock: (
      <Scene vars={{ "--cx0": "250px", "--cy0": "20px", "--cx1": "150px", "--cy1": "62px" } as React.CSSProperties}>
        <div className="ob-col" style={{ alignItems: "center", justifyContent: "center", height: "100%", gap: 9 }}>
          <div className="ob-reveal" style={{ fontSize: 22 }}>🌳</div>
          <div className="ob-reveal ob-chip">no server · no account · no telemetry</div>
        </div>
      </Scene>
    ),
  },
  {
    icon: "▚",
    title: "The terminal is the hero",
    body: "Launch any agent CLI in a real terminal.",
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
    icon: "🎯",
    title: "One place for every agent",
    body: "Every session in one panel — answer prompts inline.",
    mock: (
      <Scene chrome="Agents" vars={{ "--cx0": "250px", "--cy0": "24px", "--cx1": "116px", "--cy1": "96px" } as React.CSSProperties}>
        <div className="ob-head">NEEDS YOUR INPUT<span className="ob-badge">1</span></div>
        <div className="ob-row" style={{ marginBottom: 6 }}>
          <span className="ob-dot run" /><Logo bg="#d97757" glyph="✳" /><b style={{ color: "var(--text)" }}>claude</b>
          <span className="ob-chip">⑂ auth</span><span className="grow" /><span className="muted">working</span>
        </div>
        <div className="ob-card2">
          <div style={{ color: "var(--text)" }}>🔔 Allow edit to <span className="ob-mono">src/auth.rs</span>?</div>
          <div style={{ display: "flex", gap: 6, marginTop: 5 }}>
            <span className="ob-btn2 ok">✓ Allow</span><span className="ob-btn2">✕ Deny</span>
          </div>
        </div>
      </Scene>
    ),
  },
  {
    icon: "♻️",
    title: "Sessions survive anything",
    body: "Close, quit, crash — resume with history intact.",
    mock: (
      <Scene chrome="canopy" vars={{ "--cx0": "60px", "--cy0": "22px", "--cx1": "250px", "--cy1": "78px" } as React.CSSProperties}>
        <div className="ob-head">PICK UP WHERE YOU LEFT OFF<span className="ob-badge">2</span></div>
        <div className="ob-subhead">Agent sessions — resume with history</div>
        <div className="ob-row" style={{ marginTop: 4 }}>
          <Logo bg="#d97757" glyph="✳" /><span className="grow ob-mono" style={{ overflow: "hidden", whiteSpace: "nowrap" }}>"add auth to the api"</span>
          <span className="ob-chip" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>⑂ auth</span>
          <span className="ob-btn">Resume</span>
        </div>
        <div className="ob-row ob-reveal" style={{ marginTop: 5, borderColor: "var(--ok)", color: "var(--ok)" }}>
          <span className="ob-dot ok" />restored · history intact
        </div>
      </Scene>
    ),
  },
  {
    icon: "⇄",
    title: "Diff-first, never a silent reload",
    body: "Every edit as a diff. Accept, or keep yours.",
    mock: (
      <Scene chrome="Session changes" vars={{ "--cx0": "250px", "--cy0": "24px", "--cx1": "244px", "--cy1": "36px" } as React.CSSProperties}>
        <div className="ob-diffbar">
          <span className="ob-difflabel">src/auth.rs</span><span className="ob-chip">Split</span>
          <span className="grow" />
          <span className="ob-chip">Keep mine</span><span className="ob-btn">Accept</span>
        </div>
        <div className="ob-rowflex" style={{ gap: 4, marginTop: 5 }}>
          <div className="ob-col grow" style={{ gap: 3 }}>
            <div className="ob-dline del"><span className="ob-gut">12</span><span className="ob-sign">-</span><span className="ob-bar" style={{ width: "70%" }} /></div>
            <div className="ob-dline"><span className="ob-gut">13</span><span className="ob-sign"> </span><span className="ob-bar" style={{ width: "55%" }} /></div>
            <div className="ob-dline del"><span className="ob-gut">14</span><span className="ob-sign">-</span><span className="ob-bar" style={{ width: "62%" }} /></div>
          </div>
          <div className="ob-col grow" style={{ gap: 3 }}>
            <div className="ob-dline add"><span className="ob-gut">12</span><span className="ob-sign">+</span><span className="ob-bar" style={{ width: "80%" }} /></div>
            <div className="ob-dline"><span className="ob-gut">13</span><span className="ob-sign"> </span><span className="ob-bar" style={{ width: "55%" }} /></div>
            <div className="ob-dline add"><span className="ob-gut">14</span><span className="ob-sign">+</span><span className="ob-bar" style={{ width: "66%" }} /></div>
          </div>
        </div>
      </Scene>
    ),
  },
  {
    icon: "📁",
    title: "Multi-project, multi-component",
    body: "Many labeled dirs, many projects, side by side.",
    mock: (
      <Scene vars={{ "--cx0": "60px", "--cy0": "22px", "--cx1": "168px", "--cy1": "12px" } as React.CSSProperties}>
        <div className="ob-ptabs">
          <span className="ob-ptab sel">canopy</span><span className="ob-ptab ob-flip-off">banana-app</span>
          <span className="ob-ptab sel ob-flip-on">banana-app</span><span className="ob-ptab-add">＋</span>
        </div>
        <div className="ob-cmphead">COMPONENTS</div>
        <div className="ob-cmp">▾ FRONTEND</div>
        <div className="ob-tree">├ src/App.tsx</div>
        <div className="ob-cmp">▸ BACKEND</div>
        <div className="ob-cmp">▸ DOCS</div>
      </Scene>
    ),
  },
  {
    icon: "🔀",
    title: "Git & PRs, built in",
    body: "Branches, diffs, PRs — commit without leaving.",
    mock: (
      <Scene chrome="Git" vars={{ "--cx0": "250px", "--cy0": "24px", "--cx1": "60px", "--cy1": "96px" } as React.CSSProperties}>
        <div className="ob-branchbar">
          <span className="ob-branch">⎇ fix/onboarding</span>
          <span style={{ color: "var(--ok)" }}>↑2</span><span className="muted">↓0</span>
          <span className="grow" /><span className="ob-chip">Push</span>
        </div>
        <div className="ob-gittabs"><span className="sel">Changes 2</span><span>Branches</span><span>Worktrees</span><span>PRs</span></div>
        <div className="ob-gfile"><span className="ob-gcode ok">M </span>src/App.tsx</div>
        <div className="ob-gfile"><span className="ob-gcode ok">M </span>src/index.css</div>
        <div style={{ position: "absolute", right: 9, bottom: 8 }}><span className="ob-btn">Commit 2</span></div>
      </Scene>
    ),
  },
  {
    icon: "🎫",
    title: "Your tickets, in the IDE",
    body: "Start work → a worktree on its branch, plus your agent.",
    mock: (
      <Scene chrome="Issues" vars={{ "--cx0": "250px", "--cy0": "24px", "--cx1": "258px", "--cy1": "64px" } as React.CSSProperties}>
        <div className="ob-pills">
          <span className="ob-pill"><Logo bg="#2a2e42" glyph="" /> GitHub Issues</span>
          <span className="ob-pill sel"><span className="ob-lmark" style={{ background: "#7b86e8" }} /> Linear</span>
        </div>
        <div className="ob-subhead" style={{ marginTop: 4 }}>IN PROGRESS <span className="ob-badge">3</span></div>
        <div className="ob-trow">
          <span className="ob-lmark" style={{ background: "#7b86e8" }} />
          <span className="ob-tid">ENG-214</span><span className="grow ob-ttitle">fix flaky auth test</span>
          <span className="ob-mine">you</span><span className="ob-play">▶</span>
        </div>
        <div className="ob-row ob-reveal" style={{ marginTop: 5 }}><span className="ob-dot run" />worktree + agent launched</div>
      </Scene>
    ),
  },
  {
    icon: "🤝",
    title: "Team collaboration, peer-to-peer",
    body: "Join by code. End-to-end encrypted, host to peer.",
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
    icon: "📊",
    title: "See what's actually running",
    body: "Every run a live service — status, CPU, memory.",
    mock: (
      <Scene chrome="report.md" vars={{ "--cx0": "250px", "--cy0": "22px", "--cx1": "96px", "--cy1": "30px" } as React.CSSProperties}>
        <div className="ob-runsrail">
          <span className="ob-runslabel">RUNS</span>
          <span className="ob-runchip sel"><span className="ob-dot run" />dev-server<span className="muted"> ↻ ✕</span></span>
          <span className="ob-runchip"><span style={{ color: "var(--ok)" }}>✓</span> build</span>
          <span className="ob-runchip"><span style={{ color: "var(--danger)" }}>✕</span> test</span>
        </div>
        <div className="ob-reveal" style={{ marginTop: 8, fontSize: 9, color: "var(--text-dim)", padding: "0 2px" }}>
          <span className="ob-dot run" style={{ display: "inline-block", marginRight: 5 }} />running — <span className="ob-mono">npm run dev</span> · :5173
        </div>
        <div className="ob-statusbar"><span>claude · opus</span><span className="grow" /><span className="ob-mono">12% cpu · 340 MB</span></div>
      </Scene>
    ),
  },
  {
    icon: "📄",
    title: "Open anything, install nothing",
    body: "Markdown, CSV, PDF, notebooks — rendered native.",
    mock: (
      <Scene vars={{ "--cx0": "240px", "--cy0": "14px", "--cx1": "118px", "--cy1": "12px" } as React.CSSProperties}>
        <div className="ob-ftabs">
          <span className="ob-ftab">📝 report.md</span>
          <span className="ob-ftab ob-flip-off">📄 spec.pdf</span>
          <span className="ob-ftab sel ob-flip-on">▦ data.csv</span>
          <span className="ob-ftab sel ob-flip-off">📝 report.md<span className="x"> ✕</span></span>
        </div>
        <div className="ob-pane ob-reveal">
          <div className="ob-sheetrow head"><span>A</span><span>B</span><span>C</span></div>
          <div className="ob-sheetrow"><span>revenue</span><span>1,204</span><span>+8%</span></div>
          <div className="ob-sheetrow"><span>churn</span><span>2.1%</span><span>−0.3</span></div>
        </div>
      </Scene>
    ),
  },
  {
    icon: "🎙️",
    title: "Talk into any field",
    body: "Local speech-to-text, one shortcut. Offline.",
    mock: (
      <Scene chrome="dictation" vars={{ "--cx0": "60px", "--cy0": "24px", "--cx1": "40px", "--cy1": "44px" } as React.CSSProperties}>
        <div className="ob-row" style={{ alignItems: "flex-start", minHeight: 34 }}>
          <span className="ob-mono ob-type" style={{ "--tw": "168px" } as React.CSSProperties}>add error handling to the parser</span>
        </div>
        <div className="ob-dictpill">
          <span className="ob-recdot" />
          <span>Listening — <span className="ob-mono">⌘D</span> inserts, Esc cancels</span>
        </div>
        <div className="ob-chip muted" style={{ position: "absolute", right: 9, bottom: 8 }}>Parakeet v3 · on-device</div>
      </Scene>
    ),
  },
  {
    icon: "🌐",
    title: "Drive your agents from a browser",
    body: "A remote control-panel for your own agents.",
    mock: (
      <Scene chrome="remote portal" vars={{ "--cx0": "250px", "--cy0": "24px", "--cx1": "150px", "--cy1": "88px" } as React.CSSProperties}>
        <div className="ob-portal">
          <div className="ob-deck"><span className="ob-recdot ok" />CanopyRemote<span className="grow" /><span className="muted">Connected</span></div>
          <div className="ob-gauges">
            <div className="ob-gauge"><b style={{ color: "var(--ok)" }}>2</b>live</div>
            <div className="ob-gauge"><b style={{ color: "var(--warn)" }}>1</b>needs you</div>
            <div className="ob-gauge"><b>3</b>idle</div>
          </div>
          <div className="ob-seg"><span className="sel">⚡ Agents</span><span>▢ Projects</span></div>
          <div className="ob-pcard ob-reveal"><span className="ob-dot ok" /><b>claude</b><span className="grow" /><span className="muted">⑂ auth</span></div>
          <div className="ob-fab">＋ New agent</div>
        </div>
      </Scene>
    ),
  },
  {
    icon: "📎",
    title: "Send files to a teammate",
    body: "Direct-first, relay fallback. Encrypted host to peer.",
    mock: (
      <Scene chrome="Team · Transfers" vars={{ "--cx0": "60px", "--cy0": "24px", "--cx1": "255px", "--cy1": "36px" } as React.CSSProperties}>
        <div className="ob-subhead">TRANSFERS</div>
        <div className="ob-xfer">
          <div className="ob-xhead">
            <span style={{ color: "var(--accent)", fontWeight: 700 }}>↑</span>
            <span className="grow">build.zip</span>
            <span className="ob-late-off ob-mono muted">63%</span>
            <span className="ob-late-on ob-mono" style={{ color: "var(--ok)" }}>done</span>
          </div>
          <div className="ob-xbar"><div className="ob-fill" /></div>
          <div className="ob-xsub">2.1 MB / 3.4 MB → ada</div>
        </div>
      </Scene>
    ),
  },
  {
    icon: "🪶",
    title: "That's the tour",
    body: "Light, offline, entirely yours. Ready?",
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

// The two faces of hibernation: a project being put to sleep, and one that is
// asleep waiting to be woken.
//
// Both are full-cover overlays over the project area rather than screens the
// app navigates to, and that is the whole trick of the wake: the frost stays
// exactly where it is while the real workspace rebuilds itself underneath, and
// only dissolves once the last terminal is back. Nothing jumps, nothing blanks
// — the project fades in already finished.
import { useEffect, useRef } from "react";
import type { Project } from "../projects";
import { snapshotSummary, wakeSteps, type ProjectSnapshot } from "../hibernation";
import { Button } from "./ui";

/** Drift positions for the ambient crystals. Fixed, not random: a random
 *  layout would reshuffle on every render (and every progress tick). */
const CRYSTALS = [
  { left: "8%", top: "18%", size: 13, delay: 0, dur: 15 },
  { left: "21%", top: "68%", size: 9, delay: 3.5, dur: 19 },
  { left: "34%", top: "34%", size: 7, delay: 7, dur: 22 },
  { left: "47%", top: "82%", size: 11, delay: 1.5, dur: 17 },
  { left: "62%", top: "24%", size: 8, delay: 5, dur: 21 },
  { left: "74%", top: "60%", size: 14, delay: 2.5, dur: 16 },
  { left: "86%", top: "38%", size: 9, delay: 6.5, dur: 20 },
  { left: "93%", top: "76%", size: 7, delay: 4, dur: 18 },
];

function Crystals() {
  return (
    <div className="hib-crystals" aria-hidden>
      {CRYSTALS.map((c, i) => (
        <span
          key={i}
          className="hib-crystal"
          style={{
            left: c.left,
            top: c.top,
            fontSize: c.size,
            animationDelay: `-${c.delay}s`,
            animationDuration: `${c.dur}s`,
          }}
        >
          ❄
        </span>
      ))}
    </div>
  );
}

/** The hero mark. Six arms drawn once on entry, then breathing — an SVG rather
 *  than the ❄ glyph so the draw-on and the thaw can be animated. */
function Snowflake({ className = "" }: { className?: string }) {
  return (
    <svg className={`hib-flake ${className}`} viewBox="0 0 100 100" aria-hidden>
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {[0, 60, 120, 180, 240, 300].map((deg) => (
          <g key={deg} transform={`rotate(${deg} 50 50)`}>
            <path d="M50 50 L50 10" />
            <path d="M50 20 L42 12" />
            <path d="M50 20 L58 12" />
            <path d="M50 32 L44 26" />
            <path d="M50 32 L56 26" />
          </g>
        ))}
      </g>
    </svg>
  );
}

const ago = (ms: number) => {
  const d = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} minutes ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} hours ago`;
  const days = Math.floor(d / 86400);
  return days === 1 ? "yesterday" : `${days} days ago`;
};

// ---------- going to sleep ----------

interface FreezeOverlayProps {
  project: Project;
  snapshot: ProjectSnapshot | null;
  /** The workspace behind has been put away and the wake screen has taken its
   *  place underneath — lift the frost off so the two cards cross-fade. */
  leaving?: boolean;
}

/** Shown over the live project for the beat between "Hibernate" and the
 *  workspace going away: it frosts over and everything it was holding is named
 *  as it is put away. */
export function FreezeOverlay({ project, snapshot, leaving }: FreezeOverlayProps) {
  const s = snapshotSummary(snapshot);
  const parts = [
    s.agents && `${s.agents} agent session${s.agents === 1 ? "" : "s"}`,
    s.terminals && `${s.terminals} terminal${s.terminals === 1 ? "" : "s"}`,
    s.files && `${s.files} file${s.files === 1 ? "" : "s"}`,
    s.views && `${s.views} view${s.views === 1 ? "" : "s"}`,
  ].filter(Boolean) as string[];
  return (
    <div
      className={`hib hib-freezing ${leaving ? "hib-lifting" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="hib-frost" />
      <Crystals />
      <div className="hib-card hib-card-freeze">
        <Snowflake className="hib-flake-freeze" />
        <h2 className="hib-title">Hibernating {project.name}</h2>
        <p className="hib-sub">
          {parts.length ? `Putting away ${parts.join(" · ")}.` : "Putting the workspace away."}
        </p>
      </div>
    </div>
  );
}

// ---------- asleep, and waking ----------

export interface WakeProgress {
  done: number;
  total: number;
  /** What is being restored right now. */
  label: string;
  /** Every step is finished; the frost is dissolving. */
  finished: boolean;
}

interface HibernationViewProps {
  project: Project;
  snapshot: ProjectSnapshot;
  /** Null until the user wakes it; then the live restore progress — at which
   *  point the screen has no controls, so the two below are moot. */
  progress: WakeProgress | null;
  onWake?: () => void;
  /** Throw the snapshot away and open the project empty. */
  onDiscard?: () => void;
}

export function HibernationView({
  project,
  snapshot,
  progress,
  onWake,
  onDiscard,
}: HibernationViewProps) {
  const steps = wakeSteps(snapshot);
  const s = snapshotSummary(snapshot);
  const waking = progress != null;
  const pct = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;
  // Keep the step being restored in view — a long workspace scrolls its list
  // rather than growing a card taller than the window.
  const currentRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    // Optional call: jsdom has no scrollIntoView, and keeping a line in view is
    // a nicety the wake must never fail over.
    currentRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [progress?.done]);

  const stats = [
    { n: s.agents, label: s.agents === 1 ? "agent session" : "agent sessions" },
    { n: s.terminals, label: s.terminals === 1 ? "terminal" : "terminals" },
    { n: s.files, label: s.files === 1 ? "file" : "files" },
    { n: s.views, label: s.views === 1 ? "view" : "views" },
  ].filter((x) => x.n > 0);

  return (
    <div
      className={`hib ${waking ? "hib-waking" : "hib-asleep"} ${
        progress?.finished ? "hib-thawed" : ""
      }`}
    >
      <div className="hib-frost" />
      <Crystals />
      <div className="hib-card">
        <Snowflake className={waking ? "hib-flake-melting" : "hib-flake-idle"} />
        <h2 className="hib-title">
          {waking ? `Waking ${project.name}` : `${project.name} is hibernating`}
        </h2>
        <p className="hib-sub">
          {waking
            ? "Putting everything back where you left it — this stays up until it's ready."
            : `Frozen ${ago(snapshot.at)}. Nothing is running: its terminals, agents and
               open files were all put away, and they come back exactly as they were.`}
        </p>

        {!waking && (
          <>
            {stats.length > 0 ? (
              <div className="hib-stats">
                {stats.map((x) => (
                  <div key={x.label} className="hib-stat">
                    <span className="hib-stat-n">{x.n}</span>
                    <span className="hib-stat-label">{x.label}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="hib-sub hib-empty">This project was asleep with nothing open.</p>
            )}
            <Button variant="accent" className="hib-wake" onClick={onWake} autoFocus>
              Wake the project from hibernation
            </Button>
            <button className="hib-discard" onClick={onDiscard}>
              Discard the snapshot and open it empty
            </button>
          </>
        )}

        {waking && (
          <div className="hib-progress">
            <div className="hib-bar">
              <div className="hib-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="hib-count">
              {progress!.finished
                ? "Ready"
                : `${Math.min(progress!.done + 1, progress!.total)} of ${progress!.total}`}
            </div>
            <ul className="hib-steps">
              {steps.map((step, i) => {
                const state =
                  i < progress!.done ? "done" : i === progress!.done ? "current" : "pending";
                return (
                  <li
                    key={i}
                    ref={state === "current" ? currentRef : undefined}
                    className={`hib-step hib-step-${state}`}
                  >
                    <span className="hib-step-mark">
                      {state === "done" ? "✓" : state === "current" ? "❄" : "·"}
                    </span>
                    <span className="hib-step-label">{step.label}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

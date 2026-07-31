// How long an agent has been working, on screen. Two numbers from one chip:
// the current uninterrupted stretch and this session's lifetime total — both
// working time, so a session left open overnight reads as the forty minutes it
// worked rather than the fourteen hours it existed. The arithmetic and the
// wording live in shared/agentDuration.ts, shared verbatim with the portal.
import {
  formatDuration,
  formatDurationWords,
  hasWorkingTime,
  workingTime,
  type ActiveTiming,
} from "../../shared/agentDuration";
import { useSecondTick } from "../useSecondTick";
import { StopwatchIcon } from "./icons";

interface AgentRuntimeProps {
  /** The session digest (or agent workspace) carrying the clock fields. */
  timing?: ActiveTiming;
  /** Whether the agent is believed to be working *right now*. Callers pass
   *  `agentLife(...).state === "working"`, never the raw digest state: a CLI
   *  that dies mid-turn leaves "working" on disk forever, and a timer counting
   *  up from that is worse than no timer. False freezes both numbers at what
   *  the hook actually credited. */
  live: boolean;
  /** `row` is the compact chip on a one-line agent row; `stat` matches the
   *  workspace header's tokens/cost chips.
   *
   *  They differ in how much they can say. An Agents-panel row is 300px wide by
   *  default, truncates to one line, and already spends that budget on the name,
   *  the directory and the branch — so it gets the one number that matters where
   *  it is (the live stretch while working, the lifetime total once stopped) and
   *  keeps the other in its tooltip. The workspace header is a full-width strip
   *  beside tokens and cost, so it shows both. */
  variant?: "row" | "stat";
}

/**
 * The runtime chip, or nothing at all when the session has never worked — a
 * `0:00` on a brand-new agent looks like a stopped clock rather than an honest
 * blank.
 *
 * This is deliberately the smallest component that shows the number: it
 * re-renders once a second while the agent is working, and the panel around it
 * must not.
 */
export function AgentRuntime({ timing, live, variant = "row" }: AgentRuntimeProps) {
  useSecondTick(live);
  const t = workingTime(timing, Date.now() / 1000, live);
  if (!hasWorkingTime(t)) return null;
  // Both numbers only where there is room for both, and only while one of them
  // is moving: on a stopped agent the "current" stretch is not current and the
  // lifetime total is the whole answer. Suppressed when they are equal too — a
  // first stretch has run === total, and "12:07 · 12:07" says nothing twice.
  const showBoth = variant === "stat" && live && t.run !== t.total;
  const title = live
    ? [
        `Working for ${formatDurationWords(t.run)} without a break`,
        `${formatDurationWords(t.total)} of work in this session`,
        "Time spent idle or waiting on you is not counted",
      ].join("\n")
    : [
        `${formatDurationWords(t.total)} of work in this session`,
        "Time spent idle or waiting on you is not counted",
      ].join("\n");
  return (
    <span className={`agent-runtime ${variant === "stat" ? "aw-stat" : ""}`} title={title}>
      <StopwatchIcon size={variant === "stat" ? 12 : 11} className="agent-runtime-mark" />
      {showBoth ? (
        <>
          {formatDuration(t.run)}
          <span className="agent-runtime-total">{formatDuration(t.total)}</span>
        </>
      ) : (
        // Working: how long this stretch has been going. Stopped: what the
        // session did in total — the number the tooltip leads with either way.
        formatDuration(live ? t.run : t.total)
      )}
    </span>
  );
}

// Typed accessor over policy.json. The manifest is the definition; this file
// only gives it a shape.
import raw from "./policy.json";

export interface Policy {
  /** Below this the session's whole process tree is doing nothing. */
  quietCpuPercent: number;
  /** How recently the pty must have painted for us to call it working. */
  quietOutputMs: number;
  /** Output this soon after the human typed is the CLI's echo, not work. */
  answerWindowMs: number;
  /** How long a hook event's claim of a turn in flight stands unaided. */
  hookTrustSecs: number;
  /** A process is here but nothing has spoken for it yet. */
  startupGraceSecs: number;
  /** How long quiet must hold before a tab falls into the Idle stack. */
  idleGroupDelayMs: number;
  /** The same fall when the CLI itself declared the turn over — short, and it
   *  overrides the active-tab hold, because a proven state outranks position. */
  provenIdleDelayMs: number;
  /** How old a digest may be before peers stop being told about it. */
  peerMaxAgeSecs: number;
  /** How long after a hook names an agent we may attribute a binary to it. */
  learnWindowSecs: number;
  /** The longest gap between events creditable to the working clock. */
  creditedGapSecs: number;
}

export const POLICY: Policy = raw as unknown as Policy;

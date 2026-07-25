// The lifecycle state a row should actually show, which is not always the one
// the hook stream last wrote.
//
// `state` comes from canopy_hook.rs, which moves it on the events a CLI fires.
// That makes every state as durable as the event that ends it — and "working"
// is ended by a Stop event some CLIs never send. A codex session that hits its
// usage limit prints the error, returns to its prompt, and fires nothing: its
// last event stays PostToolUse, so the digest reads "working" and the panel
// pulses a green dot at a session that stopped hours ago. Same for a CLI that
// crashes, is SIGKILLed, or loses its connection mid-turn.
//
// So "working" is corroborated rather than believed. Two signals have to agree
// before we stop believing it:
//
//   1. No hook event for a long time. Not sufficient alone — a legitimate tool
//      call can take ten minutes, and the events that bracket it are that far
//      apart by definition.
//   2. The session's process tree is using no CPU. Not sufficient alone
//      either — an agent waiting on a slow API response is idle-looking and
//      genuinely mid-turn.
//
// Together they are good enough: a `cargo build` is quiet in events but not in
// CPU, and a thinking agent is quiet in CPU but not for five minutes. What's
// left is honest uncertainty, so the state is `stale` — "no signal", not
// "finished". Nothing that acts on a finished agent (hibernation reclaims
// idle/ended sessions) may key on it, because we do not know that it is done.

/** How long a turn may go without a single hook event before the claim that it
 *  is still running needs corroborating. Deliberately generous: a long build
 *  or test run is a normal reason for silence. */
export const STALE_AFTER_SECS = 300;

/** Below this, the session's whole process tree is doing nothing. An agent
 *  streaming tokens or running a tool sits well above it. */
export const QUIET_CPU_PERCENT = 2;

export interface StateInputs {
  /** What the hook stream last said. */
  state?: string;
  /** Unix seconds of the last hook event for this session. */
  updated?: number;
  /** Total CPU% across the session's process tree, from the pty monitor. */
  cpu: number;
  /** Unix seconds now. */
  now: number;
}

/**
 * The state to display. Identical to the recorded one except for a `working`
 * session that has gone quiet in both senses, which becomes `stale`.
 */
export function effectiveState({ state, updated, cpu, now }: StateInputs): string | undefined {
  if (state !== "working") return state;
  // A digest written before `updated` existed can't be aged; believe it.
  if (!updated) return state;
  const silentFor = now - updated;
  if (silentFor < STALE_AFTER_SECS) return state;
  if (cpu >= QUIET_CPU_PERCENT) return state;
  return "stale";
}

/** How long a stale session has been silent, for the row's tooltip. */
export function silenceLabel(updated: number | undefined, now: number): string {
  if (!updated) return "some time";
  const mins = Math.floor((now - updated) / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

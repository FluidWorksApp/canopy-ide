// Is the brain connected — installed, signed in, and answering?
//
// One state for the whole app, so the settings row, a status-bar dot and a
// feature deciding whether to even try all read the same thing. It is set two
// ways: actively, by `checkBrainConnection` (a one-word probe on the cheap
// tier), and passively, by every `askBrain` outcome — a feature that just got
// "usage limit reached" has learned something the status should show without
// anyone spending a probe to rediscover it.

import { chosenBrainId } from "./brain";
import { askBrain, type BrainAnswer } from "./brainCall";

export type BrainConnectionState =
  | "unknown"
  | "checking"
  | "connected"
  | "signed-out"
  | "missing"
  | "rate-limited"
  | "error";

export type BrainConnection = {
  state: BrainConnectionState;
  /** Registry id of the brain CLI, when one was resolved. */
  cli: string | null;
  /** Display name of that CLI. */
  label: string | null;
  checkedAt: number | null;
  message?: string;
};

export const BRAIN_CONNECTION_EVENT = "canopy:brain-connection";

let current: BrainConnection = { state: "unknown", cli: null, label: null, checkedAt: null };

export function brainConnection(): BrainConnection {
  return current;
}

function set(next: BrainConnection): void {
  current = next;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BRAIN_CONNECTION_EVENT));
}

/** Hear about every change. Returns an unsubscribe. */
export function subscribeBrainConnection(cb: () => void): () => void {
  window.addEventListener(BRAIN_CONNECTION_EVENT, cb);
  return () => window.removeEventListener(BRAIN_CONNECTION_EVENT, cb);
}

/** Fold one askBrain outcome into the state. Called by askBrain itself.
 *
 *  Only outcomes that say something about the *connection* move it. A budget
 *  refusal never reached the CLI; invalid output means the brain answered
 *  (badly), which is still connected; a generic failure or timeout outside a
 *  probe is one feature's bad luck, not evidence the connection broke — the
 *  probe is what turns those into `error`. */
export function noteBrainOutcome(
  answer: BrainAnswer<unknown>,
  cli: { id: string; name: string } | null,
  opts: { probe?: boolean; now?: number } = {},
): void {
  // An answer from a CLI that is no longer the brain (a call that started
  // before the person switched) says nothing about the current one.
  if (cli && cli.id !== chosenBrainId()) return;
  const base = {
    cli: cli?.id ?? current.cli,
    label: cli?.name ?? current.label,
    checkedAt: opts.now ?? Date.now(),
  };
  if (answer.ok) {
    set({ ...base, state: "connected" });
    return;
  }
  switch (answer.reason) {
    case "no-brain":
      set({ ...base, cli: null, label: null, state: "missing", message: answer.message });
      return;
    case "signed-out":
      set({ ...base, state: "signed-out", message: answer.message });
      return;
    case "rate-limited":
      set({ ...base, state: "rate-limited", message: answer.message });
      return;
    case "invalid-output":
      set({ ...base, state: "connected" });
      return;
    case "failed":
    case "timeout":
      if (opts.probe) set({ ...base, state: "error", message: answer.message });
      return;
    case "over-budget":
      return;
  }
}

let inFlight: Promise<BrainConnection> | null = null;
/** Which brain the running probe is asking. */
let inFlightFor = "";

/** Probe the brain with a one-word question on the background tier. Coalesced:
 *  a second caller while a probe of the same brain runs gets the same answer;
 *  after a switch, the new brain is probed once the old probe ends. */
export function checkBrainConnection(cwd?: string): Promise<BrainConnection> {
  const target = chosenBrainId();
  if (inFlight && inFlightFor === target) return inFlight;
  if (inFlight) return inFlight.then(() => checkBrainConnection(cwd));
  inFlightFor = target;
  // Until the probe answers, the state belongs to the brain being asked, not
  // to whichever CLI answered last.
  set({
    ...current,
    ...(current.cli !== target ? { cli: target, label: null, checkedAt: null } : {}),
    state: "checking",
    message: undefined,
  });
  inFlight = (async () => {
    try {
      await askBrain({
        feature: "connect-probe",
        tier: "background",
        prompt: "Reply with the single word OK.",
        cwd: cwd ?? "",
        timeoutMs: 60_000,
      });
    } catch (err) {
      set({ ...current, state: "error", checkedAt: Date.now(), message: String(err) });
    }
    return current;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Tests only. */
export function resetBrainConnectionForTests(): void {
  current = { state: "unknown", cli: null, label: null, checkedAt: null };
  inFlight = null;
  inFlightFor = "";
}

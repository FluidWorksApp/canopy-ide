// Turns raw key events into dictation start/stop/cancel intents.
//
// The hard part is not the state machine, it is binding a BARE modifier
// without breaking typing. ⇧ is pressed hundreds of times an hour, and every
// one of those presses is a keydown followed by a keyup on the very key we are
// watching. The rule that makes it safe:
//
//   a modifier press only counts as a trigger if NOTHING ELSE was pressed
//   while it was down.
//
// Shift-A pollutes the Shift press, so it never triggers. Shift on its own
// does not, so it can. That single rule is what separates "hold ⇧ to talk"
// from "dictation starts every time I capitalise a letter", and every mode
// below is built on it.
//
// Everything here is deliberately host-agnostic and side-effect free apart
// from timers, so dictationTrigger.test.ts can drive it with fake timers
// instead of a real keyboard.
import type {
  DictationModKey,
  DictationTriggerMode,
  Hotkey,
} from "./settings";
import { matchesHotkey } from "./settings";

export interface TriggerTimings {
  /** How long a bare modifier must stay down before push-to-talk opens the
   *  mic. Long enough that a slow ⇧-then-letter does not reach it, short
   *  enough that it still feels like a key press. */
  holdMs: number;
  /** Window for the second tap of a double-tap, and for the re-press that
   *  latches a push-to-talk recording. SuprFlow uses 0.4s; so do we. */
  doubleTapMs: number;
  /** Grace period after releasing push-to-talk before the recording actually
   *  stops. Absorbs finger slips and hardware bounce, and gives the re-press
   *  that latches hands-free somewhere to land. */
  releaseGraceMs: number;
}

export const DEFAULT_TIMINGS: TriggerTimings = {
  holdMs: 400,
  doubleTapMs: 400,
  releaseGraceMs: 300,
};

export interface TriggerConfig {
  mode: DictationTriggerMode;
  key: DictationModKey;
  hotkey: Hotkey;
  timings?: TriggerTimings;
}

export interface TriggerActions {
  /** Open the mic. `latched` means the user is not holding anything, so only
   *  an explicit tap (or Esc) ends it. */
  start(latched: boolean): void;
  /** Close the mic and insert what was said. */
  stop(): void;
  /** Throw the recording away — the trigger turned out to be a mis-read. */
  cancel(): void;
  /** The host's own view of whether the mic is open. The trigger defers to it
   *  rather than tracking recording state in parallel: a recording can also
   *  end by Esc, by a backend error, or by a model download starting instead,
   *  and a duplicate copy of that state would drift out of sync and leave the
   *  key toggling the wrong way. */
  isRecording(): boolean;
}

/** Does this `KeyboardEvent.code` satisfy the configured trigger key? A bare
 *  name ("Shift") takes either side; a sided name takes only that one. */
export function matchesModKey(code: string, key: DictationModKey): boolean {
  if (code === key) return true;
  // "Shift" matches ShiftLeft/ShiftRight, but "ShiftLeft" must not match
  // "ShiftRight" — so only widen when the configured key has no side.
  if (/(Left|Right)$/.test(key)) return false;
  return code === `${key}Left` || code === `${key}Right`;
}

/** The modifier family a trigger key belongs to, as `getModifierState` names
 *  them. Both sides of a key share one family, which is why a sided binding
 *  still has to ignore its own family when testing for a chord. */
function modFamily(key: DictationModKey): string {
  return key.replace(/(Left|Right)$/, "");
}

const CHORD_FAMILIES = ["Meta", "Control", "Alt", "Shift"] as const;

/** Was some OTHER modifier already down when the trigger key was pressed?
 *  That makes the press part of a chord (⌘ held, ⇧ tapped) rather than a bare
 *  trigger. The trigger's own family is excluded because the browser reports a
 *  modifier as held on its own keydown — `e.shiftKey` is already true in the
 *  ShiftLeft keydown, so testing it would mark every press a chord. */
function chordedWithOther(e: KeyboardEvent, key: DictationModKey): boolean {
  const own = modFamily(key);
  return CHORD_FAMILIES.some((m) => m !== own && e.getModifierState(m));
}

type HoldPhase =
  /** Nothing pressed. */
  | "idle"
  /** Trigger key is down, hold timer running, not yet recording. */
  | "pending"
  /** Hold threshold passed, mic open, user still holding. */
  | "holding"
  /** Key released, stop scheduled — a re-press here latches instead. */
  | "releasing"
  /** Recording with nothing held; the next clean tap ends it. */
  | "latched";

export class DictationTrigger {
  private cfg: TriggerConfig;
  private readonly act: TriggerActions;
  private t: TriggerTimings;

  private phase: HoldPhase = "idle";
  /** Set when any non-trigger key goes down while the trigger key is held.
   *  Reset on each fresh trigger keydown. */
  private polluted = false;
  /** Whether the trigger key is physically down right now. */
  private down = false;
  /** Set when a keydown latched the recording on. The keyup that closes that
   *  same press must not immediately read as the "tap to stop" gesture —
   *  without this, a double-tap starts and stops in one motion. */
  private swallowNextUp = false;
  private lastTapAt = 0;
  private holdTimer: number | undefined;
  private stopTimer: number | undefined;

  constructor(cfg: TriggerConfig, act: TriggerActions) {
    this.cfg = cfg;
    this.act = act;
    this.t = cfg.timings ?? DEFAULT_TIMINGS;
  }

  /** Settings are read live, so a rebind takes effect on the next key press
   *  with no reload. Changing mode or key abandons any half-finished gesture. */
  configure(cfg: TriggerConfig) {
    const changed = cfg.mode !== this.cfg.mode || cfg.key !== this.cfg.key;
    this.cfg = cfg;
    this.t = cfg.timings ?? DEFAULT_TIMINGS;
    if (changed) this.reset();
  }

  /** Forget every in-flight gesture without emitting anything. Used when the
   *  recording ended by some other route (Esc, a backend error, a rebind) so
   *  the machine does not later try to stop something already stopped. */
  reset() {
    this.clearTimers();
    this.phase = "idle";
    this.polluted = false;
    this.down = false;
    this.swallowNextUp = false;
    this.lastTapAt = 0;
  }

  /** True while a bare-modifier gesture owns the current recording. The host
   *  uses this to know whether an Esc should also reset the machine. */
  get engaged(): boolean {
    return this.phase === "holding" || this.phase === "latched" || this.phase === "releasing";
  }

  private clearTimers() {
    if (this.holdTimer !== undefined) window.clearTimeout(this.holdTimer);
    if (this.stopTimer !== undefined) window.clearTimeout(this.stopTimer);
    this.holdTimer = undefined;
    this.stopTimer = undefined;
  }

  /** Feed a keydown. Returns true if the event was consumed as a trigger and
   *  the caller should preventDefault. Bare-modifier gestures deliberately
   *  return false — swallowing a Shift keydown would break typing outright. */
  handleKeyDown(e: KeyboardEvent): boolean {
    if (this.cfg.mode === "combo") {
      if (matchesHotkey(e, this.cfg.hotkey)) {
        // The combo is a plain toggle, exactly as it has always been.
        if (this.act.isRecording()) this.act.stop();
        else this.act.start(true);
        return true;
      }
      return false;
    }

    if (!matchesModKey(e.code, this.cfg.key)) {
      // Any other key while the trigger is held means the trigger was being
      // used as a modifier. Mark it, and if we had already opened the mic on
      // the strength of the hold, take it back.
      if (this.down || this.phase === "pending") {
        this.polluted = true;
        if (this.holdTimer !== undefined) {
          window.clearTimeout(this.holdTimer);
          this.holdTimer = undefined;
        }
        if (this.phase === "holding") {
          this.phase = "idle";
          this.act.cancel();
        } else if (this.phase === "pending") {
          this.phase = "idle";
        }
      }
      return false;
    }

    // --- the trigger key itself ---
    if (e.repeat) return false;

    const otherHeld = chordedWithOther(e, this.cfg.key);

    this.down = true;

    // Re-press inside the release grace period: the user tapped again rather
    // than letting the recording end, which is the hands-free latch.
    if (this.phase === "releasing") {
      this.clearTimers();
      this.phase = "latched";
      this.swallowNextUp = true;
      return false;
    }

    // A tap while already latched ends the recording.
    if (this.phase === "latched") {
      this.polluted = otherHeld;
      return false;
    }

    this.polluted = otherHeld;
    const now = Date.now();
    const isSecondTap = now - this.lastTapAt <= this.t.doubleTapMs;

    // A clean second tap latches, in both bare modes. In "hold" that is the
    // hands-free shortcut; in "doubleTap" it is the only way to start.
    if (isSecondTap && !this.polluted && !this.act.isRecording()) {
      this.lastTapAt = 0;
      this.phase = "latched";
      this.swallowNextUp = true;
      this.act.start(true);
      return false;
    }
    if (this.cfg.mode === "doubleTap") return false;

    this.phase = "pending";
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = undefined;
      if (this.phase !== "pending" || this.polluted || !this.down) return;
      if (this.act.isRecording()) return;
      this.phase = "holding";
      this.act.start(false);
    }, this.t.holdMs);
    return false;
  }

  /** Feed a keyup. */
  handleKeyUp(e: KeyboardEvent) {
    if (this.cfg.mode === "combo") return;
    if (!matchesModKey(e.code, this.cfg.key)) return;

    this.down = false;
    if (this.holdTimer !== undefined) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = undefined;
    }

    const clean = !this.polluted;

    if (this.swallowNextUp) {
      this.swallowNextUp = false;
      return;
    }

    if (this.phase === "latched") {
      // A full clean tap while latched is the stop gesture. A polluted one
      // (the user chorded with our key) is ignored, so dictation is not ended
      // by someone reaching for ⌘S mid-thought.
      if (clean) {
        this.phase = "idle";
        this.lastTapAt = 0;
        this.act.stop();
      }
      return;
    }

    if (this.phase === "holding") {
      // Release ends push-to-talk, but only after the grace period, so a
      // bounce or a deliberate re-press can still latch it instead.
      this.phase = "releasing";
      this.stopTimer = window.setTimeout(() => {
        this.stopTimer = undefined;
        if (this.phase !== "releasing") return;
        this.phase = "idle";
        this.act.stop();
      }, this.t.releaseGraceMs);
      return;
    }

    // Released before the hold threshold: a tap. Remember it so a second one
    // can pair with it into a latch.
    this.phase = "idle";
    if (clean) this.lastTapAt = Date.now();
  }

  /** Canopy lost focus. Held keys go stale the moment the window is not
   *  receiving events — the keyup for whatever is down will never arrive — so
   *  a push-to-talk recording must be abandoned. A latched recording has no
   *  held key to lose and deliberately survives focus changes: this lets the
   *  user navigate elsewhere in the app while continuing to dictate. */
  handleBlur() {
    if (this.phase === "latched") {
      this.clearTimers();
      this.down = false;
      this.polluted = false;
      this.swallowNextUp = false;
      this.lastTapAt = 0;
      return;
    }
    const wasRecording = this.engaged;
    this.reset();
    if (wasRecording) this.act.cancel();
  }
}

/** One-line description of the configured trigger, for the pill and Settings. */
export function describeTrigger(
  mode: DictationTriggerMode,
  keyLabel: string,
  hotkeyLabel: string,
): string {
  if (mode === "combo") return hotkeyLabel;
  if (mode === "hold") return `hold ${keyLabel}`;
  return `double-tap ${keyLabel}`;
}

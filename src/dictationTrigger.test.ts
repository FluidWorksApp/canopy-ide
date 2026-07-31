import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DictationTrigger, matchesModKey, DEFAULT_TIMINGS } from "./dictationTrigger";
import type { TriggerConfig } from "./dictationTrigger";
import { DEFAULT_DICTATION_HOTKEY } from "./settings";

/** Build a KeyboardEvent-shaped object. `held` lists modifier FAMILIES the
 *  browser would report as down at the moment of the event — for a modifier's
 *  own keydown that includes itself, which is exactly the case the pollution
 *  logic has to not trip over. */
function ev(code: string, held: string[] = [], repeat = false): KeyboardEvent {
  return {
    code,
    repeat,
    getModifierState: (m: string) => held.includes(m),
  } as unknown as KeyboardEvent;
}

function family(code: string): string {
  return code.replace(/(Left|Right)$/, "");
}

/** A key press with nothing else down: keydown reports its own family held. */
function tap(t: DictationTrigger, code: string, alsoHeld: string[] = []) {
  t.handleKeyDown(ev(code, [family(code), ...alsoHeld]));
  t.handleKeyUp(ev(code, alsoHeld));
}

function makeTrigger(over: Partial<TriggerConfig> = {}) {
  const calls: string[] = [];
  let recording = false;
  const t = new DictationTrigger(
    {
      mode: "hold",
      key: "ShiftLeft",
      hotkey: DEFAULT_DICTATION_HOTKEY,
      timings: DEFAULT_TIMINGS,
      ...over,
    },
    {
      start: (latched) => {
        recording = true;
        calls.push(latched ? "start:latched" : "start:hold");
      },
      stop: () => {
        recording = false;
        calls.push("stop");
      },
      cancel: () => {
        recording = false;
        calls.push("cancel");
      },
      isRecording: () => recording,
    },
  );
  return { t, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("matchesModKey", () => {
  it("takes either side for a bare family name", () => {
    expect(matchesModKey("ShiftLeft", "Shift")).toBe(true);
    expect(matchesModKey("ShiftRight", "Shift")).toBe(true);
  });

  it("does not let a sided binding match the other side", () => {
    expect(matchesModKey("ShiftLeft", "ShiftRight")).toBe(false);
    expect(matchesModKey("MetaLeft", "MetaRight")).toBe(false);
  });

  it("matches CapsLock, which has no sides", () => {
    expect(matchesModKey("CapsLock", "CapsLock")).toBe(true);
    expect(matchesModKey("ShiftLeft", "CapsLock")).toBe(false);
  });
});

describe("hold mode", () => {
  it("opens the mic once the key has been held past the threshold", () => {
    const { t, calls } = makeTrigger();
    t.handleKeyDown(ev("ShiftLeft", ["Shift"]));
    vi.advanceTimersByTime(DEFAULT_TIMINGS.holdMs + 10);
    expect(calls).toEqual(["start:hold"]);
  });

  it("inserts on release, after the grace period", () => {
    const { t, calls } = makeTrigger();
    t.handleKeyDown(ev("ShiftLeft", ["Shift"]));
    vi.advanceTimersByTime(DEFAULT_TIMINGS.holdMs + 10);
    t.handleKeyUp(ev("ShiftLeft"));
    expect(calls).toEqual(["start:hold"]);
    vi.advanceTimersByTime(DEFAULT_TIMINGS.releaseGraceMs + 10);
    expect(calls).toEqual(["start:hold", "stop"]);
  });

  // The whole reason a bare modifier is bindable at all.
  it("never triggers when the modifier is used to type a capital letter", () => {
    const { t, calls } = makeTrigger();
    t.handleKeyDown(ev("ShiftLeft", ["Shift"]));
    t.handleKeyDown(ev("KeyA", ["Shift"]));
    t.handleKeyUp(ev("KeyA", ["Shift"]));
    t.handleKeyUp(ev("ShiftLeft"));
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual([]);
  });

  it("takes back a recording if a letter arrives after a slow hold", () => {
    const { t, calls } = makeTrigger();
    t.handleKeyDown(ev("ShiftLeft", ["Shift"]));
    vi.advanceTimersByTime(DEFAULT_TIMINGS.holdMs + 10);
    expect(calls).toEqual(["start:hold"]);
    t.handleKeyDown(ev("KeyA", ["Shift"]));
    expect(calls).toEqual(["start:hold", "cancel"]);
    t.handleKeyUp(ev("ShiftLeft"));
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual(["start:hold", "cancel"]);
  });

  it("ignores a press that is part of a chord with another modifier", () => {
    const { t, calls } = makeTrigger();
    // ⌘ already down, then ⇧ — this is ⌘⇧, not a bare trigger.
    t.handleKeyDown(ev("ShiftLeft", ["Meta", "Shift"]));
    vi.advanceTimersByTime(DEFAULT_TIMINGS.holdMs + 10);
    expect(calls).toEqual([]);
  });

  it("latches hands-free when the key is re-pressed inside the grace period", () => {
    const { t, calls } = makeTrigger();
    t.handleKeyDown(ev("ShiftLeft", ["Shift"]));
    vi.advanceTimersByTime(DEFAULT_TIMINGS.holdMs + 10);
    t.handleKeyUp(ev("ShiftLeft"));
    vi.advanceTimersByTime(50);
    t.handleKeyDown(ev("ShiftLeft", ["Shift"]));
    t.handleKeyUp(ev("ShiftLeft"));
    // The pending stop was cancelled and never fires.
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual(["start:hold"]);
    // A later clean tap is what ends it.
    tap(t, "ShiftLeft");
    expect(calls).toEqual(["start:hold", "stop"]);
  });

  it("starts latched on a double-tap instead of a hold", () => {
    const { t, calls } = makeTrigger();
    tap(t, "ShiftLeft");
    vi.advanceTimersByTime(100);
    t.handleKeyDown(ev("ShiftLeft", ["Shift"]));
    expect(calls).toEqual(["start:latched"]);
    t.handleKeyUp(ev("ShiftLeft"));
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual(["start:latched"]);
  });
});

describe("doubleTap mode", () => {
  const cfg = { mode: "doubleTap" as const, key: "ShiftLeft" as const };

  it("does nothing on a single tap, however long", () => {
    const { t, calls } = makeTrigger(cfg);
    t.handleKeyDown(ev("ShiftLeft", ["Shift"]));
    vi.advanceTimersByTime(5000);
    t.handleKeyUp(ev("ShiftLeft"));
    expect(calls).toEqual([]);
  });

  it("starts latched on two quick taps and does not stop on that keyup", () => {
    const { t, calls } = makeTrigger(cfg);
    tap(t, "ShiftLeft");
    vi.advanceTimersByTime(100);
    tap(t, "ShiftLeft");
    expect(calls).toEqual(["start:latched"]);
  });

  it("ends on the next single tap", () => {
    const { t, calls } = makeTrigger(cfg);
    tap(t, "ShiftLeft");
    vi.advanceTimersByTime(100);
    tap(t, "ShiftLeft");
    vi.advanceTimersByTime(3000);
    tap(t, "ShiftLeft");
    expect(calls).toEqual(["start:latched", "stop"]);
  });

  it("does not start when the two taps are too far apart", () => {
    const { t, calls } = makeTrigger(cfg);
    tap(t, "ShiftLeft");
    vi.advanceTimersByTime(DEFAULT_TIMINGS.doubleTapMs + 100);
    tap(t, "ShiftLeft");
    expect(calls).toEqual([]);
  });

  // "Hello World" is shift-H … shift-W: both presses are polluted, so the
  // pair must not read as a double-tap.
  it("survives shifted typing that looks like a double-tap", () => {
    const { t, calls } = makeTrigger(cfg);
    t.handleKeyDown(ev("ShiftLeft", ["Shift"]));
    t.handleKeyDown(ev("KeyH", ["Shift"]));
    t.handleKeyUp(ev("KeyH", ["Shift"]));
    t.handleKeyUp(ev("ShiftLeft"));
    vi.advanceTimersByTime(120);
    t.handleKeyDown(ev("ShiftLeft", ["Shift"]));
    t.handleKeyDown(ev("KeyW", ["Shift"]));
    t.handleKeyUp(ev("KeyW", ["Shift"]));
    t.handleKeyUp(ev("ShiftLeft"));
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual([]);
  });

  it("keeps a latched recording when the key is chorded mid-dictation", () => {
    const { t, calls } = makeTrigger(cfg);
    tap(t, "ShiftLeft");
    vi.advanceTimersByTime(100);
    tap(t, "ShiftLeft");
    expect(calls).toEqual(["start:latched"]);
    // ⇧S while dictating — a chord, so it must not end the recording.
    t.handleKeyDown(ev("ShiftLeft", ["Shift"]));
    t.handleKeyDown(ev("KeyS", ["Shift"]));
    t.handleKeyUp(ev("KeyS", ["Shift"]));
    t.handleKeyUp(ev("ShiftLeft"));
    expect(calls).toEqual(["start:latched"]);
  });
});

describe("sided bindings", () => {
  it("ignores the other side of the same key", () => {
    const { t, calls } = makeTrigger({ key: "MetaRight" });
    t.handleKeyDown(ev("MetaLeft", ["Meta"]));
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual([]);
    t.handleKeyDown(ev("MetaRight", ["Meta"]));
    vi.advanceTimersByTime(DEFAULT_TIMINGS.holdMs + 10);
    expect(calls).toEqual(["start:hold"]);
  });
});

describe("combo mode", () => {
  it("toggles on the configured chord and reports the event consumed", () => {
    const { t, calls } = makeTrigger({ mode: "combo" });
    // Built from the default itself, which differs by platform (⌘D on macOS,
    // Alt+D elsewhere) — hardcoding one of them fails on the other.
    const h = DEFAULT_DICTATION_HOTKEY;
    const combo = {
      ...ev(h.code),
      metaKey: h.meta,
      ctrlKey: h.ctrl,
      altKey: h.alt,
      shiftKey: h.shift,
    } as KeyboardEvent;
    expect(t.handleKeyDown(combo)).toBe(true);
    expect(calls).toEqual(["start:latched"]);
    expect(t.handleKeyDown(combo)).toBe(true);
    expect(calls).toEqual(["start:latched", "stop"]);
  });

  it("leaves bare modifiers alone entirely", () => {
    const { t, calls } = makeTrigger({ mode: "combo" });
    tap(t, "ShiftLeft");
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual([]);
  });
});

describe("focus loss", () => {
  it("abandons a held recording, since its keyup will never arrive", () => {
    const { t, calls } = makeTrigger();
    t.handleKeyDown(ev("ShiftLeft", ["Shift"]));
    vi.advanceTimersByTime(DEFAULT_TIMINGS.holdMs + 10);
    t.handleBlur();
    expect(calls).toEqual(["start:hold", "cancel"]);
  });

  it("is a no-op when nothing was in flight", () => {
    const { t, calls } = makeTrigger();
    t.handleBlur();
    expect(calls).toEqual([]);
  });
});

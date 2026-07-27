// Hold a modifier, see the numbers. ⌘ (Ctrl off macOS) numbers the tabs in the
// pane bar; ⌥ (Alt off macOS) numbers the project pills. The number you press
// is where you land — so the shortcut teaches itself instead of living in a
// help sheet nobody opens.
import { useEffect, useState } from "react";
import { IS_MAC } from "./platform";

/** "tabs" is ⌘/Ctrl, "projects" is ⌥/Alt — named for what they reveal rather
 *  than for a key, because the key differs per platform. */
export type HintKey = "tabs" | "projects";

/** KeyboardEvent.key of the physical modifier behind each hint layer. */
const HINT_KEY: Record<HintKey, string> = {
  tabs: IS_MAC ? "Meta" : "Control",
  projects: "Alt",
};

/** True while `e` carries the modifier for `which` and no other — a chord like
 *  ⌘⇧N or Ctrl+⌘→ is somebody else's shortcut, not a request for hints. */
export function hintModifierOnly(e: KeyboardEvent, which: HintKey): boolean {
  if (e.shiftKey) return false;
  const wanted = which === "tabs" ? (IS_MAC ? "meta" : "ctrl") : "alt";
  const down = { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey };
  return (Object.keys(down) as (keyof typeof down)[]).every(
    (k) => down[k] === (k === wanted),
  );
}

/** 1-9 for Digit1..Digit9 and the numpad twins, else null. Reads `code` so a
 *  non-US layout still numbers its tabs the way the key is engraved. */
export function digitFromCode(code: string): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return m ? Number(m[1]) : null;
}

/** A modifier tapped and released on its own is usually on its way somewhere
 *  else (⌘C, Alt-tab). Waiting a beat keeps the hints out of that traffic. */
const HOLD_MS = 350;

/** True while the hint modifier for `which` is held down. Cleared the moment
 *  it is released, another key intrudes, or the window loses focus — a hint
 *  layer left painted over a window you've walked away from is a bug. */
export function useHeldModifier(which: HintKey, enabled = true): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setHeld(false);
      return;
    }
    const key = HINT_KEY[which];
    let timer: number | null = null;
    const disarm = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const clear = () => {
      disarm();
      setHeld((v) => (v ? false : v));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === key) {
        // Auto-repeat while held: the timer is already running (or done).
        if (e.repeat || timer !== null) return;
        if (!hintModifierOnly(e, which)) return;
        timer = window.setTimeout(() => {
          timer = null;
          setHeld(true);
        }, HOLD_MS);
        return;
      }
      // The digits are what the hints are for — pressing one keeps them up so
      // a second jump doesn't need the modifier released and held again.
      if (digitFromCode(e.code) !== null && hintModifierOnly(e, which)) return;
      clear();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.getModifierState(key)) clear();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    // Alt-tab and ⌘-tab leave the keyup on the other side of the switch, so
    // blur is the only signal that the key is no longer ours.
    window.addEventListener("blur", clear);
    return () => {
      disarm();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", clear);
    };
  }, [which, enabled]);

  return held;
}

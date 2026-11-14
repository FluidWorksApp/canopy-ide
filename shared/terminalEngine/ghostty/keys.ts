// A DOM keyboard event as the engine's key encoder wants it (see
// canopy-term-wasm `Terminal::encode_key`). The encoder owns every byte
// table; this only says which key it was.

export const MOD_SHIFT = 1;
export const MOD_ALT = 2;
export const MOD_CTRL = 4;
export const MOD_SUPER = 8;
export const MOD_CAPS = 64;
export const MOD_NUM = 128;

export interface KeyArgs {
  key: string;
  mods: number;
  /** What the key types, "" when it types nothing or a modifier claims it. */
  text: string;
  shifted: number;
  base: number;
  /** A character key with nothing but Shift held: plain typing. */
  plainText: boolean;
}

const NAMED: Record<string, string> = {
  Escape: "Escape",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Insert: "Insert",
  Delete: "Delete",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
  CapsLock: "CapsLock",
  ScrollLock: "ScrollLock",
  NumLock: "NumLock",
  PrintScreen: "PrintScreen",
  Pause: "Pause",
  ContextMenu: "Menu",
};

const KEYPAD: Record<string, string> = {
  Numpad0: "Kp0",
  Numpad1: "Kp1",
  Numpad2: "Kp2",
  Numpad3: "Kp3",
  Numpad4: "Kp4",
  Numpad5: "Kp5",
  Numpad6: "Kp6",
  Numpad7: "Kp7",
  Numpad8: "Kp8",
  Numpad9: "Kp9",
  NumpadDecimal: "KpDecimal",
  NumpadDivide: "KpDivide",
  NumpadMultiply: "KpMultiply",
  NumpadSubtract: "KpSubtract",
  NumpadAdd: "KpAdd",
  NumpadEnter: "KpEnter",
  NumpadEqual: "KpEqual",
};

const MODIFIERS: Record<string, string> = {
  ShiftLeft: "ModLeftShift",
  ShiftRight: "ModRightShift",
  ControlLeft: "ModLeftControl",
  ControlRight: "ModRightControl",
  AltLeft: "ModLeftAlt",
  AltRight: "ModRightAlt",
  MetaLeft: "ModLeftSuper",
  MetaRight: "ModRightSuper",
  OSLeft: "ModLeftSuper",
  OSRight: "ModRightSuper",
};

/** The character a physical key has on a US layout, from `event.code`. */
const US_PUNCTUATION: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  Space: " ",
};

export function usLayoutChar(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code[3].toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code[5];
  return US_PUNCTUATION[code] ?? "";
}

function singleScalar(text: string): boolean {
  if (!text) return false;
  const cp = text.codePointAt(0)!;
  return text.length === (cp > 0xffff ? 2 : 1);
}

export interface KeyOptions {
  mac: boolean;
  /** Option sends ESC + key instead of composing a character (macOS). */
  optionIsMeta: boolean;
}

/** null: not a key the terminal sends (an unknown named key, a dead key). */
export function keyArgs(ev: KeyboardEvent, options: KeyOptions): KeyArgs | null {
  let mods = 0;
  if (ev.shiftKey) mods |= MOD_SHIFT;
  if (ev.altKey) mods |= MOD_ALT;
  if (ev.ctrlKey) mods |= MOD_CTRL;
  if (ev.metaKey) mods |= MOD_SUPER;
  if (ev.getModifierState?.("CapsLock")) mods |= MOD_CAPS;
  if (ev.getModifierState?.("NumLock")) mods |= MOD_NUM;

  const modifier = MODIFIERS[ev.code];
  if (modifier && ["Shift", "Control", "Alt", "Meta", "OS"].includes(ev.key)) {
    return { key: modifier, mods, text: "", shifted: 0, base: 0, plainText: false };
  }

  // The keypad with Num Lock on types its characters; with it off the DOM
  // already reports the navigation key ("Home", "ArrowLeft"), handled below.
  const keypad = ev.location === 3 ? KEYPAD[ev.code] : undefined;
  if (keypad && (singleScalar(ev.key) || ev.key === "Enter")) {
    const typed = ev.key === "Enter" || ev.ctrlKey || ev.altKey || ev.metaKey ? "" : ev.key;
    return { key: keypad, mods, text: typed, shifted: 0, base: 0, plainText: false };
  }

  const named = NAMED[ev.key];
  if (named) return { key: named, mods, text: "", shifted: 0, base: 0, plainText: false };
  const fn = /^F([1-9]|[12][0-9]|3[0-5])$/.exec(ev.key);
  if (fn) return { key: ev.key, mods, text: "", shifted: 0, base: 0, plainText: false };

  const us = usLayoutChar(ev.code);
  // AltGr types a character (Windows and Linux report it as Ctrl+Alt).
  const altGraph = !options.mac && !!ev.getModifierState?.("AltGraph");
  if (altGraph) mods &= ~(MOD_ALT | MOD_CTRL);

  const optionMeta = options.mac && ev.altKey && options.optionIsMeta;
  if (optionMeta || ev.key === "Dead") {
    // Option composed something ("å", or a dead key waiting for a vowel).
    // As Meta, what is wanted is the key itself.
    if (!optionMeta || !us) return null;
    const shifted = ev.shiftKey && /^[a-z]$/.test(us) ? us.toUpperCase().codePointAt(0)! : 0;
    return { key: us, mods, text: "", shifted, base: 0, plainText: false };
  }

  if (!singleScalar(ev.key)) return null;

  const typed = ev.key;
  const lower = typed.toLowerCase();
  // The unshifted character of this key in the active layout: the typed
  // character when nothing shifted it, its lowercase for a letter, otherwise
  // the US key as the best available answer.
  let key: string;
  if (!ev.shiftKey && !ev.altKey) key = singleScalar(lower) ? lower : typed;
  else if (lower !== typed.toUpperCase() && singleScalar(lower)) key = lower;
  else key = us || typed;

  const claimed = (mods & (MOD_CTRL | MOD_ALT | MOD_SUPER)) !== 0;
  const shifted = ev.shiftKey && typed !== key ? typed.codePointAt(0)! : 0;
  const base = us && us !== key ? us.codePointAt(0)! : 0;
  return {
    key,
    mods,
    text: claimed ? "" : typed,
    shifted,
    base,
    plainText: !claimed,
  };
}

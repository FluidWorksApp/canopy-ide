// Recent dictations, and the hold-to-cycle picker that pastes one back.
//
// One dictation is one entry, however long it ran and however many passes the
// model needed internally — what you said in one press is one line here.
//
// The interaction is SuprFlow's, because it is the right one: hold the
// modifiers, tap the key to walk back through what you said, let go to paste
// whichever one you landed on. Tap and release immediately and you get the
// latest, which is the common case and costs no thought. The picker is on
// screen the whole time, so cycling is never blind.
//
// Storage and the cycle are both here and both side-effect free apart from
// localStorage, so dictationHistory.test.ts can drive them without a keyboard.
import type { Hotkey } from "./settings";

export interface TranscriptEntry {
  id: string;
  text: string;
  /** Epoch ms, for the "2m ago" line in the picker. */
  at: number;
}

const KEY = "canopy.dictationHistory";
/** Kept on disk. Generous — entries are a few hundred bytes and the whole
 *  point is that something you said an hour ago is still there. */
export const MAX_STORED = 100;
/** Shown in the picker. Past this, cycling by tapping stops being faster than
 *  retyping, and the overlay starts covering the thing you are pasting into. */
export const MAX_VISIBLE = 10;

function read(): TranscriptEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Anything malformed is dropped rather than thrown: a corrupt history must
    // never be the reason dictation itself stops working.
    return parsed.filter(
      (e): e is TranscriptEntry =>
        !!e &&
        typeof e.text === "string" &&
        typeof e.id === "string" &&
        typeof e.at === "number",
    );
  } catch {
    return [];
  }
}

function write(entries: TranscriptEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // A full quota is not worth failing a transcription over.
  }
}

export function loadHistory(): TranscriptEntry[] {
  return read();
}

/** Record a completed dictation. Newest first. Returns the new history so the
 *  caller can render it without a second read. */
export function pushTranscript(
  text: string,
  now = Date.now(),
): TranscriptEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return read();
  const entries = read();
  // Saying the same thing twice in a row is nearly always a retry after a bad
  // insert, and two identical rows make the picker harder to read for no gain.
  if (entries[0]?.text === trimmed) return entries;
  const next = [
    {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      text: trimmed,
      at: now,
    },
    ...entries,
  ];
  const capped = next.slice(0, MAX_STORED);
  write(capped);
  return capped;
}

export function removeTranscript(id: string): TranscriptEntry[] {
  const next = read().filter((e) => e.id !== id);
  write(next);
  return next;
}

export function clearHistory() {
  write([]);
}

/** "just now" / "4m ago" / "3h ago" / "2d ago". */
export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The modifiers a hotkey holds down, as the set whose release commits the
 *  pick. `matchesHotkey` demands an exact match on all four, so the same four
 *  flags define what "still holding it" means. */
export function heldModifiers(h: Hotkey): {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
} {
  return { meta: h.meta, ctrl: h.ctrl, alt: h.alt, shift: h.shift };
}

/** Whether every modifier the hotkey needs is still down. Extra modifiers are
 *  tolerated — only letting go matters. */
export function stillHolding(
  e:
    | KeyboardEvent
    | {
        metaKey: boolean;
        ctrlKey: boolean;
        altKey: boolean;
        shiftKey: boolean;
      },
  h: Hotkey,
): boolean {
  const need = heldModifiers(h);
  return (
    (!need.meta || e.metaKey) &&
    (!need.ctrl || e.ctrlKey) &&
    (!need.alt || e.altKey) &&
    (!need.shift || e.shiftKey)
  );
}

export interface CycleActions {
  /** Selection moved (or the picker opened) — render it. */
  show(entries: TranscriptEntry[], index: number): void;
  /** The user let go: paste this one and close. */
  commit(entry: TranscriptEntry): void;
  /** Closed with nothing pasted. */
  dismiss(): void;
}

/** The picker's state machine.
 *
 *  Open on the hotkey, advance on every further press of its key while the
 *  modifiers stay down, commit the moment they come up. Esc leaves without
 *  pasting; Delete drops the highlighted entry. Arrows work too, for anyone
 *  who would rather look than tap.
 *
 *  Nothing here touches the DOM — the host wires real events to `keydown` /
 *  `keyup` / `blur` and renders whatever `show` reports. */
export class HistoryCycle {
  private entries: TranscriptEntry[] = [];
  private index = 0;
  private open = false;
  private actions: CycleActions;
  private hotkey: Hotkey;
  private list: () => TranscriptEntry[];
  private remove: (id: string) => TranscriptEntry[];

  constructor(
    actions: CycleActions,
    hotkey: Hotkey,
    list: () => TranscriptEntry[],
    remove: (id: string) => TranscriptEntry[],
  ) {
    this.actions = actions;
    this.hotkey = hotkey;
    this.list = list;
    this.remove = remove;
  }

  get isOpen() {
    return this.open;
  }

  setHotkey(h: Hotkey) {
    this.hotkey = h;
  }

  /** Returns true when the event was consumed and must not reach the editor,
   *  the terminal, or the browser's own paste. */
  keydown(
    e: KeyboardEvent,
    matches: (e: KeyboardEvent, h: Hotkey) => boolean,
  ): boolean {
    if (matches(e, this.hotkey)) {
      if (!this.open) return this.begin();
      // Deliberate taps only. Leaning on the key would otherwise walk the list
      // at the OS repeat rate — thirty steps a second past ten entries is not
      // cycling, it is a blur. Still swallowed, so no stray character lands.
      if (e.repeat) return true;
      // Shift walks the other way, the way ⌘⇧Tab does.
      this.step(e.shiftKey ? -1 : 1);
      return true;
    }
    if (!this.open) return false;
    // A held hotkey with shift added reads as a different chord to
    // matchesHotkey, so check the bare key too rather than making the user
    // release and re-press to go back.
    if (e.code === this.hotkey.code && stillHolding(e, this.hotkey)) {
      if (!e.repeat) this.step(e.shiftKey ? -1 : 1);
      return true;
    }
    if (e.key === "Escape") {
      this.close();
      this.actions.dismiss();
      return true;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      this.step(1);
      return true;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      this.step(-1);
      return true;
    }
    if (e.key === "Enter") {
      this.confirm();
      return true;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      this.drop();
      return true;
    }
    return false;
  }

  /** Modifier release is the commit. Watched on keyup rather than a periodic
   *  check so the paste lands the instant the hand lifts. */
  keyup(e: KeyboardEvent): void {
    if (!this.open) return;
    if (!stillHolding(e, this.hotkey)) this.confirm();
  }

  /** Losing the window mid-cycle must not leave a picker stranded on screen
   *  with no way to reach it — nor paste something the user never chose. */
  blur(): void {
    if (!this.open) return;
    this.close();
    this.actions.dismiss();
  }

  private begin(): boolean {
    const entries = this.list().slice(0, MAX_VISIBLE);
    // Nothing said yet: swallow nothing, let the key through to whatever it
    // normally does.
    if (!entries.length) return false;
    this.entries = entries;
    this.index = 0;
    this.open = true;
    this.actions.show(this.entries, this.index);
    return true;
  }

  private step(delta: number) {
    const n = this.entries.length;
    if (!n) return;
    // Wraps, so holding the key never dead-ends at the oldest entry.
    this.index = (this.index + delta + n) % n;
    this.actions.show(this.entries, this.index);
  }

  private confirm() {
    const entry = this.entries[this.index];
    this.close();
    if (entry) this.actions.commit(entry);
    else this.actions.dismiss();
  }

  private drop() {
    const entry = this.entries[this.index];
    if (!entry) return;
    const rest = this.remove(entry.id).slice(0, MAX_VISIBLE);
    if (!rest.length) {
      this.close();
      this.actions.dismiss();
      return;
    }
    this.entries = rest;
    if (this.index >= rest.length) this.index = rest.length - 1;
    this.actions.show(this.entries, this.index);
  }

  private close() {
    this.open = false;
    this.entries = [];
    this.index = 0;
  }
}

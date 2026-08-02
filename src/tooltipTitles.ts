// The app's tooltip vocabulary is the native `title` attribute — four hundred
// of them, spread over every panel, rail, row and chip. The webview renders
// those as the platform's own grey box: unthemed, unstyled, a second later than
// you wanted it, and clipped to nothing on a long path. This module is the
// reading half of the fix — it turns one title string into the pieces the
// themed bubble draws, and says which elements may be upgraded at all.
// TooltipLayer.tsx does the hovering and drawing; Tooltip.tsx stays the
// hand-written component for surfaces that want a body, a chord and a variant.

export interface TipContent {
  /** One line, emphasised. Absent when the title is a paragraph (see PROSE). */
  label?: string;
  /** Dim continuation — everything after the first line, or the whole of a
   *  long single-line title. */
  body?: string;
  /** Mono chip, lifted out of a trailing "(⌘B)". */
  hint?: string;
}

/** A parenthesised tail is only a shortcut if it actually contains a key
 *  glyph — "(3 files)" and "(read-only)" are part of the sentence. */
const CHORD = /[⌘⇧⌃⌥⏎⌫⎋⌦↑↓←→]/;

/** A single-line title longer than this is prose, not a name: "Built the
 *  native Cleanup resources task and raised PR #260 — it found 82 GB…" set in
 *  the label's semibold reads as shouting. The bubble caps at 280px, which is
 *  roughly 45 characters a line — so this is "anything that would wrap". */
const PROSE = 48;

/** null when there is nothing worth showing (empty or whitespace-only title). */
export function parseTitle(raw: string): TipContent | null {
  const text = raw.replace(/\r/g, "").trim();
  if (!text) return null;

  const lines = text.split("\n");
  let label = lines[0].trim();
  const body = lines.slice(1).join("\n").trim() || undefined;

  let hint: string | undefined;
  const chord = label.match(/\s*\(([^()]{1,16})\)$/);
  if (chord && CHORD.test(chord[1])) {
    hint = chord[1].trim();
    label = label.slice(0, chord.index).trim();
  }

  // A title that is nothing but its chord keeps the chord as the label — a
  // bubble holding only a floating key chip explains nothing.
  if (!label && hint) return { label: hint };
  if (!label) return body ? { body } : null;
  if (!body && !hint && label.length > PROSE) return { body: label };
  return { label, body, hint };
}

/** Elements whose `title` is not a tooltip, or cannot be overlaid by us:
 *  an <iframe> title is its accessible name and never renders; <option> and
 *  <optgroup> titles are drawn by the OS inside a native popup we cannot paint
 *  over. `data-native-title` is the deliberate opt-out. */
const SKIP = "iframe, option, optgroup, [data-native-title]";

export function upgradable(el: Element): boolean {
  if (el.matches(SKIP)) return false;
  // Our own bubble carries no titles, but a future one might; never recurse.
  return el.closest(".cnp-tooltip") == null;
}

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/** Which way a trigger wants its bubble to open. Vertical is the default and
 *  right for anything in a horizontal row — a toolbar, a tab strip. A vertical
 *  strip is the opposite case: the activity rail is a column of icons, and a
 *  bubble under one covers the next icon down, which is exactly where the
 *  pointer is heading. Declared by the trigger (`data-tip-side`), because only
 *  the trigger knows which way its neighbours lie. */
export type TipSide = "vertical" | "right" | "left";

export interface Placement {
  left: number;
  top: number;
  side: "top" | "bottom" | "right" | "left";
  /** Arrow offset from the bubble's left edge, in px. */
  arrow: number;
}

/** Gap between trigger and bubble, and the bubble's margin from the edges. */
const GAP = 10;
const MARGIN = 6;
/** Keeps the arrow off the rounded corners (radius 8/12 plus its own width). */
const ARROW_INSET = 15;

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** Above the trigger when it fits, below when it doesn't; horizontally centred
 *  on the trigger and pulled back inside the window. Viewport coordinates —
 *  the bubble is position:fixed, because a `title` can be on any element in
 *  the app and there is no wrapper for it to be relative to. */
export function placeTip(
  anchor: Box,
  tip: { width: number; height: number },
  view: { width: number; height: number },
  prefer: TipSide = "vertical",
): Placement {
  if (prefer !== "vertical") {
    // Beside the trigger, centred on it. Flips to the other side when the
    // preferred one cannot hold the bubble — a rail on the right edge of the
    // window wants its tips on the left — and clamps into the viewport the
    // same way the vertical case does.
    const fitsRight = anchor.right + GAP + tip.width <= view.width - MARGIN;
    const fitsLeft = anchor.left - GAP - tip.width >= MARGIN;
    const side: "right" | "left" =
      prefer === "right" ? (fitsRight || !fitsLeft ? "right" : "left") : fitsLeft || !fitsRight ? "left" : "right";
    const rawLeft = side === "right" ? anchor.right + GAP : anchor.left - GAP - tip.width;
    const left = Math.max(MARGIN, Math.min(rawLeft, view.width - tip.width - MARGIN));
    const middle = anchor.top + anchor.height / 2;
    const top = Math.max(
      MARGIN,
      Math.min(middle - tip.height / 2, view.height - tip.height - MARGIN),
    );
    const arrow = clamp(middle - top, ARROW_INSET, Math.max(ARROW_INSET, tip.height - ARROW_INSET));
    return { left, top, side, arrow };
  }
  const above = anchor.top - GAP - tip.height;
  const fitsAbove = above >= MARGIN;
  const fitsBelow = anchor.bottom + GAP + tip.height <= view.height - MARGIN;
  // Open away from the nearer edge, then fall back to the other side if the
  // preferred one cannot hold the bubble. Preferring "above whenever it fits"
  // put the bubble over the window's own chrome for anything in the top bar —
  // a tab, a stack chip, a toolbar button — which fits the viewport and still
  // lands on top of the title bar and the project tabs.
  const roomAbove = anchor.top - GAP - MARGIN;
  const roomBelow = view.height - anchor.bottom - GAP - MARGIN;
  // …and when the bubble fits on neither side, the roomier one still wins, so
  // the clamp below eats as little of the trigger as it can.
  const preferTop = roomAbove >= roomBelow;
  const side: "top" | "bottom" = preferTop
    ? fitsAbove || !fitsBelow
      ? "top"
      : "bottom"
    : fitsBelow || !fitsAbove
      ? "bottom"
      : "top";
  const rawTop = side === "top" ? above : anchor.bottom + GAP;
  // Math.max last: a bubble taller than the window is clamped to the top edge
  // rather than to a negative offset.
  const top = Math.max(MARGIN, Math.min(rawTop, view.height - tip.height - MARGIN));

  const centre = anchor.left + anchor.width / 2;
  const left = Math.max(
    MARGIN,
    Math.min(centre - tip.width / 2, view.width - tip.width - MARGIN),
  );

  const arrow = clamp(centre - left, ARROW_INSET, Math.max(ARROW_INSET, tip.width - ARROW_INSET));
  return { left, top, side, arrow };
}

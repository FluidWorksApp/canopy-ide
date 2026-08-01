// The shape of what's coming, held in place while it loads.
//
// A view that opens as one line of dim text and then rearranges itself into
// cards is a view you have to re-read every time you open it: you find the
// title, and then the title moves. These placeholders take the space the real
// content is going to take, so what arrives fills a frame that was already
// there instead of shoving the page around underneath the cursor.
//
// The rule for using them: skeleton the *content*, never the chrome. Anything
// already known at first paint — a section's title, a card's border, a toolbar —
// renders for real, and only the parts still in flight get stubbed. A skeleton
// that also fakes the headings is just a second layout to step through.

import type { ReactNode } from "react";

/** Widths for stubbed prose. A fixed cycle rather than random ones: a random
 *  width is re-rolled on every render, so the placeholder flickers while it
 *  waits — the one thing it exists to avoid. */
const LINE_WIDTHS = ["97%", "89%", "94%", "83%", "91%", "86%"];

export interface SkeletonProps {
  /** CSS width. A number is px; anything else passes through (`"60%"`). */
  w?: number | string;
  /** CSS height in px. Defaults to a text line. */
  h?: number;
  /** Round it fully — for avatars, dots and pills. */
  round?: boolean;
  className?: string;
}

/** One placeholder bar. */
export function Skeleton({ w, h = 11, round, className = "" }: SkeletonProps) {
  return (
    <span
      className={`cnp-skel ${round ? "is-round" : ""} ${className}`}
      style={{
        width: typeof w === "number" ? `${w}px` : w,
        height: `${h}px`,
        ...(round ? { borderRadius: "999px" } : null),
      }}
    />
  );
}

export interface SkeletonTextProps {
  /** How many lines of prose to stand in for. */
  lines?: number;
  className?: string;
}

/** A paragraph's worth of bars, ragged on the right the way prose is. */
export function SkeletonText({ lines = 3, className = "" }: SkeletonTextProps) {
  return (
    <div className={`cnp-skel-text ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          // The last line stops short, because the last line of a paragraph
          // does. Without it a block of even bars reads as a table.
          w={i === lines - 1 ? "58%" : LINE_WIDTHS[i % LINE_WIDTHS.length]}
        />
      ))}
    </div>
  );
}

export interface SkeletonBoxProps {
  /** What's loading, in the user's words — announced, not drawn. */
  label: string;
  children: ReactNode;
  className?: string;
}

/** Wraps a group of placeholders and gives it the one thing bars can't carry:
 *  a name. Empty spans announce as nothing, so without this a screen reader is
 *  told the panel is simply blank; this says "Loading the conversation" once,
 *  politely, for anyone who isn't looking at the shimmer. */
export function SkeletonBox({ label, children, className = "" }: SkeletonBoxProps) {
  return (
    <div
      className={`cnp-skel-box ${className}`}
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      {children}
    </div>
  );
}

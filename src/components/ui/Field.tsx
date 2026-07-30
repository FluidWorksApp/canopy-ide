import type { ReactNode } from "react";

/** How wide a control is, chosen from a scale rather than per call site.
 *  `xs` a number, `sm` a short word, `md` a name, `lg` a path or a sentence,
 *  `full` fills its row. */
export type ControlWidth = "xs" | "sm" | "md" | "lg" | "full" | "auto";

export const widthClass = (w: ControlWidth = "auto"): string =>
  w === "auto" ? "" : `ctl-w-${w}`;

/**
 * Controls side by side. Related settings that each need only a few
 * characters — a font, a size, a cursor style — read as one decision on one
 * row; stacked full-width they read as three, and the page turns into a
 * column of near-empty boxes.
 *
 * Wraps rather than overflowing, so a narrow window degrades to stacked
 * instead of clipping.
 */
export function Row({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`ctl-row ${className}`.trim()}>{children}</div>;
}

/**
 * One control with its own small label. Only needed inside a `Row` — a
 * control that owns its whole section is already named by the section
 * heading, and labelling it twice is noise.
 */
export function Field({
  label,
  children,
  className = "",
}: {
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ctl-field ${className}`.trim()}>
      {label && <span className="ctl-field-label">{label}</span>}
      {children}
    </div>
  );
}

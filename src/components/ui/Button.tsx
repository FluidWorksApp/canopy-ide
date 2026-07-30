import type { ButtonHTMLAttributes, ReactNode } from "react";

/** What the button *is*, not what it looks like. The skin decides the colour;
 *  this decides which job the button is doing in the row it sits in.
 *
 *  - `default` — the ordinary action. Most buttons.
 *  - `accent`  — the one thing this view is for. At most one per row.
 *  - `danger`  — destroys work. Never the default focus target.
 *  - `ghost`   — a button that shouldn't look like one until you reach it:
 *                toolbar and header actions that would otherwise draw a grid
 *                of boxes across the chrome.
 */
export type ButtonVariant = "default" | "accent" | "danger" | "ghost";

/** `md` in dialogs and forms, `sm` in chrome — tab strips, pane bars, rows.
 *  Both come off the same --ctl-h scale as every other control, so a button
 *  beside a select beside an input is one straight line. */
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Square, icon-only. Pass an accessible name via `title` or `aria-label` —
   *  there is no text for a screen reader to fall back on. */
  icon?: boolean;
  children?: ReactNode;
}

const VARIANT: Record<ButtonVariant, string> = {
  default: "",
  accent: "btn-accent",
  danger: "btn-danger",
  ghost: "btn-ghost",
};

/**
 * The button. There is one, and this is it.
 *
 * Before this component the app had four unrelated button systems — `.btn`,
 * `.dlg-btn*`, `.icon-btn`, `.btn-icon` — plus six one-offs, so the same
 * action rendered at three heights depending on which view you opened it
 * from. Everything routes through here now; `className` is still forwarded
 * for genuine one-off positioning (a grid area, a margin), but anything that
 * changes how the button *looks* belongs in a variant, not a call site.
 */
export function Button({
  variant = "default",
  size = "md",
  icon = false,
  className = "",
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    icon ? "btn-icon" : "btn",
    size === "sm" ? (icon ? "btn-icon-sm" : "btn-sm") : "",
    VARIANT[variant],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  // type="button" by default: an unqualified <button> inside a <form>
  // submits it, which in this app means a full page reload of the webview.
  return (
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  );
}

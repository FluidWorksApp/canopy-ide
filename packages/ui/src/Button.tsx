import type { ButtonHTMLAttributes, Ref } from "react";
import "./Button.css";

export type ButtonVariant = "default" | "accent" | "danger" | "danger-solid";
export type ButtonSize = "default" | "mini" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** What the button means. `danger` is quiet until hover; `danger-solid` is the
   *  one you press to confirm a delete. */
  variant?: ButtonVariant;
  /** How much room it takes. `icon` is chromeless — a clickable glyph. */
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
}

const VARIANT: Record<ButtonVariant, string> = {
  default: "",
  accent: "cn-btn-accent",
  danger: "cn-btn-danger",
  "danger-solid": "cn-btn-danger-solid",
};

const SIZE: Record<ButtonSize, string> = {
  default: "",
  mini: "cn-btn-mini",
  icon: "cn-btn-icon",
};

/**
 * The only button in the system.
 *
 * `type` defaults to "button". HTML defaults it to "submit", which inside a
 * form turns any unmarked button into a submit — the reason a Cancel button can
 * silently save instead.
 */
export function Button({
  variant = "default",
  size = "default",
  type = "button",
  className,
  ref,
  ...rest
}: ButtonProps) {
  const cls = ["cn-btn", VARIANT[variant], SIZE[size], className]
    .filter(Boolean)
    .join(" ");
  return <button ref={ref} type={type} className={cls} {...rest} />;
}

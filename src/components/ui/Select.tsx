import type { SelectHTMLAttributes } from "react";
import { type ControlWidth, widthClass } from "./Field";

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  width?: ControlWidth;
  size?: "md" | "sm";
}

/**
 * A dropdown that belongs to the app rather than to the OS.
 *
 * It is still a real `<select>` — the option list is the platform's, which
 * means keyboard behaviour, type-ahead and long lists all work the way the
 * user expects, and no popover of ours can be clipped by a dialog's
 * `overflow: hidden`. Only the closed control is ours: `appearance: none`
 * removes the grey macOS widget and its double chevron, and the caret is
 * redrawn as a mask so it follows the skin.
 */
export function Select({
  width = "md",
  size = "md",
  className = "",
  ...rest
}: SelectProps) {
  return (
    <span className={`ctl-select-wrap ${widthClass(width)}`.trim()}>
      <select
        className={`ctl ctl-select ${size === "sm" ? "ctl-sm" : ""} ${className}`.trim()}
        {...rest}
      />
    </span>
  );
}

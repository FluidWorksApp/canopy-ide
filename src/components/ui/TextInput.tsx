import type { InputHTMLAttributes } from "react";
import { type ControlWidth, widthClass } from "./Field";

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  width?: ControlWidth;
  size?: "md" | "sm";
  /** Renders the magnifier in the gutter. A search box is a text input with a
   *  mark on it — not, as it had become in three places, its own widget with
   *  its own height and its own corner radius. */
  search?: boolean;
}

export function TextInput({
  width = "md",
  size = "md",
  search = false,
  className = "",
  type = "text",
  ...rest
}: TextInputProps) {
  const input = (
    <input
      type={type}
      className={`ctl ${size === "sm" ? "ctl-sm" : ""} ${search ? "" : widthClass(width)} ${className}`.trim()}
      {...rest}
    />
  );
  if (!search) return input;
  return (
    <span className={`ctl-search-wrap ${widthClass(width)}`.trim()}>{input}</span>
  );
}

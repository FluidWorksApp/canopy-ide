import type { ReactNode } from "react";

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** The line under the label saying what turning it on actually does. A
   *  checkbox whose label is a noun phrase almost always needs one. */
  hint?: ReactNode;
  disabled?: boolean;
}

/**
 * A checkbox and its label as one thing, because they were never separable:
 * every call site wrapped the input in a `<label>` by hand, and the ones that
 * forgot produced a box you couldn't click the text of.
 *
 * The box itself is drawn in CSS (see `.set-inline-check input`) rather than
 * left to the UA, which renders a 13px system control with a system-blue tick
 * that ignores the skin completely.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: CheckboxProps) {
  return (
    <label className={`set-inline-check ${hint ? "has-hint" : ""}`.trim()}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint && <em>{hint}</em>}
      </span>
    </label>
  );
}

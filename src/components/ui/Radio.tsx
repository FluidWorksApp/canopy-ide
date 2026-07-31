import type { ReactNode } from "react";

export interface RadioProps {
  /** The `name` every option in the group shares — what makes them one choice. */
  name: string;
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  /** The line under the label saying what picking this one costs. */
  hint?: ReactNode;
  disabled?: boolean;
}

/**
 * One option of a group, drawn like `Checkbox` because the two sit in the same
 * lists — before this, every radio in the app was a hand-rolled `<label>` and
 * the ones that got the markup wrong lost their hint styling.
 */
export function Radio({
  name,
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: RadioProps) {
  return (
    <label className={`set-inline-check ${hint ? "has-hint" : ""}`.trim()}>
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span>
        {label}
        {hint && <em>{hint}</em>}
      </span>
    </label>
  );
}

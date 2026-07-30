export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Required: a switch with no visible label needs an accessible name. */
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

/**
 * On/off for a thing that takes effect the moment you flip it — a server
 * starting, a permission opening. Distinct from `Checkbox`, which is a choice
 * you make as part of a form.
 *
 * The one this replaced was a `<button role="switch">` carrying eight inline
 * styles, including a hardcoded `#fff` knob and a track painted with
 * `var(--border)`. On a skin whose border is 7.5%-opacity white that read as
 * a blank white pill: the track vanished and the knob was the only thing
 * left. Styling lives in CSS with the rest of the controls now, so it follows
 * the skin like everything else.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      className="ctl-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="ctl-switch-knob" />
    </button>
  );
}

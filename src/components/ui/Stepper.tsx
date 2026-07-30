export interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Shown after the number — "px", "ms". Kept out of the value so the digits
   *  stay tabular and the control doesn't resize as you step through it. */
  suffix?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

/**
 * A small integer, stepped. Replaces `<input type="number">`, whose spinner
 * is a ~12px OS widget that no skin reaches, is close to unclickable, and
 * renders differently on each platform.
 *
 * Deliberately not typeable: every use of this in the app is a bounded value
 * you nudge (font size, a day count), and a free text field for those invites
 * the empty-string and out-of-range states that each call site then has to
 * handle. Clamping lives here instead.
 */
export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  disabled = false,
  "aria-label": ariaLabel,
}: StepperProps) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div
      className="ctl ctl-stepper"
      role="spinbutton"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={ariaLabel}
    >
      <button
        type="button"
        className="ctl-stepper-btn"
        disabled={disabled || value <= min}
        aria-label="Decrease"
        onClick={() => onChange(clamp(value - step))}
      >
        −
      </button>
      <span className="ctl-stepper-value">
        {value}
        {suffix}
      </span>
      <button
        type="button"
        className="ctl-stepper-btn"
        disabled={disabled || value >= max}
        aria-label="Increase"
        onClick={() => onChange(clamp(value + step))}
      >
        +
      </button>
    </div>
  );
}

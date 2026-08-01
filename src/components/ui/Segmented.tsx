import type { ReactNode } from "react";

export interface SegmentedOption<T extends string> {
  id: T;
  /** Usually a word. A node so a segment can carry a count beside it — see
   *  `.ctl-seg-count`, which sets that count back a step so the word stays the
   *  thing you read and the number stays the thing you check. */
  label: ReactNode;
}

export interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Names the group for screen readers — the buttons alone don't say what
   *  they are a choice between. */
  "aria-label"?: string;
}

/**
 * A small set of mutually exclusive choices, all visible at once. Use it when
 * there are two to four options and seeing them side by side is the point;
 * past that a `Select` is kinder.
 *
 * Sized off the same `--ctl-h` as every other control, so a segmented control
 * next to a button or a field lines up — and, just as importantly, so two of
 * them on the same page read as two controls rather than one long strip with
 * a gap in it.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  "aria-label": ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div className="ctl-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          disabled={disabled}
          className="ctl-seg-item"
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

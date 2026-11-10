// Molecule: a row of buttons with one selected value — the Agents buckets in the session list,
// the dashboard range, timeline density and zoom.
import { useId } from "react";
import "./SegmentedControl.scss";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string | number> {
  /** Group name; visible above the buttons with `showLabel`, otherwise only to assistive technologies. */
  label: string;
  showLabel?: boolean;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** sm — 32px (filters, timeline), md — 40px (dashboard range). */
  size?: "sm" | "md";
}

export function SegmentedControl<T extends string | number>({
  label,
  showLabel = false,
  options,
  value,
  onChange,
  size = "sm",
}: SegmentedControlProps<T>) {
  const labelId = useId();
  return (
    <div className="torch-segmented">
      {showLabel && (
        <span id={labelId} className="torch-segmented__label">
          {label}
        </span>
      )}
      <div
        role="group"
        className={`torch-segmented__group torch-segmented__group--${size}`}
        aria-label={showLabel ? undefined : label}
        aria-labelledby={showLabel ? labelId : undefined}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="torch-segmented__button"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

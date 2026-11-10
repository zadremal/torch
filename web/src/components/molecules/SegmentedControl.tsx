// Molecule: a row of buttons with one selected value — the Agents buckets in the session list,
// the dashboard range, timeline density and zoom.
import { useId } from "react";
import styles from "./SegmentedControl.module.css";

const GROUP_CLASS = { sm: `${styles.group} ${styles.groupSm}`, md: `${styles.group} ${styles.groupMd}` };

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
    <div className={styles.root}>
      {showLabel && (
        <span id={labelId} className={styles.label}>
          {label}
        </span>
      )}
      <div
        role="group"
        className={GROUP_CLASS[size]}
        aria-label={showLabel ? undefined : label}
        aria-labelledby={showLabel ? labelId : undefined}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={styles.button}
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

// A button mark on a lane. Its kind comes from the TimelineMark atom: its kind classes,
// error and dimming. The atom itself does not fit for two reasons: it has no place in the keyboard
// traversal order (`tabIndex`) and no mark number, by which the organism moves focus with the arrows, and
// its click-area pseudo-element is too expensive on thousands of marks (see Timeline.module.css).
import type { Selection } from "@contracts/selection.ts";
import { memo } from "react";
import markStyles from "../../atoms/TimelineMark.module.css";
import { MARK_KIND_CLASS, type TimelineMarkKind } from "../../atoms/TimelineMark.tsx";
import styles from "./Timeline.module.css";
import type { Mark as MarkModel } from "./model.ts";

export interface MarkProps {
  mark: MarkModel;
  /** Mark number in the lane. */
  index: number;
  selected: boolean;
  dimmed: boolean;
  /** The mark that Tab brings to this lane; the rest are reached with the arrows. */
  tabStop: boolean;
  onSelect: (sel: Selection) => void;
}

export const Mark = memo(function Mark({ mark, index, selected, dimmed, tabStop, onSelect }: MarkProps) {
  // The layout mark kind is one of the atom's kinds: a mismatch between the lists will not pass type checking.
  const kind: TimelineMarkKind = mark.kind;
  const className = [
    styles.mark,
    MARK_KIND_CLASS[kind],
    mark.error && markStyles.error,
    mark.error && styles.markError,
    dimmed && markStyles.dimmed,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={className}
      style={{ left: mark.left, width: mark.width, top: mark.top }}
      aria-label={mark.label}
      aria-pressed={selected}
      title={mark.label}
      tabIndex={tabStop ? 0 : -1}
      data-i={index}
      onClick={() => onSelect(mark.select)}
    >
      {mark.text}
    </button>
  );
});

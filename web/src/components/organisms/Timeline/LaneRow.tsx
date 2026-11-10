// Timeline row: the lane label and the lane with marks that fall into the render window.
// Props are primitives and immutable parts of the layout: the row is redrawn only when
// something that concerns it changes (horizontal window, selection in it, focus in it).
import type { Selection } from "@contracts/selection.ts";
import { type CSSProperties, type MouseEvent, memo, useMemo } from "react";
import type { Axis } from "./axis.ts";
import { Mark } from "./Mark.tsx";
import { type Lane, type LaneTitleTone, markDimmed, markSelected } from "./model.ts";
import styles from "./Timeline.module.css";
import { nearestMark, visibleMarks } from "./window.ts";

const TITLE_CLASS: Record<LaneTitleTone, string> = {
  plain: styles.title,
  strong: `${styles.title} ${styles.titleStrong}`,
  secondary: `${styles.title} ${styles.titleSecondary}`,
  mono: `${styles.title} ${styles.titleMono}`,
};

export interface LaneRowProps {
  lane: Lane;
  /** Row number in the layout: the keyboard uses it to find the lane. */
  row: number;
  top: number;
  axis: Axis;
  trackWidth: number;
  x0: number;
  x1: number;
  /** Lane background: axis tick lines. */
  gridStyle: CSSProperties;
  active: boolean;
  /** Selection record, if the selected mark sits in this lane. */
  selKey: string | null;
  /** Selected agent, if marks of the others are dimmed in this lane. */
  dimAgent: string | null;
  /** Key of the focused mark, if the focus is in this lane. */
  focusKey: string | null;
  onSelect: (sel: Selection) => void;
}

/** Indent of a nested subagent's label per level, px. */
const INDENT_STEP = 12;

export const LaneRow = memo(function LaneRow({
  lane,
  row,
  top,
  axis,
  trackWidth,
  x0,
  x1,
  gridStyle,
  active,
  selKey,
  dimAgent,
  focusKey,
  onSelect,
}: LaneRowProps) {
  const shown = useMemo(
    () => visibleMarks(lane, axis, { trackWidth, x0, x1 }, selKey, focusKey),
    [lane, axis, trackWidth, x0, x1, selKey, focusKey],
  );
  const isSelected = (index: number) => markSelected(lane.marks[index]!, selKey);
  // Tab brings to the lane the focused mark, otherwise the selected one, otherwise the first in the window.
  const focused = focusKey === null ? undefined : lane.index.get(focusKey);
  const tabStop = focused ?? shown.find(isSelected) ?? shown[0];

  // A click next to a narrow mark but missing it goes to the nearest one: the click area is wider than the mark.
  const onTrackClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const index = nearestMark(lane, axis, trackWidth, shown, x);
    if (index !== null) onSelect(lane.marks[index]!.select);
  };

  return (
    <div
      className={active ? `${styles.lane} ${styles.laneActive}` : styles.lane}
      style={{ top, height: lane.height }}
    >
      <div className={styles.label} style={lane.indent > 0 ? { paddingInlineStart: 16 + lane.indent * INDENT_STEP } : undefined}>
        <span className={TITLE_CLASS[lane.titleTone]} title={lane.titleHint}>
          {lane.title}
        </span>
        <small className={styles.caption}>{lane.caption}</small>
      </div>
      <div className={styles.track} role="group" aria-label={`${lane.titleHint ?? lane.title}, ${lane.caption}`} data-row={row} style={gridStyle} onClick={onTrackClick}>
        {shown.map((index) => {
          const mark = lane.marks[index]!;
          return (
            <Mark
              key={mark.key}
              mark={mark}
              index={index}
              selected={isSelected(index)}
              dimmed={markDimmed(mark, dimAgent)}
              tabStop={index === tabStop}
              onSelect={onSelect}
            />
          );
        })}
      </div>
    </div>
  );
});

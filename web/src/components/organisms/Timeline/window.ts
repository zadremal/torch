// What of the layout gets into the DOM and where the focus goes. Pure functions.
//
// The DOM holds only the marks that are visible: a row intersects the scroll window vertically,
// a mark horizontally. The window is taken with a margin and moves in steps, so scrolling changes
// the DOM contents not on every event but when crossing a step boundary. In a dense lane, where many marks
// fall on one pixel, marks fully covered by an identical mark do not get into the DOM.
import { type Axis, MIN_MARK_WIDTH, pointToPx, pxToTime, timeToPx } from "./axis.ts";
import { LABEL_WIDTH, type Lane, type Row, markSelected } from "./model.ts";

/**
 * Window shift step, px, and the margin beyond the visible part on each side. Horizontally the step is half
 * the margin: one shift brings into the DOM a band of marks one step wide, and the narrower it is, the
 * shorter the work per frame; vertically a row enters whole, and the step equals the margin.
 */
export const WINDOW_STEP_X = 120;
export const WINDOW_MARGIN_X = 240;
export const WINDOW_STEP_Y = 160;
export const WINDOW_MARGIN_Y = 160;

/**
 * A lane is dense if it has more marks than this number: then of the marks of one kind that coincide pixel for pixel
 * only one stays in the DOM. Up to the threshold every mark in the window is a button.
 * The flag is a property of the lane, not of the window: the DOM contents do not change abruptly while scrolling.
 */
export const DENSE_LANE_MARKS = 1500;

/** Render window in lane coordinates: x — from the left edge of the lane, y — from the top of the first row. */
export interface Viewport {
  trackWidth: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface ScrollMetrics {
  scrollLeft: number;
  scrollTop: number;
  clientWidth: number;
  clientHeight: number;
  /** Content width including the label column. */
  contentWidth: number;
}

/** Render window from the scroll position: the visible part bounds are rounded to the step and extended by the margin. */
export function quantizeViewport(m: ScrollMetrics): Viewport {
  // The label column sticks to the left edge and covers the lane: the visible part is shorter by its width.
  const visibleWidth = Math.max(0, m.clientWidth - LABEL_WIDTH);
  return {
    trackWidth: Math.max(1, m.contentWidth - LABEL_WIDTH),
    x0: Math.floor(m.scrollLeft / WINDOW_STEP_X) * WINDOW_STEP_X - WINDOW_MARGIN_X,
    x1: Math.ceil((m.scrollLeft + visibleWidth) / WINDOW_STEP_X) * WINDOW_STEP_X + WINDOW_MARGIN_X,
    y0: Math.floor(m.scrollTop / WINDOW_STEP_Y) * WINDOW_STEP_Y - WINDOW_MARGIN_Y,
    y1: Math.ceil((m.scrollTop + m.clientHeight) / WINDOW_STEP_Y) * WINDOW_STEP_Y + WINDOW_MARGIN_Y,
  };
}

export function sameViewport(a: Viewport, b: Viewport): boolean {
  return a.trackWidth === b.trackWidth && a.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1;
}

/** The first number for which `isAfter` is true; `count` if there is none. The condition is monotonic. */
function firstIndex(count: number, isAfter: (index: number) => boolean): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (isAfter(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Row numbers [first, last) that intersect the window vertically. */
export function visibleRows(offsets: readonly number[], y0: number, y1: number): { first: number; last: number } {
  const count = offsets.length - 1;
  const first = firstIndex(count, (i) => offsets[i + 1]! > y0);
  const last = firstIndex(count, (i) => offsets[i]! >= y1);
  return { first, last: Math.max(first, last) };
}

/**
 * Numbers of the lane marks needed in the DOM, ascending: those that intersect the window [x0, x1].
 * In a dense lane (DENSE_LANE_MARKS) a mark is skipped if a mark of the same kind already sits on the same
 * pixels: they are indistinguishable on screen, only the top one is reachable with the mouse, and the arrows
 * go through all of them. Selected ones (`selKey`) are not thinned out; the focused mark (`pinnedKey`)
 * always stays, otherwise scrolling and thinning would carry the focus away with it.
 */
export function visibleMarks(
  lane: Lane,
  axis: Axis,
  viewport: Pick<Viewport, "trackWidth" | "x0" | "x1">,
  selKey: string | null,
  pinnedKey: string | null,
): number[] {
  const { marks, reach } = lane;
  const { trackWidth, x0, x1 } = viewport;
  // A window extending beyond the lane edge does not limit on that side.
  const t0 = x0 <= 0 ? Number.NEGATIVE_INFINITY : pxToTime(axis, x0, trackWidth);
  const t1 = x1 >= trackWidth ? Number.POSITIVE_INFINITY : pxToTime(axis, x1, trackWidth);
  const first = firstIndex(marks.length, (i) => reach[i]! >= t0);
  const last = firstIndex(marks.length, (i) => marks[i]!.start > t1);
  const pinned = pinnedKey === null ? undefined : lane.index.get(pinnedKey);
  const selected = selKey !== null && lane.keys.has(selKey) ? selKey : null;

  const dense = marks.length > DENSE_LANE_MARKS;

  const result: number[] = [];
  if (pinned !== undefined && pinned < first) result.push(pinned);
  // Marks go by time, hence by the left edge too: identical ones sit consecutively.
  let column = Number.NaN;
  const seen = new Set<string>();
  for (let i = first; i < last; i++) {
    const mark = marks[i]!;
    const keep = i === pinned || markSelected(mark, selected);
    if (mark.end < t0 && !keep) continue;
    if (!dense) {
      result.push(i);
      continue;
    }
    const left = Math.round(pointToPx(axis, mark.from, trackWidth));
    if (left !== column) {
      column = left;
      seen.clear();
    }
    const footprint = `${Math.round(pointToPx(axis, mark.to, trackWidth))}|${mark.look}`;
    if (seen.has(footprint)) {
      if (!keep) continue;
    } else {
      seen.add(footprint);
    }
    result.push(i);
  }
  if (pinned !== undefined && pinned >= last) result.push(pinned);
  return result;
}

// ── Mouse ───────────────────────────────────────────────────────────────────────────────────

/** Click area margin around a mark, px: a mark 2–3px wide is otherwise hard to hit. */
export const HIT_SLOP = 6;

/**
 * The mark that a click missing the marks at point `x` of the lane (px from its left edge) is addressed to:
 * the nearest of the shown ones (`shown`), no farther than HIT_SLOP from its edges; null — no marks nearby.
 * With equal distance — the later one: it is drawn on top.
 */
export function nearestMark(lane: Lane, axis: Axis, trackWidth: number, shown: readonly number[], x: number): number | null {
  let best: number | null = null;
  let bestDistance = HIT_SLOP;
  for (const index of shown) {
    const mark = lane.marks[index]!;
    // Marks that sit in rows inside the lane (agent runs in Compact) cannot be told apart by a single coordinate.
    if (mark.top !== undefined) continue;
    const left = pointToPx(axis, mark.from, trackWidth);
    const right = Math.max(pointToPx(axis, mark.to, trackWidth), left + MIN_MARK_WIDTH);
    const distance = Math.max(left - x, x - right, 0);
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

// ── Keyboard ────────────────────────────────────────────────────────────────────────────────

export const NAV_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"] as const;
export type NavKey = (typeof NAV_KEYS)[number];

export interface MarkRef {
  /** Layout row number. */
  row: number;
  /** Mark number in the lane. */
  mark: number;
}

/**
 * Where a key moves the focus from mark `from`; null — nowhere.
 * ← and → — the neighboring-in-time mark of the same lane, Home and End — the first and the last,
 * ↑ and ↓ — the nearest-in-time mark of the adjacent lane that has marks.
 */
export function moveFocus(rows: readonly Row[], from: MarkRef, key: NavKey): MarkRef | null {
  const row = rows[from.row];
  if (!row || row.type !== "lane" || !row.marks[from.mark]) return null;
  const step = (mark: number): MarkRef | null => (mark === from.mark || mark < 0 || mark >= row.marks.length ? null : { row: from.row, mark });
  switch (key) {
    case "ArrowLeft":
      return step(from.mark - 1);
    case "ArrowRight":
      return step(from.mark + 1);
    case "Home":
      return step(0);
    case "End":
      return step(row.marks.length - 1);
    case "ArrowUp":
    case "ArrowDown": {
      const direction = key === "ArrowUp" ? -1 : 1;
      const ts = row.marks[from.mark]!.start;
      for (let i = from.row + direction; i >= 0 && i < rows.length; i += direction) {
        const next = rows[i]!;
        if (next.type !== "lane" || next.marks.length === 0) continue;
        const after = firstIndex(next.marks.length, (m) => next.marks[m]!.start >= ts);
        const before = after - 1;
        const nearest =
          after >= next.marks.length || (before >= 0 && ts - next.marks[before]!.start <= next.marks[after]!.start - ts) ? before : after;
        return { row: i, mark: nearest };
      }
      return null;
    }
  }
}

// ── Scroll ──────────────────────────────────────────────────────────────────────────────────

/**
 * Where to scroll so that the segment [from, to] lands in the visible part [scroll, scroll + size]:
 * the new scroll position with the segment in the middle; null — the segment is already fully visible.
 */
export function revealScroll(from: number, to: number, scroll: number, size: number): number | null {
  if (from >= scroll && to <= scroll + size) return null;
  return Math.max(0, (from + to) / 2 - size / 2);
}

/** Scroll and lane sizes before or after a change of its width. */
export interface TrackView {
  scrollLeft: number;
  trackWidth: number;
  /** Visible part of the lane: the window width without the label column. */
  visibleWidth: number;
}

/**
 * Scroll position after a change of the lane width (zoom, panel opening, window size):
 * the anchor moment stays at the same place of the window. The anchor is the selected mark's cursor, if it was
 * visible (its place is counted as a share of the visible part: it could change too), otherwise the middle of the window.
 */
export function anchoredScrollLeft(axis: Axis, before: TrackView, after: Omit<TrackView, "scrollLeft">, cursorTs: number | null): number {
  const cursorX = cursorTs === null ? null : timeToPx(axis, cursorTs, before.trackWidth) - before.scrollLeft;
  const cursorVisible = cursorX !== null && cursorX >= 0 && cursorX <= before.visibleWidth;
  const share = cursorVisible && before.visibleWidth > 0 ? cursorX / before.visibleWidth : 0.5;
  const ts = cursorVisible ? cursorTs! : pxToTime(axis, before.scrollLeft + before.visibleWidth / 2, before.trackWidth);
  return Math.max(0, timeToPx(axis, ts, after.trackWidth) - share * after.visibleWidth);
}

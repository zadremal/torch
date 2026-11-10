// Timeline time axis (plan §9.2): piecewise linear. Active segments are to scale, each
// gap from the API response takes a band of constant width. Pure functions: time → position
// (as a CSS value and in pixels), pixel → time, axis ticks.
import type { TimelineGap } from "@contracts/api.ts";

/** Width of a gap band, px: independent of the zoom and the idle duration. */
export const GAP_WIDTH = 56;

/** Smallest width of a mark with a duration, px (`max(3px, …)` in the artboard). */
export const MIN_MARK_WIDTH = 3;

/** How many axis ticks fit the window width at Fit zoom. */
const TICKS_PER_SCREEN = 10;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Allowed tick steps, ascending. */
const TICK_STEPS = [
  SECOND,
  2 * SECOND,
  5 * SECOND,
  10 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
];

export interface Axis {
  start: number;
  end: number;
  /** Gaps inside [start, end], by time, non-overlapping. */
  gaps: TimelineGap[];
  /** idleBefore[i] — total duration of the gaps with numbers less than i; length is gaps.length + 1. */
  idleBefore: number[];
  /** Time outside the gaps: it takes the lane width minus the gap bands. */
  activeMs: number;
}

/**
 * Position of a point in time on the axis, independent of the lane width:
 * x = active × (width − all gap bands) + gaps × GAP_WIDTH.
 */
export interface AxisPoint {
  /** Share of active time to the left of the point, 0…1. */
  active: number;
  /** Number of gap bands to the left; fractional if the point falls inside a gap. */
  gaps: number;
}

/** Session axis. Gaps are clipped to the session bounds, empty and overlapping ones are discarded. */
export function buildAxis(start: number, end: number, gaps: readonly TimelineGap[]): Axis {
  const last = Math.max(start, end);
  const clean: TimelineGap[] = [];
  const idleBefore = [0];
  let cursor = start;
  for (const gap of [...gaps].sort((a, b) => a.start - b.start)) {
    const from = Math.max(gap.start, cursor);
    const to = Math.min(gap.end, last);
    if (to <= from) continue;
    clean.push({ start: from, end: to });
    idleBefore.push(idleBefore[idleBefore.length - 1]! + (to - from));
    cursor = to;
  }
  return { start, end: last, gaps: clean, idleBefore, activeMs: last - start - idleBefore[clean.length]! };
}

/** Number of gaps that started no later than `ts`. */
function gapsStartedBy(axis: Axis, ts: number): number {
  let lo = 0;
  let hi = axis.gaps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (axis.gaps[mid]!.start <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Time → position. Time outside the session is clamped to its bounds. */
export function locate(axis: Axis, ts: number): AxisPoint {
  const t = Math.min(Math.max(ts, axis.start), axis.end);
  const started = gapsStartedBy(axis, t);
  const inside = started > 0 && t < axis.gaps[started - 1]!.end ? axis.gaps[started - 1]! : null;
  // Inside a gap the active time stays at its start, and the point moves along the gap band.
  const index = inside ? started - 1 : started;
  const activeTime = (inside ? inside.start : t) - axis.start - axis.idleBefore[index]!;
  return {
    active: axis.activeMs > 0 ? activeTime / axis.activeMs : 0,
    gaps: inside ? index + (t - inside.start) / (inside.end - inside.start) : index,
  };
}

/** Lane width given to the active time. */
function activeWidth(axis: Axis, trackWidth: number): number {
  return Math.max(1, trackWidth - axis.gaps.length * GAP_WIDTH);
}

/** Position in pixels from the left edge of a lane of width `trackWidth`. */
export function pointToPx(axis: Axis, point: AxisPoint, trackWidth: number): number {
  return point.active * activeWidth(axis, trackWidth) + point.gaps * GAP_WIDTH;
}

/** Time → pixel. */
export function timeToPx(axis: Axis, ts: number, trackWidth: number): number {
  return pointToPx(axis, locate(axis, ts), trackWidth);
}

/** Pixel → time: the inverse of timeToPx. Pixels outside the lane give the session bounds. */
export function pxToTime(axis: Axis, x: number, trackWidth: number): number {
  const width = activeWidth(axis, trackWidth);
  const activeAt = (px: number, gapsBefore: number) => ((px - gapsBefore * GAP_WIDTH) / width) * axis.activeMs;
  for (let i = 0; i < axis.gaps.length; i++) {
    const gap = axis.gaps[i]!;
    const gapX = ((gap.start - axis.start - axis.idleBefore[i]!) / (axis.activeMs || 1)) * width + i * GAP_WIDTH;
    if (x < gapX) return Math.max(axis.start, axis.start + axis.idleBefore[i]! + activeAt(x, i));
    if (x < gapX + GAP_WIDTH) return gap.start + ((x - gapX) / GAP_WIDTH) * (gap.end - gap.start);
  }
  const n = axis.gaps.length;
  const ts = axis.start + axis.idleBefore[n]! + activeAt(x, n);
  return Math.min(Math.max(ts, axis.start), axis.end);
}

const trim = (value: number, digits: number) => String(Number(value.toFixed(digits)));

/**
 * Position as the CSS value `left`. Percentages are computed from the lane width, so a zoom change
 * and a window width change need no recalculation: without gaps — "12.5%", with gaps —
 * "calc(56px + (100% - 112px) * 0.125)".
 */
export function cssLeft(axis: Axis, point: AxisPoint): string {
  if (axis.gaps.length === 0) return `${trim(point.active * 100, 4)}%`;
  return `calc(${trim(point.gaps * GAP_WIDTH, 2)}px + (100% - ${axis.gaps.length * GAP_WIDTH}px) * ${trim(point.active, 6)})`;
}

/** Mark width between two positions as the CSS value `width`, not narrower than MIN_MARK_WIDTH. */
export function cssWidth(axis: Axis, from: AxisPoint, to: AxisPoint): string {
  const active = Math.max(0, to.active - from.active);
  if (axis.gaps.length === 0) return `max(${MIN_MARK_WIDTH}px, ${trim(active * 100, 4)}%)`;
  const gapsPx = Math.max(0, to.gaps - from.gaps) * GAP_WIDTH;
  return `max(${MIN_MARK_WIDTH}px, calc(${trim(gapsPx, 2)}px + (100% - ${axis.gaps.length * GAP_WIDTH}px) * ${trim(active, 6)}))`;
}

export interface AxisTick {
  /** Tick time. */
  ts: number;
  /** Time since the session start: "0m", "2m", "1h 30m". */
  label: string;
}

/** Tick label: time since the session start with the precision of the step. */
export function formatTick(offsetMs: number, stepMs: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const seconds = Math.round(offsetMs / SECOND);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (days > 0) return hours > 0 || minutes > 0 ? `${days}d ${hours}h${minutes > 0 ? ` ${pad(minutes)}m` : ""}` : `${days}d`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (stepMs < MINUTE) return minutes > 0 ? `${minutes}m ${pad(rest)}s` : `${rest}s`;
  return `${minutes}m`;
}

/** Tick step: the smallest allowed one at which no more than TICKS_PER_SCREEN fit the window width. */
export function tickStep(axis: Axis, zoom: number): number {
  const wanted = axis.activeMs / (TICKS_PER_SCREEN * zoom);
  return TICK_STEPS.find((step) => step >= wanted) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
}

/**
 * Axis ticks: points that are multiples of the step from the session start, except those that fall inside a gap.
 * Labels are the real time since the start, so after a gap they continue with a jump.
 */
export function axisTicks(axis: Axis, zoom: number): AxisTick[] {
  const step = tickStep(axis, zoom);
  const ticks: AxisTick[] = [];
  let segmentStart = axis.start;
  for (let i = 0; i <= axis.gaps.length; i++) {
    const segmentEnd = i < axis.gaps.length ? axis.gaps[i]!.start : axis.end;
    // The start of a segment after a gap belongs to the segment, the end of a gap does not.
    const first = Math.ceil((segmentStart - axis.start) / step);
    const last = Math.floor((segmentEnd - axis.start) / step);
    for (let k = first; k <= last; k++) {
      const ts = axis.start + k * step;
      if (ticks.length > 0 && ticks[ticks.length - 1]!.ts === ts) continue;
      ticks.push({ ts, label: formatTick(k * step, step) });
    }
    if (i < axis.gaps.length) segmentStart = axis.gaps[i]!.end;
  }
  return ticks;
}

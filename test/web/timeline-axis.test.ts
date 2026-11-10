// Timeline axis (W5): time → position with gaps taken into account, the inverse conversion, ticks.
import { describe, expect, test } from "bun:test";
import type { TimelineResponse } from "../../src/contracts/api.ts";
import {
  GAP_WIDTH,
  axisTicks,
  buildAxis,
  cssLeft,
  cssWidth,
  formatTick,
  locate,
  pointToPx,
  pxToTime,
  tickStep,
  timeToPx,
} from "../../web/src/components/organisms/Timeline/axis.ts";
import reference from "../fixtures/dto/timeline.json";

const data = reference as unknown as TimelineResponse;
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("axis without gaps", () => {
  const axis = buildAxis(data.session.startedAt, data.session.endedAt, data.gaps);

  test("baseline session: no gaps, the whole duration is active", () => {
    expect(axis.gaps).toEqual([]);
    expect(axis.activeMs).toBe(1_122_000);
  });

  test("position is linear in time and does not depend on the track width", () => {
    expect(locate(axis, axis.start)).toEqual({ active: 0, gaps: 0 });
    expect(locate(axis, axis.end)).toEqual({ active: 1, gaps: 0 });
    expect(locate(axis, axis.start + 561_000)).toEqual({ active: 0.5, gaps: 0 });
    expect(timeToPx(axis, axis.start + 561_000, 1000)).toBe(500);
    expect(timeToPx(axis, axis.start + 561_000, 4000)).toBe(2000);
  });

  test("CSS values are percentages of the track width, as in the artboard", () => {
    // The second prompt of the baseline session: +512 s out of 1122 s.
    expect(cssLeft(axis, locate(axis, data.prompts[1]!.ts))).toBe("45.6328%");
    expect(cssWidth(axis, locate(axis, axis.start), locate(axis, axis.end))).toBe("max(3px, 100%)");
    expect(cssWidth(axis, locate(axis, axis.start), locate(axis, axis.start + 120_000))).toBe("max(3px, 10.6952%)");
  });

  test("time outside the session is clamped to its bounds", () => {
    expect(locate(axis, axis.start - 5000)).toEqual({ active: 0, gaps: 0 });
    expect(locate(axis, axis.end + 5000)).toEqual({ active: 1, gaps: 0 });
  });

  test("a session of zero duration does not give NaN", () => {
    const empty = buildAxis(1000, 1000, []);
    expect(locate(empty, 1000)).toEqual({ active: 0, gaps: 0 });
    expect(cssLeft(empty, locate(empty, 1000))).toBe("0%");
    expect(pxToTime(empty, 300, 1000)).toBe(1000);
  });
});

describe("axis with gaps", () => {
  // 10 minutes of work, 3 hours idle, 20 minutes of work, a day idle, 10 minutes of work.
  const start = 1_000_000;
  const gapA = { start: start + 10 * MIN, end: start + 10 * MIN + 3 * HOUR };
  const gapB = { start: gapA.end + 20 * MIN, end: gapA.end + 20 * MIN + 24 * HOUR };
  const end = gapB.end + 10 * MIN;
  const axis = buildAxis(start, end, [gapA, gapB]);
  const WIDTH = 1000 + 2 * GAP_WIDTH;

  test("active time is the duration without gaps", () => {
    expect(axis.activeMs).toBe(40 * MIN);
    expect(axis.idleBefore).toEqual([0, 3 * HOUR, 27 * HOUR]);
  });

  test("active segments share a common scale, a gap takes a band of constant width", () => {
    expect(timeToPx(axis, start, WIDTH)).toBe(0);
    expect(timeToPx(axis, gapA.start, WIDTH)).toBe(250);
    expect(timeToPx(axis, gapA.end, WIDTH)).toBe(250 + GAP_WIDTH);
    expect(timeToPx(axis, gapB.start, WIDTH)).toBe(750 + GAP_WIDTH);
    expect(timeToPx(axis, gapB.end, WIDTH)).toBe(750 + 2 * GAP_WIDTH);
    expect(timeToPx(axis, end, WIDTH)).toBe(WIDTH);
  });

  test("a gap band does not grow with the scale and does not depend on the idle duration", () => {
    for (const width of [WIDTH, 2 * WIDTH, 4 * WIDTH]) {
      expect(timeToPx(axis, gapA.end, width) - timeToPx(axis, gapA.start, width)).toBeCloseTo(GAP_WIDTH, 6);
      expect(timeToPx(axis, gapB.end, width) - timeToPx(axis, gapB.start, width)).toBeCloseTo(GAP_WIDTH, 6);
    }
  });

  test("a moment inside a gap stands inside its band", () => {
    const middle = locate(axis, (gapA.start + gapA.end) / 2);
    expect(middle).toEqual({ active: 0.25, gaps: 0.5 });
    expect(pointToPx(axis, middle, WIDTH)).toBe(250 + GAP_WIDTH / 2);
  });

  test("position does not decrease with time", () => {
    let previous = -1;
    for (let ts = start; ts <= end; ts += (end - start) / 500) {
      const x = timeToPx(axis, ts, WIDTH);
      expect(x).toBeGreaterThanOrEqual(previous);
      previous = x;
    }
  });

  test("CSS values: gap bands in pixels, the active part is a share of the remaining width", () => {
    expect(cssLeft(axis, locate(axis, start))).toBe("calc(0px + (100% - 112px) * 0)");
    expect(cssLeft(axis, locate(axis, gapA.end))).toBe("calc(56px + (100% - 112px) * 0.25)");
    expect(cssLeft(axis, locate(axis, gapB.end + 5 * MIN))).toBe("calc(112px + (100% - 112px) * 0.875)");
    // A band across both gaps: the whole active width and both bands.
    expect(cssWidth(axis, locate(axis, start), locate(axis, end))).toBe("max(3px, calc(112px + (100% - 112px) * 1))");
    expect(cssWidth(axis, locate(axis, gapA.end), locate(axis, gapA.end + 2 * MIN))).toBe("max(3px, calc(0px + (100% - 112px) * 0.05))");
  });

  test("pixel → time is the inverse of time → pixel", () => {
    const moments = [start, start + 3 * MIN, gapA.start, gapA.start + HOUR, gapA.end, gapA.end + 7 * MIN, gapB.start + 5 * HOUR, gapB.end + MIN, end];
    for (const width of [WIDTH, 3 * WIDTH]) {
      for (const ts of moments) expect(pxToTime(axis, timeToPx(axis, ts, width), width)).toBeCloseTo(ts, 3);
    }
    expect(pxToTime(axis, -50, WIDTH)).toBe(start);
    expect(pxToTime(axis, WIDTH + 50, WIDTH)).toBe(end);
  });

  test("gaps are clipped to the session bounds, overlapping and empty ones are dropped", () => {
    const messy = buildAxis(start, start + HOUR, [
      { start: start + 50 * MIN, end: start + 2 * HOUR },
      { start: start - HOUR, end: start + 10 * MIN },
      { start: start + 5 * MIN, end: start + 8 * MIN },
      { start: start + 30 * MIN, end: start + 30 * MIN },
    ]);
    expect(messy.gaps).toEqual([
      { start, end: start + 10 * MIN },
      { start: start + 50 * MIN, end: start + HOUR },
    ]);
    expect(messy.activeMs).toBe(40 * MIN);
  });
});

describe("axis ticks", () => {
  test("baseline session: a 2-minute step, ten ticks from 0m to 18m, as in the artboard", () => {
    const axis = buildAxis(data.session.startedAt, data.session.endedAt, []);
    expect(tickStep(axis, 1)).toBe(2 * MIN);
    const ticks = axisTicks(axis, 1);
    expect(ticks.map((t) => t.label)).toEqual(["0m", "2m", "4m", "6m", "8m", "10m", "12m", "14m", "16m", "18m"]);
    expect(ticks[1]!.ts).toBe(axis.start + 2 * MIN);
  });

  test("scale reduces the step", () => {
    const axis = buildAxis(data.session.startedAt, data.session.endedAt, []);
    expect(tickStep(axis, 2)).toBe(MIN);
    expect(tickStep(axis, 4)).toBe(30_000);
    expect(axisTicks(axis, 4).slice(0, 4).map((t) => t.label)).toEqual(["0s", "30s", "1m 00s", "1m 30s"]);
  });

  test("there are no ticks inside a gap; after it the labels show the real time since the session start", () => {
    const start = 0;
    const gap = { start: 10 * MIN, end: 3 * HOUR + 11 * MIN };
    const axis = buildAxis(start, gap.end + 9 * MIN, [gap]);
    expect(tickStep(axis, 1)).toBe(2 * MIN);
    const ticks = axisTicks(axis, 1);
    expect(ticks.every((t) => t.ts <= gap.start || t.ts >= gap.end)).toBe(true);
    expect(ticks.map((t) => t.label)).toEqual(["0m", "2m", "4m", "6m", "8m", "10m", "3h 12m", "3h 14m", "3h 16m", "3h 18m", "3h 20m"]);
  });

  test("tick label", () => {
    expect(formatTick(0, 2 * MIN)).toBe("0m");
    expect(formatTick(18 * MIN, 2 * MIN)).toBe("18m");
    expect(formatTick(45_000, 15_000)).toBe("45s");
    expect(formatTick(90_000, 30_000)).toBe("1m 30s");
    expect(formatTick(HOUR, 30 * MIN)).toBe("1h 00m");
    expect(formatTick(26 * HOUR + 5 * MIN, HOUR)).toBe("1d 2h 05m");
    expect(formatTick(48 * HOUR, 12 * HOUR)).toBe("2d");
  });
});

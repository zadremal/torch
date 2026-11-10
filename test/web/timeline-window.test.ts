// Timeline (W5): what gets into the DOM on scroll and scale, where the keys move focus.
// The baseline session; large sessions are in timeline-render.test.ts.
import { describe, expect, test } from "bun:test";
import type { TimelineResponse } from "../../src/contracts/api.ts";
import { pointToPx } from "../../web/src/components/organisms/Timeline/axis.ts";
import { LABEL_WIDTH, type Lane, type TimelineModel, buildModel } from "../../web/src/components/organisms/Timeline/model.ts";
import {
  HIT_SLOP,
  WINDOW_MARGIN_X,
  WINDOW_MARGIN_Y,
  WINDOW_STEP_X,
  type Viewport,
  anchoredScrollLeft,
  moveFocus,
  nearestMark,
  quantizeViewport,
  revealScroll,
  sameViewport,
  visibleMarks,
  visibleRows,
} from "../../web/src/components/organisms/Timeline/window.ts";
import reference from "../fixtures/dto/timeline.json";

const data = reference as unknown as TimelineResponse;

const lanesOf = (model: TimelineModel): Lane[] => model.rows.filter((row): row is Lane => row.type === "lane");
const lane = (model: TimelineModel, id: string): Lane => lanesOf(model).find((l) => l.id === id)!;
/** A window into which a track of width `trackWidth` fits entirely. */
const whole = (trackWidth: number) => ({ trackWidth, x0: -WINDOW_MARGIN_X, x1: trackWidth + WINDOW_MARGIN_X });
/** A screen window of width `screen` at scroll `scrollLeft`. */
const screenAt = (trackWidth: number, scrollLeft: number, screen = 1240): Viewport =>
  quantizeViewport({ scrollLeft, scrollTop: 0, clientWidth: screen, clientHeight: 800, contentWidth: trackWidth + LABEL_WIDTH });
const shownCount = (model: TimelineModel, viewport: Pick<Viewport, "trackWidth" | "x0" | "x1">) =>
  lanesOf(model).reduce((sum, l) => sum + visibleMarks(l, model.axis, viewport, null, null).length, 0);

describe("render window", () => {
  test("bounds are rounded to the step and extended by a margin on each side", () => {
    const viewport = quantizeViewport({ scrollLeft: 500, scrollTop: 330, clientWidth: 1240, clientHeight: 800, contentWidth: 4960 });
    // The label column covers 200px of the window: the visible part of the track is [500, 1540].
    expect(viewport).toEqual({ trackWidth: 4760, x0: 240, x1: 1800, y0: 160, y1: 1440 });
    expect(viewport.x0).toBeLessThanOrEqual(500 - WINDOW_MARGIN_X);
    expect(viewport.x1).toBeGreaterThanOrEqual(1540 + WINDOW_MARGIN_X);
    expect(viewport.y0).toBeLessThanOrEqual(330 - WINDOW_MARGIN_Y);
    expect(viewport.y1).toBeGreaterThanOrEqual(330 + 800 + WINDOW_MARGIN_Y);
  });

  test("a per-pixel scroll changes the window only at a step boundary", () => {
    let changes = 0;
    let previous = screenAt(4760, 0);
    for (let scrollLeft = 1; scrollLeft <= 2400; scrollLeft++) {
      const next = screenAt(4760, scrollLeft);
      if (!sameViewport(previous, next)) changes++;
      previous = next;
    }
    // 2400 scroll events give no more than two window changes per step: the left and the right bound.
    expect(changes).toBeLessThanOrEqual((2400 / WINDOW_STEP_X) * 2);
    expect(changes).toBeGreaterThan(0);
  });

  test("rows: only those intersecting the window get into it", () => {
    const offsets = [0, 29, 68, 107, 136, 175, 214];
    expect(visibleRows(offsets, 0, 1000)).toEqual({ first: 0, last: 6 });
    expect(visibleRows(offsets, 68, 136)).toEqual({ first: 2, last: 4 });
    expect(visibleRows(offsets, 70, 110)).toEqual({ first: 2, last: 4 });
    expect(visibleRows(offsets, 500, 900)).toEqual({ first: 6, last: 6 });
    expect(visibleRows(offsets, -320, -160)).toEqual({ first: 0, last: 0 });
    expect(visibleRows([0], 0, 100)).toEqual({ first: 0, last: 0 });
  });
});

describe("marks in the window: baseline session", () => {
  const model = buildModel(data, "compact");
  const tools = lane(model, "tools");

  test("at Fit scale every mark of every track is in the DOM", () => {
    for (const l of lanesOf(model)) expect(visibleMarks(l, model.axis, whole(1040), null, null)).toHaveLength(l.marks.length);
    expect(shownCount(model, whole(1040))).toBe(1 + 3 + 5 + 186 + 110 + 147);
  });

  test("at 4× scale only the marks intersecting the window with a margin are in the DOM", () => {
    const trackWidth = 4 * 1240 - LABEL_WIDTH;
    const viewport = screenAt(trackWidth, 2000);
    const shown = visibleMarks(tools, model.axis, viewport, null, null);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(tools.marks.length);
    const inWindow = (i: number) => {
      const mark = tools.marks[i]!;
      return pointToPx(model.axis, mark.to, trackWidth) >= viewport.x0 && pointToPx(model.axis, mark.from, trackWidth) <= viewport.x1;
    };
    expect(shown.every(inWindow)).toBe(true);
    // And conversely: no mark intersecting the window is skipped.
    expect(tools.marks.filter((_, i) => inWindow(i))).toHaveLength(shown.length);
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
  });

  test("a long mark that started before the window stays: the session and main agent bands are visible at any scroll", () => {
    const viewport = screenAt(4 * 1240 - LABEL_WIDTH, 3000);
    expect(visibleMarks(lane(model, "session"), model.axis, viewport, null, null)).toEqual([0]);
    expect(visibleMarks(lane(model, "agents"), model.axis, viewport, null, null)).toContain(0);
    // A long call among short ones: started far before the window, ended inside it.
    const long = { ...data.tools[0]!, id: "long", start: data.session.startedAt + 1000, durationMs: 900_000 };
    const withLong = lane(buildModel({ ...data, tools: [...data.tools, long] }, "compact"), "tools");
    const shown = visibleMarks(withLong, model.axis, viewport, null, null);
    expect(shown).toContain(withLong.index.get("long")!);
  });

  test("the focused mark stays in the DOM outside the window too, in its place in the order", () => {
    const viewport = screenAt(4 * 1240 - LABEL_WIDTH, 2000);
    const first = tools.marks[0]!.key;
    const last = tools.marks.at(-1)!.key;
    const plain = visibleMarks(tools, model.axis, viewport, null, null);
    expect(plain).not.toContain(0);
    expect(visibleMarks(tools, model.axis, viewport, null, first)).toEqual([0, ...plain]);
    expect(visibleMarks(tools, model.axis, viewport, null, last)).toEqual([...plain, tools.marks.length - 1]);
    // A foreign key changes nothing.
    expect(visibleMarks(tools, model.axis, viewport, null, "no-such-key")).toEqual(plain);
  });
});

describe("hit area", () => {
  const model = buildModel(data, "compact");
  const WIDTH = 1040;
  const all = (l: Lane) => l.marks.map((_, i) => i);
  const px = (l: Lane, i: number) => pointToPx(model.axis, l.marks[i]!.from, WIDTH);

  test("a press near a narrow mark goes to it, far from the marks to no one", () => {
    const prompts = lane(model, "prompts");
    const second = px(prompts, 1);
    expect(nearestMark(prompts, model.axis, WIDTH, all(prompts), second - HIT_SLOP)).toBe(1);
    expect(nearestMark(prompts, model.axis, WIDTH, all(prompts), second + 3 + HIT_SLOP)).toBe(1);
    expect(nearestMark(prompts, model.axis, WIDTH, all(prompts), second - HIT_SLOP - 1)).toBeNull();
    expect(nearestMark(prompts, model.axis, WIDTH, all(prompts), second + 60)).toBeNull();
  });

  test("of two neighbors the nearest is chosen; only the shown marks are considered", () => {
    // Two prompts 10 seconds apart: about 9px at a track width of 1040px.
    const at = (seconds: number, id: string) => ({ id, kind: "follow_up" as const, ts: data.session.startedAt + seconds * 1000 });
    const close = buildModel({ ...data, prompts: [at(100, "a"), at(110, "b"), at(600, "c")] }, "compact");
    const prompts = lane(close, "prompts");
    const [a, b] = [px(prompts, 0), px(prompts, 1)];
    expect(b - a).toBeGreaterThan(8);
    expect(nearestMark(prompts, close.axis, WIDTH, all(prompts), b - 1)).toBe(1);
    expect(nearestMark(prompts, close.axis, WIDTH, all(prompts), a + 4)).toBe(0);
    // There is no mark "b" in the DOM: a press near it goes to "a" if it is within the margin.
    expect(nearestMark(prompts, close.axis, WIDTH, [0, 2], a + 3 + HIT_SLOP)).toBe(0);
    expect(nearestMark(prompts, close.axis, WIDTH, [0, 2], b + 2)).toBeNull();
    expect(nearestMark(prompts, close.axis, WIDTH, [], a)).toBeNull();
  });

  test("agent launches in Compact stand in rows: horizontally they are indistinguishable, there is no margin", () => {
    const agents = lane(model, "agents");
    expect(nearestMark(agents, model.axis, WIDTH, all(agents), px(agents, 1) + 5)).toBeNull();
  });
});

describe("keyboard", () => {
  const model = buildModel(data, "expanded");
  const rowOf = (id: string) => model.rows.findIndex((row) => row.type === "lane" && row.id === id);
  const tools = rowOf("tools main");

  test("← and → are the neighbor mark of the same track by time; there is no move at the edge", () => {
    expect(moveFocus(model.rows, { row: tools, mark: 5 }, "ArrowRight")).toEqual({ row: tools, mark: 6 });
    expect(moveFocus(model.rows, { row: tools, mark: 5 }, "ArrowLeft")).toEqual({ row: tools, mark: 4 });
    expect(moveFocus(model.rows, { row: tools, mark: 0 }, "ArrowLeft")).toBeNull();
    expect(moveFocus(model.rows, { row: tools, mark: 60 }, "ArrowRight")).toBeNull();
  });

  test("Home and End are the first and last mark of the track", () => {
    expect(moveFocus(model.rows, { row: tools, mark: 30 }, "Home")).toEqual({ row: tools, mark: 0 });
    expect(moveFocus(model.rows, { row: tools, mark: 30 }, "End")).toEqual({ row: tools, mark: 60 });
    expect(moveFocus(model.rows, { row: tools, mark: 0 }, "Home")).toBeNull();
  });

  test("↑ and ↓ are the nearest mark by time of the neighboring track; group headings are skipped", () => {
    const prompts = rowOf("prompts");
    const mainBar = rowOf("agent main");
    // Between Prompts and the main agent band stands a group heading.
    expect(mainBar - prompts).toBe(2);
    expect(moveFocus(model.rows, { row: mainBar, mark: 0 }, "ArrowUp")).toEqual({ row: prompts, mark: 0 });
    expect(moveFocus(model.rows, { row: prompts, mark: 2 }, "ArrowDown")).toEqual({ row: mainBar, mark: 0 });
    // From the call gp-1 up goes to the gp-1 band, down to the gp-2 band.
    const gp1 = rowOf("tools gp-1");
    expect(moveFocus(model.rows, { row: gp1, mark: 10 }, "ArrowUp")).toEqual({ row: rowOf("agent gp-1"), mark: 0 });
    expect(moveFocus(model.rows, { row: gp1, mark: 10 }, "ArrowDown")).toEqual({ row: rowOf("agent gp-2"), mark: 0 });
  });

  test("↓ picks the mark nearest in time, not the first one", () => {
    const from = rowOf("agent gp-2");
    const to = rowOf("tools gp-2");
    const target = moveFocus(model.rows, { row: from, mark: 0 }, "ArrowDown")!;
    expect(target).toEqual({ row: to, mark: 0 });
    const lastPrompt = moveFocus(model.rows, { row: rowOf("agent main"), mark: 0 }, "ArrowUp");
    expect(lastPrompt).toEqual({ row: rowOf("prompts"), mark: 0 });
    // From the last call of the main agent up to its band, from it to the last prompt is closer than to the first.
    const promptsLane = model.rows[rowOf("prompts")] as Lane;
    const mainTools = model.rows[tools] as Lane;
    const late = mainTools.marks.length - 1;
    const viaTime = moveFocus(model.rows.filter((row) => row.type === "lane" && (row.id === "prompts" || row.id === "tools main")), { row: 1, mark: late }, "ArrowUp");
    expect(viaTime).toEqual({ row: 0, mark: promptsLane.marks.length - 1 });
  });

  test("from the edge track there is no move up or down; an empty track is skipped", () => {
    const sessionRow = rowOf("session");
    expect(moveFocus(model.rows, { row: sessionRow, mark: 0 }, "ArrowUp")).toBeNull();
    const external = rowOf("external");
    expect(moveFocus(model.rows, { row: external, mark: 0 }, "ArrowDown")).toBeNull();
    const empty = buildModel({ ...data, external: [], prompts: [] }, "compact");
    const session = empty.rows.findIndex((row) => row.type === "lane" && row.id === "session");
    expect(moveFocus(empty.rows, { row: session, mark: 0 }, "ArrowDown")).toEqual({ row: session + 2, mark: 0 });
  });

  test("the number of a nonexistent mark or of a heading row gives no move", () => {
    expect(moveFocus(model.rows, { row: 0, mark: 0 }, "ArrowRight")).toBeNull();
    expect(moveFocus(model.rows, { row: tools, mark: 999 }, "ArrowLeft")).toBeNull();
    expect(moveFocus(model.rows, { row: 999, mark: 0 }, "Home")).toBeNull();
  });
});

describe("scroll to the selection and scale change", () => {
  const model = buildModel(data, "compact");
  const axis = model.axis;

  test("the visible one is not scrolled, the invisible one is placed in the middle", () => {
    expect(revealScroll(500, 500, 0, 1040)).toBeNull();
    expect(revealScroll(0, 0, 0, 1040)).toBeNull();
    expect(revealScroll(3000, 3000, 0, 1040)).toBe(2480);
    expect(revealScroll(100, 100, 800, 1040)).toBe(0);
    // A row: a segment from top to bottom.
    expect(revealScroll(780, 819, 0, 800)).toBe(399.5);
    expect(revealScroll(400, 439, 0, 800)).toBeNull();
  });

  test("scale change: the middle of the window stays the middle", () => {
    // Fit → 4×: under the middle of the window was the middle of the session.
    const left = anchoredScrollLeft(axis, { scrollLeft: 0, trackWidth: 1040, visibleWidth: 1040 }, { trackWidth: 4160, visibleWidth: 1040 }, null);
    expect(left).toBe(4160 / 2 - 520);
    // And back: 4× → Fit leaves no scroll.
    expect(anchoredScrollLeft(axis, { scrollLeft: left, trackWidth: 4160, visibleWidth: 1040 }, { trackWidth: 1040, visibleWidth: 1040 }, null)).toBe(0);
  });

  test("scale change: the visible cursor of the selected mark stays in its place in the window", () => {
    const cursorTs = axis.start + axis.activeMs * 0.75;
    const left = anchoredScrollLeft(axis, { scrollLeft: 0, trackWidth: 1040, visibleWidth: 1040 }, { trackWidth: 4160, visibleWidth: 1040 }, cursorTs);
    // The cursor was 780px from the left edge of the track and stayed there in the window.
    expect(left).toBeCloseTo(0.75 * 4160 - 780, 6);
    // A cursor outside the window is not an anchor: the middle stays in place.
    const far = anchoredScrollLeft(axis, { scrollLeft: 3000, trackWidth: 4160, visibleWidth: 1040 }, { trackWidth: 2080, visibleWidth: 1040 }, axis.start);
    expect(far).toBeCloseTo((3000 + 520) / 2 - 520, 6);
  });

  test("a panel opened: the window and the track became narrower, the cursor stays at the same share of the window", () => {
    // 4× in a 1240px window → 4× in an 800px window.
    const cursorTs = axis.start + axis.activeMs * 0.5;
    const before = { scrollLeft: 0.5 * 4160 - 780, trackWidth: 4160, visibleWidth: 1040 };
    const left = anchoredScrollLeft(axis, before, { trackWidth: 2400, visibleWidth: 600 }, cursorTs);
    expect(left).toBeCloseTo(0.5 * 2400 - 0.75 * 600, 6);
  });
});

// Timeline (W5): large sessions and markup.
// A large session is assembled by multiplying the baseline response: a thousand and ten thousand calls; on it
// we check how many marks get into the DOM and how many a scroll step changes.
// The markup of the organism and the page is rendered on the server through Vite, as in shell.test.ts:
// without a browser, so the render window is the initial one (artboard width, scroll at the start).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TimelineResponse } from "../../src/contracts/api.ts";
import type { Selection, TimelineView, TimelineZoom } from "../../src/contracts/selection.ts";
import { pointToPx } from "../../web/src/components/organisms/Timeline/axis.ts";
import { LABEL_WIDTH, type Lane, type TimelineModel, buildModel, trackWidth as trackWidthOf } from "../../web/src/components/organisms/Timeline/model.ts";
import {
  DENSE_LANE_MARKS,
  WINDOW_MARGIN_X,
  WINDOW_STEP_X,
  type Viewport,
  quantizeViewport,
  visibleMarks,
  visibleRows,
} from "../../web/src/components/organisms/Timeline/window.ts";
import { formatClock } from "../../web/src/lib/format.ts";
import reference from "../fixtures/dto/timeline.json";

const data = reference as unknown as TimelineResponse;

/**
 * The baseline session repeated `copies` times in a row with idle time between the repeats: each repeat has
 * its own subagents and its own ids, there is one main agent, and there is a gap between the repeats.
 */
function repeatTimeline(source: TimelineResponse, copies: number, idleMs = 30 * 60_000): TimelineResponse {
  const length = source.session.endedAt - source.session.startedAt;
  const result: TimelineResponse = {
    session: { ...source.session },
    gaps: [],
    prompts: [],
    agents: [],
    tools: [],
    files: [],
    modelCalls: [],
    apiErrors: [],
    external: [],
  };
  for (let k = 0; k < copies; k++) {
    const shift = k * (length + idleMs);
    const id = (value: string) => `${value}#${k}`;
    const agent = (value: string) => (value === "main" ? value : id(value));
    if (k > 0) result.gaps.push({ start: source.session.startedAt + shift - idleMs, end: source.session.startedAt + shift });
    result.prompts.push(...source.prompts.map((p) => ({ ...p, id: id(p.id), ts: p.ts + shift })));
    result.agents.push(
      ...source.agents
        .filter((a) => a.agentId !== "main")
        .map((a) => ({ ...a, agentId: id(a.agentId), start: a.start + shift, end: a.end + shift })),
    );
    result.tools.push(...source.tools.map((t) => ({ ...t, id: id(t.id), agentId: agent(t.agentId), start: t.start + shift })));
    result.files.push(...source.files.map((f) => ({ ...f, toolCallId: id(f.toolCallId), agentId: agent(f.agentId), ts: f.ts + shift })));
    result.modelCalls.push(...source.modelCalls.map((c) => ({ ...c, id: id(c.id), agentId: agent(c.agentId), start: c.start + shift })));
    result.apiErrors.push(...source.apiErrors.map((e) => ({ ...e, id: id(e.id), agentId: agent(e.agentId), ts: e.ts + shift })));
    result.external.push(...source.external.map((x) => ({ ...x, id: id(x.id), agentId: agent(x.agentId), ts: x.ts + shift })));
  }
  const main = source.agents.find((a) => a.agentId === "main")!;
  const endedAt = source.session.endedAt + (copies - 1) * (length + idleMs);
  result.agents.unshift({ ...main, end: endedAt, toolCalls: main.toolCalls * copies, toolErrors: main.toolErrors * copies });
  result.session = {
    ...source.session,
    endedAt,
    activeMs: source.session.activeMs * copies,
    modelCalls: source.session.modelCalls * copies,
    toolCalls: source.session.toolCalls * copies,
    toolErrors: source.session.toolErrors * copies,
    apiErrors: source.session.apiErrors * copies,
  };
  return result;
}

const lanesOf = (model: TimelineModel): Lane[] => model.rows.filter((row): row is Lane => row.type === "lane");
const lane = (model: TimelineModel, id: string): Lane => lanesOf(model).find((l) => l.id === id)!;
/** A window into which a track of width `trackWidth` fits entirely. */
const whole = (trackWidth: number) => ({ trackWidth, x0: -WINDOW_MARGIN_X, x1: trackWidth + WINDOW_MARGIN_X });
/** A screen window of width `screen` at scroll `scrollLeft`. */
const screenAt = (trackWidth: number, scrollLeft: number, screen = 1240): Viewport =>
  quantizeViewport({ scrollLeft, scrollTop: 0, clientWidth: screen, clientHeight: 800, contentWidth: trackWidth + LABEL_WIDTH });
/** Track width at scale `zoom` in a window as wide as the artboard timeline area. */
const widthAt = (model: TimelineModel, zoom: number) => trackWidthOf(model.axis, zoom, 1240);
const shownCount = (model: TimelineModel, viewport: Pick<Viewport, "trackWidth" | "x0" | "x1">) =>
  lanesOf(model).reduce((sum, l) => sum + visibleMarks(l, model.axis, viewport, null, null).length, 0);

describe("a session with a thousand calls", () => {
  const big = repeatTimeline(data, 6);
  const model = buildModel(big, "compact");

  test("example: 1116 tool calls, 852 model calls, 25 agents, 5 gaps", () => {
    expect([big.tools.length, big.modelCalls.length, big.agents.length, big.gaps.length]).toEqual([1116, 852, 25, 5]);
    expect(lane(model, "tools").marks).toHaveLength(1116);
    expect(model.axis.gaps).toHaveLength(5);
    expect(model.axis.activeMs).toBe(6 * 1_122_000);
  });

  test("tracks are not dense: every mark in the window is a button", () => {
    const trackWidth = widthAt(model, 1);
    for (const l of lanesOf(model)) {
      expect(l.marks.length).toBeLessThanOrEqual(DENSE_LANE_MARKS);
      expect(visibleMarks(l, model.axis, whole(trackWidth), null, null)).toHaveLength(l.marks.length);
    }
  });

  test("at 4× scale part of the marks are in the DOM, and a scroll by a step changes few", () => {
    const trackWidth = widthAt(model, 4);
    const tools = lane(model, "tools");
    const before = new Set(visibleMarks(tools, model.axis, screenAt(trackWidth, 1200), null, null));
    const after = new Set(visibleMarks(tools, model.axis, screenAt(trackWidth, 1200 + WINDOW_STEP_X), null, null));
    expect(before.size).toBeLessThan(tools.marks.length);
    const entered = [...after].filter((i) => !before.has(i)).length;
    const left = [...before].filter((i) => !after.has(i)).length;
    // The other marks are the same: React does not touch their buttons.
    expect(entered + left).toBeLessThan(before.size / 2);
  });
});

describe("a session with ten thousand calls", () => {
  const huge = repeatTimeline(data, 54);
  const model = buildModel(huge, "compact");
  const trackWidth = widthAt(model, 1);
  const tools = lane(model, "tools");

  test("example: 10,044 tool calls, 7668 model calls, 217 agents, 53 gaps", () => {
    expect([huge.tools.length, huge.modelCalls.length, huge.agents.length, huge.gaps.length]).toEqual([10_044, 7668, 217, 53]);
    expect(lanesOf(model).reduce((sum, l) => sum + l.marks.length, 0)).toBeGreaterThan(24_000);
  });

  test("a dense track is thinned: the DOM has many times fewer buttons than marks", () => {
    const shown = visibleMarks(tools, model.axis, whole(trackWidth), null, null);
    expect(shown.length).toBeLessThan(tools.marks.length / 2);
    expect(shownCount(model, whole(trackWidth))).toBeLessThan(10_000);
  });

  test("only a mark entirely covered by an identical one on the same pixels is skipped; errors are not lost", () => {
    const shown = visibleMarks(tools, model.axis, whole(trackWidth), null, null);
    const footprint = (i: number) => {
      const mark = tools.marks[i]!;
      return `${Math.round(pointToPx(model.axis, mark.from, trackWidth))}|${Math.round(pointToPx(model.axis, mark.to, trackWidth))}|${mark.look}`;
    };
    const kept = new Set(shown.map(footprint));
    expect(tools.marks.every((_, i) => kept.has(footprint(i)))).toBe(true);
    // The error look differs from the look of a successful call: a neighbor does not cover it.
    const errorColumns = new Set(tools.marks.flatMap((m, i) => (m.error ? [footprint(i)] : [])));
    expect(shown.filter((i) => tools.marks[i]!.error).map(footprint)).toEqual([...errorColumns]);
  });

  test("the selected mark and the focused mark are not thinned", () => {
    const shown = new Set(visibleMarks(tools, model.axis, whole(trackWidth), null, null));
    const hidden = tools.marks.findIndex((_, i) => !shown.has(i));
    expect(hidden).toBeGreaterThan(0);
    const key = tools.marks[hidden]!.key;
    expect(visibleMarks(tools, model.axis, whole(trackWidth), null, key)).toContain(hidden);
    expect(visibleMarks(tools, model.axis, whole(trackWidth), tools.marks[hidden]!.matches[0]!, null)).toContain(hidden);
  });

  test("at 4× scale a scroll by a step changes a small share of buttons, not all", () => {
    const zoomed = widthAt(model, 4);
    let previous = new Set(visibleMarks(tools, model.axis, screenAt(zoomed, 0), null, null));
    let worst = 0;
    for (let scrollLeft = WINDOW_STEP_X; scrollLeft <= zoomed - 1040; scrollLeft += WINDOW_STEP_X) {
      const next = new Set(visibleMarks(tools, model.axis, screenAt(zoomed, scrollLeft), null, null));
      const changed = [...next].filter((i) => !previous.has(i)).length + [...previous].filter((i) => !next.has(i)).length;
      worst = Math.max(worst, changed);
      expect(next.size).toBeLessThan(tools.marks.length / 2);
      previous = next;
    }
    expect(worst).toBeLessThan(tools.marks.length / 4);
  });

  test("Expanded mode: a small part of the rows falls into the window vertically", () => {
    const expanded = buildModel(huge, "expanded");
    expect(expanded.rows.length).toBeGreaterThan(440);
    const viewport = quantizeViewport({ scrollLeft: 0, scrollTop: 4000, clientWidth: 1240, clientHeight: 800, contentWidth: 1240 });
    const { first, last } = visibleRows(expanded.offsets, viewport.y0, viewport.y1);
    expect(last - first).toBeLessThan(40);
    expect(expanded.offsets[first + 1]!).toBeGreaterThan(viewport.y0);
    expect(expanded.offsets[last - 1]!).toBeLessThan(viewport.y1);
  });

  test("the layout and window computation fits in a frame with a margin", () => {
    const startBuild = performance.now();
    buildModel(huge, "compact");
    const buildMs = performance.now() - startBuild;
    const startWindow = performance.now();
    const rounds = 20;
    for (let i = 0; i < rounds; i++) shownCount(model, screenAt(widthAt(model, 4), i * WINDOW_STEP_X));
    const windowMs = (performance.now() - startWindow) / rounds;
    // The layout is computed once per API response, the window on every scroll step change.
    expect(buildMs).toBeLessThan(1000);
    expect(windowMs).toBeLessThan(16);
  });
});

// ── Markup ──────────────────────────────────────────────────────────────────────────────────

const WEB_DIR = join(import.meta.dir, "../../web");

interface ViteServer {
  ssrLoadModule(id: string): Promise<Record<string, any>>;
  close(): Promise<void>;
}

let server: ViteServer;
let renderTimeline: (props: { data: TimelineResponse; selection?: Selection | null; view?: TimelineView; zoom?: TimelineZoom }) => string;
let renderLegend: () => string;
let renderRoute: (location: string) => string;

// On first render Carbon prints reminders about v12 flags: they are not needed in the test output.
const consoleInfo = console.info;

beforeAll(async () => {
  console.info = () => {};
  // Vite is installed in the web package, not in the root.
  const vitePath = createRequire(join(WEB_DIR, "package.json")).resolve("vite");
  const vite = await import(pathToFileURL(vitePath).href);
  server = await vite.createServer({
    root: WEB_DIR,
    configFile: join(WEB_DIR, "vite.config.ts"),
    server: { middlewareMode: true, ws: false, hmr: false },
    appType: "custom",
    logLevel: "silent",
    plugins: [
      {
        // React for the test is taken by the same path as for the components: a single instance.
        name: "torch-test-harness",
        resolveId: (id: string) => (id === "virtual:harness" ? "\0virtual:harness" : null),
        load: (id: string) =>
          id === "\0virtual:harness"
            ? `export { createElement } from "react";
               export { renderToString } from "react-dom/server";
               export { StaticRouter } from "react-router";
               export { App } from "/src/App.tsx";
               export { Timeline } from "/src/components/organisms/Timeline/Timeline.tsx";
               export { TimelineLegend } from "/src/components/organisms/Timeline/TimelineLegend.tsx";`
            : null,
      },
    ],
  });
  const harness = await server.ssrLoadModule("virtual:harness");
  const h = harness.createElement;
  const toHtml = (element: unknown): string => harness.renderToString(element).replaceAll("<!-- -->", "");
  renderTimeline = ({ data: timeline, selection = null, view = "compact", zoom = 1 }) =>
    toHtml(h(harness.Timeline, { data: timeline, selection, view, zoom, onSelect() {} }));
  renderLegend = () => toHtml(h(harness.TimelineLegend));
  renderRoute = (location) => toHtml(h(harness.StaticRouter, { location }, h(harness.App)));
}, 60_000);

afterAll(async () => {
  console.info = consoleInfo;
  await server?.close();
});

const count = (html: string, needle: string) => html.split(needle).length - 1;
const buttons = (html: string) => html.match(/<button[^>]*>/g) ?? [];
/** Track markup in order: each part starts right after the track class. */
const laneHtml = (html: string) => html.split('<div class="Timeline__lane').slice(1);
const isActive = (laneMarkup: string) => laneMarkup.startsWith(" Timeline__laneActive");
const titleOf = (laneMarkup: string) => laneMarkup.match(/Timeline__title[^>]*>([^<]*)</)![1];

describe("markup: Compact mode on the baseline session", () => {
  let html: string;
  beforeAll(() => {
    html = renderTimeline({ data });
  });

  test("the timeline area, the axis with the local start time and ticks", () => {
    expect(html).toStartWith('<section aria-label="Timeline" class="Timeline__root"');
    expect(html).toContain(`>${formatClock(data.session.startedAt)} start</div>`);
    expect([...html.matchAll(/class="Timeline__tick"[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual([
      "0m",
      "2m",
      "4m",
      "6m",
      "8m",
      "10m",
      "12m",
      "14m",
      "16m",
      "18m",
    ]);
    expect(html).toContain('class="Timeline__content" style="width:calc(200px + 1 * max(700px, 100% - 200px))"');
  });

  test("six tracks with labels; each mark is a button with a name", () => {
    const lanes = laneHtml(html);
    expect(lanes.map(titleOf)).toEqual(["Session", "Prompts", "Agents", "Tools", "Files", "Network"]);
    expect(lanes.map((l) => buttons(l).length)).toEqual([1, 3, 5, 186, 110, 147]);
    const all = buttons(html);
    expect(all.every((b) => b.includes('type="button"') && /aria-label="[^"]+"/.test(b) && /title="[^"]+"/.test(b))).toBe(true);
    expect(html).toContain('aria-label="Bash bun install · Main agent at +0:07"');
    expect(html).toContain(">Session · 186 tool calls · 147 network calls · 10 errors</button>");
  });

  test("mark kinds and errors are TimelineMark atom classes", () => {
    expect(count(html, "Timeline__mark TimelineMark__tool")).toBe(186);
    expect(count(html, "Timeline__mark TimelineMark__tool TimelineMark__error")).toBe(7);
    expect(count(html, "Timeline__mark TimelineMark__model TimelineMark__error")).toBe(3);
    expect(count(html, "Timeline__mark TimelineMark__prompt")).toBe(3);
    expect(count(html, "Timeline__mark TimelineMark__agentCompact")).toBe(5);
    expect(count(html, "Timeline__mark TimelineMark__external")).toBe(2);
    expect(count(html, "Timeline__mark TimelineMark__fileRead") + count(html, "Timeline__mark TimelineMark__fileWrite")).toBe(110);
  });

  test("each track has one Tab stop, the first mark; the rest are reached by arrows", () => {
    for (const l of laneHtml(html)) {
      const marks = buttons(l);
      expect(marks.filter((b) => b.includes('tabindex="0"'))).toHaveLength(1);
      expect(marks[0]).toContain('tabindex="0"');
      expect(marks.filter((b) => b.includes('tabindex="-1"'))).toHaveLength(marks.length - 1);
    }
  });

  test("nothing selected: no selected marks, highlighted tracks, dimming or cursor", () => {
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).not.toContain("Timeline__laneActive");
    expect(html).not.toContain("TimelineMark__dimmed");
    expect(html).not.toContain("Timeline__cursor");
    expect(html).not.toContain("Timeline__gap");
  });
});

describe("markup: selection", () => {
  test("tool call: the mark is pressed, its track is highlighted, the cursor is at its start, Tab leads to it", () => {
    const tool = data.tools.find((t) => t.agentId === "gp-1" && t.name === "Bash")!;
    const html = renderTimeline({ data, selection: { kind: "tool", id: tool.id } });
    const pressed = buttons(html).filter((b) => b.includes('aria-pressed="true"'));
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toContain("TimelineMark__tool");
    expect(pressed[0]).toContain('tabindex="0"');
    expect(laneHtml(html).map(isActive)).toEqual([false, false, false, true, false, false]);
    const left = pressed[0]!.match(/left:([^;"]+)/)![1];
    expect(html).toContain(`<span class="Timeline__cursor" style="left:${left}"></span>`);
  });

  test("agent in Compact mode: the marks of the other agents are dimmed", () => {
    const html = renderTimeline({ data, selection: { kind: "agent", id: "gp-1" } });
    const others = (list: { agentId: string }[]) => list.filter((x) => x.agentId !== "gp-1").length;
    const lanes = laneHtml(html);
    expect(lanes.map((l) => count(l, "TimelineMark__dimmed"))).toEqual([
      0,
      0,
      0,
      others(data.tools),
      others(data.files),
      others(data.modelCalls) + others(data.apiErrors) + others(data.external),
    ]);
    expect(lanes.map(isActive)).toEqual([false, false, true, false, false, false]);
    expect(buttons(lanes[2]!).filter((b) => b.includes('aria-pressed="true"'))).toHaveLength(1);
  });

  test("file: all operations on it are pressed", () => {
    const path = data.files[0]!.path;
    const html = renderTimeline({ data, selection: { kind: "file", id: path } });
    expect(count(html, 'aria-pressed="true"')).toBe(data.files.filter((op) => op.path === path).length);
  });
});

describe("markup: Expanded mode", () => {
  test("groups, a track and calls of each agent, a track per file, network", () => {
    const html = renderTimeline({ data, view: "expanded" });
    expect([...html.matchAll(/Timeline__groupTitle">([^<]*)</g)].map((m) => m[1])).toEqual([
      "Session",
      "Agents and tool calls",
      "Files",
      "Network",
    ]);
    expect(html).toContain('<span class="Timeline__title Timeline__titleStrong">Main agent</span>');
    expect(html).toContain('<small class="Timeline__caption">gp-1 · claude-sonnet-4-5</small>');
    expect(html).toContain(">Rewrite tests with bun test</button>");
    expect(html).toContain(
      '<span class="Timeline__title Timeline__titleMono" title="/Users/dev/code/billing-web/src/api/billing/schemas.ts">…/billing/schemas.ts</span>',
    );
    expect(html).toContain(">Model API</span>");
    // The call label has no agent: it is named by the track.
    expect(html).toContain('aria-label="Bash bun install at +0:07"');
  });

  test("a call is selected: both tracks of its agent are highlighted", () => {
    const tool = data.tools.find((t) => t.agentId === "explore-1")!;
    const html = renderTimeline({ data, view: "expanded", selection: { kind: "tool", id: tool.id } });
    expect(laneHtml(html).filter(isActive).map(titleOf).slice(0, 2)).toEqual(["Explore", "Tools"]);
    expect(html).not.toContain("TimelineMark__dimmed");
  });
});

describe("markup: gaps", () => {
  const gapped = repeatTimeline(data, 2, 3 * 3_600_000 + 12 * 60_000);

  test("a gap is a band across all tracks and a duration label on the axis", () => {
    const html = renderTimeline({ data: gapped });
    const gap = gapped.gaps[0]!;
    expect(html).toContain(
      `<span class="Timeline__gapLabel" style="left:calc(0px + (100% - 56px) * 0.5);width:56px" title="No activity for 3h 12m: ${formatClock(gap.start)}–${formatClock(gap.end)}">3h 12m</span>`,
    );
    expect(html).toContain('<span class="Timeline__gap" style="left:calc(0px + (100% - 56px) * 0.5);width:56px"></span>');
    // The gap band is part of the constant width: the scale does not stretch it.
    expect(html).toContain("width:calc(256px + 1 * max(700px, 100% - 256px))");
    // The marks of the second half stand after the gap band.
    expect(html).toContain("left:calc(56px + (100% - 56px) * 0.5)");
    // Ticks after the gap are labeled with the real time since the start.
    expect([...html.matchAll(/class="Timeline__tick"[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(["0m", "5m", "10m", "15m", "3h 35m", "3h 40m", "3h 45m"]);
  });
});

describe("markup: large sessions", () => {
  test("a thousand calls: on first render every mark is a button", () => {
    const html = renderTimeline({ data: repeatTimeline(data, 6) });
    expect(count(html, "Timeline__mark TimelineMark__tool")).toBe(1116);
    expect(buttons(html).length).toBe(1 + 18 + 25 + 1116 + 660 + 882);
  });

  test("ten thousand calls: the DOM has many times fewer buttons than marks, and one Tab stop per track", () => {
    const huge = repeatTimeline(data, 54);
    const total = lanesOf(buildModel(huge, "compact")).reduce((sum, l) => sum + l.marks.length, 0);
    const html = renderTimeline({ data: huge });
    expect(total).toBeGreaterThan(24_000);
    expect(buttons(html).length).toBeLessThan(total / 3);
    expect(count(html, 'tabindex="0"')).toBe(6);
    // Errors are visible in a dense track too.
    expect(count(html, "TimelineMark__error")).toBeGreaterThan(0);
  });

  test("ten thousand calls, Expanded: the DOM has only the rows near the scroll start", () => {
    const huge = repeatTimeline(data, 54);
    const html = renderTimeline({ data: huge, view: "expanded" });
    const shown = laneHtml(html).length;
    expect(buildModel(huge, "expanded").rows.length).toBeGreaterThan(440);
    expect(shown).toBeGreaterThan(10);
    expect(shown).toBeLessThan(40);
  });
});

describe("legend and page", () => {
  test("legend: eight mark samples with the artboard labels", () => {
    const html = renderLegend();
    expect(html).toStartWith('<ul aria-label="Legend"');
    expect([...html.matchAll(/<\/span>([^<]+)<\/li>/g)].map((m) => m[1])).toEqual([
      "Agent run",
      "Tool call",
      "Error (any item that failed)",
      "Prompt",
      "File read",
      "File edit or write",
      "Model API call",
      "External request",
    ]);
    expect(count(html, "TimelineMark__sample")).toBe(8);
  });

  const pressedIn = (html: string, group: string) =>
    html.match(new RegExp(`aria-label="${group}">(.*?)</div>`, "s"))![1]!.match(/aria-pressed="true">([^<]*)</)?.[1];

  test("an address without parameters: Compact, Fit, panel closed, Show details is present", () => {
    const html = renderRoute("/sessions/abc/timeline");
    expect(pressedIn(html, "Density")).toBe("Compact");
    expect(pressedIn(html, "Zoom")).toBe("Fit");
    expect(html).toContain("Show details");
    expect(html).not.toContain('aria-label="Details"');
    expect(html).toContain('class="SessionTimelinePage__workspace"');
    expect(html).toContain('<ul aria-label="Legend"');
  });

  test("mode, scale, dock and selection are read from the address", () => {
    const html = renderRoute("/sessions/abc/timeline?sel=agent:gp-1&dock=left&view=expanded&zoom=4");
    expect(pressedIn(html, "Density")).toBe("Expanded");
    expect(pressedIn(html, "Zoom")).toBe("4×");
    expect(html).toContain("SessionTimelinePage__workspaceLeft");
    // In the dock stands the panel with the marked position and a link to a separate tab with the same selection.
    expect(html).toContain('<div class="SessionTimelinePage__panel"><section class="DetailPanel__root" aria-label="Details">');
    expect(html).toContain('href="/sessions/abc/panel?sel=agent%3Agp-1"');
    expect(html).not.toContain("Show details");
    expect(renderRoute("/sessions/abc/timeline?sel=session&dock=bottom")).toContain("SessionTimelinePage__workspaceBottom");
  });
});

// Timeline layout (W5) on the test/fixtures/dto/timeline.json response: the Compact and
// Expanded mode tracks, mark labels and positions, what follows from the selection for the screen.
import { describe, expect, test } from "bun:test";
import type { TimelineResponse } from "../../src/contracts/api.ts";
import { type Selection, formatSelection } from "../../src/contracts/selection.ts";
import {
  GROUP_HEIGHT,
  LANE_HEIGHT,
  type Lane,
  type Row,
  type TimelineModel,
  buildModel,
  contentWidthCss,
  laneSelection,
  markDimmed,
  markSelected,
  selectionContext,
  selectionLabel,
  shortPath,
  trackWidth,
} from "../../web/src/components/organisms/Timeline/model.ts";
import { formatClock } from "../../web/src/lib/format.ts";
import reference from "../fixtures/dto/timeline.json";

const data = reference as unknown as TimelineResponse;
const compact = buildModel(data, "compact");
const expanded = buildModel(data, "expanded");

const lanes = (model: TimelineModel): Lane[] => model.rows.filter((row): row is Lane => row.type === "lane");
const laneById = (model: TimelineModel, id: string): Lane => {
  const lane = lanes(model).find((l) => l.id === id);
  if (!lane) throw new Error(`No track ${id}`);
  return lane;
};
const outline = (rows: Row[]) => rows.map((row) => (row.type === "group" ? `# ${row.title}` : row.title));
const SCHEMAS = "/Users/dev/code/billing-web/src/api/billing/schemas.ts";

describe("Compact mode", () => {
  test("six tracks in artboard order with labels from the data", () => {
    expect(lanes(compact).map((l) => [l.title, l.caption])).toEqual([
      ["Session", "8f3c1a2e · 18m 36s"],
      ["Prompts", "3 user messages"],
      ["Agents", "5 · 1 main, 4 subagents"],
      ["Tools", "186 calls · 7 failed"],
      ["Files", "13 files · 110 operations"],
      ["Network", "147 requests · 3 failed"],
    ]);
    expect(compact.rows.every((row) => row.type === "lane")).toBe(true);
  });

  test("each response record is a mark of its own track", () => {
    expect(lanes(compact).map((l) => l.marks.length)).toEqual([1, 3, 5, 186, 110, 147]);
  });

  test("the marks of each track are in time order", () => {
    for (const lane of [...lanes(compact), ...lanes(expanded)]) {
      for (let i = 1; i < lane.marks.length; i++) expect(lane.marks[i]!.start).toBeGreaterThanOrEqual(lane.marks[i - 1]!.start);
    }
  });

  test("session band: the full width, totals in the text", () => {
    const [mark] = laneById(compact, "session").marks;
    expect(mark).toMatchObject({
      kind: "session",
      left: "0%",
      width: "max(3px, 100%)",
      text: "Session · 186 tool calls · 147 network calls · 10 errors",
      select: { kind: "session" },
    });
  });

  test("prompts: a diamond at the send moment, a label with the local time", () => {
    const marks = laneById(compact, "prompts").marks;
    expect(marks.map((m) => m.left)).toEqual(["0%", "45.6328%", "89.8396%"]);
    expect(marks.map((m) => m.width)).toEqual([undefined, undefined, undefined]);
    expect(marks[0]!.label).toBe(`Original prompt at ${formatClock(data.prompts[0]!.ts)}`);
    expect(marks[1]!.label).toBe(`Follow-up prompt at ${formatClock(data.prompts[1]!.ts)}`);
    expect(marks[1]!.select).toEqual({ kind: "prompt", id: "ref-prompt-2" });
  });

  test("agents: simultaneous launches stand in different rows of the track, the track height follows the row count", () => {
    const lane = laneById(compact, "agents");
    expect(lane.marks.map((m) => [m.key, m.top])).toEqual([
      ["main", "5px"],
      ["explore-1", "16px"],
      ["plan-1", "16px"],
      ["gp-1", "16px"],
      ["gp-2", "27px"],
    ]);
    expect(lane.height).toBe(3 * 11 + 8 + 1);
    const explore = lane.marks[1]!;
    expect(explore).toMatchObject({ kind: "agent-compact", left: "5.7041%", width: "max(3px, 13.0125%)", select: { kind: "agent", id: "explore-1" } });
    expect(explore.label).toBe(
      `Explore · explore-1 · Map existing API client usage · ${formatClock(data.agents[1]!.start)}–${formatClock(data.agents[1]!.end)}`,
    );
  });

  test("tool call: width by duration, the label names the agent, the error is marked", () => {
    const tools = laneById(compact, "tools").marks;
    expect(tools[0]).toMatchObject({
      key: "toolu_main_001",
      kind: "tool",
      left: "0.6462%",
      width: "max(3px, 0.6462%)",
      label: "Bash bun install · Main agent at +0:07",
      error: false,
      agentId: "main",
      select: { kind: "tool", id: "toolu_main_001" },
    });
    const failed = tools.filter((m) => m.error);
    expect(failed).toHaveLength(data.session.toolErrors);
    expect(failed.every((m) => m.label.endsWith(", failed"))).toBe(true);
    expect(tools.find((m) => m.agentId === "gp-1")!.label).toContain(" · general-purpose · gp-1 at +");
  });

  test("a call without a result, a denial and an interruption are not errors, the status is named in the label", () => {
    const tool = (id: string, status: TimelineResponse["tools"][number]["status"], durationMs: number | null) => ({
      ...data.tools[0]!,
      id,
      status,
      durationMs,
    });
    const model = buildModel({ ...data, tools: [tool("a", "pending", null), tool("b", "denied", 10), tool("c", "interrupted", 10)] }, "compact");
    const marks = laneById(model, "tools").marks;
    expect(marks.map((m) => m.error)).toEqual([false, false, false]);
    expect(marks.map((m) => m.label.split(", ")[1])).toEqual(["running", "denied", "interrupted"]);
    expect(marks[0]!.width).toBe("max(3px, 0%)");
  });

  test("file operations: a read and an edit differ in kind, a press opens the file", () => {
    const files = laneById(compact, "files").marks;
    expect(files[0]).toMatchObject({
      kind: "file-write",
      label: `Edit ${SCHEMAS} by Main agent at +0:43`,
      select: { kind: "file", id: SCHEMAS },
    });
    expect(new Set(files.map((m) => m.kind))).toEqual(new Set(["file-read", "file-write"]));
    expect(files.filter((m) => m.kind === "file-read")).toHaveLength(data.files.filter((op) => op.op === "read").length);
  });

  test("network: model calls, failed attempts and external requests in one track", () => {
    const net = laneById(compact, "network").marks;
    expect(net.filter((m) => m.kind === "model" && !m.error)).toHaveLength(142);
    expect(net.filter((m) => m.kind === "external")).toHaveLength(2);
    const errors = net.filter((m) => m.error);
    expect(errors.map((m) => m.select)).toEqual([
      { kind: "net", net: "error", id: "ref-apierr-explore-1" },
      { kind: "net", net: "error", id: "ref-apierr-main" },
      { kind: "net", net: "error", id: "ref-apierr-gp-1" },
    ]);
    expect(errors[0]!.label).toBe("Model API call · Explore · explore-1 at +1:47, failed");
    expect(net.find((m) => m.kind === "external")).toMatchObject({
      label: "Web fetch · Plan · plan-1 at +4:47",
      select: { kind: "net", net: "external", id: "toolu_plan-1_008" },
    });
  });

  test("mark keys are unique within a track", () => {
    for (const lane of [...lanes(compact), ...lanes(expanded)]) expect(lane.index.size).toBe(lane.marks.length);
  });
});

describe("Expanded mode", () => {
  test("groups and tracks in artboard order", () => {
    expect(outline(expanded.rows).slice(0, 14)).toEqual([
      "# Session",
      "Session",
      "Prompts",
      "# Agents and tool calls",
      "Main agent",
      "Tools",
      "Explore",
      "Tools",
      "Plan",
      "Tools",
      "general-purpose",
      "Tools",
      "general-purpose",
      "Tools",
    ]);
    expect(outline(expanded.rows).slice(-3)).toEqual(["# Network", "Model API", "External"]);
  });

  test("agent: a band with the task description and its own call track", () => {
    const bar = laneById(expanded, "agent gp-1");
    expect(bar).toMatchObject({ title: "general-purpose", titleTone: "strong", caption: "gp-1 · claude-sonnet-4-5", agentId: "gp-1" });
    expect(bar.marks[0]).toMatchObject({ kind: "agent", text: "Rewrite tests with bun test", left: "54.3672%", width: "max(3px, 26.2923%)" });
    const tools = laneById(expanded, "tools gp-1");
    expect(tools).toMatchObject({ title: "Tools", titleTone: "secondary", caption: "49 calls · 4 failed", agentId: "gp-1" });
    expect(tools.marks).toHaveLength(49);
    expect(tools.marks.every((m) => m.agentId === "gp-1")).toBe(true);
    // The agent is named by the track, it is not in the mark label.
    expect(tools.marks[0]!.label).toBe("Read /Users/dev/code/billing-web/openapi-ts.config.ts at +10:12");
    expect(laneById(expanded, "tools explore-1").caption).toBe("38 calls");
    expect(laneById(expanded, "agent main").marks[0]!.text).toBe("Orchestrator");
  });

  test("calls of all agents together are all the calls of the session", () => {
    const total = lanes(expanded)
      .filter((l) => l.id.startsWith("tools "))
      .reduce((sum, l) => sum + l.marks.length, 0);
    expect(total).toBe(186);
  });

  test("files: a track per file, by descending operation count, a short path in the label", () => {
    const files = lanes(expanded).filter((l) => l.id.startsWith("file "));
    expect(files).toHaveLength(13);
    expect(files[0]).toMatchObject({ title: "…/billing/schemas.ts", titleTone: "mono", titleHint: SCHEMAS, caption: "6 reads · 9 changes" });
    const counts = files.map((l) => l.marks.length);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(110);
    expect(files.at(-1)!.caption).toBe("0 reads · 1 change");
  });

  test("network: Model API with failed attempts and External", () => {
    expect(laneById(expanded, "model-api")).toMatchObject({ caption: "145 calls · 3 failed" });
    expect(laneById(expanded, "model-api").marks).toHaveLength(145);
    expect(laneById(expanded, "external")).toMatchObject({ caption: "2 requests" });
  });

  test("a nested subagent gets a label indent, the main agent's subagents do not", () => {
    const nested = { ...data.agents[4]!, agentId: "nested-1", parentAgentId: "gp-1", depth: 2 };
    const model = buildModel({ ...data, agents: [...data.agents, nested] }, "expanded");
    expect(laneById(model, "agent gp-1").indent).toBe(0);
    expect(laneById(model, "agent nested-1").indent).toBe(1);
    expect(laneById(model, "tools nested-1").indent).toBe(1);
  });

  test("row heights add up to offsets: the rows are placed by them", () => {
    expect(expanded.offsets).toHaveLength(expanded.rows.length + 1);
    expect(expanded.offsets[0]).toBe(0);
    const groups = expanded.rows.filter((row) => row.type === "group").length;
    expect(expanded.offsets.at(-1)).toBe(groups * GROUP_HEIGHT + (expanded.rows.length - groups) * LANE_HEIGHT);
    expect(expanded.offsets[2]).toBe(GROUP_HEIGHT + LANE_HEIGHT);
  });
});

describe("axis and gaps in the layout", () => {
  test("the axis label is the local start time; the baseline session has no gaps", () => {
    expect(compact.startLabel).toBe(`${formatClock(data.session.startedAt)} start`);
    expect(compact.axis.gaps).toEqual([]);
  });

  test("a gap from the response shifts the marks after it by its band", () => {
    // Between the second and third prompts of the baseline session there are three hours idle.
    const cut = data.prompts[2]!.ts - 20_000;
    const shift = (ts: number) => (ts >= cut ? ts + 3 * 3_600_000 : ts);
    const gapped: TimelineResponse = {
      ...data,
      session: { ...data.session, endedAt: shift(data.session.endedAt) },
      gaps: [{ start: cut, end: cut + 3 * 3_600_000 }],
      prompts: data.prompts.map((p) => ({ ...p, ts: shift(p.ts) })),
    };
    const model = buildModel(gapped, "compact");
    expect(model.axis.activeMs).toBe(1_122_000);
    const prompts = laneById(model, "prompts").marks;
    expect(prompts[1]!.left).toBe("calc(0px + (100% - 56px) * 0.456328)");
    expect(prompts[2]!.left).toBe("calc(56px + (100% - 56px) * 0.898396)");
    // The session band goes through the gap.
    expect(laneById(model, "session").marks[0]!.width).toBe("max(3px, calc(56px + (100% - 56px) * 1))");
  });
});

describe("track width", () => {
  const plain = compact.axis;
  const gapped = buildModel({ ...data, gaps: [{ start: data.session.startedAt + 60_000, end: data.session.startedAt + 120_000 }] }, "compact").axis;

  test("Fit: the track takes the window without the label column, but no narrower than in the artboard", () => {
    expect(trackWidth(plain, 1, 1440)).toBe(1240);
    expect(trackWidth(plain, 1, 600)).toBe(700);
    expect(contentWidthCss(plain, 1)).toBe("calc(200px + 1 * max(700px, 100% - 200px))");
  });

  test("scale stretches the active part, gap bands stay the same", () => {
    expect(trackWidth(plain, 4, 1440)).toBe(4 * 1240);
    expect(trackWidth(gapped, 1, 1440)).toBe(1240);
    expect(trackWidth(gapped, 2, 1440)).toBe(56 + 2 * (1240 - 56));
    // The window is narrower than the gap bands and the smallest active part: the scale stretches anyway.
    expect(trackWidth(gapped, 1, 500)).toBe(56 + 700);
    expect(trackWidth(gapped, 4, 500)).toBe(56 + 4 * 700);
    expect(contentWidthCss(gapped, 4)).toBe("calc(256px + 4 * max(700px, 100% - 256px))");
  });
});

describe("selection", () => {
  const context = (sel: Selection | null, view: "compact" | "expanded" = "compact") => selectionContext(data, sel, view);
  const activeLanes = (model: TimelineModel, sel: Selection, view: "compact" | "expanded") =>
    lanes(model)
      .filter((lane) => laneSelection(lane, context(sel, view)).active)
      .map((lane) => lane.id);

  test("nothing selected: no cursor, highlight or dimming", () => {
    expect(context(null)).toEqual({ key: null, focusAgent: null, cursorTs: null, dimAgent: null });
    expect(lanes(compact).some((lane) => laneSelection(lane, context(null)).active)).toBe(false);
  });

  test("tool call: the cursor at its start, its tracks highlighted", () => {
    const tool = data.tools.find((t) => t.agentId === "gp-1" && t.name === "Edit")!;
    const sel: Selection = { kind: "tool", id: tool.id };
    expect(context(sel)).toEqual({ key: `tool:${tool.id}`, focusAgent: "gp-1", cursorTs: tool.start, dimAgent: null });
    // Compact: the Tools track and the Files track where this call's operation stands.
    expect(activeLanes(compact, sel, "compact")).toEqual(["tools", "files"]);
    // Expanded: both tracks of the agent and the track of the file it edited.
    expect(activeLanes(expanded, sel, "expanded")).toEqual(["agent gp-1", "tools gp-1", `file ${tool.target}`]);
  });

  test("the selected mark is one; a file operation is highlighted also when its call is selected", () => {
    const op = data.files[0]!;
    const toolKey = formatSelection({ kind: "tool", id: op.toolCallId });
    expect(laneById(compact, "tools").marks.filter((m) => markSelected(m, toolKey)).map((m) => m.key)).toEqual([op.toolCallId]);
    expect(laneById(compact, "files").marks.filter((m) => markSelected(m, toolKey))).toHaveLength(1);
    expect(markSelected(laneById(compact, "tools").marks[0]!, null)).toBe(false);
  });

  test("file: all operations on it and its track are highlighted; no cursor", () => {
    const sel: Selection = { kind: "file", id: SCHEMAS };
    expect(context(sel).cursorTs).toBeNull();
    expect(laneById(compact, "files").marks.filter((m) => markSelected(m, formatSelection(sel)))).toHaveLength(15);
    expect(activeLanes(compact, sel, "compact")).toEqual(["files"]);
    expect(activeLanes(expanded, sel, "expanded")).toEqual([`file ${SCHEMAS}`]);
  });

  test("agent in Compact mode: the marks of the other agents are dimmed in Tools, Files and Network", () => {
    const sel: Selection = { kind: "agent", id: "gp-1" };
    const ctx = context(sel);
    expect(ctx).toEqual({ key: "agent:gp-1", focusAgent: "gp-1", cursorTs: null, dimAgent: "gp-1" });
    expect(activeLanes(compact, sel, "compact")).toEqual(["agents"]);
    expect(lanes(compact).map((lane) => laneSelection(lane, ctx).dimAgent)).toEqual([null, null, null, "gp-1", "gp-1", "gp-1"]);
    const tools = laneById(compact, "tools").marks;
    const bright = tools.filter((m) => !markDimmed(m, "gp-1"));
    expect(bright).toHaveLength(49);
    expect(bright.every((m) => m.agentId === "gp-1")).toBe(true);
    expect(tools.filter((m) => markDimmed(m, null))).toHaveLength(0);
  });

  test("agent in Expanded mode: its tracks are highlighted, no dimming", () => {
    const sel: Selection = { kind: "agent", id: "gp-1" };
    expect(context(sel, "expanded").dimAgent).toBeNull();
    expect(activeLanes(expanded, sel, "expanded")).toEqual(["agent gp-1", "tools gp-1"]);
    expect(lanes(expanded).every((lane) => laneSelection(lane, context(sel, "expanded")).dimAgent === null)).toBe(true);
  });

  test("prompt and network calls: the cursor at the event moment", () => {
    expect(context({ kind: "prompt", id: "ref-prompt-2" })).toMatchObject({ cursorTs: data.prompts[1]!.ts, focusAgent: null });
    expect(context({ kind: "net", net: "model", id: "req_main_002" })).toMatchObject({ cursorTs: data.modelCalls[1]!.start, focusAgent: "main" });
    expect(context({ kind: "net", net: "error", id: "ref-apierr-gp-1" })).toMatchObject({ cursorTs: data.apiErrors[2]!.ts, focusAgent: "gp-1" });
    expect(context({ kind: "net", net: "external", id: "toolu_plan-1_008" })).toMatchObject({ cursorTs: data.external[0]!.ts, focusAgent: "plan-1" });
    expect(activeLanes(compact, { kind: "net", net: "error", id: "ref-apierr-gp-1" }, "compact")).toEqual(["network"]);
    expect(activeLanes(expanded, { kind: "net", net: "model", id: "req_main_002" }, "expanded")).toEqual(["agent main", "tools main", "model-api"]);
  });

  test("session: its track is highlighted", () => {
    expect(activeLanes(compact, { kind: "session" }, "compact")).toEqual(["session"]);
  });

  test("a selection that is not in the data highlights nothing and does not crash", () => {
    const ctx = context({ kind: "tool", id: "no-such-id" });
    expect(ctx).toEqual({ key: "tool:no-such-id", focusAgent: null, cursorTs: null, dimAgent: null });
    expect(lanes(compact).some((lane) => laneSelection(lane, ctx).active)).toBe(false);
  });

  test("the \"Back to …\" button label", () => {
    expect(selectionLabel(data, { kind: "session" })).toBe("session");
    expect(selectionLabel(data, { kind: "agent", id: "main" })).toBe("Main agent");
    expect(selectionLabel(data, { kind: "agent", id: "gp-1" })).toBe("general-purpose (gp-1)");
    expect(selectionLabel(data, { kind: "tool", id: "toolu_main_001" })).toBe("Bash call");
    expect(selectionLabel(data, { kind: "tool", id: "none" })).toBe("tool call");
    expect(selectionLabel(data, { kind: "file", id: SCHEMAS })).toBe("file");
    expect(selectionLabel(data, { kind: "prompt", id: "ref-prompt-1" })).toBe("prompt");
    expect(selectionLabel(data, { kind: "net", net: "model", id: "req_main_001" })).toBe("network call");
  });
});

test("shortPath: a long path is shortened to the last two parts", () => {
  expect(shortPath(SCHEMAS)).toBe("…/billing/schemas.ts");
  expect(shortPath("package.json")).toBe("package.json");
  expect(shortPath("src/index.ts")).toBe("src/index.ts");
});

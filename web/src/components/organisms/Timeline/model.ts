// Timeline layout without rendering: API response → rows (groups and lanes) with marks, each
// mark having its position, label and the selection it opens ready. Also here — what follows from
// the selection for the screen: the cursor, the highlighted lane, dimming of other agents' marks.
import type { TimelineAgent, TimelineResponse } from "@contracts/api.ts";
import { MAIN_AGENT_ID } from "@contracts/constants.ts";
import { type Selection, type TimelineView, formatSelection } from "@contracts/selection.ts";
import { formatClock, formatCount, formatDuration, formatOffset } from "../../../lib/format.ts";
import { type Axis, type AxisPoint, GAP_WIDTH, buildAxis, cssLeft, cssWidth, locate } from "./axis.ts";

// Layout sizes, px. The only place: the styles receive them through element props.
/** Lane label column; sticks to the left edge. */
export const LABEL_WIDTH = 200;
/** Smallest width of the active part of a lane at Fit zoom: in the artboard the content is no narrower than 900px including labels. */
export const MIN_TRACK_WIDTH = 700;
/** Axis row; sticks to the top edge. */
export const AXIS_HEIGHT = 33;
/** Lane: a two-line label and a line at the bottom. */
export const LANE_HEIGHT = 39;
/** Header of a lane group in Expanded mode. */
export const GROUP_HEIGHT = 29;
// The Agents lane in Compact mode: runs that go on simultaneously sit one under another.
const AGENT_LEVEL_STEP = 11;
const AGENT_LEVEL_TOP = 5;
const AGENT_LEVELS_PADDING = 8;

/** Mark kinds; they match the kinds of the TimelineMark atom, which Mark.tsx draws them with. */
export type MarkKind =
  | "session"
  | "agent"
  | "agent-compact"
  | "tool"
  | "prompt"
  | "file-read"
  | "file-write"
  | "model"
  | "external";

export interface Mark {
  /** Unique within a lane. */
  key: string;
  kind: MarkKind;
  start: number;
  /** Equals start for a mark without a duration. */
  end: number;
  from: AxisPoint;
  to: AxisPoint;
  /** CSS values: position, width (for marks with a duration), row inside the lane. */
  left: string;
  width?: string;
  top?: string;
  /** Button name for assistive technologies and the hint. */
  label: string;
  /** Text inside the session and agent bar. */
  text?: string;
  error: boolean;
  agentId: string | null;
  /** What a click opens. */
  select: Selection;
  /** Selection records (formatSelection) for which the mark is shown as selected. */
  matches: readonly string[];
  /** Everything the look of the mark depends on, except position: identical ones on one pixel are indistinguishable. */
  look: string;
}

export type LaneTitleTone = "plain" | "strong" | "secondary" | "mono";

export interface Lane {
  type: "lane";
  id: string;
  title: string;
  titleTone: LaneTitleTone;
  /** Title hint: the full file path. */
  titleHint?: string;
  caption: string;
  /** Label indent, levels: nested subagents (plan §9.3). */
  indent: number;
  height: number;
  /** By start time. */
  marks: Mark[];
  /** reach[i] — the greatest end among marks 0…i: the first mark reaching the window is searched by it. */
  reach: number[];
  /** Mark key → its number. */
  index: Map<string, number>;
  /** All selection records for which the lane has a selected mark. */
  keys: Set<string>;
  /** The lane of one agent in Expanded mode. */
  agentId: string | null;
  /** The lane has marks of different agents: those of others are dimmed when an agent is selected. */
  dimmable: boolean;
}

export interface Group {
  type: "group";
  id: string;
  title: string;
  height: number;
}

export type Row = Lane | Group;

export interface TimelineModel {
  axis: Axis;
  rows: Row[];
  /** offsets[i] — the top of the i-th row; offsets[rows.length] — the total height. */
  offsets: number[];
  /** Axis row label: the local start time of the session. */
  startLabel: string;
}

/**
 * Lane width in a window of width `clientWidth`: gap bands are constant, the zoom stretches
 * only the active part, and at Fit it takes the rest of the window, but no less than MIN_TRACK_WIDTH.
 */
export function trackWidth(axis: Axis, zoom: number, clientWidth: number): number {
  const gapsWidth = axis.gaps.length * GAP_WIDTH;
  return gapsWidth + zoom * Math.max(MIN_TRACK_WIDTH, clientWidth - LABEL_WIDTH - gapsWidth);
}

/** The same as a CSS rule for the content width including the label column: the browser computes it itself. */
export function contentWidthCss(axis: Axis, zoom: number): string {
  const fixed = LABEL_WIDTH + axis.gaps.length * GAP_WIDTH;
  return `calc(${fixed}px + ${zoom} * max(${MIN_TRACK_WIDTH}px, 100% - ${fixed}px))`;
}

const plural = (count: number, one: string, many = `${one}s`) => `${formatCount(count)} ${count === 1 ? one : many}`;

const isMain = (agent: TimelineAgent) => agent.agentId === MAIN_AGENT_ID;

/** Short form of a session identifier, as in the breadcrumbs. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Agent lane title: "Main agent" or the subagent type. */
function agentTitle(agent: TimelineAgent): string {
  return isMain(agent) ? "Main agent" : (agent.type ?? agent.agentId);
}

/** Agent name in mark labels: "Main agent", "Explore · explore-1". */
function agentName(agent: TimelineAgent | undefined, agentId: string): string {
  if (!agent) return agentId;
  return isMain(agent) ? "Main agent" : `${agent.type ?? "Subagent"} · ${agent.agentId}`;
}

/** "…/billing/schemas.ts" for a long path. */
export function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

const FILE_OP_LABEL = { read: "Read", edit: "Edit", write: "Write" } as const;
const EXTERNAL_LABEL = { web_fetch: "Web fetch", web_search: "Web search" } as const;
/** Call label suffix by status; a successful call has none. */
const TOOL_STATUS_SUFFIX = { ok: "", error: ", failed", denied: ", denied", interrupted: ", interrupted", pending: ", running" } as const;

type MarkInput = Omit<Mark, "from" | "to" | "left" | "width" | "top" | "matches" | "look"> & { row?: number };

/** A mark with a position on the axis. `sized` — the kind has a duration, otherwise it is a point in time. */
function place(axis: Axis, input: MarkInput, sized: boolean, extraMatches: string[] = []): Mark {
  const { row, ...rest } = input;
  const from = locate(axis, input.start);
  const to = sized ? locate(axis, input.end) : from;
  return {
    ...rest,
    from,
    to,
    left: cssLeft(axis, from),
    width: sized ? cssWidth(axis, from, to) : undefined,
    top: row === undefined ? undefined : `${AGENT_LEVEL_TOP + row * AGENT_LEVEL_STEP}px`,
    matches: [formatSelection(input.select), ...extraMatches],
    look: `${input.kind}|${input.error ? 1 : 0}|${input.agentId ?? ""}|${row ?? 0}`,
  };
}

type LaneInput = Pick<Lane, "id" | "title" | "caption"> & Partial<Pick<Lane, "titleTone" | "titleHint" | "indent" | "height" | "agentId" | "dimmable">>;

function lane(input: LaneInput, unsorted: Mark[]): Lane {
  const marks = [...unsorted].sort((a, b) => a.start - b.start);
  const reach: number[] = [];
  const index = new Map<string, number>();
  const keys = new Set<string>();
  let far = Number.NEGATIVE_INFINITY;
  marks.forEach((mark, i) => {
    far = Math.max(far, mark.end);
    reach.push(far);
    index.set(mark.key, i);
    for (const key of mark.matches) keys.add(key);
  });
  return {
    type: "lane",
    titleTone: "plain",
    indent: 0,
    height: LANE_HEIGHT,
    agentId: null,
    dimmable: false,
    ...input,
    marks,
    reach,
    index,
    keys,
  };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(keyOf(item));
    if (list) list.push(item);
    else groups.set(keyOf(item), [item]);
  }
  return groups;
}

const group = (id: string, title: string): Group => ({ type: "group", id, title, height: GROUP_HEIGHT });

/** Layout for the `view` mode. The marks of each lane are ordered by time. */
export function buildModel(data: TimelineResponse, view: TimelineView): TimelineModel {
  const { session } = data;
  const axis = buildAxis(session.startedAt, session.endedAt, data.gaps);
  const agentsById = new Map(data.agents.map((agent) => [agent.agentId, agent]));
  const nameOf = (agentId: string) => agentName(agentsById.get(agentId), agentId);
  const offset = (ts: number) => formatOffset(ts - session.startedAt);
  const compact = view === "compact";

  // ── Session and Prompts: identical in both modes ──────────────────────────────────────────
  const networkCalls = data.modelCalls.length + data.apiErrors.length + data.external.length;
  const networkFailed = data.apiErrors.length + data.external.filter((x) => x.error).length;
  const sessionText = [
    "Session",
    plural(session.toolCalls, "tool call"),
    plural(networkCalls, "network call"),
    plural(session.toolErrors + networkFailed, "error"),
  ].join(" · ");
  const sessionLane = lane({ id: "session", title: "Session", caption: `${shortId(session.id)} · ${formatDuration(session.activeMs)}` }, [
    place(
      axis,
      { key: "session", kind: "session", start: axis.start, end: axis.end, label: sessionText, text: sessionText, error: false, agentId: null, select: { kind: "session" } },
      true,
    ),
  ]);
  const promptsLane = lane(
    { id: "prompts", title: "Prompts", caption: plural(data.prompts.length, "user message") },
    data.prompts.map((prompt) =>
      place(
        axis,
        {
          key: prompt.id,
          kind: "prompt",
          start: prompt.ts,
          end: prompt.ts,
          label: `${prompt.kind === "original" ? "Original prompt" : "Follow-up prompt"} at ${formatClock(prompt.ts)}`,
          error: false,
          agentId: null,
          select: { kind: "prompt", id: prompt.id },
        },
        false,
      ),
    ),
  );

  // ── Marks shared by the modes: in Compact the label names the agent, in Expanded the lane names it ───
  const agentMark = (agent: TimelineAgent, kind: "agent" | "agent-compact", row?: number): Mark => {
    const description = agent.description ?? (isMain(agent) ? "Orchestrator" : null);
    return place(
      axis,
      {
        key: agent.agentId,
        kind,
        start: agent.start,
        end: agent.end,
        label: [nameOf(agent.agentId), description, `${formatClock(agent.start)}–${formatClock(agent.end)}`].filter(Boolean).join(" · "),
        text: kind === "agent" ? (description ?? agentTitle(agent)) : undefined,
        error: false,
        agentId: agent.agentId,
        select: { kind: "agent", id: agent.agentId },
        row,
      },
      true,
    );
  };
  const toolMarks = (tools: TimelineResponse["tools"], withAgent: boolean) =>
    tools.map((tool) =>
      place(
        axis,
        {
          key: tool.id,
          kind: "tool",
          start: tool.start,
          end: tool.start + (tool.durationMs ?? 0),
          label: `${[tool.name, tool.target].filter(Boolean).join(" ")}${withAgent ? ` · ${nameOf(tool.agentId)}` : ""} at ${offset(tool.start)}${TOOL_STATUS_SUFFIX[tool.status]}`,
          error: tool.status === "error",
          agentId: tool.agentId,
          select: { kind: "tool", id: tool.id },
        },
        true,
      ),
    );
  const fileMarks = (ops: TimelineResponse["files"]) =>
    ops.map((op) =>
      place(
        axis,
        {
          key: `${op.toolCallId} ${op.path}`,
          kind: op.op === "read" ? "file-read" : "file-write",
          start: op.ts,
          end: op.ts,
          label: `${FILE_OP_LABEL[op.op]} ${op.path} by ${nameOf(op.agentId)} at ${offset(op.ts)}${op.error ? ", failed" : ""}`,
          error: op.error,
          agentId: op.agentId,
          select: { kind: "file", id: op.path },
        },
        false,
        // The operation is highlighted also when the tool call that performed it is selected.
        [formatSelection({ kind: "tool", id: op.toolCallId })],
      ),
    );
  const modelMarks = () => [
    ...data.modelCalls.map((call) =>
      place(
        axis,
        {
          key: `model ${call.id}`,
          kind: "model",
          start: call.start,
          end: call.start,
          label: `Model API call · ${nameOf(call.agentId)} at ${offset(call.start)}`,
          error: false,
          agentId: call.agentId,
          select: { kind: "net", net: "model", id: call.id },
        },
        false,
      ),
    ),
    ...data.apiErrors.map((error) =>
      place(
        axis,
        {
          key: `error ${error.id}`,
          kind: "model",
          start: error.ts,
          end: error.ts,
          label: `Model API call · ${nameOf(error.agentId)} at ${offset(error.ts)}, failed`,
          error: true,
          agentId: error.agentId,
          select: { kind: "net", net: "error", id: error.id },
        },
        false,
      ),
    ),
  ];
  const externalMarks = () =>
    data.external.map((request) =>
      place(
        axis,
        {
          key: `external ${request.id}`,
          kind: "external",
          start: request.ts,
          end: request.ts,
          label: `${EXTERNAL_LABEL[request.kind]} · ${nameOf(request.agentId)} at ${offset(request.ts)}${request.error ? ", failed" : ""}`,
          error: request.error,
          agentId: request.agentId,
          select: { kind: "net", net: "external", id: request.id },
        },
        false,
      ),
    );

  const filesCount = new Set(data.files.map((op) => op.path)).size;
  const failed = (count: number) => `${formatCount(count)} failed`;
  let rows: Row[];

  if (compact) {
    // A run takes the first row that is free at its start.
    const levelEnds: number[] = [];
    const agentMarks = [...data.agents]
      .sort((a, b) => a.start - b.start)
      .map((agent) => {
        let level = 0;
        while (levelEnds[level] !== undefined && levelEnds[level]! > agent.start) level++;
        levelEnds[level] = agent.end;
        return agentMark(agent, "agent-compact", level);
      });
    const subagents = data.agents.filter((agent) => !isMain(agent)).length;
    rows = [
      sessionLane,
      promptsLane,
      lane(
        {
          id: "agents",
          title: "Agents",
          caption: `${formatCount(data.agents.length)} · ${data.agents.length - subagents} main, ${plural(subagents, "subagent")}`,
          height: Math.max(LANE_HEIGHT, levelEnds.length * AGENT_LEVEL_STEP + AGENT_LEVELS_PADDING + 1),
        },
        agentMarks,
      ),
      lane(
        { id: "tools", title: "Tools", caption: `${plural(data.tools.length, "call")} · ${failed(session.toolErrors)}`, dimmable: true },
        toolMarks(data.tools, true),
      ),
      lane(
        { id: "files", title: "Files", caption: `${plural(filesCount, "file")} · ${plural(data.files.length, "operation")}`, dimmable: true },
        fileMarks(data.files),
      ),
      lane(
        { id: "network", title: "Network", caption: `${plural(networkCalls, "request")} · ${failed(networkFailed)}`, dimmable: true },
        [...modelMarks(), ...externalMarks()],
      ),
    ];
  } else {
    const toolsByAgent = groupBy(data.tools, (tool) => tool.agentId);
    const opsByPath = groupBy(data.files, (op) => op.path);
    // Files — by descending number of operations, as in the artboard; with a tie — by the first operation.
    const fileLanes = [...opsByPath.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[1][0]!.ts - b[1][0]!.ts)
      .map(([path, ops]) => {
        const reads = ops.filter((op) => op.op === "read").length;
        return lane(
          {
            id: `file ${path}`,
            title: shortPath(path),
            titleTone: "mono",
            titleHint: path,
            caption: `${plural(reads, "read")} · ${plural(ops.length - reads, "change")}`,
          },
          fileMarks(ops),
        );
      });
    rows = [
      group("group-session", "Session"),
      sessionLane,
      promptsLane,
      group("group-agents", "Agents and tool calls"),
      ...data.agents.flatMap((agent) => [
        lane(
          {
            id: `agent ${agent.agentId}`,
            title: agentTitle(agent),
            titleTone: "strong",
            caption: [agent.agentId, agent.model].filter(Boolean).join(" · "),
            // The main agent and its subagents stand level, as in the artboard; the indent is for nested ones.
            indent: Math.max(0, agent.depth - 1),
            agentId: agent.agentId,
          },
          [agentMark(agent, "agent")],
        ),
        lane(
          {
            id: `tools ${agent.agentId}`,
            title: "Tools",
            titleTone: "secondary",
            caption: `${plural(agent.toolCalls, "call")}${agent.toolErrors > 0 ? ` · ${failed(agent.toolErrors)}` : ""}`,
            indent: Math.max(0, agent.depth - 1),
            agentId: agent.agentId,
          },
          toolMarks(toolsByAgent.get(agent.agentId) ?? [], false),
        ),
      ]),
      group("group-files", "Files"),
      ...fileLanes,
      group("group-network", "Network"),
      lane(
        { id: "model-api", title: "Model API", caption: `${plural(data.modelCalls.length + data.apiErrors.length, "call")} · ${failed(data.apiErrors.length)}` },
        modelMarks(),
      ),
      lane({ id: "external", title: "External", caption: plural(data.external.length, "request") }, externalMarks()),
    ];
  }

  const offsets = [0];
  for (const row of rows) offsets.push(offsets[offsets.length - 1]! + row.height);
  return {
    axis,
    rows,
    offsets,
    startLabel: `${formatClock(session.startedAt)} start`,
  };
}

// ── Selection ───────────────────────────────────────────────────────────────────────────────

export interface SelectionContext {
  /** Selection record (formatSelection); null — nothing is selected. */
  key: string | null;
  /** Agent of the selected item: its lanes in Expanded mode are highlighted. */
  focusAgent: string | null;
  /** Moment of the selected call or prompt: a vertical line through all lanes. */
  cursorTs: number | null;
  /** An agent is selected in Compact mode: marks of the other agents are dimmed. */
  dimAgent: string | null;
}

/** What the selection means for the timeline. A selection that is not in the data highlights nothing. */
export function selectionContext(data: TimelineResponse, sel: Selection | null, view: TimelineView): SelectionContext {
  const none: SelectionContext = { key: null, focusAgent: null, cursorTs: null, dimAgent: null };
  if (!sel) return none;
  const context = { ...none, key: formatSelection(sel) };
  switch (sel.kind) {
    case "agent":
      return { ...context, focusAgent: sel.id, dimAgent: view === "compact" ? sel.id : null };
    case "tool": {
      const tool = data.tools.find((t) => t.id === sel.id);
      return tool ? { ...context, focusAgent: tool.agentId, cursorTs: tool.start } : context;
    }
    case "prompt": {
      const prompt = data.prompts.find((p) => p.id === sel.id);
      return prompt ? { ...context, cursorTs: prompt.ts } : context;
    }
    case "net": {
      const item =
        sel.net === "model"
          ? data.modelCalls.find((c) => c.id === sel.id)
          : sel.net === "error"
            ? data.apiErrors.find((e) => e.id === sel.id)
            : data.external.find((x) => x.id === sel.id);
      if (!item) return context;
      return { ...context, focusAgent: item.agentId, cursorTs: "start" in item ? item.start : item.ts };
    }
    default:
      return context;
  }
}

/** The part of the selection that concerns one lane; the row is redrawn only when this changes. */
export interface LaneSelection {
  /** The lane is highlighted: the selected mark sits in it or it is the lane of the selected item's agent. */
  active: boolean;
  /** Selection record if the selected mark sits in this lane. */
  selKey: string | null;
  /** Selected agent if marks of the others are dimmed in this lane. */
  dimAgent: string | null;
}

export function laneSelection(lane: Lane, context: SelectionContext): LaneSelection {
  const selKey = context.key !== null && lane.keys.has(context.key) ? context.key : null;
  return {
    active: selKey !== null || (lane.agentId !== null && lane.agentId === context.focusAgent),
    selKey,
    dimAgent: lane.dimmable ? context.dimAgent : null,
  };
}

export function markSelected(mark: Mark, selKey: string | null): boolean {
  return selKey !== null && mark.matches.includes(selKey);
}

/** A mark of another agent while an agent is selected. */
export function markDimmed(mark: Mark, dimAgent: string | null): boolean {
  return dimAgent !== null && mark.agentId !== dimAgent;
}

/** How the selection is named in the "Back to …" button of the detail panel. */
export function selectionLabel(data: TimelineResponse, sel: Selection): string {
  switch (sel.kind) {
    case "session":
      return "session";
    case "agent": {
      const agent = data.agents.find((a) => a.agentId === sel.id);
      if (!agent) return "agent";
      return isMain(agent) ? "Main agent" : `${agent.type ?? "Subagent"} (${agent.agentId})`;
    }
    case "tool": {
      const tool = data.tools.find((t) => t.id === sel.id);
      return tool ? `${tool.name} call` : "tool call";
    }
    case "prompt":
      return "prompt";
    case "file":
      return "file";
    case "net":
      return "network call";
  }
}

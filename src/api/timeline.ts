// Timeline tracks and the gap map. The response is built with a fixed number of queries per session:
// a session can have thousands of calls. Each track is returned by time. Package A2.
import type { Database } from "bun:sqlite";
import type { TimelineGap, TimelineResponse } from "../contracts/api.ts";
import { IDLE_GAP_MS } from "../contracts/constants.ts";
import type { ApiErrorRow, ExternalRequestRow, FileOpRow, ModelCallRow, PromptRow, ToolCallRow } from "../contracts/rows.ts";
import { type Handler, notFound } from "./context.ts";
import { agentsInTreeOrder, getSessionRow } from "./sessions.ts";

type PromptMark = Pick<PromptRow, "id" | "ts" | "kind">;
type ToolMark = Pick<ToolCallRow, "id" | "agent_id" | "name" | "target" | "ts_start" | "ts_end" | "duration_ms" | "status">;
type FileMark = Pick<FileOpRow, "tool_call_id" | "agent_id" | "path" | "op" | "ts">;
type ModelCallMark = Pick<ModelCallRow, "id" | "agent_id" | "ts_start" | "ts_end" | "duration_ms" | "duration_exact">;

/**
 * Start of a model call mark. The exact duration from OTel is counted from the end of the response:
 * `ts_start` is an estimate from the agent's previous event, and a mark from it would end before the response.
 */
const modelCallStart = (call: ModelCallMark): number => (call.duration_exact === 1 ? call.ts_end - call.duration_ms : call.ts_start);
type ApiErrorMark = Pick<ApiErrorRow, "id" | "agent_id" | "ts">;
type ExternalMark = Pick<ExternalRequestRow, "id" | "agent_id" | "tool_call_id" | "kind" | "status_code" | "duration_ms" | "ts">;

/** Rows of one session's event table: event ids are unique only within it. */
function ofSession<Row>(db: Database, columns: string, table: string, order: string, sessionId: string): Row[] {
  return db.query<Row, [string]>(`SELECT ${columns} FROM ${table} WHERE session_id = ? ORDER BY ${order}`).all(sessionId);
}

/** Busy time: a call from start to end, or a mark without duration (start = end). */
interface Span {
  start: number;
  end: number;
}

const moment = (ts: number): Span => ({ start: ts, end: ts });

/**
 * Idle periods longer than IDLE_GAP_MS (decision 31): the intervals between busy spans. A running call
 * occupies all of its time, so an idle period inside it does not become a gap.
 *
 * Spans are clamped to the session bounds and to the order "start not after end": the machine clock may
 * jump back between the call row and the result row. So gaps do not overlap,
 * lie inside the session and cover no mark — the timeline axis relies on this.
 */
function idleGaps(spans: Span[], from: number, to: number): TimelineGap[] {
  const clamp = (ts: number) => Math.min(Math.max(ts, from), to);
  const byStart = spans.map((span) => ({ start: clamp(span.start), end: clamp(Math.max(span.start, span.end)) })).sort((a, b) => a.start - b.start);
  const gaps: TimelineGap[] = [];
  let busyUntil = from;
  for (const span of byStart) {
    if (span.start - busyUntil > IDLE_GAP_MS) gaps.push({ start: busyUntil, end: span.start });
    busyUntil = Math.max(busyUntil, span.end);
  }
  return gaps;
}

export const getTimeline: Handler = (c) => {
  const db = c.get("db");
  const id = c.req.param("id") ?? "";
  const session = getSessionRow(db, id);
  if (!session) return notFound(c, `session ${id}`);

  // A session without a single timestamp degenerates to a point.
  const startedAt = session.started_at ?? session.ended_at ?? 0;
  const endedAt = session.ended_at ?? startedAt;

  const prompts = ofSession<PromptMark>(db, "id, ts, kind", "prompts", "ts, seq", id);
  const tools = ofSession<ToolMark>(db, "id, agent_id, name, target, ts_start, ts_end, duration_ms, status", "tool_calls", "ts_start, id", id);
  const files = ofSession<FileMark>(db, "tool_call_id, agent_id, path, op, ts", "file_ops", "ts, id", id);
  const modelCalls = ofSession<ModelCallMark>(db, "id, agent_id, ts_start, ts_end, duration_ms, duration_exact", "model_calls", "ts_start, id", id);
  const apiErrors = ofSession<ApiErrorMark>(db, "id, agent_id, ts", "api_errors", "ts, id", id);
  const external = ofSession<ExternalMark>(db, "id, agent_id, tool_call_id, kind, status_code, duration_ms, ts", "external_requests", "ts, id", id);

  const agents = agentsInTreeOrder(db, id).map((agent) => {
    const start = agent.started_at ?? startedAt;
    return {
      agentId: agent.agent_id,
      parentAgentId: agent.parent_agent_id,
      depth: agent.depth,
      type: agent.type,
      description: agent.description,
      model: agent.model,
      start,
      end: agent.ended_at ?? start,
      toolCalls: agent.tool_calls,
      toolErrors: agent.tool_errors,
    };
  });

  const failedTools = new Set(tools.filter((tool) => tool.status === "error").map((tool) => tool.id));

  // File operations and external requests lie inside their tool calls and are not counted
  // separately. An agent bar is not a call: its edges are counted as marks, otherwise the main agent,
  // which runs the whole session, would leave no gap at all.
  const gaps = idleGaps([
    moment(startedAt),
    moment(endedAt),
    ...prompts.map((prompt) => moment(prompt.ts)),
    ...agents.flatMap((agent) => [moment(agent.start), moment(agent.end)]),
    // A call without a result runs to the end of the session while it is running. In a finished session it is no longer
    // running (interrupted or copied into a continued session) and occupies only its own moment.
    ...tools.map((tool) => ({ start: tool.ts_start, end: tool.ts_end ?? (session.status === "running" ? endedAt : tool.ts_start) })),
    ...modelCalls.map((call) => ({ start: call.ts_start, end: call.ts_end })),
    ...apiErrors.map((error) => moment(error.ts)),
  ], startedAt, endedAt);

  return c.json<TimelineResponse>({
    session: {
      id: session.id,
      name: session.name ?? session.id,
      status: session.status,
      startedAt,
      endedAt,
      activeMs: session.active_ms,
      modelCalls: session.model_calls,
      toolCalls: session.tool_calls,
      toolErrors: session.tool_errors,
      apiErrors: session.api_errors,
    },
    gaps,
    prompts,
    agents,
    tools: tools.map((tool) => ({
      id: tool.id,
      agentId: tool.agent_id,
      name: tool.name,
      target: tool.target,
      start: tool.ts_start,
      durationMs: tool.duration_ms,
      status: tool.status,
    })),
    files: files.map((op) => ({
      toolCallId: op.tool_call_id,
      agentId: op.agent_id,
      path: op.path,
      op: op.op,
      ts: op.ts,
      error: failedTools.has(op.tool_call_id),
    })),
    modelCalls: modelCalls.map((call) => ({ id: call.id, agentId: call.agent_id, start: modelCallStart(call), durationMs: call.duration_ms })),
    apiErrors: apiErrors.map((error) => ({ id: error.id, agentId: error.agent_id, ts: error.ts })),
    external: external.map((request) => ({
      id: request.id,
      agentId: request.agent_id,
      kind: request.kind,
      ts: request.ts,
      durationMs: request.duration_ms,
      error: (request.status_code ?? 0) >= 400 || failedTools.has(request.tool_call_id),
    })),
  });
};

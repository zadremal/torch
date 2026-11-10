// Panels of an agent, tool call, prompt, file and network call. Event ids
// are unique only within a session, so every query is restricted by session_id. Package A2.
import type { Database } from "bun:sqlite";
import type {
  AgentPanel,
  ApiErrorPanel,
  CallRow,
  ContextBreakdownEntry,
  ExternalRequestPanel,
  FilePanel,
  InstructionEntry,
  ModelCallPanel,
  NetworkKind,
  NetworkPanel,
  PromptPanel,
  ToolCallPanel,
  ToolUsageEntry,
} from "../contracts/api.ts";
import type {
  AgentRow,
  ApiErrorRow,
  ExternalRequestRow,
  FileOpRow,
  InstructionLoadedRow,
  MessageRow,
  ModelCallRow,
  PromptRow,
  ToolCallRow,
} from "../contracts/rows.ts";
import { bodyRef } from "./contents.ts";
import { type Handler, notFound } from "./context.ts";
import { badQuery, QueryError, textParam } from "./filters.ts";

// ── Common ──────────────────────────────────────────────────────────────────────────────────

type WithAgentType<Row> = Row & { agent_type: string | null };

/** Row of an event table by id within a session, together with the type of its agent. */
function eventRow<Row>(db: Database, table: string, sessionId: string, id: string): WithAgentType<Row> | null {
  return db
    .query<WithAgentType<Row>, [string, string]>(
      `SELECT e.*, a.type AS agent_type
       FROM ${table} e
       LEFT JOIN agents a ON a.session_id = e.session_id AND a.agent_id = e.agent_id
       WHERE e.session_id = ? AND e.id = ?`,
    )
    .get(sessionId, id);
}

type CallColumns = Pick<ToolCallRow, "id" | "agent_id" | "name" | "target" | "ts_start" | "duration_ms" | "duration_exact" | "status">;

const callRow = (row: CallColumns): CallRow => ({
  id: row.id,
  agentId: row.agent_id,
  name: row.name,
  target: row.target,
  start: row.ts_start,
  durationMs: row.duration_ms,
  durationExact: row.duration_exact === 1,
  status: row.status,
});

/** Tool calls of an agent by time; `modelCallId` keeps those requested by one model response. */
function agentCalls(db: Database, sessionId: string, agentId: string, modelCallId?: string): CallRow[] {
  const ofCall = modelCallId === undefined ? "" : "AND model_call_id = ?";
  return db
    .query<ToolCallRow, string[]>(`SELECT * FROM tool_calls WHERE session_id = ? AND agent_id = ? ${ofCall} ORDER BY ts_start, id`)
    .all(sessionId, agentId, ...(modelCallId === undefined ? [] : [modelCallId]))
    .map(callRow);
}

// ── Agent ───────────────────────────────────────────────────────────────────────────────────

/** Tool usage by descending call count: the same order as in the session overview. */
function toolUsage(calls: CallRow[]): ToolUsageEntry[] {
  const byName = new Map<string, ToolUsageEntry>();
  for (const call of calls) {
    const entry = byName.get(call.name) ?? { name: call.name, count: 0, errors: 0 };
    entry.count++;
    if (call.status === "error") entry.errors++;
    byName.set(call.name, entry);
  }
  return [...byName.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

export const getAgent: Handler = (c) => {
  const db = c.get("db");
  const sessionId = c.req.param("id") ?? "";
  const agentId = c.req.param("agentId") ?? "";
  const agent = db.query<AgentRow, [string, string]>("SELECT * FROM agents WHERE session_id = ? AND agent_id = ?").get(sessionId, agentId);
  if (!agent) return notFound(c, `agent ${agentId} of session ${sessionId}`);

  const calls = agentCalls(db, sessionId, agentId);
  const instructions = db
    .query<InstructionLoadedRow, [string, string]>("SELECT * FROM instructions_loaded WHERE session_id = ? AND agent_id = ? ORDER BY ts, id")
    .all(sessionId, agentId)
    .map(
      (row): InstructionEntry => ({
        path: row.file_path,
        memoryType: row.memory_type,
        loadReason: row.load_reason,
        tokensEst: row.tokens_est,
        source: row.source,
      }),
    );

  return c.json<AgentPanel>({
    sessionId,
    agentId: agent.agent_id,
    parentAgentId: agent.parent_agent_id,
    depth: agent.depth,
    type: agent.type,
    description: agent.description,
    model: agent.model,
    startedAt: agent.started_at,
    endedAt: agent.ended_at,
    runMs: agent.run_ms,
    modelCalls: agent.model_calls,
    apiErrors: agent.api_errors,
    toolCalls: agent.tool_calls,
    toolErrors: agent.tool_errors,
    tokens: {
      input: agent.tok_input,
      output: agent.tok_output,
      cacheRead: agent.tok_cache_read,
      cacheWrite: agent.tok_cache_write,
      thinking: agent.tok_thinking,
      total: agent.tok_total,
    },
    costUsd: agent.cost_usd,
    prompt: bodyRef(db, agent.prompt_content_id),
    ctxWindow: agent.ctx_window,
    ctxFirst: agent.ctx_first,
    ctxLast: agent.ctx_last,
    ctxPeak: agent.ctx_peak,
    ctxPeakCallId: agent.ctx_peak_call_id,
    ctxBreakdown: agent.ctx_breakdown_json ? (JSON.parse(agent.ctx_breakdown_json) as ContextBreakdownEntry[]) : [],
    ctxBreakdownExact: agent.ctx_breakdown_exact === 1,
    instructions,
    toolUsage: toolUsage(calls),
    calls,
  });
};

// ── Tool call ───────────────────────────────────────────────────────────────────────────────

export const getToolCall: Handler = (c) => {
  const db = c.get("db");
  const sessionId = c.req.param("id") ?? "";
  const callId = c.req.param("callId") ?? "";
  const call = eventRow<ToolCallRow>(db, "tool_calls", sessionId, callId);
  if (!call) return notFound(c, `tool call ${callId} of session ${sessionId}`);

  // A file_ops row exists only for Read, Edit and Write; its id matches the call.
  const fileOp = db.query<Pick<FileOpRow, "path">, [string, string]>("SELECT path FROM file_ops WHERE session_id = ? AND id = ?").get(sessionId, callId);

  return c.json<ToolCallPanel>({
    sessionId,
    id: call.id,
    agentId: call.agent_id,
    agentType: call.agent_type,
    name: call.name,
    mcpServer: call.mcp_server,
    target: call.target,
    status: call.status,
    errorTitle: call.error_title,
    start: call.ts_start,
    durationMs: call.duration_ms,
    durationExact: call.duration_exact === 1,
    turnIndex: call.turn_index,
    modelCallId: call.model_call_id,
    permissionDecision: call.permission_decision,
    permissionSource: call.permission_source,
    spawnedAgentId: call.spawned_agent_id,
    input: bodyRef(db, call.input_content_id),
    output: bodyRef(db, call.output_content_id),
    filePath: fileOp?.path ?? null,
    linesAdded: call.lines_added,
    linesRemoved: call.lines_removed,
  });
};

// ── Prompt ──────────────────────────────────────────────────────────────────────────────────

export const getPrompt: Handler = (c) => {
  const db = c.get("db");
  const sessionId = c.req.param("id") ?? "";
  const promptId = c.req.param("promptId") ?? "";
  const prompt = db.query<PromptRow, [string, string]>("SELECT * FROM prompts WHERE session_id = ? AND id = ?").get(sessionId, promptId);
  if (!prompt) return notFound(c, `prompt ${promptId} of session ${sessionId}`);

  return c.json<PromptPanel>({
    sessionId,
    id: prompt.id,
    kind: prompt.kind,
    ts: prompt.ts,
    tokensEst: prompt.tokens_est,
    attachments: prompt.attachments_json ? (JSON.parse(prompt.attachments_json) as string[]) : [],
    // A prompt without a body in the database is returned empty: the contract requires a link.
    body: bodyRef(db, prompt.content_id) ?? { contentId: prompt.content_id, bytes: 0, preview: "", truncated: false },
  });
};

// ── File ────────────────────────────────────────────────────────────────────────────────────

type FileOpCall = WithAgentType<CallColumns & Pick<FileOpRow, "op" | "lines_added" | "lines_removed">>;

export const getFile: Handler = (c) => {
  const db = c.get("db");
  const sessionId = c.req.param("id") ?? "";
  const path = textParam(c.req.query("path"));
  if (path === undefined) return badQuery(c, new QueryError("Parameter path: a file path is expected"));

  const ops = db
    .query<FileOpCall, [string, string]>(
      `SELECT t.id, t.agent_id, t.name, t.target, t.ts_start, t.duration_ms, t.duration_exact, t.status,
              f.op, f.lines_added, f.lines_removed, a.type AS agent_type
       FROM file_ops f
       JOIN tool_calls t ON t.session_id = f.session_id AND t.id = f.tool_call_id
       LEFT JOIN agents a ON a.session_id = f.session_id AND a.agent_id = f.agent_id
       WHERE f.session_id = ? AND f.path = ?
       ORDER BY f.ts, f.id`,
    )
    .all(sessionId, path);
  if (ops.length === 0) return notFound(c, `file ${path} of session ${sessionId}`);

  const count = (op: FileOpRow["op"]) => ops.filter((row) => row.op === op).length;
  return c.json<FilePanel>({
    sessionId,
    path,
    reads: count("read"),
    edits: count("edit"),
    writes: count("write"),
    linesAdded: ops.reduce((sum, row) => sum + (row.lines_added ?? 0), 0),
    linesRemoved: ops.reduce((sum, row) => sum + (row.lines_removed ?? 0), 0),
    agents: [...new Set(ops.map((row) => row.agent_id))],
    ops: ops.map((row) => ({
      ...callRow(row),
      op: row.op,
      agentType: row.agent_type,
      linesAdded: row.lines_added,
      linesRemoved: row.lines_removed,
    })),
  });
};

// ── Network call ────────────────────────────────────────────────────────────────────────────

function modelCallPanel(db: Database, sessionId: string, id: string): ModelCallPanel | null {
  const call = eventRow<ModelCallRow>(db, "model_calls", sessionId, id);
  if (!call) return null;
  const messages = db
    .query<Pick<MessageRow, "kind" | "content_id">, [string, string]>("SELECT kind, content_id FROM messages WHERE session_id = ? AND model_call_id = ? ORDER BY ts, id")
    .all(sessionId, id);
  return {
    net: "model",
    sessionId,
    id: call.id,
    agentId: call.agent_id,
    agentType: call.agent_type,
    model: call.model,
    start: call.ts_start,
    durationMs: call.duration_ms,
    durationExact: call.duration_exact === 1,
    stopReason: call.stop_reason,
    turnIndex: call.turn_index,
    querySource: call.query_source,
    tokInput: call.tok_input,
    tokOutput: call.tok_output,
    tokCacheRead: call.tok_cache_read,
    tokCacheWrite5m: call.tok_cache_write_5m,
    tokCacheWrite1h: call.tok_cache_write_1h,
    tokThinking: call.tok_thinking,
    ctxTokens: call.ctx_tokens,
    costUsd: call.cost_usd,
    messages: messages.flatMap((message) => {
      const body = bodyRef(db, message.content_id);
      return body ? [{ kind: message.kind, body }] : [];
    }),
    toolCalls: agentCalls(db, sessionId, call.agent_id, call.id),
  };
}

function apiErrorPanel(db: Database, sessionId: string, id: string): ApiErrorPanel | null {
  const error = eventRow<ApiErrorRow>(db, "api_errors", sessionId, id);
  if (!error) return null;
  return {
    net: "error",
    sessionId,
    id: error.id,
    agentId: error.agent_id,
    agentType: error.agent_type,
    ts: error.ts,
    requestId: error.request_id,
    statusCode: error.status_code,
    error: error.error,
    attempt: error.attempt,
    maxRetries: error.max_retries,
    retryInMs: error.retry_in_ms,
    source: error.source,
  };
}

function externalRequestPanel(db: Database, sessionId: string, id: string): ExternalRequestPanel | null {
  const request = eventRow<ExternalRequestRow>(db, "external_requests", sessionId, id);
  if (!request) return null;
  return {
    net: "external",
    sessionId,
    id: request.id,
    agentId: request.agent_id,
    agentType: request.agent_type,
    toolCallId: request.tool_call_id,
    kind: request.kind,
    url: request.url,
    statusCode: request.status_code,
    bytes: request.bytes,
    durationMs: request.duration_ms,
    ts: request.ts,
  };
}

/** Kind of network panel by the `kind` value in the address. */
const NETWORK_PANELS: Record<NetworkKind, (db: Database, sessionId: string, id: string) => NetworkPanel | null> = {
  model: modelCallPanel,
  error: apiErrorPanel,
  external: externalRequestPanel,
};

export const getNetwork: Handler = (c) => {
  const sessionId = c.req.param("id") ?? "";
  const kind = c.req.param("kind") ?? "";
  const netId = c.req.param("netId") ?? "";
  const panel = Object.hasOwn(NETWORK_PANELS, kind) ? NETWORK_PANELS[kind as NetworkKind](c.get("db"), sessionId, netId) : null;
  if (!panel) return notFound(c, `network call ${kind}:${netId} of session ${sessionId}`);
  return c.json<NetworkPanel>(panel);
};

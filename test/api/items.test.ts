// Detail panels: agent, tool call, prompt, file, network call (three kinds).
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type {
  AgentPanel,
  ApiError,
  ApiErrorPanel,
  ContextBreakdownEntry,
  ExternalRequestPanel,
  FilePanel,
  ModelCallPanel,
  PromptPanel,
  ToolCallPanel,
} from "../../src/contracts/api.ts";
import { BODY_PREVIEW_CHARS } from "../../src/contracts/constants.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { putContent } from "../../src/ingest/reduce/contents.ts";
import { testApi } from "../support/api.ts";
import { seed } from "../support/seed.ts";

const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);

const get = <T>(db: Database, path: string) => testApi(db).get<T>(`/api/sessions/${path}`);
const body = (db: Database, text: string) => ({ contentId: putContent(db, text), bytes: Buffer.byteLength(text), preview: text, truncated: false });

async function expectNotFound(db: Database, path: string, mention: string): Promise<void> {
  const response = await testApi(db).request(`/api/sessions/${path}`);
  expect(response.status).toBe(404);
  expect(((await response.json()) as ApiError).error).toContain(mention);
}

// ── Agent ───────────────────────────────────────────────────────────────────────────────────

test("the agent panel fills every AgentPanel field with values from the database", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  const breakdown: ContextBreakdownEntry[] = [
    { category: "system_tools", tokens: 18_000 },
    { category: "instructions", tokens: 3_600 },
    { category: "messages", tokens: 20_000 },
    { category: "tool_results", tokens: 48_400 },
  ];
  seed.agent(db, {
    session_id: "s1",
    agent_id: "explore-1",
    parent_agent_id: "main",
    depth: 1,
    type: "Explore",
    description: "Find slow queries",
    model: "claude-haiku-4-5",
    started_at: T0 + 60_000,
    ended_at: T0 + 105_000,
    run_ms: 45_000,
    model_calls: 9,
    tool_calls: 4,
    tool_errors: 1,
    api_errors: 2,
    tok_input: 1_100,
    tok_output: 2_200,
    tok_cache_read: 33_000,
    tok_cache_write: 4_400,
    tok_thinking: 550,
    tok_total: 40_700,
    cost_usd: 0.42,
    ctx_window: 200_000,
    ctx_first: 21_000,
    ctx_last: 88_000,
    ctx_peak: 90_000,
    ctx_peak_call_id: "req-7",
    ctx_breakdown_json: JSON.stringify(breakdown),
    ctx_breakdown_exact: 1,
    prompt_content_id: putContent(db, "Find the slow queries in checkout"),
  });
  // Loaded in reverse insertion order: the panel returns them by time.
  seed.instruction(db, { session_id: "s1", id: "i2", agent_id: "explore-1", ts: T0 + 70_000, file_path: "/app/src/CLAUDE.md", memory_type: "Project", load_reason: "nested_traversal", tokens_est: null, source: "hook" });
  seed.instruction(db, { session_id: "s1", id: "i1", agent_id: "explore-1", ts: T0 + 60_000, file_path: "/app/CLAUDE.md", memory_type: "Project", tokens_est: 2_400 });
  seed.instruction(db, { session_id: "s1", id: "i0", ts: T0, file_path: "/Users/dev/.claude/CLAUDE.md", memory_type: "User" });
  seed.toolCall(db, { session_id: "s1", id: "t3", agent_id: "explore-1", name: "Read", target: "/app/b.ts", ts_start: T0 + 63_000, duration_ms: 120 });
  seed.toolCall(db, { session_id: "s1", id: "t1", agent_id: "explore-1", name: "Grep", target: "SELECT", ts_start: T0 + 61_000, duration_ms: 300, duration_exact: 1 });
  seed.toolCall(db, { session_id: "s1", id: "t2", agent_id: "explore-1", name: "Read", target: "/app/a.ts", ts_start: T0 + 62_000, duration_ms: 80, status: "error" });
  seed.toolCall(db, { session_id: "s1", id: "t4", agent_id: "explore-1", name: "Bash", target: "bun test", ts_start: T0 + 64_000, duration_ms: null, status: "pending" });
  seed.toolCall(db, { session_id: "s1", id: "t-main", name: "Agent", ts_start: T0 + 60_000 });

  expect(await get<AgentPanel>(db, "s1/agents/explore-1")).toEqual({
    sessionId: "s1",
    agentId: "explore-1",
    parentAgentId: "main",
    depth: 1,
    type: "Explore",
    description: "Find slow queries",
    model: "claude-haiku-4-5",
    startedAt: T0 + 60_000,
    endedAt: T0 + 105_000,
    runMs: 45_000,
    modelCalls: 9,
    apiErrors: 2,
    toolCalls: 4,
    toolErrors: 1,
    tokens: { input: 1_100, output: 2_200, cacheRead: 33_000, cacheWrite: 4_400, thinking: 550, total: 40_700 },
    costUsd: 0.42,
    prompt: body(db, "Find the slow queries in checkout"),
    ctxWindow: 200_000,
    ctxFirst: 21_000,
    ctxLast: 88_000,
    ctxPeak: 90_000,
    ctxPeakCallId: "req-7",
    ctxBreakdown: breakdown,
    ctxBreakdownExact: true,
    instructions: [
      { path: "/app/CLAUDE.md", memoryType: "Project", loadReason: null, tokensEst: 2_400, source: "transcript" },
      { path: "/app/src/CLAUDE.md", memoryType: "Project", loadReason: "nested_traversal", tokensEst: null, source: "hook" },
    ],
    toolUsage: [
      { name: "Read", count: 2, errors: 1 },
      { name: "Bash", count: 1, errors: 0 },
      { name: "Grep", count: 1, errors: 0 },
    ],
    calls: [
      { id: "t1", agentId: "explore-1", name: "Grep", target: "SELECT", start: T0 + 61_000, durationMs: 300, durationExact: true, status: "ok" },
      { id: "t2", agentId: "explore-1", name: "Read", target: "/app/a.ts", start: T0 + 62_000, durationMs: 80, durationExact: false, status: "error" },
      { id: "t3", agentId: "explore-1", name: "Read", target: "/app/b.ts", start: T0 + 63_000, durationMs: 120, durationExact: false, status: "ok" },
      { id: "t4", agentId: "explore-1", name: "Bash", target: "bun test", start: T0 + 64_000, durationMs: null, durationExact: false, status: "pending" },
    ],
  } satisfies AgentPanel);
});

test("an agent without calls, tasks and a context breakdown is returned with empty lists", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1", cost_usd: null, ctx_window: null });

  const panel = await get<AgentPanel>(db, "s1/agents/main");
  expect(panel).toMatchObject({ agentId: "main", type: null, costUsd: null, prompt: null, ctxWindow: null, ctxPeak: null, ctxBreakdown: [], ctxBreakdownExact: false, instructions: [], toolUsage: [], calls: [] });
});

test("the start of the body is returned at once, a long body is marked truncated", async () => {
  const db = openMemoryDb();
  const long = "é".repeat(BODY_PREVIEW_CHARS + 1);
  const exact = "z".repeat(BODY_PREVIEW_CHARS);
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1", prompt_content_id: putContent(db, long) });
  seed.agent(db, { session_id: "s1", agent_id: "sub", prompt_content_id: putContent(db, exact) });

  const { prompt } = await get<AgentPanel>(db, "s1/agents/main");
  // bytes is the size of the whole body in bytes, not the length of the start in characters.
  expect(prompt).toEqual({ contentId: putContent(db, long), bytes: 2 * (BODY_PREVIEW_CHARS + 1), preview: "é".repeat(BODY_PREVIEW_CHARS), truncated: true });
  expect((await get<AgentPanel>(db, "s1/agents/sub")).prompt).toEqual({ contentId: putContent(db, exact), bytes: BODY_PREVIEW_CHARS, preview: exact, truncated: false });
});

// ── Tool call ───────────────────────────────────────────────────────────────────────────────

test("the tool call panel fills every ToolCallPanel field with values from the database", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1", agent_id: "gp-1", parent_agent_id: "main", depth: 1, type: "general-purpose" });
  seed.toolCall(db, {
    session_id: "s1",
    id: "toolu_01",
    agent_id: "gp-1",
    model_call_id: "req-4",
    turn_index: 4,
    name: "Edit",
    target: "/app/src/cart.ts",
    ts_start: T0 + 5_000,
    duration_ms: 240,
    duration_exact: 1,
    status: "error",
    error_title: "String to replace not found in file.",
    permission_decision: "accept",
    permission_source: "config",
    input: '{"file_path":"/app/src/cart.ts","old_string":"a","new_string":"b"}',
    output: "String to replace not found in file.\nDid you mean…",
    lines_added: 3,
    lines_removed: 1,
  });
  seed.fileOp(db, { session_id: "s1", tool_call_id: "toolu_01", agent_id: "gp-1", path: "/app/src/cart.ts", op: "edit" });

  expect(await get<ToolCallPanel>(db, "s1/tool-calls/toolu_01")).toEqual({
    sessionId: "s1",
    id: "toolu_01",
    agentId: "gp-1",
    agentType: "general-purpose",
    name: "Edit",
    mcpServer: null,
    target: "/app/src/cart.ts",
    status: "error",
    errorTitle: "String to replace not found in file.",
    start: T0 + 5_000,
    durationMs: 240,
    durationExact: true,
    turnIndex: 4,
    modelCallId: "req-4",
    permissionDecision: "accept",
    permissionSource: "config",
    spawnedAgentId: null,
    input: body(db, '{"file_path":"/app/src/cart.ts","old_string":"a","new_string":"b"}'),
    output: body(db, "String to replace not found in file.\nDid you mean…"),
    filePath: "/app/src/cart.ts",
    linesAdded: 3,
    linesRemoved: 1,
  } satisfies ToolCallPanel);
});

test("a call without a result, an MCP call and a subagent launch", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1" });
  seed.toolCall(db, { session_id: "s1", id: "pending", name: "Bash", target: "sleep 600", duration_ms: null, status: "pending", input: '{"command":"sleep 600"}' });
  seed.toolCall(db, { session_id: "s1", id: "mcp", name: "mcp__linear__list_issues", mcp_server: "linear", status: "denied", permission_decision: "reject", permission_source: "user_reject" });
  seed.toolCall(db, { session_id: "s1", id: "spawn", name: "Agent", target: "Find slow queries", spawned_agent_id: "explore-1" });

  expect(await get<ToolCallPanel>(db, "s1/tool-calls/pending")).toMatchObject({
    agentType: null,
    status: "pending",
    durationMs: null,
    durationExact: false,
    turnIndex: null,
    modelCallId: null,
    permissionDecision: null,
    permissionSource: null,
    input: body(db, '{"command":"sleep 600"}'),
    output: null,
    filePath: null,
    linesAdded: null,
    linesRemoved: null,
  });
  expect(await get<ToolCallPanel>(db, "s1/tool-calls/mcp")).toMatchObject({ mcpServer: "linear", status: "denied", permissionDecision: "reject", permissionSource: "user_reject", input: null });
  expect(await get<ToolCallPanel>(db, "s1/tool-calls/spawn")).toMatchObject({ name: "Agent", spawnedAgentId: "explore-1" });
});

// ── Prompt ──────────────────────────────────────────────────────────────────────────────────

test("the prompt panel fills every PromptPanel field with values from the database", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.prompt(db, { session_id: "s1", id: "p1", ts: T0, seq: 0, kind: "original", text: "Make checkout faster", tokens_est: 5, attachments_json: JSON.stringify(["Image #1", "Image #2"]) });
  seed.prompt(db, { session_id: "s1", id: "p2", ts: T0 + 300_000, seq: 1, kind: "follow_up", text: "Keep the public API", tokens_est: 4 });

  expect(await get<PromptPanel>(db, "s1/prompts/p1")).toEqual({
    sessionId: "s1",
    id: "p1",
    kind: "original",
    ts: T0,
    tokensEst: 5,
    attachments: ["Image #1", "Image #2"],
    body: body(db, "Make checkout faster"),
  } satisfies PromptPanel);
  expect(await get<PromptPanel>(db, "s1/prompts/p2")).toEqual({
    sessionId: "s1",
    id: "p2",
    kind: "follow_up",
    ts: T0 + 300_000,
    tokensEst: 4,
    attachments: [],
    body: body(db, "Keep the public API"),
  });
});

// ── File ────────────────────────────────────────────────────────────────────────────────────

test("the file panel fills every FilePanel field: counters, lines, agents, operations by time", async () => {
  const db = openMemoryDb();
  const path = "/app/src/cart & checkout/price list.ts";
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1" });
  seed.agent(db, { session_id: "s1", agent_id: "gp-1", parent_agent_id: "main", depth: 1, type: "general-purpose" });
  const op = (id: string, agent_id: string, name: string, kind: "read" | "edit" | "write", offset: number, lines: [number | null, number | null], extra: { status?: "ok" | "error"; duration_exact?: 0 | 1 } = {}) => {
    seed.toolCall(db, { session_id: "s1", id, agent_id, name, target: path, ts_start: T0 + offset, duration_ms: 50, ...extra });
    seed.fileOp(db, { session_id: "s1", tool_call_id: id, agent_id, path, op: kind, ts: T0 + offset, lines_added: lines[0], lines_removed: lines[1] });
  };
  // Inserted not in time order.
  op("t4", "main", "Edit", "edit", 4_000, [2, 5]);
  op("t1", "gp-1", "Read", "read", 1_000, [null, null]);
  op("t3", "gp-1", "Write", "write", 3_000, [40, 0], { duration_exact: 1 });
  op("t2", "main", "Read", "read", 2_000, [null, null], { status: "error" });
  op("t5", "gp-1", "Edit", "edit", 5_000, [1, 1]);
  // Another file does not get into the panel.
  seed.toolCall(db, { session_id: "s1", id: "t6", name: "Read", target: "/app/other.ts", ts_start: T0 + 6_000 });
  seed.fileOp(db, { session_id: "s1", tool_call_id: "t6", path: "/app/other.ts", ts: T0 + 6_000 });

  const call = { target: path, durationMs: 50, durationExact: false, status: "ok" } as const;
  expect(await get<FilePanel>(db, `s1/files?path=${encodeURIComponent(path)}`)).toEqual({
    sessionId: "s1",
    path,
    reads: 2,
    edits: 2,
    writes: 1,
    linesAdded: 43,
    linesRemoved: 6,
    agents: ["gp-1", "main"],
    ops: [
      { ...call, id: "t1", agentId: "gp-1", name: "Read", start: T0 + 1_000, op: "read", agentType: "general-purpose", linesAdded: null, linesRemoved: null },
      { ...call, id: "t2", agentId: "main", name: "Read", start: T0 + 2_000, status: "error", op: "read", agentType: null, linesAdded: null, linesRemoved: null },
      { ...call, id: "t3", agentId: "gp-1", name: "Write", start: T0 + 3_000, durationExact: true, op: "write", agentType: "general-purpose", linesAdded: 40, linesRemoved: 0 },
      { ...call, id: "t4", agentId: "main", name: "Edit", start: T0 + 4_000, op: "edit", agentType: null, linesAdded: 2, linesRemoved: 5 },
      { ...call, id: "t5", agentId: "gp-1", name: "Edit", start: T0 + 5_000, op: "edit", agentType: "general-purpose", linesAdded: 1, linesRemoved: 1 },
    ],
  });
});

test("file panel: without the path parameter — 400, a file not in the session — 404", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  for (const query of ["", "?path="]) {
    const response = await testApi(db).request(`/api/sessions/s1/files${query}`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error).toContain("path");
  }
  await expectNotFound(db, "s1/files?path=%2Fapp%2Fmissing.ts", "/app/missing.ts");
});

// ── Network call ────────────────────────────────────────────────────────────────────────────

test("the model call panel fills every ModelCallPanel field: tokens, response texts, requested calls", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1", agent_id: "plan-1", parent_agent_id: "main", depth: 1, type: "Plan" });
  seed.modelCall(db, {
    session_id: "s1",
    id: "req_011",
    agent_id: "plan-1",
    turn_index: 3,
    model: "claude-sonnet-4-5",
    ts_start: T0 + 10_000,
    duration_ms: 8_400,
    duration_exact: 1,
    stop_reason: "tool_use",
    tok_input: 12,
    tok_output: 640,
    tok_cache_read: 41_000,
    tok_cache_write_5m: 900,
    tok_cache_write_1h: 300,
    tok_thinking: 210,
    ctx_tokens: 42_212,
    cost_usd: 0.0312,
    query_source: "agent:custom",
  });
  // Blocks of one response: thinking before text; inserted in reverse order.
  seed.message(db, { session_id: "s1", id: "u2:0", agent_id: "plan-1", model_call_id: "req_011", ts: T0 + 16_000, kind: "text", text: "I'll read both files." });
  seed.message(db, { session_id: "s1", id: "u1:0", agent_id: "plan-1", model_call_id: "req_011", ts: T0 + 14_000, kind: "thinking", text: "Two files matter here." });
  seed.message(db, { session_id: "s1", id: "u9:0", agent_id: "plan-1", model_call_id: "req_012", ts: T0 + 30_000, text: "Another response" });
  seed.toolCall(db, { session_id: "s1", id: "t2", agent_id: "plan-1", model_call_id: "req_011", name: "Read", target: "/app/b.ts", ts_start: T0 + 18_400, duration_ms: 90 });
  seed.toolCall(db, { session_id: "s1", id: "t1", agent_id: "plan-1", model_call_id: "req_011", name: "Read", target: "/app/a.ts", ts_start: T0 + 18_400, duration_ms: 70, status: "error" });
  seed.toolCall(db, { session_id: "s1", id: "t3", agent_id: "plan-1", model_call_id: "req_012", name: "Grep", ts_start: T0 + 31_000 });

  expect(await get<ModelCallPanel>(db, "s1/network/model/req_011")).toEqual({
    net: "model",
    sessionId: "s1",
    id: "req_011",
    agentId: "plan-1",
    agentType: "Plan",
    model: "claude-sonnet-4-5",
    start: T0 + 10_000,
    durationMs: 8_400,
    durationExact: true,
    stopReason: "tool_use",
    turnIndex: 3,
    querySource: "agent:custom",
    tokInput: 12,
    tokOutput: 640,
    tokCacheRead: 41_000,
    tokCacheWrite5m: 900,
    tokCacheWrite1h: 300,
    tokThinking: 210,
    ctxTokens: 42_212,
    costUsd: 0.0312,
    messages: [
      { kind: "thinking", body: body(db, "Two files matter here.") },
      { kind: "text", body: body(db, "I'll read both files.") },
    ],
    toolCalls: [
      { id: "t1", agentId: "plan-1", name: "Read", target: "/app/a.ts", start: T0 + 18_400, durationMs: 70, durationExact: false, status: "error" },
      { id: "t2", agentId: "plan-1", name: "Read", target: "/app/b.ts", start: T0 + 18_400, durationMs: 90, durationExact: false, status: "ok" },
    ],
  } satisfies ModelCallPanel);
});

test("a call of an unknown model without text and tools", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.modelCall(db, { session_id: "s1", id: "req-1", model: "claude-next", cost_usd: null, stop_reason: null });

  expect(await get<ModelCallPanel>(db, "s1/network/model/req-1")).toMatchObject({ agentType: null, model: "claude-next", costUsd: null, stopReason: null, durationExact: false, querySource: null, messages: [], toolCalls: [] });
});

test("the API error panel fills every ApiErrorPanel field with values from the database", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1", agent_id: "gp-1", parent_agent_id: "main", depth: 1, type: "general-purpose" });
  seed.apiError(db, { session_id: "s1", id: "err-1", agent_id: "gp-1", ts: T0 + 9_000, request_id: "req_020", status_code: 529, error: "Overloaded", attempt: 2, max_retries: 10, retry_in_ms: 1_250, source: "otel" });
  seed.apiError(db, { session_id: "s1", id: "err-2", ts: T0 + 9_500, request_id: null, status_code: null, error: "Connection error.", attempt: null, max_retries: null, retry_in_ms: null });

  expect(await get<ApiErrorPanel>(db, "s1/network/error/err-1")).toEqual({
    net: "error",
    sessionId: "s1",
    id: "err-1",
    agentId: "gp-1",
    agentType: "general-purpose",
    ts: T0 + 9_000,
    requestId: "req_020",
    statusCode: 529,
    error: "Overloaded",
    attempt: 2,
    maxRetries: 10,
    retryInMs: 1_250,
    source: "otel",
  } satisfies ApiErrorPanel);
  expect(await get<ApiErrorPanel>(db, "s1/network/error/err-2")).toMatchObject({ agentId: "main", requestId: null, statusCode: null, error: "Connection error.", attempt: null, maxRetries: null, retryInMs: null, source: "transcript" });
});

test("the external request panel fills every ExternalRequestPanel field with values from the database", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1", agent_id: "plan-1", parent_agent_id: "main", depth: 1, type: "Plan" });
  seed.externalRequest(db, { session_id: "s1", tool_call_id: "toolu_07", agent_id: "plan-1", kind: "web_fetch", url: "https://bun.sh/docs/cli/test", status_code: 200, bytes: 88_268, duration_ms: 4_486, ts: T0 + 7_000 });
  seed.externalRequest(db, { session_id: "s1", tool_call_id: "toolu_08", kind: "web_search", url: "bun test timeout", status_code: null, bytes: null, duration_ms: null, ts: T0 + 8_000 });

  expect(await get<ExternalRequestPanel>(db, "s1/network/external/toolu_07")).toEqual({
    net: "external",
    sessionId: "s1",
    id: "toolu_07",
    agentId: "plan-1",
    agentType: "Plan",
    toolCallId: "toolu_07",
    kind: "web_fetch",
    url: "https://bun.sh/docs/cli/test",
    statusCode: 200,
    bytes: 88_268,
    durationMs: 4_486,
    ts: T0 + 7_000,
  } satisfies ExternalRequestPanel);
  expect(await get<ExternalRequestPanel>(db, "s1/network/external/toolu_08")).toMatchObject({ agentType: null, kind: "web_search", url: "bun test timeout", statusCode: null, bytes: null, durationMs: null });
});

// ── Session bounds, 404, a session without a transcript ─────────────────────────────────────

/** A session in which the event of each kind has the same id `x`. */
function seedSameIds(db: Database, sessionId: string, mark: string, offset: number): void {
  seed.session(db, { id: sessionId });
  seed.agent(db, { session_id: sessionId, agent_id: "x", description: mark, prompt_content_id: putContent(db, `task ${mark}`) });
  seed.prompt(db, { session_id: sessionId, id: "x", ts: T0 + offset, text: `prompt ${mark}` });
  seed.modelCall(db, { session_id: sessionId, id: "x", agent_id: "x", ts_start: T0 + offset });
  seed.message(db, { session_id: sessionId, id: "x:0", agent_id: "x", model_call_id: "x", ts: T0 + offset, text: `answer ${mark}` });
  seed.toolCall(db, { session_id: sessionId, id: "x", agent_id: "x", model_call_id: "x", target: "/app/x.ts", ts_start: T0 + offset, input: `input ${mark}`, output: `output ${mark}` });
  seed.fileOp(db, { session_id: sessionId, tool_call_id: "x", agent_id: "x", path: "/app/x.ts", ts: T0 + offset });
  seed.externalRequest(db, { session_id: sessionId, tool_call_id: "x", agent_id: "x", url: `https://example.com/${mark}`, ts: T0 + offset });
  seed.apiError(db, { session_id: sessionId, id: "x", agent_id: "x", ts: T0 + offset, error: `error ${mark}` });
  seed.instruction(db, { session_id: sessionId, id: "x", agent_id: "x", ts: T0 + offset, file_path: `/app/${mark}/CLAUDE.md` });
}

test("ids are unique only within a session: the panel returns the event of its own session", async () => {
  const db = openMemoryDb();
  seedSameIds(db, "s1", "one", 0);
  seedSameIds(db, "s2", "two", 60_000);

  for (const [sessionId, mark, start] of [["s1", "one", T0], ["s2", "two", T0 + 60_000]] as const) {
    const agent = await get<AgentPanel>(db, `${sessionId}/agents/x`);
    expect([agent.sessionId, agent.description, agent.prompt?.preview]).toEqual([sessionId, mark, `task ${mark}`]);
    expect(agent.calls.map((call) => call.start)).toEqual([start]);
    expect(agent.instructions.map((entry) => entry.path)).toEqual([`/app/${mark}/CLAUDE.md`]);
    expect(agent.toolUsage).toEqual([{ name: "Read", count: 1, errors: 0 }]);

    const tool = await get<ToolCallPanel>(db, `${sessionId}/tool-calls/x`);
    expect([tool.sessionId, tool.start, tool.input?.preview, tool.output?.preview, tool.filePath]).toEqual([sessionId, start, `input ${mark}`, `output ${mark}`, "/app/x.ts"]);

    const prompt = await get<PromptPanel>(db, `${sessionId}/prompts/x`);
    expect([prompt.sessionId, prompt.ts, prompt.body.preview]).toEqual([sessionId, start, `prompt ${mark}`]);

    const file = await get<FilePanel>(db, `${sessionId}/files?path=%2Fapp%2Fx.ts`);
    expect([file.sessionId, file.reads, file.ops.map((op) => op.start)]).toEqual([sessionId, 1, [start]]);

    const call = await get<ModelCallPanel>(db, `${sessionId}/network/model/x`);
    expect([call.sessionId, call.start, call.messages.map((message) => message.body.preview), call.toolCalls.map((row) => row.start)]).toEqual([sessionId, start, [`answer ${mark}`], [start]]);

    const error = await get<ApiErrorPanel>(db, `${sessionId}/network/error/x`);
    expect([error.sessionId, error.error]).toEqual([sessionId, `error ${mark}`]);

    const request = await get<ExternalRequestPanel>(db, `${sessionId}/network/external/x`);
    expect([request.sessionId, request.url]).toEqual([sessionId, `https://example.com/${mark}`]);
  }
});

test("the item is not in this session — 404, even if it is in another", async () => {
  const db = openMemoryDb();
  seedSameIds(db, "s1", "one", 0);
  seed.session(db, { id: "s2" });

  for (const sessionId of ["s2", "missing"]) {
    await expectNotFound(db, `${sessionId}/agents/x`, "x");
    await expectNotFound(db, `${sessionId}/tool-calls/x`, "x");
    await expectNotFound(db, `${sessionId}/prompts/x`, "x");
    await expectNotFound(db, `${sessionId}/files?path=%2Fapp%2Fx.ts`, "/app/x.ts");
    await expectNotFound(db, `${sessionId}/network/model/x`, "model:x");
    await expectNotFound(db, `${sessionId}/network/error/x`, "error:x");
    await expectNotFound(db, `${sessionId}/network/external/x`, "external:x");
  }
  await expectNotFound(db, "s1/agents/unknown", "unknown");
  await expectNotFound(db, "s1/tool-calls/unknown", "unknown");
  await expectNotFound(db, "s1/prompts/unknown", "unknown");
});

test("the network panel kind is set by kind: an unknown kind and a foreign id — 404", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.modelCall(db, { session_id: "s1", id: "req-1" });
  seed.apiError(db, { session_id: "s1", id: "err-1" });

  expect((await get<ModelCallPanel>(db, "s1/network/model/req-1")).net).toBe("model");
  expect((await get<ApiErrorPanel>(db, "s1/network/error/err-1")).net).toBe("error");
  await expectNotFound(db, "s1/network/error/req-1", "error:req-1");
  await expectNotFound(db, "s1/network/model/err-1", "model:err-1");
  await expectNotFound(db, "s1/network/gateway/req-1", "gateway:req-1");
  await expectNotFound(db, "s1/network/toString/req-1", "toString:req-1");
});

test("a session without a transcript returns texts from the database", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", transcript_present: 0 });
  seed.sourceFile(db, { path: "/gone/s1.jsonl", session_id: "s1", missing_since: T0 + 86_400_000 });
  seed.agent(db, { session_id: "s1", prompt_content_id: putContent(db, "Agent task text") });
  seed.prompt(db, { session_id: "s1", id: "p1", text: "Prompt text kept in the database" });
  seed.modelCall(db, { session_id: "s1", id: "req-1" });
  seed.message(db, { session_id: "s1", id: "u1:0", model_call_id: "req-1", kind: "thinking", text: "Thinking kept in the database" });
  seed.toolCall(db, { session_id: "s1", id: "t1", model_call_id: "req-1", input: "Tool input kept", output: "Tool output kept ".repeat(1_000) });

  expect((await get<AgentPanel>(db, "s1/agents/main")).prompt?.preview).toBe("Agent task text");
  expect((await get<PromptPanel>(db, "s1/prompts/p1")).body.preview).toBe("Prompt text kept in the database");
  expect((await get<ModelCallPanel>(db, "s1/network/model/req-1")).messages).toEqual([{ kind: "thinking", body: body(db, "Thinking kept in the database") }]);

  const tool = await get<ToolCallPanel>(db, "s1/tool-calls/t1");
  expect(tool.input?.preview).toBe("Tool input kept");
  // A long output is stored compressed in the database: the start is in the panel, the whole by body id.
  expect(tool.output).toMatchObject({ bytes: 17_000, truncated: true, preview: "Tool output kept ".repeat(1_000).slice(0, BODY_PREVIEW_CHARS) });
  const full = await testApi(db).get<{ text: string }>(`/api/contents/${tool.output!.contentId}`);
  expect(full.text).toBe("Tool output kept ".repeat(1_000));
});

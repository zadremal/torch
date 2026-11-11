// mergeEnrichment: OTel events refine model calls, tool calls and API errors (plan §6.3).
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { OTEL_EVENT_NAMES } from "../../src/contracts/enrich.ts";
import type { ApiErrorRow, ModelCallRow, ToolCallRow } from "../../src/contracts/rows.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { mergeEnrichment } from "../../src/enrich/merge.ts";
import { SEED_TIME, seed } from "../support/seed.ts";
import { ANTHROPIC_PROVIDER } from "../support/provider.ts";

function sessionDb(): Database {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1" });
  return db;
}

const all = <Row>(db: Database, sql: string): Row[] => db.query<Row, []>(sql).all();
const applied = (db: Database): number[] => all<{ applied: number }>(db, "SELECT applied FROM otel_events ORDER BY id").map((row) => row.applied);
const modelCall = (db: Database, id: string, sessionId = "s1") => db.query<ModelCallRow, [string, string]>("SELECT * FROM model_calls WHERE session_id = ? AND id = ?").get(sessionId, id)!;
const toolCall = (db: Database, id: string, sessionId = "s1") => db.query<ToolCallRow, [string, string]>("SELECT * FROM tool_calls WHERE session_id = ? AND id = ?").get(sessionId, id)!;
const apiErrors = (db: Database) => all<ApiErrorRow>(db, "SELECT * FROM api_errors ORDER BY session_id, ts, id");

type ErrorAttrs = { request_id?: string; status_code?: number; error?: string; attempt?: number };

/** An `api_error` event of session s1 with a time offset from SEED_TIME. */
const errorEvent = (db: Database, offset: number, attrs: ErrorAttrs, sessionId = "s1") =>
  seed.otelEvent(db, { session_id: sessionId, ts: SEED_TIME + offset, name: OTEL_EVENT_NAMES.apiError, attrs: { error: "Overloaded", ...attrs } });

/** A retry row from the transcript (`system/api_error`): without `request_id` and status, with an attempt number. */
const retryLine = (db: Database, id: string, offset: number, attempt: number | null) =>
  seed.apiError(db, { session_id: "s1", id, ts: SEED_TIME + offset, request_id: null, status_code: null, attempt });

/** A final refusal from the transcript (`assistant` with `isApiErrorMessage`): with `request_id`, without an attempt number. */
const refusalLine = (db: Database, id: string, offset: number, requestId: string | null) =>
  seed.apiError(db, { session_id: "s1", id, ts: SEED_TIME + offset, request_id: requestId, status_code: 529, attempt: null, max_retries: null, retry_in_ms: null });

// ── api_request → model_calls ───────────────────────────────────────────────────────────────

test("api_request sets the exact duration and the request source on the call with the same request_id", () => {
  const db = sessionDb();
  const before = seed.modelCall(db, { session_id: "s1", id: "req_1", duration_ms: 4000, tok_output: 120 });
  const untouched = seed.modelCall(db, { session_id: "s1", id: "req_2", duration_ms: 900 });
  seed.otelEvent(db, {
    session_id: "s1",
    name: OTEL_EVENT_NAMES.apiRequest,
    attrs: { request_id: "req_1", model: "claude-opus-5-5", duration_ms: 2350, ttft_ms: 410, cost_usd: 0.01, query_source: "repl_main_thread" },
  });

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);

  expect(modelCall(db, "req_1")).toEqual({ ...before, duration_ms: 2350, duration_exact: 1, query_source: "repl_main_thread" });
  expect(modelCall(db, "req_2")).toEqual(untouched);
  expect(applied(db)).toEqual([1]);
});

test("api_request without a duration gives only the request source: the duration estimate stays an estimate", () => {
  const db = sessionDb();
  const before = seed.modelCall(db, { session_id: "s1", id: "req_1", duration_ms: 4000 });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "req_1", query_source: "compact" } });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(modelCall(db, "req_1")).toEqual({ ...before, query_source: "compact" });
  expect(applied(db)).toEqual([1]);
});

test("a repeated event about the same request replaces the duration and the request source", () => {
  const db = sessionDb();
  seed.modelCall(db, { session_id: "s1", id: "req_1", duration_ms: 2350, duration_exact: 1, query_source: "sdk" });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "req_1", duration_ms: 2400, query_source: "repl_main_thread" } });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(modelCall(db, "req_1")).toMatchObject({ duration_ms: 2400, duration_exact: 1, query_source: "repl_main_thread" });
});

test("api_request without a duration does not reset an exact duration recorded earlier", () => {
  const db = sessionDb();
  const before = seed.modelCall(db, { session_id: "s1", id: "req_1", duration_ms: 2350, duration_exact: 1, query_source: "repl_main_thread" });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "req_1" } });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(modelCall(db, "req_1")).toEqual(before);
});

test("api_request without a call in the transcript changes nothing and waits", () => {
  const db = sessionDb();
  const call = seed.modelCall(db, { session_id: "s1", id: "req_1" });
  // A request that is not in the transcript: for example, a service call for the session title.
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "req_title", duration_ms: 300 } });

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);

  expect(modelCall(db, "req_1")).toEqual(call);
  expect(applied(db)).toEqual([0]);
});

// ── tool_result, tool_decision → tool_calls ─────────────────────────────────────────────────

test("tool_result sets the exact duration on the call with the same tool_use_id", () => {
  const db = sessionDb();
  const before = seed.toolCall(db, { session_id: "s1", id: "toolu_1", name: "Bash", duration_ms: 5000 });
  seed.otelEvent(db, {
    session_id: "s1",
    name: OTEL_EVENT_NAMES.toolResult,
    attrs: { tool_use_id: "toolu_1", tool_name: "Bash", success: "true", duration_ms: 4321, tool_result_size_bytes: 80, request_id: "req_1" },
  });

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);

  expect(toolCall(db, "toolu_1")).toEqual({ ...before, duration_ms: 4321, duration_exact: 1 });
  expect(applied(db)).toEqual([1]);
});

test("a duration that arrived as a string is stored as a number", () => {
  const db = sessionDb();
  seed.toolCall(db, { session_id: "s1", id: "toolu_1" });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.toolResult, attrs: { tool_use_id: "toolu_1", duration_ms: "4321" } });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(toolCall(db, "toolu_1")).toMatchObject({ duration_ms: 4321, duration_exact: 1 });
});

test("the duration from tool_result takes precedence over the one measured in the transcript", () => {
  const db = sessionDb();
  seed.toolCall(db, { session_id: "s1", id: "toolu_1", duration_ms: 700, duration_exact: 1 });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.toolResult, attrs: { tool_use_id: "toolu_1", duration_ms: 688 } });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(toolCall(db, "toolu_1")).toMatchObject({ duration_ms: 688, duration_exact: 1 });
});

test("tool_decision stores the decision and its source and does not touch the duration", () => {
  const db = sessionDb();
  const before = seed.toolCall(db, { session_id: "s1", id: "toolu_1", duration_ms: 5000 });
  seed.otelEvent(db, {
    session_id: "s1",
    name: OTEL_EVENT_NAMES.toolDecision,
    attrs: { tool_use_id: "toolu_1", tool_name: "Read", decision: "accept", source: "config", permission_mode: "default" },
  });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(toolCall(db, "toolu_1")).toEqual({ ...before, permission_decision: "accept", permission_source: "config" });
});

test("tool_decision does not reset the exact duration of the call", () => {
  const db = sessionDb();
  const before = seed.toolCall(db, { session_id: "s1", id: "toolu_1", duration_ms: 700, duration_exact: 1 });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.toolDecision, attrs: { tool_use_id: "toolu_1", decision: "accept", source: "config" } });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(toolCall(db, "toolu_1")).toEqual({ ...before, permission_decision: "accept", permission_source: "config" });
});

test("the decision from the event replaces the one recorded by the transcript", () => {
  const db = sessionDb();
  seed.toolCall(db, { session_id: "s1", id: "toolu_1", permission_decision: "accept", permission_source: "user" });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.toolDecision, attrs: { tool_use_id: "toolu_1", decision: "reject", source: "user_reject" } });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(toolCall(db, "toolu_1")).toMatchObject({ permission_decision: "reject", permission_source: "user_reject" });
});

test("tool_result with decision_type and decision_source gives both the duration and the decision", () => {
  const db = sessionDb();
  seed.toolCall(db, { session_id: "s1", id: "toolu_1" });
  seed.otelEvent(db, {
    session_id: "s1",
    name: OTEL_EVENT_NAMES.toolResult,
    attrs: { tool_use_id: "toolu_1", duration_ms: 15, decision_type: "accept", decision_source: "user_temporary" },
  });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(toolCall(db, "toolu_1")).toMatchObject({ duration_ms: 15, duration_exact: 1, permission_decision: "accept", permission_source: "user_temporary" });
});

test("tool_decision and tool_result of the same call add up; a tool_result without a decision does not erase it", () => {
  const db = sessionDb();
  seed.toolCall(db, { session_id: "s1", id: "toolu_1" });
  seed.otelEvent(db, { session_id: "s1", ts: SEED_TIME, name: OTEL_EVENT_NAMES.toolDecision, attrs: { tool_use_id: "toolu_1", decision: "accept", source: "hook" } });
  seed.otelEvent(db, { session_id: "s1", ts: SEED_TIME + 40, name: OTEL_EVENT_NAMES.toolResult, attrs: { tool_use_id: "toolu_1", duration_ms: 38 } });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(toolCall(db, "toolu_1")).toMatchObject({ duration_ms: 38, duration_exact: 1, permission_decision: "accept", permission_source: "hook" });
  expect(applied(db)).toEqual([1, 1]);
});

test("tool events without a call in the transcript wait", () => {
  const db = sessionDb();
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.toolDecision, attrs: { tool_use_id: "toolu_1", decision: "accept", source: "config" } });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.toolResult, attrs: { tool_use_id: "toolu_1", duration_ms: 38 } });

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);

  expect(applied(db)).toEqual([0, 0]);
});

// ── api_error → api_errors ──────────────────────────────────────────────────────────────────

test("api_error without a transcript row gives a record with source otel", () => {
  const db = sessionDb();
  const event = errorEvent(db, 500, { request_id: "req_9", status_code: 529, attempt: 2 });

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);

  expect(apiErrors(db)).toEqual([
    {
      session_id: "s1",
      id: `otel:${event.id}`,
      agent_id: "main",
      ts: SEED_TIME + 500,
      request_id: "req_9",
      status_code: 529,
      error: "Overloaded",
      attempt: 2,
      max_retries: null,
      retry_in_ms: null,
      source: "otel",
    },
  ]);
  expect(applied(db)).toEqual([1]);
});

test("api_error without a server response arrives without request_id and status_code", () => {
  const db = sessionDb();
  errorEvent(db, 0, { error: "Connection error.", attempt: 1 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db)).toMatchObject([{ request_id: null, status_code: null, error: "Connection error.", attempt: 1, source: "otel" }]);
});

test("an error from two sources with the same request_id and attempt number is one record", () => {
  const db = sessionDb();
  const fromTranscript = seed.apiError(db, { session_id: "s1", id: "uuid-1", agent_id: "a1", ts: SEED_TIME, request_id: "req_9", status_code: null, attempt: 2 });
  // The event time differs from the row by more than a second: the pair is found by identifier.
  errorEvent(db, 30_000, { request_id: "req_9", status_code: 529, attempt: 2 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db)).toEqual([{ ...fromTranscript, status_code: 529 }]);
  expect(applied(db)).toEqual([1]);
});

test("a final refusal from the transcript gets the attempt number from the event with the same request_id", () => {
  const db = sessionDb();
  const refusal = refusalLine(db, "uuid-1", 0, "req_9");
  errorEvent(db, 0, { request_id: "req_9", status_code: 529, attempt: 11 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db)).toEqual([{ ...refusal, attempt: 11 }]);
});

test("the same request_id with different attempt numbers gives two records", () => {
  const db = sessionDb();
  seed.apiError(db, { session_id: "s1", id: "uuid-1", request_id: "req_9", attempt: 1 });
  errorEvent(db, 10, { request_id: "req_9", status_code: 529, attempt: 2 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db).map((row) => [row.source, row.attempt])).toEqual([
    ["transcript", 1],
    ["otel", 2],
  ]);
});

test("without request_id, errors from two sources are merged by time within a second", () => {
  const db = sessionDb();
  const fromTranscript = seed.apiError(db, { session_id: "s1", id: "uuid-1", agent_id: "a1", ts: SEED_TIME, status_code: null, error: "529 Overloaded", attempt: 1 });
  errorEvent(db, 999, { request_id: "req_9", status_code: 529, attempt: 1 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  // The transcript row stays with its own agent and text; request_id and status come from the event.
  expect(apiErrors(db)).toEqual([{ ...fromTranscript, request_id: "req_9", status_code: 529 }]);
});

test("errors more than a second apart are different records", () => {
  const db = sessionDb();
  retryLine(db, "uuid-1", 0, 1);
  errorEvent(db, 1000, { attempt: 1 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db).map((row) => row.source)).toEqual(["transcript", "otel"]);
});

test("different request_id values are not merged, even if the errors are close in time", () => {
  const db = sessionDb();
  refusalLine(db, "uuid-1", 0, "req_1");
  errorEvent(db, 10, { request_id: "req_2", attempt: 1 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db).map((row) => row.request_id)).toEqual(["req_1", "req_2"]);
});

test("close in time but with different attempt numbers: two records", () => {
  const db = sessionDb();
  const line = retryLine(db, "uuid-1", 0, 1);
  errorEvent(db, 500, { attempt: 2 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db)).toMatchObject([line, { source: "otel", attempt: 2 }]);
});

test("one row and two events nearby: the row accepts one, the other stays a record of its own", () => {
  const db = sessionDb();
  retryLine(db, "uuid-1", 0, 1);
  errorEvent(db, 5, { attempt: 1 });
  errorEvent(db, 600, { attempt: 2 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db).map((row) => [row.source, row.attempt])).toEqual([
    ["transcript", 1],
    ["otel", 2],
  ]);
});

test("a row accepts one event, even when the attempt number does not tell them apart", () => {
  const db = sessionDb();
  // The row has no attempt number: by it both events fit.
  retryLine(db, "uuid-1", 600, null);
  errorEvent(db, 5, { attempt: 1, status_code: 529 });
  errorEvent(db, 590, { attempt: 2, status_code: 503 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  // The pair goes to the event nearest in time, not the first in order.
  expect(apiErrors(db).map((row) => [row.source, row.attempt, row.status_code])).toEqual([
    ["otel", 1, 529],
    ["transcript", 2, 503],
  ]);
});

test("a refusal with a known attempt number does not get a foreign number from an event without request_id", () => {
  const db = sessionDb();
  const refusal = seed.apiError(db, { session_id: "s1", id: "uuid-1", ts: SEED_TIME, request_id: "req_A", status_code: 529, attempt: 4 });
  errorEvent(db, 400, { attempt: 3 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db)).toMatchObject([refusal, { source: "otel", request_id: null, attempt: 3 }]);
});

test("an exact pair by request_id takes precedence over the nearest in time", () => {
  const db = sessionDb();
  const retry = retryLine(db, "uuid-1", 100, 2);
  const refusal = refusalLine(db, "uuid-2", 900, "req_A");
  errorEvent(db, 0, { request_id: "req_A", status_code: 529, attempt: 3 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db)).toEqual([retry, { ...refusal, attempt: 3 }]);
});

test("an exact pair also takes precedence over the row that is nearer in time and fits by attempt number", () => {
  const db = sessionDb();
  const retry = retryLine(db, "uuid-1", 100, 3);
  const refusal = refusalLine(db, "uuid-2", 900, "req_A");
  errorEvent(db, 0, { request_id: "req_A", status_code: 529, attempt: 3 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db)).toEqual([retry, { ...refusal, attempt: 3 }]);
});

test("a row that got an exact pair does not also accept an event close in time", () => {
  const db = sessionDb();
  const refusal = refusalLine(db, "uuid-1", 0, "req_A");
  errorEvent(db, 0, { request_id: "req_A", status_code: 529, attempt: 3 });
  errorEvent(db, 100, { error: "Connection error.", attempt: 3 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db)).toMatchObject([
    { ...refusal, attempt: 3 },
    { source: "otel", request_id: null, error: "Connection error." },
  ]);
});

test("two consecutive attempts each merge with their own row, the nearest in time", () => {
  const db = sessionDb();
  // The rows have no attempt numbers: only time decides the pairs.
  retryLine(db, "uuid-1", 5, null);
  retryLine(db, "uuid-2", 605, null);
  errorEvent(db, 600, { request_id: "req_2", status_code: 503, attempt: 2 });
  errorEvent(db, 0, { request_id: "req_1", status_code: 529, attempt: 1 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db).map((row) => [row.id, row.request_id, row.status_code, row.attempt])).toEqual([
    ["uuid-1", "req_1", 529, 1],
    ["uuid-2", "req_2", 503, 2],
  ]);
});

test("when merging, the row's own value takes precedence over the event's, an empty one gets filled", () => {
  const db = sessionDb();
  // The row has its own request_id and status, no attempt number; the event has a different status and a number.
  const own = seed.apiError(db, { session_id: "s1", id: "uuid-1", ts: SEED_TIME, request_id: "req_A", status_code: 500, attempt: null });
  errorEvent(db, 10, { status_code: 529, attempt: 3 });
  // The row has only an attempt number; the event has request_id and status, no number.
  const bare = retryLine(db, "uuid-2", 60_000, 2);
  errorEvent(db, 60_010, { request_id: "req_B", status_code: 503 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db)).toEqual([
    { ...own, attempt: 3 },
    { ...bare, request_id: "req_B", status_code: 503 },
  ]);
});

// ── Merge boundaries ────────────────────────────────────────────────────────────────────────

test("events of another session and events without a session are not applied", () => {
  const db = sessionDb();
  seed.session(db, { id: "s2" });
  seed.modelCall(db, { session_id: "s1", id: "req_1", duration_ms: 4000 });
  const other = seed.modelCall(db, { session_id: "s2", id: "req_1", duration_ms: 4000 });
  seed.otelEvent(db, { session_id: "s2", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "req_1", duration_ms: 100 } });
  seed.otelEvent(db, { session_id: null, name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "req_1", duration_ms: 200 } });
  seed.otelEvent(db, { session_id: "s2", name: "claude_code.user_prompt", attrs: { prompt_length: 12 } });

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);

  expect(modelCall(db, "req_1")).toMatchObject({ duration_ms: 4000, duration_exact: 0 });
  expect(modelCall(db, "req_1", "s2")).toEqual(other);
  expect(applied(db)).toEqual([0, 0, 0]);
});

test("identifiers are unique within a session: events refine only the rows of their own session", () => {
  const db = sessionDb();
  seed.session(db, { id: "s2" });
  // A continued session copies the history of the original: the same identifiers and the same times.
  for (const session_id of ["s1", "s2"]) {
    seed.modelCall(db, { session_id, id: "req_1", duration_ms: 4000 });
    seed.toolCall(db, { session_id, id: "toolu_1", duration_ms: 5000 });
    seed.apiError(db, { session_id, id: "uuid-1", request_id: "req_9", status_code: null, attempt: null });
    seed.apiError(db, { session_id, id: "uuid-2", ts: SEED_TIME + 60_000, request_id: null, status_code: null, attempt: 1 });
  }
  const copy = { call: modelCall(db, "req_1", "s2"), tool: toolCall(db, "toolu_1", "s2"), errors: apiErrors(db).filter((row) => row.session_id === "s2") };
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "req_1", duration_ms: 100, query_source: "repl_main_thread" } });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.toolResult, attrs: { tool_use_id: "toolu_1", duration_ms: 77 } });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.toolDecision, attrs: { tool_use_id: "toolu_1", decision: "accept", source: "config" } });
  errorEvent(db, 0, { request_id: "req_9", status_code: 529, attempt: 2 });
  errorEvent(db, 60_010, { status_code: 503, attempt: 1 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(modelCall(db, "req_1")).toMatchObject({ duration_ms: 100, duration_exact: 1, query_source: "repl_main_thread" });
  expect(toolCall(db, "toolu_1")).toMatchObject({ duration_ms: 77, duration_exact: 1, permission_decision: "accept" });
  expect(apiErrors(db).filter((row) => row.session_id === "s1")).toMatchObject([
    { id: "uuid-1", status_code: 529, attempt: 2 },
    { id: "uuid-2", status_code: 503 },
  ]);
  expect({ call: modelCall(db, "req_1", "s2"), tool: toolCall(db, "toolu_1", "s2"), errors: apiErrors(db).filter((row) => row.session_id === "s2") }).toEqual(copy);
  // The merge of the other session does not see these events: neither its rows nor the events themselves change.
  expect(mergeEnrichment(db, "s2", ANTHROPIC_PROVIDER)).toBe(false);
  expect(apiErrors(db).filter((row) => row.session_id === "s2")).toEqual(copy.errors);
});

test("an error record from OTel is not merged with a transcript row of another session", () => {
  const db = sessionDb();
  seed.session(db, { id: "s2" });
  const foreign = seed.apiError(db, { session_id: "s2", id: "uuid-1", request_id: "req_9", status_code: null, attempt: null });
  errorEvent(db, 0, { request_id: "req_9", status_code: 529, attempt: 2 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(apiErrors(db)).toMatchObject([{ session_id: "s1", source: "otel", request_id: "req_9" }, foreign]);
});

test("events without a rule are marked as applied and do not change session data", () => {
  const db = sessionDb();
  seed.otelEvent(db, { session_id: "s1", name: "claude_code.user_prompt", attrs: { prompt_length: 12 } });
  seed.otelEvent(db, { session_id: "s1", name: "claude_code.hook_execution_start", attrs: {} });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.toolResult, attrs: { tool_use_id: "toolu_later", duration_ms: 5 } });

  // The session data did not change: there is no need to recalculate derived data.
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);

  // Only the event that waits for its row stays pending.
  expect(applied(db)).toEqual([1, 1, 0]);
});

test("until the session is in the database, its events wait: both API errors and events without a rule", () => {
  const db = openMemoryDb();
  errorEvent(db, 0, { attempt: 1 });
  seed.otelEvent(db, { session_id: "s1", name: "claude_code.user_prompt", attrs: {} });

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);
  expect(apiErrors(db)).toEqual([]);
  expect(applied(db)).toEqual([0, 0]);

  seed.session(db, { id: "s1" });
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);
  expect(apiErrors(db)).toHaveLength(1);
  expect(applied(db)).toEqual([1, 1]);
});

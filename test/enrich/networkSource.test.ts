// otelNetworkSource: not yet applied network events of a session from otel_events (decisions 13, 18, 24).
import { expect, test } from "bun:test";
import { OTEL_EVENT_NAMES, type NetworkEvent } from "../../src/contracts/enrich.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { otelNetworkSource } from "../../src/enrich/networkSource.ts";
import { parseOtlpLogs, storeOtelEvents } from "../../src/enrich/otlp.ts";
import { SEED_TIME, seed } from "../support/seed.ts";
import { apiError, apiErrorNoResponse, apiRequest, logRecord, logsRequest, OTLP_SESSION_ID, toolDecision, toolResult } from "./otlp.support.ts";

test("api_request and api_error of an ingested batch are returned as network events by time", () => {
  const db = openMemoryDb();
  storeOtelEvents(db, parseOtlpLogs(logsRequest([apiError(SEED_TIME + 300), toolDecision(SEED_TIME + 310), toolResult(SEED_TIME + 320), apiRequest(SEED_TIME)])));

  expect(otelNetworkSource(db).pending(OTLP_SESSION_ID)).toEqual<NetworkEvent[]>([
    {
      kind: "api_request",
      eventId: expect.any(Number),
      sessionId: OTLP_SESSION_ID,
      ts: SEED_TIME,
      requestId: "req_011AAAAAAAAAAAAAAAAAAAAA",
      model: "claude-opus-5-5",
      durationMs: 1840,
      querySource: "repl_main_thread",
      inputTokens: 12,
      outputTokens: 340,
      cacheReadTokens: 18_000,
      cacheCreationTokens: 900,
    },
    {
      kind: "api_error",
      eventId: expect.any(Number),
      sessionId: OTLP_SESSION_ID,
      ts: SEED_TIME + 300,
      requestId: "req_011BBBBBBBBBBBBBBBBBBBBB",
      statusCode: 529,
      error: "Overloaded",
      attempt: 2,
      durationMs: 320,
    },
  ]);
});

test("api_error without a server response: requestId and statusCode are null", () => {
  const db = openMemoryDb();
  storeOtelEvents(db, parseOtlpLogs(logsRequest([apiErrorNoResponse()])));

  expect(otelNetworkSource(db).pending(OTLP_SESSION_ID)).toEqual<NetworkEvent[]>([
    { kind: "api_error", eventId: expect.any(Number), sessionId: OTLP_SESSION_ID, ts: SEED_TIME, requestId: null, statusCode: null, error: "Connection error.", attempt: 1, durationMs: 15 },
  ]);
});

test("numbers sent as strings are read as numbers; a non-numeric value is null", () => {
  const db = openMemoryDb();
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "r1", duration_ms: "1840", model: "claude-opus-5-5", input_tokens: "12", output_tokens: "n/a" } });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiError, ts: SEED_TIME + 1, attrs: { error: "Overloaded", status_code: "529", attempt: "2", duration_ms: "n/a" } });

  expect(otelNetworkSource(db).pending("s1")).toEqual<NetworkEvent[]>([
    {
      kind: "api_request",
      eventId: expect.any(Number),
      sessionId: "s1",
      ts: SEED_TIME,
      requestId: "r1",
      model: "claude-opus-5-5",
      durationMs: 1840,
      querySource: null,
      inputTokens: 12,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    },
    { kind: "api_error", eventId: expect.any(Number), sessionId: "s1", ts: SEED_TIME + 1, requestId: null, statusCode: 529, error: "Overloaded", attempt: 2, durationMs: null },
  ]);
});

test("applied events, other sessions and events without a session are not returned", () => {
  const db = openMemoryDb();
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "applied" }, applied: 1 });
  seed.otelEvent(db, { session_id: "s2", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "other" } });
  seed.otelEvent(db, { session_id: null, name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "nobody" } });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "mine" } });

  const source = otelNetworkSource(db);
  expect(source.pending("s1").map((event) => event.requestId)).toEqual(["mine"]);
  expect(source.pending("s2").map((event) => event.requestId)).toEqual(["other"]);
  expect(source.pending("s3")).toEqual([]);
});

test("non-network and unknown events, and api_request without request_id are not returned", () => {
  const db = openMemoryDb();
  storeOtelEvents(db, parseOtlpLogs(logsRequest([toolDecision(), toolResult(), logRecord("brand_new_event"), logRecord("api_request", { model: "claude-opus-5-5", duration_ms: 5 })])));

  expect(otelNetworkSource(db).pending(OTLP_SESSION_ID)).toEqual([]);
});

test("events with equal time are returned in ingestion order", () => {
  const db = openMemoryDb();
  for (const id of ["r1", "r2", "r3"]) seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: id } });

  expect(otelNetworkSource(db).pending("s1").map((event) => event.requestId)).toEqual(["r1", "r2", "r3"]);
});

test("an event marked as applied is no longer returned", () => {
  const db = openMemoryDb();
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "r1" } });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest, ts: SEED_TIME + 1, attrs: { request_id: "r2" } });

  const source = otelNetworkSource(db);
  const [first] = source.pending("s1");
  source.markApplied([first!.eventId]);
  expect(source.pending("s1").map((event) => event.requestId)).toEqual(["r2"]);
});

// POST /otlp/v1/logs and /otlp/v1/metrics: OTLP http/json receiver (plan §8, spikes.md §8).
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { API_ROUTES } from "../../src/contracts/api.ts";
import { DEFAULT_HOST, DEFAULT_PORT } from "../../src/contracts/constants.ts";
import { OTEL_DROPPED_ATTRS, OTEL_EVENT_NAMES } from "../../src/contracts/enrich.ts";
import type { RawEventRow } from "../../src/contracts/rows.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { createServer } from "../../src/server.ts";
import {
  apiError,
  apiErrorNoResponse,
  apiRequest,
  assistantResponse,
  logRecord,
  logsRequest,
  OTLP_SESSION_ID,
  toolDecision,
  toolResult,
  userPrompt,
} from "../enrich/otlp.support.ts";
import { testApi, testConfig } from "../support/api.ts";
import { SEED_TIME } from "../support/seed.ts";

const rows = (db: Database) => db.query<RawEventRow, []>("SELECT * FROM otel_events ORDER BY id").all();

/** A request the way Claude Code sends it: `content-type: application/json`, no compression. */
function post(db: Database, route: string, body: unknown): Promise<Response> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return Promise.resolve(testApi(db).app.request(route, { method: "POST", headers: { "content-type": "application/json" }, body: text }));
}

test("a batch with the four plan §3.3 events is accepted: 200 and four otel_events rows", async () => {
  const db = openMemoryDb();
  const response = await post(db, API_ROUTES.otlpLogs, logsRequest([apiRequest(SEED_TIME), toolDecision(SEED_TIME + 1), toolResult(SEED_TIME + 2), apiError(SEED_TIME + 3)]));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({});
  expect(rows(db).map(({ attrs_json: _attrs, ...row }) => row)).toEqual([
    { id: 1, session_id: OTLP_SESSION_ID, ts: SEED_TIME, name: OTEL_EVENT_NAMES.apiRequest, applied: 0 },
    { id: 2, session_id: OTLP_SESSION_ID, ts: SEED_TIME + 1, name: OTEL_EVENT_NAMES.toolDecision, applied: 0 },
    { id: 3, session_id: OTLP_SESSION_ID, ts: SEED_TIME + 2, name: OTEL_EVENT_NAMES.toolResult, applied: 0 },
    { id: 4, session_id: OTLP_SESSION_ID, ts: SEED_TIME + 3, name: OTEL_EVENT_NAMES.apiError, applied: 0 },
  ]);
  expect(JSON.parse(rows(db)[0]!.attrs_json)).toMatchObject({ request_id: "req_011AAAAAAAAAAAAAAAAAAAAA", duration_ms: 1840, model: "claude-opus-5-5" });
});

test("an unknown event is saved without an error", async () => {
  const db = openMemoryDb();
  const response = await post(db, API_ROUTES.otlpLogs, logsRequest([logRecord("brand_new_event", { answer: 42 })]));

  expect(response.status).toBe(200);
  expect(rows(db)).toHaveLength(1);
  expect(rows(db)[0]).toMatchObject({ name: "claude_code.brand_new_event", session_id: OTLP_SESSION_ID });
  expect(JSON.parse(rows(db)[0]!.attrs_json).answer).toBe(42);
});

test("attributes from OTEL_DROPPED_ATTRS do not reach the database for any event", async () => {
  const db = openMemoryDb();
  const records = [apiRequest(), apiError(), apiErrorNoResponse(), toolResult(), toolDecision(), userPrompt(), assistantResponse(), logRecord("brand_new_event")];
  expect((await post(db, API_ROUTES.otlpLogs, logsRequest(records))).status).toBe(200);

  const stored = rows(db);
  expect(stored).toHaveLength(records.length);
  for (const row of stored) {
    const attrs = JSON.parse(row.attrs_json) as Record<string, unknown>;
    for (const key of OTEL_DROPPED_ATTRS) expect({ name: row.name, key, stored: key in attrs }).toEqual({ name: row.name, key, stored: false });
    expect(row.attrs_json).not.toContain("dev@example.com");
    expect(row.attrs_json).not.toContain("REDACTED");
  }
});

test("api_error without a server response is stored without request_id and status_code", async () => {
  const db = openMemoryDb();
  expect((await post(db, API_ROUTES.otlpLogs, logsRequest([apiErrorNoResponse()]))).status).toBe(200);

  const [row] = rows(db);
  expect(row!.name).toBe(OTEL_EVENT_NAMES.apiError);
  const attrs = JSON.parse(row!.attrs_json) as Record<string, unknown>;
  expect(attrs).toMatchObject({ error: "Connection error.", attempt: 1 });
  expect(attrs).not.toHaveProperty("request_id");
  expect(attrs).not.toHaveProperty("status_code");
});

test("batch fields outside the contract do not hinder acceptance", async () => {
  const db = openMemoryDb();
  const body = {
    resourceLogs: [
      {
        resource: { attributes: [], droppedAttributesCount: 0 },
        scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events", version: "2.1.321" }, logRecords: [{ ...apiRequest(), severityNumber: 9, traceId: "", spanId: "" }] }],
        schemaUrl: "",
      },
    ],
  };
  expect((await post(db, API_ROUTES.otlpLogs, body)).status).toBe(200);
  expect(rows(db).map((row) => row.name)).toEqual([OTEL_EVENT_NAMES.apiRequest]);
});

test("an empty batch is accepted and writes nothing", async () => {
  const db = openMemoryDb();
  const response = await post(db, API_ROUTES.otlpLogs, {});
  expect(response.status).toBe(200);
  expect(rows(db)).toEqual([]);
});

test.each([
  ["not JSON", "{resourceLogs"],
  ["empty body", ""],
  ["JSON not an object", "5"],
])("request body — %s: 400 and nothing written", async (_name, body) => {
  const db = openMemoryDb();
  const response = await post(db, API_ROUTES.otlpLogs, body);
  expect(response.status).toBe(400);
  expect(rows(db)).toEqual([]);
});

test("metrics: 200 and nothing is stored", async () => {
  const db = openMemoryDb();
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('meta')").all();
  const metrics = {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code-desktop" } }] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.session.count",
                sum: { dataPoints: [{ asInt: "1", timeUnixNano: `${SEED_TIME}000000`, attributes: [{ key: "session.id", value: { stringValue: OTLP_SESSION_ID } }] }] },
              },
            ],
          },
        ],
      },
    ],
  };

  const response = await post(db, API_ROUTES.otlpMetrics, metrics);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({});
  for (const { name } of tables) {
    expect({ name, rows: db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${name}`).get()!.n }).toEqual({ name, rows: 0 });
  }
  // The metrics body is not parsed: a non-JSON one is accepted the same way.
  expect((await post(db, API_ROUTES.otlpMetrics, "not json")).status).toBe(200);
});

test("a server at the default address accepts a batch at the address from the Claude Code settings", async () => {
  const db = openMemoryDb();
  const app = createServer({ db, config: testConfig(), now: () => 0 });
  const endpoint = `http://${DEFAULT_HOST}:${DEFAULT_PORT}${API_ROUTES.otlpLogs}`;

  const response = await app.request(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(logsRequest([apiRequest()])) });
  expect(response.status).toBe(200);
  expect(rows(db).map((row) => row.name)).toEqual([OTEL_EVENT_NAMES.apiRequest]);
});

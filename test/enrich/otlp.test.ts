// parseOtlpLogs and storeOtelEvents: an OTLP http/json batch → otel_events rows (plan §3.3, spikes.md §8).
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { OTEL_DROPPED_ATTRS, OTEL_EVENT_NAMES, type OtlpLogsRequest } from "../../src/contracts/enrich.ts";
import type { RawEventRow } from "../../src/contracts/rows.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { parseOtlpLogs, storeOtelEvents } from "../../src/enrich/otlp.ts";
import { SEED_TIME } from "../support/seed.ts";
import {
  apiError,
  apiErrorNoResponse,
  apiRequest,
  assistantResponse,
  logRecord,
  logsRequest,
  OTLP_SESSION_ID,
  otlpAttrs,
  toolDecision,
  toolResult,
  userPrompt,
} from "./otlp.support.ts";

const rows = (db: Database) => db.query<RawEventRow, []>("SELECT * FROM otel_events ORDER BY id").all();

describe("the four events of plan §3.3", () => {
  test("api_request: full name, session, time and call attributes", () => {
    const [event, ...rest] = parseOtlpLogs(logsRequest([apiRequest(SEED_TIME + 1500)]));
    expect(rest).toEqual([]);
    expect(event).toMatchObject({ sessionId: OTLP_SESSION_ID, ts: SEED_TIME + 1500, name: OTEL_EVENT_NAMES.apiRequest });
    expect(event!.attrs).toMatchObject({
      request_id: "req_011AAAAAAAAAAAAAAAAAAAAA",
      model: "claude-opus-5-5",
      duration_ms: 1840,
      ttft_ms: 610,
      cost_usd: 0.0421,
      input_tokens: 12,
      output_tokens: 340,
      cache_read_tokens: 18_000,
      cache_creation_tokens: 900,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 900,
      query_source: "repl_main_thread",
    });
  });

  test("api_error: status, error text and attempt number", () => {
    const [event] = parseOtlpLogs(logsRequest([apiError()]));
    expect(event!.name).toBe(OTEL_EVENT_NAMES.apiError);
    expect(event!.attrs).toMatchObject({ request_id: "req_011BBBBBBBBBBBBBBBBBBBBB", status_code: 529, error: "Overloaded", attempt: 2, duration_ms: 320 });
  });

  test("api_error without a server response arrives without request_id and status_code", () => {
    const [event] = parseOtlpLogs(logsRequest([apiErrorNoResponse()]));
    expect(event!.name).toBe(OTEL_EVENT_NAMES.apiError);
    expect(event!.attrs).toMatchObject({ error: "Connection error.", attempt: 1, duration_ms: 15, model: "claude-opus-5-5" });
    expect(event!.attrs).not.toHaveProperty("request_id");
    expect(event!.attrs).not.toHaveProperty("status_code");
  });

  test("tool_result: call, success, duration and sizes", () => {
    const [event] = parseOtlpLogs(logsRequest([toolResult()]));
    expect(event!.name).toBe(OTEL_EVENT_NAMES.toolResult);
    expect(event!.attrs).toMatchObject({
      tool_use_id: "toolu_01AAAAAAAAAAAAAAAAAAAAAA",
      tool_name: "Read",
      success: "true",
      duration_ms: 42,
      tool_input_size_bytes: 58,
      tool_result_size_bytes: 2048,
      request_id: "req_011AAAAAAAAAAAAAAAAAAAAA",
    });
  });

  test("tool_decision: the decision and its source", () => {
    const [event] = parseOtlpLogs(logsRequest([toolDecision()]));
    expect(event!.name).toBe(OTEL_EVENT_NAMES.toolDecision);
    expect(event!.attrs).toMatchObject({ tool_use_id: "toolu_01AAAAAAAAAAAAAAAAAAAAAA", decision: "accept", source: "config", tool_name: "Read" });
  });

  test("a batch with several events is parsed in record order", () => {
    const events = parseOtlpLogs(logsRequest([apiRequest(SEED_TIME), toolDecision(SEED_TIME + 1), toolResult(SEED_TIME + 2), apiError(SEED_TIME + 3)]));
    expect(events.map((event) => [event.name, event.ts])).toEqual([
      [OTEL_EVENT_NAMES.apiRequest, SEED_TIME],
      [OTEL_EVENT_NAMES.toolDecision, SEED_TIME + 1],
      [OTEL_EVENT_NAMES.toolResult, SEED_TIME + 2],
      [OTEL_EVENT_NAMES.apiError, SEED_TIME + 3],
    ]);
  });

  test("records from several resources and scopes are collected into one list", () => {
    const body: OtlpLogsRequest = {
      resourceLogs: [{ scopeLogs: [{ logRecords: [apiRequest()] }, { logRecords: [toolResult()] }] }, { scopeLogs: [{ logRecords: [apiError()] }] }],
    };
    expect(parseOtlpLogs(body).map((event) => event.name)).toEqual([OTEL_EVENT_NAMES.apiRequest, OTEL_EVENT_NAMES.toolResult, OTEL_EVENT_NAMES.apiError]);
  });
});

describe("event name", () => {
  const record = (attrs: Record<string, string>, body?: string) => ({
    timeUnixNano: `${SEED_TIME}000000`,
    ...(body === undefined ? {} : { body: { stringValue: body } }),
    attributes: otlpAttrs(attrs),
  });
  const names = (...records: ReturnType<typeof record>[]) => parseOtlpLogs(logsRequest(records)).map((event) => event.name);

  test("a short name from event.name gets the prefix added", () => {
    expect(names(record({ "event.name": "api_request" }))).toEqual(["claude_code.api_request"]);
  });

  test("a full name in event.name does not get the prefix added", () => {
    expect(names(record({ "event.name": "claude_code.tool_result" }))).toEqual(["claude_code.tool_result"]);
  });

  test("without event.name the name is taken from the record body", () => {
    expect(names(record({}, "claude_code.tool_decision"))).toEqual(["claude_code.tool_decision"]);
  });

  test("an unknown event is kept under its own name", () => {
    const events = parseOtlpLogs(logsRequest([logRecord("hook_execution_complete", { hook_name: "SessionStart" }), logRecord("brand_new_event")]));
    expect(events.map((event) => event.name)).toEqual(["claude_code.hook_execution_complete", "claude_code.brand_new_event"]);
    expect(events[0]!.attrs.hook_name).toBe("SessionStart");
  });

  test("a record without a name is skipped", () => {
    expect(names(record({ "session.id": OTLP_SESSION_ID }), record({ "event.name": "api_error" }))).toEqual(["claude_code.api_error"]);
  });
});

describe("attributes", () => {
  test("personal data and texts do not end up in any event", () => {
    const events = parseOtlpLogs(
      logsRequest([apiRequest(), apiError(), apiErrorNoResponse(), toolResult(), toolDecision(), userPrompt(), assistantResponse(), logRecord("brand_new_event")]),
    );
    expect(events).toHaveLength(8);
    for (const event of events) {
      for (const key of OTEL_DROPPED_ATTRS) expect(event.attrs).not.toHaveProperty([key]);
      expect(JSON.stringify(event.attrs)).not.toContain("dev@example.com");
    }
  });

  test("events with texts keep their lengths", () => {
    const [prompt, response] = parseOtlpLogs(logsRequest([userPrompt(), assistantResponse()]));
    expect(prompt!.attrs.prompt_length).toBe(27);
    expect(response!.attrs.response_length).toBe(512);
  });

  test("values arrive with their own type: string, integer as string and as number, fractional, boolean", () => {
    const [event] = parseOtlpLogs(
      logsRequest([
        {
          timeUnixNano: `${SEED_TIME}000000`,
          attributes: [
            { key: "event.name", value: { stringValue: "api_request" } },
            { key: "duration_ms", value: { intValue: "1840" } },
            { key: "attempt", value: { intValue: 3 } },
            { key: "cost_usd", value: { doubleValue: 0.5 } },
            { key: "success", value: { boolValue: false } },
            { key: "ttft_ms", value: { stringValue: "610" } },
          ],
        },
      ]),
    );
    expect(event!.attrs).toEqual({ "event.name": "api_request", duration_ms: 1840, attempt: 3, cost_usd: 0.5, success: false, ttft_ms: "610" });
  });

  test("values of kinds outside the contract and attributes without a value are dropped", () => {
    const body = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: `${SEED_TIME}000000`,
                  attributes: [
                    { key: "event.name", value: { stringValue: "api_request" } },
                    { key: "tags", value: { arrayValue: { values: [{ stringValue: "a" }] } } },
                    { key: "empty", value: {} },
                    { key: "no_value" },
                    { key: "bad_int", value: { intValue: "12x" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as unknown as OtlpLogsRequest;
    expect(parseOtlpLogs(body)[0]!.attrs).toEqual({ "event.name": "api_request" });
  });

  test("an event without session.id gets sessionId = null", () => {
    const [event] = parseOtlpLogs(logsRequest([{ timeUnixNano: `${SEED_TIME}000000`, attributes: otlpAttrs({ "event.name": "plugin_loaded" }) }]));
    expect(event).toEqual({ sessionId: null, ts: SEED_TIME, name: "claude_code.plugin_loaded", attrs: { "event.name": "plugin_loaded" } });
  });
});

describe("event time", () => {
  const record = (time: object) => ({ ...time, attributes: otlpAttrs({ "event.name": "api_request" }) });
  const times = (time: object) => parseOtlpLogs(logsRequest([record(time)])).map((event) => event.ts);

  test("timeUnixNano is converted to milliseconds", () => {
    expect(times({ timeUnixNano: `${SEED_TIME}123456` })).toEqual([SEED_TIME]);
  });

  test("without timeUnixNano, observedTimeUnixNano is used", () => {
    expect(times({ observedTimeUnixNano: `${SEED_TIME + 5}000000` })).toEqual([SEED_TIME + 5]);
    expect(times({ timeUnixNano: "0", observedTimeUnixNano: `${SEED_TIME + 5}000000` })).toEqual([SEED_TIME + 5]);
  });

  test("a record without a time is skipped", () => {
    expect(times({})).toEqual([]);
    expect(times({ timeUnixNano: "yesterday" })).toEqual([]);
  });
});

describe("malformed body", () => {
  test.each([
    ["empty object", {}],
    ["empty resource list", { resourceLogs: [] }],
    ["resourceLogs is not a list", { resourceLogs: "nope" }],
    ["resource without scopes", { resourceLogs: [{}, null] }],
    ["scope without records", { resourceLogs: [{ scopeLogs: [{}, null, { logRecords: "nope" }] }] }],
    ["record is not an object", { resourceLogs: [{ scopeLogs: [{ logRecords: [null, 5, "x"] }] }] }],
    ["attributes are not a list", { resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: "1000000", attributes: { a: 1 } }] }] }] }],
  ])("%s: no events, no exception", (_name, body) => {
    expect(parseOtlpLogs(body as unknown as OtlpLogsRequest)).toEqual([]);
  });
});

describe("storeOtelEvents", () => {
  test("each event is an otel_events row with applied = 0", () => {
    const db = openMemoryDb();
    storeOtelEvents(db, parseOtlpLogs(logsRequest([apiRequest(SEED_TIME), toolResult(SEED_TIME + 40)])));

    const stored = rows(db);
    expect(stored.map(({ attrs_json: _attrs, ...row }) => row)).toEqual([
      { id: 1, session_id: OTLP_SESSION_ID, ts: SEED_TIME, name: OTEL_EVENT_NAMES.apiRequest, applied: 0 },
      { id: 2, session_id: OTLP_SESSION_ID, ts: SEED_TIME + 40, name: OTEL_EVENT_NAMES.toolResult, applied: 0 },
    ]);
    expect(JSON.parse(stored[0]!.attrs_json)).toMatchObject({ request_id: "req_011AAAAAAAAAAAAAAAAAAAAA", duration_ms: 1840 });
    expect(JSON.parse(stored[1]!.attrs_json)).toMatchObject({ tool_use_id: "toolu_01AAAAAAAAAAAAAAAAAAAAAA", duration_ms: 42 });
  });

  test("an event without a session and an unknown event are stored", () => {
    const db = openMemoryDb();
    storeOtelEvents(db, [
      { sessionId: null, ts: SEED_TIME, name: "claude_code.plugin_loaded", attrs: {} },
      { sessionId: "s1", ts: SEED_TIME, name: "claude_code.brand_new_event", attrs: { answer: 42 } },
    ]);
    expect(rows(db)).toEqual([
      { id: 1, session_id: null, ts: SEED_TIME, name: "claude_code.plugin_loaded", attrs_json: "{}", applied: 0 },
      { id: 2, session_id: "s1", ts: SEED_TIME, name: "claude_code.brand_new_event", attrs_json: '{"answer":42}', applied: 0 },
    ]);
  });

  test("an empty list writes nothing; the next batch is appended to earlier ones", () => {
    const db = openMemoryDb();
    storeOtelEvents(db, []);
    expect(rows(db)).toEqual([]);
    storeOtelEvents(db, parseOtlpLogs(logsRequest([apiRequest()])));
    storeOtelEvents(db, parseOtlpLogs(logsRequest([apiError()])));
    expect(rows(db).map((row) => row.name)).toEqual([OTEL_EVENT_NAMES.apiRequest, OTEL_EVENT_NAMES.apiError]);
  });
});

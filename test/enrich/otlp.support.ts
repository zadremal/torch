// Synthetic OTLP http/json batches following the structure recorded in docs/spikes.md §8. The values are made up.
import { OTEL_EVENT_PREFIX, type AttrValue, type OtlpAnyValue, type OtlpKeyValue, type OtlpLogRecord, type OtlpLogsRequest } from "../../src/contracts/enrich.ts";
import { SEED_TIME } from "../support/seed.ts";

export const OTLP_SESSION_ID = "11111111-2222-4333-8444-555555555555";

/** A JS value as an OTLP value; an integer is written as a string, like `int64` in JSON. */
export function otlpValue(value: AttrValue): OtlpAnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

export const otlpAttrs = (attrs: Record<string, AttrValue>): OtlpKeyValue[] => Object.entries(attrs).map(([key, value]) => ({ key, value: otlpValue(value) }));

/** Attributes carried by every event of a desktop session, personal ones included. */
export function commonAttrs(shortName: string, ts: number): Record<string, AttrValue> {
  return {
    "session.id": OTLP_SESSION_ID,
    "event.name": shortName,
    "event.timestamp": new Date(ts).toISOString(),
    "event.sequence": 7,
    "terminal.type": "non-interactive",
    "user.id": "user-hash-0001",
    "user.email": "dev@example.com",
    "user.account_uuid": "acc-uuid-0001",
    "user.account_id": "acc-id-0001",
    "organization.id": "org-0001",
    "service.name": "claude-code-desktop",
    "service.version": "1.2.3",
    "claude.deployment_mode": "desktop",
    "process.owner": "dev",
    "anthropic.provider": "anthropic",
    "anthropic.plan": "max",
  };
}

/** An event log record: the body carries the full name, `event.name` the short one. */
export function logRecord(shortName: string, attrs: Record<string, AttrValue> = {}, ts: number = SEED_TIME): OtlpLogRecord {
  const nanos = `${ts}000000`;
  return {
    timeUnixNano: nanos,
    observedTimeUnixNano: nanos,
    body: { stringValue: OTEL_EVENT_PREFIX + shortName },
    attributes: otlpAttrs({ ...commonAttrs(shortName, ts), ...attrs }),
  };
}

export function logsRequest(records: OtlpLogRecord[]): OtlpLogsRequest {
  return {
    resourceLogs: [
      {
        resource: { attributes: otlpAttrs({ "service.name": "claude-code-desktop", "service.version": "1.2.3", "process.owner": "dev" }) },
        scopeLogs: [{ logRecords: records }],
      },
    ],
  };
}

// ── The four events of plan §3.3 with attributes from spikes §8 ─────────────────────────────

export const apiRequest = (ts?: number): OtlpLogRecord =>
  logRecord(
    "api_request",
    {
      model: "claude-opus-5-5",
      input_tokens: 12,
      output_tokens: 340,
      cache_read_tokens: 18_000,
      cache_creation_tokens: 900,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 900,
      cost_usd: 0.0421,
      cost_usd_micros: 42_100,
      duration_ms: 1840,
      ttft_ms: 610,
      request_id: "req_011AAAAAAAAAAAAAAAAAAAAA",
      client_request_id: "client-req-0001",
      speed: "normal",
      query_source: "repl_main_thread",
      effort: "high",
    },
    ts,
  );

/** An error with a server response. */
export const apiError = (ts?: number): OtlpLogRecord =>
  logRecord(
    "api_error",
    {
      model: "claude-opus-5-5",
      error: "Overloaded",
      status_code: 529,
      duration_ms: 320,
      attempt: 2,
      request_id: "req_011BBBBBBBBBBBBBBBBBBBBB",
      speed: "normal",
      query_source: "repl_main_thread",
    },
    ts,
  );

/** An error without a server response: `request_id` and `status_code` do not arrive. */
export const apiErrorNoResponse = (ts?: number): OtlpLogRecord =>
  logRecord(
    "api_error",
    { model: "claude-opus-5-5", error: "Connection error.", duration_ms: 15, attempt: 1, speed: "normal", query_source: "repl_main_thread", "prompt.id": "prompt-0001" },
    ts,
  );

export const toolDecision = (ts?: number): OtlpLogRecord =>
  logRecord(
    "tool_decision",
    {
      decision: "accept",
      source: "config",
      tool_name: "Read",
      tool_use_id: "toolu_01AAAAAAAAAAAAAAAAAAAAAA",
      tool_source: "builtin",
      permission_mode: "default",
      request_id: "req_011AAAAAAAAAAAAAAAAAAAAA",
    },
    ts,
  );

export const toolResult = (ts?: number): OtlpLogRecord =>
  logRecord(
    "tool_result",
    {
      tool_name: "Read",
      tool_use_id: "toolu_01AAAAAAAAAAAAAAAAAAAAAA",
      success: "true",
      duration_ms: 42,
      tool_input_size_bytes: 58,
      tool_result_size_bytes: 2048,
      request_id: "req_011AAAAAAAAAAAAAAAAAAAAA",
    },
    ts,
  );

/** Service events with texts: the receiver stores them without the texts. */
export const userPrompt = (ts?: number): OtlpLogRecord => logRecord("user_prompt", { prompt: "<REDACTED>", prompt_text: "<REDACTED>", prompt_length: 27 }, ts);
export const assistantResponse = (ts?: number): OtlpLogRecord => logRecord("assistant_response", { response: "<REDACTED>", response_length: 512 }, ts);

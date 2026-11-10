// Parsing of OTLP http/json and storing events in otel_events. Package E1.
import type { Database } from "bun:sqlite";
import {
  OTEL_DROPPED_ATTRS,
  OTEL_EVENT_PREFIX,
  type AttrValue,
  type OtelEvent,
  type OtlpAnyValue,
  type OtlpKeyValue,
  type OtlpLogRecord,
  type OtlpLogsRequest,
} from "../contracts/enrich.ts";

const NANOS_PER_MS = 1_000_000n;

/** The request body comes over the network: anything may turn up in place of a list. */
const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);

/** An OTLP value as a JS value; `int64` is written as a string in JSON. Kinds outside the contract (arrays, nested lists) give undefined. */
function anyValue(value: OtlpAnyValue | undefined): AttrValue | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (typeof value.doubleValue === "number") return value.doubleValue;
  if (typeof value.intValue === "number") return value.intValue;
  if (typeof value.intValue === "string" && value.intValue !== "" && Number.isFinite(Number(value.intValue))) return Number(value.intValue);
  return undefined;
}

/** Record attributes without personal data and texts (`OTEL_DROPPED_ATTRS`). */
function attributes(pairs: OtlpKeyValue[] | undefined): Record<string, AttrValue> {
  const attrs: Record<string, AttrValue> = {};
  for (const pair of list(pairs)) {
    if (typeof pair?.key !== "string" || OTEL_DROPPED_ATTRS.includes(pair.key)) continue;
    const value = anyValue(pair.value);
    if (value !== undefined) attrs[pair.key] = value;
  }
  return attrs;
}

/** Epoch nanoseconds to milliseconds; null if there is no time (`"0"` also means "none"). */
function nanosToMs(nanos: string | undefined): number | null {
  if (typeof nanos !== "string" || !/^\d+$/.test(nanos)) return null;
  const ms = Number(BigInt(nanos) / NANOS_PER_MS);
  return ms > 0 ? ms : null;
}

/** Full event name: the short one from `event.name` gets the prefix added; without the attribute the record body is used. */
function eventName(record: OtlpLogRecord, attrs: Record<string, AttrValue>): string | null {
  const short = attrs["event.name"];
  if (typeof short === "string" && short !== "") return short.startsWith(OTEL_EVENT_PREFIX) ? short : OTEL_EVENT_PREFIX + short;
  const body = anyValue(record.body);
  return typeof body === "string" && body !== "" ? body : null;
}

/**
 * Log records of a batch in arrival order. An unknown event name is kept as is; a record without
 * a name or without a time is not counted as an event and is skipped. Never throws.
 */
export function parseOtlpLogs(body: OtlpLogsRequest): OtelEvent[] {
  const events: OtelEvent[] = [];
  for (const resource of list(body?.resourceLogs)) {
    for (const scope of list(resource?.scopeLogs)) {
      for (const record of list(scope?.logRecords)) {
        if (typeof record !== "object" || record === null) continue;
        const attrs = attributes(record.attributes);
        const name = eventName(record, attrs);
        const ts = nanosToMs(record.timeUnixNano) ?? nanosToMs(record.observedTimeUnixNano);
        if (name === null || ts === null) continue;
        const sessionId = attrs["session.id"];
        events.push({ sessionId: typeof sessionId === "string" ? sessionId : null, ts, name, attrs });
      }
    }
  }
  return events;
}

/** Puts events into `otel_events` in one transaction, with `applied = 0`: enrich/merge.ts applies them. */
export function storeOtelEvents(db: Database, events: OtelEvent[]): void {
  if (events.length === 0) return;
  const insert = db.query("INSERT INTO otel_events (session_id, ts, name, attrs_json) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    for (const event of events) insert.run(event.sessionId, event.ts, event.name, JSON.stringify(event.attrs));
  })();
}

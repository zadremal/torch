// Network event source: the interface and the only first-wave implementation on top of otel_events. Package E1.
import type { Database } from "bun:sqlite";
import { OTEL_EVENT_NAMES, type AttrValue, type NetworkEvent, type NetworkSource } from "../contracts/enrich.ts";
import type { RawEventRow } from "../contracts/rows.ts";

type Attrs = Record<string, AttrValue | undefined>;

const text = (value: AttrValue | undefined): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Number from an attribute: the exporter may send it either as a number or as a string holding a number. */
function number(value: AttrValue | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * An `otel_events` row as a network event. An `api_request` without `request_id` (a gateway sends none) is a
 * network event too: whether it can be tied to a call is the provider's decision (`matchApiRequests`).
 */
function networkEvent(row: RawEventRow & { session_id: string }): NetworkEvent {
  const attrs = JSON.parse(row.attrs_json) as Attrs;
  const common = { eventId: row.id, sessionId: row.session_id, ts: row.ts, durationMs: number(attrs.duration_ms) };
  if (row.name === OTEL_EVENT_NAMES.apiError) {
    // Without a server response, `request_id` and `status_code` do not arrive (spikes.md §8).
    return {
      kind: "api_error",
      ...common,
      requestId: text(attrs.request_id),
      statusCode: number(attrs.status_code),
      error: text(attrs.error) ?? "",
      attempt: number(attrs.attempt),
    };
  }
  return {
    kind: "api_request",
    ...common,
    requestId: text(attrs.request_id),
    model: text(attrs.model),
    querySource: text(attrs.query_source),
    inputTokens: number(attrs.input_tokens),
    outputTokens: number(attrs.output_tokens),
    cacheReadTokens: number(attrs.cache_read_tokens),
    cacheCreationTokens: number(attrs.cache_creation_tokens),
  };
}

export function otelNetworkSource(db: Database): NetworkSource {
  const pending = db.query<RawEventRow & { session_id: string }, [string, string, string]>(
    "SELECT * FROM otel_events WHERE applied = 0 AND session_id = ? AND name IN (?, ?) ORDER BY ts, id",
  );
  const apply = db.query("UPDATE otel_events SET applied = 1 WHERE id = ?");
  return {
    markApplied: (eventIds) => {
      for (const id of eventIds) apply.run(id);
    },
    pending: (sessionId) =>
      pending
        .all(sessionId, OTEL_EVENT_NAMES.apiRequest, OTEL_EVENT_NAMES.apiError)
        .map(networkEvent),
  };
}

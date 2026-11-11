// Enrichment: OpenTelemetry events and hooks (plan §3.3, §3.4, §6.3).
// The format of the hooks section and the set of events and attributes were verified by experiment: docs/spikes.md §8.

// ── OTLP http/json, POST /otlp/v1/logs and /otlp/v1/metrics ─────────────────────────────────
// The receiver accepts metrics and does not store them: without their address, log export does not
// start in some setups (spikes.md §8).

export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpLogRecord {
  timeUnixNano?: string;
  observedTimeUnixNano?: string;
  body?: OtlpAnyValue;
  attributes?: OtlpKeyValue[];
}

export interface OtlpLogsRequest {
  resourceLogs?: {
    resource?: { attributes?: OtlpKeyValue[] };
    scopeLogs?: { logRecords?: OtlpLogRecord[] }[];
  }[];
}

/** Full event names: this is how they are stored in `otel_events.name`. The record body carries the full name,
 * the `event.name` attribute the short one (`api_request`); when parsing, the short one is completed with the prefix. */
export const OTEL_EVENT_PREFIX = "claude_code.";

export const OTEL_EVENT_NAMES = {
  apiRequest: "claude_code.api_request",
  apiError: "claude_code.api_error",
  toolResult: "claude_code.tool_result",
  toolDecision: "claude_code.tool_decision",
} as const;

/** Attributes the receiver drops before writing: personal data and the texts of the prompt and the response. */
export const OTEL_DROPPED_ATTRS: readonly string[] = [
  "user.id",
  "user.email",
  "user.account_uuid",
  "user.account_id",
  "organization.id",
  "process.owner",
  "prompt",
  "prompt_text",
  "response",
];

export type AttrValue = string | number | boolean;

/** A log record after parsing: what goes into `otel_events`. An unknown event name is kept as is. */
export interface OtelEvent {
  /** The `session.id` attribute. */
  sessionId: string | null;
  ts: number;
  name: string;
  attrs: Record<string, AttrValue>;
}

// ── Hooks ───────────────────────────────────────────────────────────────────────────────────

export const HOOK_EVENT_NAMES = ["InstructionsLoaded", "SessionStart", "SessionEnd", "PreCompact", "PostCompact"] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/** JSON that Claude Code passes to the handler on stdin and that `hooks/record.sh` puts into the spool as a file. */
export interface HookPayload {
  hook_event_name: string;
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  /** Present in desktop sessions. */
  scratchpad_dir?: string;
  prompt_id?: string;
  /** Subagent event; the main agent has no such field. */
  agent_id?: string;
  agent_type?: string;
  // InstructionsLoaded
  file_path?: string;
  memory_type?: string;
  load_reason?: string;
  trigger_file_path?: string;
  parent_file_path?: string;
  // SessionStart; `model` does not arrive in practice
  source?: string;
  model?: string;
  // SessionEnd
  reason?: string;
  // PreCompact, PostCompact
  trigger?: string;
  compact_summary?: string;
}

/** Attributes that enrich/hooks.ts adds to an event on receipt. */
export interface HookEventExtras {
  /** Size of the instructions file on disk at the time of receipt; null if the file is unavailable. */
  file_bytes: number | null;
}

// ── Source of network events (decisions 13, 18, 24) ─────────────────────────────────────────

/**
 * `api_request` carries the token counts of the response: through a gateway the event has no `request_id`, and
 * the provider pairs it with a model call by model, time and tokens (src/contracts/provider.ts).
 */
export type NetworkEvent =
  | {
      kind: "api_request";
      eventId: number;
      sessionId: string;
      ts: number;
      requestId: string | null;
      model: string | null;
      durationMs: number | null;
      querySource: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens: number | null;
      cacheCreationTokens: number | null;
    }
  | { kind: "api_error"; eventId: number; sessionId: string; ts: number; requestId: string | null; statusCode: number | null; error: string; attempt: number | null; durationMs: number | null };

/** The only implementation in the first wave reads `otel_events`; the gateway adapter is the second wave. */
export interface NetworkSource {
  /**
   * Network events of the session not yet applied. `eventId` is the event's identifier at the source. An event
   * without `requestId` is tied to a call by the provider's `matchApiRequests`.
   */
  pending(sessionId: string): NetworkEvent[];
  /** The merge applied these events: the source no longer returns them. */
  markApplied(eventIds: number[]): void;
}

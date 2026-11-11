// Support for the provider tests: assistant lines through the real parser, events and calls with defaults.
import type { AssistantLine } from "../../src/contracts/lines.ts";
import type { ApiRequestEvent, CallCandidate } from "../../src/contracts/provider.ts";
import { parseLine } from "../../src/ingest/parse.ts";
import { text, transcript } from "../support/transcript.ts";

export const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);

/** The parsed assistant lines of one response and the call key the builder reports. */
export function response(options: { gateway?: boolean; requestId?: string } = {}): { lines: AssistantLine[]; key: string } {
  const t = transcript({ sessionId: "s1", gateway: options.gateway });
  const { requestId } = t.assistant({ blocks: [text("a"), text("b")], requestId: options.requestId });
  const lines = t.lines.map((raw) => parseLine(JSON.stringify(raw)).line).filter((line): line is AssistantLine => line.kind === "assistant");
  return { lines, key: requestId };
}

export const event = (eventId: number, fields: Partial<ApiRequestEvent> = {}): ApiRequestEvent => ({
  kind: "api_request",
  eventId,
  sessionId: "s1",
  ts: T0,
  requestId: null,
  model: "align-aws-opus-5-5",
  durationMs: 1000,
  querySource: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  ...fields,
});

export const call = (id: string, fields: Partial<CallCandidate> = {}): CallCandidate => ({
  id,
  model: "claude-align-aws-opus-5-5",
  tsEnd: T0,
  durationExact: false,
  tokInput: 0,
  tokOutput: 0,
  tokCacheRead: 0,
  tokCacheWrite: 0,
  ...fields,
});

/** Event and call counts that agree: the event's `cache_creation_tokens` is 5m + 1h of the call. */
export const tokens = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  event: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheCreationTokens: cacheWrite },
  call: { tokInput: input, tokOutput: output, tokCacheRead: cacheRead, tokCacheWrite: cacheWrite },
});

export const pairs = (matched: Map<number, string>): [number, string][] => [...matched].sort((a, b) => a[0] - b[0]);

// The direct Anthropic API: every assistant line carries the `requestId` of its response, model names are the
// price table's own, and OTel `api_request` events carry the same `request_id`.
import type { Provider } from "../contracts/provider.ts";

export const anthropic: Provider = {
  id: "anthropic",
  callKey: (line) => line.requestId,
  // A dated name (`claude-haiku-4-5-20251001`) is resolved by the price lookup itself (ingest/reduce/cost.ts).
  canonicalModel: (model) => model,
  declaredContextWindow: () => null,
  /**
   * By `request_id` only: an event without one, or naming a call the transcript does not have, stays unmatched.
   * Repeated events about one request (an exporter retry) all pair with its call, as they did before providers
   * existed: the merge applies them in order, the later one wins.
   */
  matchApiRequests(events, calls) {
    const ids = new Set(calls.map((call) => call.id));
    const matched = new Map<number, string>();
    for (const event of events) {
      if (event.requestId !== null && ids.has(event.requestId)) matched.set(event.eventId, event.requestId);
    }
    return matched;
  },
};

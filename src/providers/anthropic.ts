// The direct Anthropic API: every assistant line carries the `requestId` of its response, model names are the
// price table's own, and OTel `api_request` events carry the same `request_id`.
import type { Provider } from "../contracts/provider.ts";

export const anthropic: Provider = {
  id: "anthropic",
  callKey: (line) => line.requestId,
  // A dated name (`claude-haiku-4-5-20251001`) is resolved by the price lookup itself (ingest/reduce/cost.ts).
  canonicalModel: (model) => model,
  declaredContextWindow: () => null,
  /** By `request_id` only: an event without one, or naming a call the transcript does not have, stays unmatched. */
  matchApiRequests(events, calls) {
    const byId = new Map(calls.map((call) => [call.id, call]));
    const taken = new Set<string>();
    const matched = new Map<number, string>();
    for (const event of events) {
      if (event.requestId === null || !byId.has(event.requestId) || taken.has(event.requestId)) continue;
      taken.add(event.requestId);
      matched.set(event.eventId, event.requestId);
    }
    return matched;
  },
};

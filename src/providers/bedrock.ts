// AWS Bedrock and corporate gateways in front of it. Measured on real history: assistant lines
// have no `requestId`, only `message.id` (`msg_bdrk_…`); models are named by the gateway
// (`claude-align-aws-opus-5-5`, `us.anthropic.claude-sonnet-5-5-v1:0`); OTel `api_request` events carry
// neither `request_id` nor `client_request_id`, so they are paired with calls by model, time and tokens.
import { API_REQUEST_MATCH_WINDOW_MS } from "../contracts/constants.ts";
import type { ApiRequestEvent, CallCandidate, Provider } from "../contracts/provider.ts";
import { anthropic } from "./anthropic.ts";

const FAMILIES = new Set(["opus", "sonnet", "haiku", "fable", "mythos"]);

/** Bedrock wrapping of a model id: region, vendor, version, a Vertex-style date. */
const WRAPPING = [/^(us|eu|apac|global)\./, /^anthropic\./, /-v\d+:\d+$/, /@\d{8}$/];

function canonicalModel(model: string): string {
  let name = model.toLowerCase().replace(/\[[^\]]*\]/g, "");
  for (const pattern of WRAPPING) name = name.replace(pattern, "");
  const tokens = name.replace(/[._]/g, "-").split("-");
  const family = tokens.findIndex((token) => FAMILIES.has(token));
  if (family === -1) return model;
  // A vendor infix (`align-aws`) is words; `claude-3-5-sonnet` has the version there and is kept as is.
  const start = tokens[0] === "claude" ? 1 : 0;
  const infix = tokens.slice(start, family);
  const rest = infix.every((token) => /^[a-z]/.test(token)) ? tokens.slice(family) : tokens.slice(start);
  return ["claude", ...rest].join("-");
}

const sameTokens = (event: ApiRequestEvent, call: CallCandidate): boolean =>
  event.inputTokens === call.tokInput &&
  event.outputTokens === call.tokOutput &&
  event.cacheReadTokens === call.tokCacheRead &&
  event.cacheCreationTokens === call.tokCacheWrite;

export const bedrock: Provider = {
  id: "bedrock",
  // A direct-API-shaped line still has its `requestId`: a history that mixes both indexes correctly.
  callKey: (line) => line.requestId ?? line.messageId,
  canonicalModel,
  declaredContextWindow: (model) => (/\[1m\]/i.test(model) ? 1_000_000 : null),
  /**
   * First by `request_id`, as on the direct API. The rest pair with calls whose duration is not exact yet, of
   * the same model, ending within API_REQUEST_MATCH_WINDOW_MS of the event. Equal token counts outrank time,
   * so parallel subagents finishing together on one model are told apart; then the nearest in time; then the
   * input order. A side request the transcript does not have (a title on another model) stays unmatched.
   */
  matchApiRequests(events, calls) {
    const matched = anthropic.matchApiRequests(events, calls);
    const taken = new Set(matched.values());
    const candidates = events.flatMap((event) => {
      if (matched.has(event.eventId) || event.model === null) return [];
      const model = canonicalModel(event.model);
      return calls.flatMap((call) => {
        const gap = Math.abs(call.tsEnd - event.ts);
        if (taken.has(call.id) || call.durationExact || gap > API_REQUEST_MATCH_WINDOW_MS || canonicalModel(call.model) !== model) return [];
        return [{ event, call, rank: sameTokens(event, call) ? 0 : 1, gap }];
      });
    });
    // The sort is stable: at equal rank and distance the input order decides.
    candidates.sort((a, b) => a.rank - b.rank || a.gap - b.gap);
    for (const { event, call } of candidates) {
      if (matched.has(event.eventId) || taken.has(call.id)) continue;
      matched.set(event.eventId, call.id);
      taken.add(call.id);
    }
    return matched;
  },
};

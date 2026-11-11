// API provider plugins: how a provider shapes what Claude Code logs (src/providers/).
// The direct Anthropic API and a gateway in front of it (AWS Bedrock, a corporate proxy) differ in the
// call identifier of transcript lines, the model names and the identifiers of OTel events. The rest of
// torch asks the active provider instead of knowing these differences. The provider is chosen by the
// `provider` key of ~/.torch/config.json.

import type { NetworkEvent } from "./enrich.ts";
import type { AssistantLine } from "./lines.ts";

/** Values of the `provider` key of config.json. */
export const PROVIDER_IDS = ["anthropic", "bedrock"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** The direct API: the behaviour torch had before providers existed. */
export const DEFAULT_PROVIDER: ProviderId = "anthropic";

export type ApiRequestEvent = Extract<NetworkEvent, { kind: "api_request" }>;

/** A model call of the session as the `api_request` matcher sees it. */
export interface CallCandidate {
  /** `model_calls.id`. */
  id: string;
  /** As the provider reported it. */
  model: string;
  tsEnd: number;
  /** The duration is already exact: an event was applied to the call. */
  durationExact: boolean;
  tokInput: number;
  tokOutput: number;
  tokCacheRead: number;
  /** Cache write, 5m + 1h: OTel reports one number. */
  tokCacheWrite: number;
}

/** The whole plugin surface. All functions are pure: no database or file access. */
export interface Provider {
  id: ProviderId;
  /**
   * Key shared by all assistant lines of one API response: `model_calls.id`. null — the line cannot be tied
   * to a call. Never the line `uuid`: one response is several lines with different uuids.
   */
  callKey(line: AssistantLine): string | null;
  /**
   * The name under which the price table knows the reported model. Storage keeps the reported name; this
   * is used only for pricing, the context window and comparing models between sources.
   */
  canonicalModel(model: string): string;
  /** Context window the reported name itself declares (a `[1m]` suffix); null — the price table decides. */
  declaredContextWindow(model: string): number | null;
  /**
   * Pairs `api_request` events with model calls, each event and each call at most once:
   * eventId → `model_calls.id`.
   */
  matchApiRequests(events: ApiRequestEvent[], calls: CallCandidate[]): Map<number, string>;
}

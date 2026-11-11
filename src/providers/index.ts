// Registry of API provider plugins (src/contracts/provider.ts).
// Adding a provider is one file in this directory, one line in PROVIDERS below and one id in PROVIDER_IDS.
import type { Provider, ProviderId } from "../contracts/provider.ts";
import { anthropic } from "./anthropic.ts";
import { bedrock } from "./bedrock.ts";

const PROVIDERS: Record<ProviderId, Provider> = {
  anthropic,
  bedrock,
};

export function providerFor(id: ProviderId): Provider {
  return PROVIDERS[id];
}

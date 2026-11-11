// The provider of tests that do not name one: the direct API, as config.json defaults to.
import { DEFAULT_PROVIDER } from "../../src/contracts/provider.ts";
import { providerFor } from "../../src/providers/index.ts";

export const ANTHROPIC_PROVIDER = providerFor(DEFAULT_PROVIDER);

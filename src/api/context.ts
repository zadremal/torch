// Environment of the API handlers: dependencies arrive through Hono context variables.
import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import type { TorchConfig } from "../config.ts";
import type { ApiError } from "../contracts/api.ts";

export interface ApiDeps {
  db: Database;
  config: TorchConfig;
  /** Current time: replaced in the period and status tests. */
  now: () => number;
}

export type AppEnv = { Variables: ApiDeps };
export type Handler = (c: Context<AppEnv>) => Response | Promise<Response>;

export function notImplemented(c: Context<AppEnv>, pkg: string): Response {
  return c.json<ApiError>({ error: `Not implemented: package ${pkg}` }, 501);
}

export function notFound(c: Context<AppEnv>, what: string): Response {
  return c.json<ApiError>({ error: `Not found: ${what}` }, 404);
}

// OTLP http/json receiver. Package E1.
import type { ApiError } from "../contracts/api.ts";
import type { OtlpLogsRequest } from "../contracts/enrich.ts";
import { parseOtlpLogs, storeOtelEvents } from "../enrich/otlp.ts";
import type { Handler } from "./context.ts";

/** OTLP response to an accepted batch: an empty object, without `partialSuccess`. */
const ACCEPTED = {};

export const postLogs: Handler = async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json<ApiError>({ error: "Request body is not JSON" }, 400);
  }
  if (typeof body !== "object" || body === null) return c.json<ApiError>({ error: "An OTLP log batch is expected" }, 400);
  storeOtelEvents(c.get("db"),parseOtlpLogs(body as OtlpLogsRequest));
  return c.json(ACCEPTED);
};

/** Metrics are accepted and not stored (contracts/enrich.ts). */
export const postMetrics: Handler = (c) => c.json(ACCEPTED);

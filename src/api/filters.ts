// Translation of session filters into SQL: shared by the list and the dashboard, so their numbers agree by
// construction (plan §4.2). This is also where query parameter values are parsed, shared by the handlers
// that take filters. Package A1.
import type { Context } from "hono";
import type { AgentsBucket, ApiError } from "../contracts/api.ts";
import { AGENT_BUCKETS } from "../contracts/constants.ts";
import type { AppEnv } from "./context.ts";

/** Session selection. All fields are optional; a missing field means no condition. */
export interface SessionFilter {
  /** Substring of the session name, case-insensitive. */
  q?: string;
  agents?: AgentsBucket;
  tcMin?: number;
  tcMax?: number;
  erMin?: number;
  erMax?: number;
  /** Total tokens, in thousands. */
  tkMin?: number;
  tkMax?: number;
  project?: string;
  /** true — include sessions from temporary directories. Without the field they are hidden (decision 6). */
  temp?: boolean;
  /** Period by started_at: [from, to), epoch milliseconds. */
  from?: number;
  to?: number;
}

export interface SqlFragment {
  /**
   * Condition for WHERE without the word WHERE; `1` for an empty filter. Columns are written with the table name
   * (`sessions.tool_calls`), so the condition also works in a query with a JOIN, if the sessions table
   * takes part in it without an alias.
   */
  where: string;
  params: (string | number)[];
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");

export function sessionFilterSql(filter: SessionFilter): SqlFragment {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const add = (condition: string, ...values: (string | number)[]) => {
    conditions.push(condition);
    params.push(...values);
  };
  const range = (column: string, min: number | undefined, max: number | undefined, scale = 1) => {
    if (min !== undefined) add(`${column} >= ?`, min * scale);
    if (max !== undefined) add(`${column} <= ?`, max * scale);
  };

  const q = filter.q?.trim();
  // The search goes over name_lower: SQLite compares case-insensitively only Latin letters.
  if (q) add("sessions.name_lower LIKE ? ESCAPE '\\'", `%${escapeLike(q.toLowerCase())}%`);
  if (filter.agents !== undefined) {
    const [min, max] = AGENT_BUCKETS[filter.agents];
    range("sessions.agents_count", min > 0 ? min : undefined, max ?? undefined);
  }
  range("sessions.tool_calls", filter.tcMin, filter.tcMax);
  range("sessions.tool_errors", filter.erMin, filter.erMax);
  range("sessions.tok_total", filter.tkMin, filter.tkMax, 1000);
  if (filter.project !== undefined) add("sessions.project = ?", filter.project);
  if (!filter.temp) add("sessions.is_temp_dir = 0");
  if (filter.from !== undefined) add("sessions.started_at >= ?", filter.from);
  if (filter.to !== undefined) add("sessions.started_at < ?", filter.to);

  return { where: conditions.length > 0 ? conditions.join(" AND ") : "1", params };
}

// ── Query parameter parsing ─────────────────────────────────────────────────────────────────
// An empty string equals a missing parameter: the filter form sends unfilled fields empty.

/** Invalid query parameter value: the handler responds 400. */
export class QueryError extends Error {}

const present = (raw: string | undefined): raw is string => raw !== undefined && raw !== "";

export function textParam(raw: string | undefined): string | undefined {
  return present(raw) ? raw : undefined;
}

/** `true` | `1` | `false` | `0`. */
export function flagParam(name: string, raw: string | undefined): boolean | undefined {
  if (!present(raw)) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new QueryError(`Parameter ${name}: expected true or false, got “${raw}”`);
}

/** Non-negative number in decimal notation, integer part no longer than nine digits. */
export function numberParam(name: string, raw: string | undefined): number | undefined {
  if (!present(raw)) return undefined;
  if (!/^\d{1,9}(\.\d+)?$/.test(raw)) throw new QueryError(`Parameter ${name}: expected a non-negative number, got “${raw}”`);
  return Number(raw);
}

export function enumParam<T extends string>(name: string, raw: string | undefined, allowed: readonly T[]): T | undefined {
  if (!present(raw)) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new QueryError(`Parameter ${name}: expected one of ${allowed.join(", ")}, got “${raw}”`);
  }
  return raw as T;
}

/** 400 response to a QueryError; any other error is rethrown. */
export function badQuery(c: Context<AppEnv>, error: unknown): Response {
  if (!(error instanceof QueryError)) throw error;
  return c.json<ApiError>({ error: error.message }, 400);
}

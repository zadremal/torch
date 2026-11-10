// Dashboard totals, series, leaderboards and tables. Package A3.
//
// All numbers in the response are computed over one set of sessions: those that started in the window and passed the
// filters.ts selection. So the totals equal the sum over the list with the same filters, and the tool
// and model tables break down those same totals. There are no per-day tables (plan §5): each block is one query
// over sessions, model_calls or tool_calls, with no per-session query.
import type { Database } from "bun:sqlite";
import type { DashboardBucket, DashboardRange, DashboardResponse, LeaderboardItem, SeriesPoint } from "../contracts/api.ts";
import { DAY_BUCKET_HOURS, LEADERBOARD_SIZE } from "../contracts/constants.ts";
import type { Handler } from "./context.ts";
import { badQuery, enumParam, flagParam, QueryError, type SessionFilter, sessionFilterSql } from "./filters.ts";

// ── Period window ───────────────────────────────────────────────────────────────────────────
// Boundaries are midnights and first days of the month in the machine's local time (decision 29). Date computes them from
// calendar fields rather than by adding milliseconds of a day: a day with a clock change lasts
// 23 or 25 hours.

const DAY_MS = 86_400_000;
const RANGES: readonly DashboardRange[] = ["day", "week", "month", "year", "custom"];
const DEFAULT_RANGE: DashboardRange = "week";

/** Length of the "up to today" windows in days and months, including today and the current month. */
const WEEK_DAYS = 7;
const MONTH_DAYS = 30;
const YEAR_MONTHS = 12;

/** Start of the local day of moment `ts`, shifted by `days` days and `hours` hours. */
function startOfDay(ts: number, days = 0, hours = 0): number {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, hours).getTime();
}

/** Start of the local month of moment `ts`, shifted by `months` months. */
function startOfMonth(ts: number, months = 0): number {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth() + months, 1).getTime();
}

/** Start of column number `index` in the window that starts at `from`. */
const BUCKET_START: Record<DashboardBucket, (from: number, index: number) => number> = {
  hours: (from, index) => startOfDay(from, 0, index * DAY_BUCKET_HOURS),
  day: (from, index) => startOfDay(from, index),
  month: (from, index) => startOfMonth(from, index),
};

/** Window [from, to) and the column width of its charts. */
interface Period {
  from: number;
  to: number;
  bucket: DashboardBucket;
}

/** Midnight of the local day from a `YYYY-MM-DD` parameter. */
function dateParam(name: string, raw: string | undefined): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw ?? "");
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(year, month - 1, day);
    // Date silently rolls February 31 over to March: such an entry is an error, not another date.
    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) return date.getTime();
  }
  throw new QueryError(`Parameter ${name}: expected a YYYY-MM-DD date, got “${raw ?? ""}”`);
}

/** Windows up to and including today; custom — the days `from` and `to` inclusive. */
function resolvePeriod(range: DashboardRange, raw: Record<string, string>, now: number): Period {
  const tomorrow = startOfDay(now, 1);
  switch (range) {
    case "day":
      return { from: startOfDay(now), to: tomorrow, bucket: "hours" };
    case "week":
      return { from: startOfDay(now, 1 - WEEK_DAYS), to: tomorrow, bucket: "day" };
    case "month":
      return { from: startOfDay(now, 1 - MONTH_DAYS), to: tomorrow, bucket: "day" };
    case "year":
      return { from: startOfMonth(now, 1 - YEAR_MONTHS), to: tomorrow, bucket: "month" };
    case "custom": {
      const from = dateParam("from", raw.from);
      const lastDay = dateParam("to", raw.to);
      if (lastDay < from) throw new QueryError(`Parameter to: date “${raw.to}” is earlier than from “${raw.from}”`);
      return { from, to: startOfDay(lastDay, 1), bucket: "day" };
    }
  }
}

/** Start of the previous window of the same length: the same number of calendar days before `from`. */
const previousFrom = ({ from, to }: Period) => startOfDay(from, -Math.round((to - from) / DAY_MS));

function bucketStarts({ from, to, bucket }: Period): number[] {
  const starts: number[] = [];
  for (let index = 0; ; index++) {
    const start = BUCKET_START[bucket](from, index);
    if (start >= to) return starts;
    starts.push(start);
  }
}

// ── Queries ─────────────────────────────────────────────────────────────────────────────────

type Params = (string | number)[];

/** Cost sums are rounded to cents: adding fractional numbers leaves a tail in the last digits. */
const cents = (usd: number) => Math.round(usd * 100) / 100;

interface TotalsRow {
  sessions: number;
  modelCalls: number;
  toolCalls: number;
  errors: number;
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
  total: number;
}

/** Sums over the selected sessions. An unknown session cost counts as zero in the sum, as in the list. */
function sessionTotals(db: Database, filter: SessionFilter): TotalsRow {
  const { where, params } = sessionFilterSql(filter);
  return db
    .query<TotalsRow, Params>(
      `SELECT COUNT(*) AS sessions,
              COALESCE(SUM(sessions.model_calls), 0) AS modelCalls,
              COALESCE(SUM(sessions.tool_calls), 0) AS toolCalls,
              COALESCE(SUM(sessions.tool_errors), 0) AS errors,
              COALESCE(SUM(sessions.cost_usd), 0) AS costUsd,
              COALESCE(SUM(sessions.tok_input), 0) AS input,
              COALESCE(SUM(sessions.tok_output), 0) AS output,
              COALESCE(SUM(sessions.tok_cache_read), 0) AS cacheRead,
              COALESCE(SUM(sessions.tok_cache_write), 0) AS cacheWrite,
              COALESCE(SUM(sessions.tok_thinking), 0) AS thinking,
              COALESCE(SUM(sessions.tok_total), 0) AS total
       FROM sessions
       WHERE ${where}`,
    )
    .get(...params)!;
}

/** Session column that each leaderboard is built on. */
const TOP_SQL: Record<keyof DashboardResponse["top"], string> = {
  cost: "sessions.cost_usd",
  duration: "sessions.active_ms",
  tokens: "sessions.tok_total",
  toolCalls: "sessions.tool_calls",
  errors: "sessions.tool_errors",
};

/**
 * Selected sessions with the largest column value. A session with zero or no value (unknown
 * cost) does not make the leaderboard: "Most errors" does not list sessions without errors. Equal values
 * go from newest to oldest.
 */
function leaderboard(db: Database, filter: SessionFilter, column: string): LeaderboardItem[] {
  const { where, params } = sessionFilterSql(filter);
  return db
    .query<LeaderboardItem, Params>(
      `SELECT sessions.id AS sessionId, COALESCE(sessions.name, sessions.id) AS name, sessions.project AS project, ${column} AS value
       FROM sessions
       WHERE ${where} AND ${column} > 0
       ORDER BY value DESC, sessions.started_at DESC, sessions.id
       LIMIT ?`,
    )
    .all(...params, LEADERBOARD_SIZE);
}

/**
 * Number of calls of the selected sessions in each column, by call start time. A call outside
 * the window (the session started in the window and continued after it) does not appear on the chart.
 */
function callSeries(db: Database, table: "model_calls" | "tool_calls", filter: SessionFilter, period: Period): SeriesPoint[] {
  const { where, params } = sessionFilterSql(filter);
  const rows = db
    .query<{ ts: number }, Params>(
      `SELECT c.ts_start AS ts
       FROM ${table} c JOIN sessions ON sessions.id = c.session_id
       WHERE ${where} AND c.ts_start >= ? AND c.ts_start < ?
       ORDER BY c.ts_start`,
    )
    .all(...params, period.from, period.to);
  const points = bucketStarts(period).map((start) => ({ start, value: 0 }));
  let index = 0;
  for (const { ts } of rows) {
    while (index + 1 < points.length && points[index + 1]!.start <= ts) index++;
    points[index]!.value++;
  }
  return points;
}

/** Tool calls of the selected sessions by tool name. An error is only the error status (decision 12). */
function toolsTable(db: Database, filter: SessionFilter): DashboardResponse["tools"] {
  const { where, params } = sessionFilterSql(filter);
  return db
    .query<DashboardResponse["tools"][number], Params>(
      `SELECT c.name AS name, COUNT(*) AS calls, SUM(c.status = 'error') AS errors
       FROM tool_calls c JOIN sessions ON sessions.id = c.session_id
       WHERE ${where}
       GROUP BY c.name
       ORDER BY calls DESC, c.name`,
    )
    .all(...params);
}

/**
 * Model calls of the selected sessions by model. Call tokens are added up the same way as in the
 * agent totals (reduce/totals.ts); cost is NULL if it is unknown for at least one call.
 */
function modelsTable(db: Database, filter: SessionFilter): DashboardResponse["models"] {
  const { where, params } = sessionFilterSql(filter);
  return db
    .query<DashboardResponse["models"][number], Params>(
      `SELECT c.model AS model,
              COUNT(*) AS calls,
              SUM(c.tok_input + c.tok_output + c.tok_cache_read + c.tok_cache_write_5m + c.tok_cache_write_1h) AS tokens,
              CASE WHEN COUNT(*) = COUNT(c.cost_usd) THEN SUM(c.cost_usd) END AS costUsd
       FROM model_calls c JOIN sessions ON sessions.id = c.session_id
       WHERE ${where}
       GROUP BY c.model
       ORDER BY calls DESC, c.model`,
    )
    .all(...params)
    .map((row) => ({ ...row, costUsd: row.costUsd === null ? null : cents(row.costUsd) }));
}

// ── Handler ─────────────────────────────────────────────────────────────────────────────────

export const getDashboard: Handler = (c) => {
  const raw = c.req.query();
  let range: DashboardRange;
  let temp: boolean | undefined;
  let period: Period;
  try {
    range = enumParam("range", raw.range, RANGES) ?? DEFAULT_RANGE;
    temp = flagParam("temp", raw.temp);
    period = resolvePeriod(range, raw, c.get("now")());
  } catch (error) {
    return badQuery(c, error);
  }

  const db = c.get("db");
  const { from, to, bucket } = period;
  const prevFrom = previousFrom(period);
  const filter: SessionFilter = { temp, from, to };
  const current = sessionTotals(db, filter);
  const previous = sessionTotals(db, { temp, from: prevFrom, to: from });
  const top = (key: keyof typeof TOP_SQL) => leaderboard(db, filter, TOP_SQL[key]);

  return c.json<DashboardResponse>({
    range,
    from,
    to,
    prevFrom,
    prevTo: from,
    bucket,
    totals: {
      sessions: { value: current.sessions, prev: previous.sessions },
      modelCalls: { value: current.modelCalls, prev: previous.modelCalls },
      toolCalls: { value: current.toolCalls, prev: previous.toolCalls },
      tokens: { value: current.total, prev: previous.total },
      costUsd: { value: cents(current.costUsd), prev: cents(previous.costUsd) },
      errors: { value: current.errors, prev: previous.errors },
    },
    series: {
      modelCalls: callSeries(db, "model_calls", filter, period),
      toolCalls: callSeries(db, "tool_calls", filter, period),
    },
    tokenMix: {
      input: current.input,
      output: current.output,
      cacheRead: current.cacheRead,
      cacheWrite: current.cacheWrite,
      thinking: current.thinking,
      total: current.total,
    },
    top: {
      cost: top("cost"),
      duration: top("duration"),
      tokens: top("tokens"),
      toolCalls: top("toolCalls"),
      errors: top("errors"),
    },
    tools: toolsTable(db, filter),
    models: modelsTable(db, filter),
  });
};

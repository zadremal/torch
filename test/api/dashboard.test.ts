// GET /api/dashboard on a seed database: windows of the five ranges with a fixed "today", totals and
// deltas, chart series, token mix, leaderboards, tool and model tables, temporary directories.
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiError, DashboardResponse, SessionsResponse } from "../../src/contracts/api.ts";
import { DAY_BUCKET_HOURS, LEADERBOARD_SIZE } from "../../src/contracts/constants.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { testApi } from "../support/api.ts";
import { seed } from "../support/seed.ts";

/**
 * A local-time moment. Called inside tests: the block's time zone is already set.
 * Month starts at one; a day and month outside the calendar are rolled over by Date itself.
 */
const at = (year: number, month: number, day: number, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime();

/** The tests' "today": 15 October 2026, 14:30 local time. */
const now = () => at(2026, 10, 15, 14, 30);

/** Time zone for the duration of a block; after the block — the previous one (bun test without TZ runs in UTC). */
function inZone(zone: string): void {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.TZ;
    process.env.TZ = zone;
  });
  afterAll(() => {
    process.env.TZ = saved ?? "UTC";
  });
}

const dashboard = (db: Database, query = "", clock: () => number = now) => testApi(db, clock).get<DashboardResponse>(`/api/dashboard${query}`);
const values = (points: { value: number }[]) => points.map((point) => point.value);
const starts = (points: { start: number }[]) => points.map((point) => point.start);
const ids = (items: { sessionId: string }[]) => items.map((item) => item.sessionId);
const days = (count: number, first: (index: number) => number) => Array.from({ length: count }, (_, index) => first(index));

/** Expected range window: boundaries and column starts. */
interface Expected {
  query: string;
  bucket: DashboardResponse["bucket"];
  from: number;
  to: number;
  prevFrom: number;
  columns: number[];
}

/** Five ranges with "today" 2026-10-15. Functions: local time is computed in the block's time zone. */
const RANGES: Record<string, () => Expected> = {
  day: () => ({
    query: "?range=day",
    bucket: "hours",
    from: at(2026, 10, 15),
    to: at(2026, 10, 16),
    prevFrom: at(2026, 10, 14),
    columns: days(24 / DAY_BUCKET_HOURS, (i) => at(2026, 10, 15, i * DAY_BUCKET_HOURS)),
  }),
  week: () => ({
    query: "?range=week",
    bucket: "day",
    from: at(2026, 10, 9),
    to: at(2026, 10, 16),
    prevFrom: at(2026, 10, 2),
    columns: days(7, (i) => at(2026, 10, 9 + i)),
  }),
  month: () => ({
    query: "?range=month",
    bucket: "day",
    from: at(2026, 9, 16),
    to: at(2026, 10, 16),
    prevFrom: at(2026, 8, 17),
    columns: days(30, (i) => at(2026, 9, 16 + i)),
  }),
  // Twelve months including the current one: November 2025 — 15 October 2026, 349 days; the same number before that.
  year: () => ({
    query: "?range=year",
    bucket: "month",
    from: at(2025, 11, 1),
    to: at(2026, 10, 16),
    prevFrom: at(2024, 11, 17),
    columns: days(12, (i) => at(2025, 11 + i, 1)),
  }),
  custom: () => ({
    query: "?range=custom&from=2026-09-10&to=2026-09-19",
    bucket: "day",
    from: at(2026, 9, 10),
    to: at(2026, 9, 20),
    prevFrom: at(2026, 8, 31),
    columns: days(10, (i) => at(2026, 9, 10 + i)),
  }),
};

describe.each(["UTC", "America/New_York", "Asia/Kolkata"])("range windows in local time, zone %s", (zone) => {
  inZone(zone);

  test.each(Object.keys(RANGES))("%s: window and previous window boundaries, column width and count", async (range) => {
    const expected = RANGES[range]!();
    const body = await dashboard(openMemoryDb(), expected.query);
    expect(body).toMatchObject({ range, bucket: expected.bucket, from: expected.from, to: expected.to, prevFrom: expected.prevFrom, prevTo: expected.from });
    expect(starts(body.series.modelCalls)).toEqual(expected.columns);
    expect(starts(body.series.toolCalls)).toEqual(expected.columns);
  });

  test.each(Object.keys(RANGES))("%s: totals and delta — sessions that started in the window and in the previous window", async (range) => {
    const { query, from, to, prevFrom } = RANGES[range]!();
    const db = openMemoryDb();
    // The numbers are powers of two: the sum shows which sessions went into it.
    seed.session(db, { id: "before-prev", started_at: prevFrom - 1, model_calls: 1, tool_calls: 1, tool_errors: 1, tok_total: 1, cost_usd: 1 });
    seed.session(db, { id: "prev-first", started_at: prevFrom, model_calls: 2, tool_calls: 2, tool_errors: 2, tok_total: 2, cost_usd: 2 });
    seed.session(db, { id: "prev-last", started_at: from - 1, model_calls: 4, tool_calls: 4, tool_errors: 4, tok_total: 4, cost_usd: 4 });
    seed.session(db, { id: "first", started_at: from, model_calls: 8, tool_calls: 8, tool_errors: 8, tok_total: 8, cost_usd: 8 });
    seed.session(db, { id: "last", started_at: to - 1, model_calls: 16, tool_calls: 16, tool_errors: 16, tok_total: 16, cost_usd: 16 });
    seed.session(db, { id: "after", started_at: to, model_calls: 32, tool_calls: 32, tool_errors: 32, tok_total: 32, cost_usd: 32 });

    const { totals, top } = await dashboard(db, query);
    expect(totals).toEqual({
      sessions: { value: 2, prev: 2 },
      modelCalls: { value: 24, prev: 6 },
      toolCalls: { value: 24, prev: 6 },
      tokens: { value: 24, prev: 6 },
      costUsd: { value: 24, prev: 6 },
      errors: { value: 24, prev: 6 },
    });
    expect(ids(top.tokens)).toEqual(["last", "first"]);
  });
});

describe("clock change", () => {
  inZone("America/New_York");

  test("a 25-hour day: twelve columns by local hours, previous window — yesterday's day", async () => {
    // On 1 November 2026 in New York the hour from 01:00 to 02:00 happens twice.
    const body = await dashboard(openMemoryDb(), "?range=day", () => at(2026, 11, 1, 12));
    expect(body.to - body.from).toBe(25 * 3_600_000);
    expect(body).toMatchObject({ from: at(2026, 11, 1), to: at(2026, 11, 2), prevFrom: at(2026, 10, 31), prevTo: at(2026, 11, 1) });
    expect(starts(body.series.modelCalls)).toEqual(days(12, (i) => at(2026, 11, 1, i * DAY_BUCKET_HOURS)));
  });

  test("a 23-hour day: twelve columns, starts ascending", async () => {
    // On 8 March 2026 in New York the hour from 02:00 to 03:00 does not exist.
    const body = await dashboard(openMemoryDb(), "?range=day", () => at(2026, 3, 8, 12));
    expect(body.to - body.from).toBe(23 * 3_600_000);
    const columns = starts(body.series.modelCalls);
    expect(columns).toHaveLength(12);
    expect(columns).toEqual([...new Set(columns)].sort((a, b) => a - b));
  });

  test("a week with a clock change: boundaries of both windows are local midnights", async () => {
    const body = await dashboard(openMemoryDb(), "?range=week", () => at(2026, 11, 3, 9));
    expect(body).toMatchObject({ from: at(2026, 10, 28), to: at(2026, 11, 4), prevFrom: at(2026, 10, 21), prevTo: at(2026, 10, 28) });
    expect(starts(body.series.toolCalls)).toEqual(days(7, (i) => at(2026, 10, 28 + i)));
  });
});

describe("query parameters", () => {
  test("without range — a week; empty parameter values equal their absence", async () => {
    const db = openMemoryDb();
    const body = await dashboard(db);
    expect(body).toMatchObject({ range: "week", from: at(2026, 10, 9), to: at(2026, 10, 16) });
    expect(await dashboard(db, "?range=&from=&to=&temp=")).toEqual(body);
  });

  test("custom of a single day — one day and one column", async () => {
    const body = await dashboard(openMemoryDb(), "?range=custom&from=2026-10-01&to=2026-10-01");
    expect(body).toMatchObject({ from: at(2026, 10, 1), to: at(2026, 10, 2), prevFrom: at(2026, 9, 30), bucket: "day" });
    expect(starts(body.series.modelCalls)).toEqual([at(2026, 10, 1)]);
  });

  test("from and to are read only in custom", async () => {
    const db = openMemoryDb();
    expect(await dashboard(db, "?range=day&from=2026-01-01&to=none")).toEqual(await dashboard(db, "?range=day"));
  });

  test.each([
    ["range=decade", "range"],
    ["temp=maybe", "temp"],
    ["range=custom", "from"],
    ["range=custom&from=2026-10-01", "to"],
    ["range=custom&from=2026-10-1&to=2026-10-31", "from"],
    ["range=custom&from=2026-02-31&to=2026-03-05", "from"],
    ["range=custom&from=2026-10-01&to=31.10.2026", "to"],
    ["range=custom&from=2026-10-02&to=2026-10-01", "to"],
  ])("invalid query %s — 400 naming the parameter", async (query, param) => {
    const response = await testApi(openMemoryDb(), now).request(`/api/dashboard?${query}`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error).toContain(`Parameter ${param}`);
  });

  test("empty database: zeros, empty leaderboards and tables, columns in place", async () => {
    const body = await dashboard(openMemoryDb());
    const zero = { value: 0, prev: 0 };
    expect(body.totals).toEqual({ sessions: zero, modelCalls: zero, toolCalls: zero, tokens: zero, costUsd: zero, errors: zero });
    expect(body.tokenMix).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, total: 0 });
    expect(body.top).toEqual({ cost: [], duration: [], tokens: [], toolCalls: [], errors: [] });
    expect(body.tools).toEqual([]);
    expect(body.models).toEqual([]);
    expect(values(body.series.modelCalls)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(values(body.series.toolCalls)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("totals", () => {
  /** Sessions in the week window, in the previous window and outside the windows; one from a temporary directory, one without cost. */
  function seeded(): Database {
    const db = openMemoryDb();
    const tokens = (input: number, output: number, cacheRead: number, cacheWrite: number, thinking: number) => ({
      tok_input: input,
      tok_output: output,
      tok_cache_read: cacheRead,
      tok_cache_write: cacheWrite,
      tok_thinking: thinking,
      tok_total: input + output + cacheRead + cacheWrite,
    });
    seed.session(db, { id: "a", started_at: at(2026, 10, 9, 8), model_calls: 40, tool_calls: 55, tool_errors: 3, cost_usd: 1.1, ...tokens(100, 50, 1000, 200, 10) });
    seed.session(db, { id: "b", started_at: at(2026, 10, 12, 19), model_calls: 7, tool_calls: 9, tool_errors: 0, cost_usd: 2.2, ...tokens(30, 20, 400, 0, 0) });
    seed.session(db, { id: "unknown-cost", started_at: at(2026, 10, 15, 9), model_calls: 3, tool_calls: 2, tool_errors: 1, cost_usd: null, ...tokens(5, 5, 0, 60, 2) });
    seed.session(db, { id: "temp", cwd: "/private/var/folders/zz/T/x", is_temp_dir: 1, started_at: at(2026, 10, 14, 10), model_calls: 500, tool_calls: 600, tool_errors: 70, cost_usd: 80, ...tokens(9000, 0, 0, 0, 0) });
    seed.session(db, { id: "prev", started_at: at(2026, 10, 5, 10), model_calls: 11, tool_calls: 13, tool_errors: 2, cost_usd: 0.7, ...tokens(1, 1, 1, 1, 1) });
    seed.session(db, { id: "old", started_at: at(2026, 8, 1, 10), model_calls: 999, tool_calls: 999, tool_errors: 999, cost_usd: 999, ...tokens(999, 999, 999, 999, 999) });
    seed.session(db, { id: "no-start", started_at: null, model_calls: 999, tool_calls: 999 });
    return db;
  }

  test("totals of the window and previous window; an unknown cost counts as zero in the sum", async () => {
    const { totals } = await dashboard(seeded());
    expect(totals).toEqual({
      sessions: { value: 3, prev: 1 },
      modelCalls: { value: 50, prev: 11 },
      toolCalls: { value: 66, prev: 13 },
      tokens: { value: 1870, prev: 4 },
      costUsd: { value: 3.3, prev: 0.7 },
      errors: { value: 4, prev: 2 },
    });
  });

  test("token mix — sums of token kinds over the window's sessions", async () => {
    expect((await dashboard(seeded())).tokenMix).toEqual({ input: 135, output: 75, cacheRead: 1400, cacheWrite: 260, thinking: 12, total: 1870 });
  });

  test.each(["", "&temp=true", "&temp=false"])("totals equal the sum over the session list with the same filters (%s)", async (temp) => {
    const db = seeded();
    const { from, to, totals } = await dashboard(db, `?range=week${temp}`);
    const list = await testApi(db).get<SessionsResponse>(`/api/sessions?${temp}`);
    const inWindow = list.items.filter((item) => item.startedAt !== null && item.startedAt >= from && item.startedAt < to);
    const sum = (value: (item: (typeof inWindow)[number]) => number) => inWindow.reduce((total, item) => total + value(item), 0);

    expect(totals.sessions.value).toBe(inWindow.length);
    expect(totals.toolCalls.value).toBe(sum((item) => item.toolCalls));
    expect(totals.errors.value).toBe(sum((item) => item.errors));
    expect(totals.tokens.value).toBe(sum((item) => item.tokens));
    expect(totals.costUsd.value).toBeCloseTo(sum((item) => item.costUsd ?? 0), 2);
    // The list row has no model calls: compare directly with the sessions column.
    const { n } = db
      .query<{ n: number }, [number, number, number]>("SELECT SUM(model_calls) AS n FROM sessions WHERE started_at >= ? AND started_at < ? AND is_temp_dir <= ?")
      .get(from, to, temp === "&temp=true" ? 1 : 0)!;
    expect(totals.modelCalls.value).toBe(n);
  });

  test("the cost sum is rounded to cents", async () => {
    const db = openMemoryDb();
    for (const [id, cost] of [["x", 0.1], ["y", 0.2], ["z", 1.004]] as const) seed.session(db, { id, started_at: at(2026, 10, 15, 9), cost_usd: cost });
    expect((await dashboard(db, "?range=day")).totals.costUsd.value).toBe(1.3);
  });
});

describe("leaderboards", () => {
  test("each leaderboard is ordered by its own column and no longer than LEADERBOARD_SIZE", async () => {
    const db = openMemoryDb();
    // Each column has its own session order: a mixed-up column gives a different leaderboard.
    const rows: [string, number, number, number, number, number][] = [
      ["s1", 7, 100, 60, 5, 1],
      ["s2", 6, 700, 50, 4, 2],
      ["s3", 5, 600, 10, 3, 3],
      ["s4", 4, 500, 20, 70, 4],
      ["s5", 3, 400, 30, 60, 5],
      ["s6", 2, 300, 40, 50, 6],
      ["s7", 1, 200, 70, 40, 7],
    ];
    for (const [id, cost, activeMs, tokens, toolCalls, errors] of rows) {
      seed.session(db, { id, name: `Name ${id}`, project: `p-${id}`, started_at: at(2026, 10, 12), cost_usd: cost, active_ms: activeMs, tok_total: tokens, tool_calls: toolCalls, tool_errors: errors });
    }
    const { top } = await dashboard(db);
    expect(LEADERBOARD_SIZE).toBe(5);
    expect(ids(top.cost)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(ids(top.duration)).toEqual(["s2", "s3", "s4", "s5", "s6"]);
    expect(ids(top.tokens)).toEqual(["s7", "s1", "s2", "s6", "s5"]);
    expect(ids(top.toolCalls)).toEqual(["s4", "s5", "s6", "s7", "s1"]);
    expect(ids(top.errors)).toEqual(["s7", "s6", "s5", "s4", "s3"]);
    expect(top.cost[0]).toEqual({ sessionId: "s1", name: "Name s1", project: "p-s1", value: 7 });
    expect(top.duration[0]).toEqual({ sessionId: "s2", name: "Name s2", project: "p-s2", value: 700 });
  });

  test("a session with zero or no value does not make the leaderboard", async () => {
    const db = openMemoryDb();
    seed.session(db, { id: "clean", started_at: at(2026, 10, 12), tool_errors: 0, tool_calls: 0, cost_usd: null, active_ms: 0, tok_total: 0 });
    seed.session(db, { id: "busy", started_at: at(2026, 10, 13), tool_errors: 2, tool_calls: 9, cost_usd: 0.4, active_ms: 5000, tok_total: 800 });
    const { top } = await dashboard(db);
    for (const board of Object.values(top)) expect(ids(board)).toEqual(["busy"]);
  });

  test("equal values go from newest to oldest; a session without a name is named by its id", async () => {
    const db = openMemoryDb();
    seed.session(db, { id: "older", started_at: at(2026, 10, 10), tool_calls: 5 });
    seed.session(db, { id: "newer", name: null, project: null, started_at: at(2026, 10, 14), tool_calls: 5 });
    expect((await dashboard(db)).top.toolCalls).toEqual([
      { sessionId: "newer", name: "newer", project: null, value: 5 },
      { sessionId: "older", name: "Session older", project: "example", value: 5 },
    ]);
  });

  test("only the window's sessions are in the leaderboards", async () => {
    const db = openMemoryDb();
    seed.session(db, { id: "in", started_at: at(2026, 10, 12), tok_total: 10 });
    seed.session(db, { id: "prev", started_at: at(2026, 10, 5), tok_total: 1000 });
    expect(ids((await dashboard(db)).top.tokens)).toEqual(["in"]);
  });
});

describe("chart series", () => {
  test("day: calls are spread over two-hour columns by call start time", async () => {
    const db = openMemoryDb();
    seed.session(db, { id: "s", started_at: at(2026, 10, 15) });
    const modelAt = [at(2026, 10, 15, 0, 0), at(2026, 10, 15, 1, 59), at(2026, 10, 15, 2, 0), at(2026, 10, 15, 13, 10), at(2026, 10, 15, 23, 59)];
    modelAt.forEach((ts, i) => seed.modelCall(db, { session_id: "s", id: `m${i}`, ts_start: ts }));
    const toolAt = [at(2026, 10, 15, 3, 59), at(2026, 10, 15, 4, 0), at(2026, 10, 15, 22, 0)];
    toolAt.forEach((ts, i) => seed.toolCall(db, { session_id: "s", id: `t${i}`, ts_start: ts }));

    const { series } = await dashboard(db, "?range=day");
    expect(values(series.modelCalls)).toEqual([2, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(values(series.toolCalls)).toEqual([0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  test("week: a session spanning several days gives calls in the columns of its days", async () => {
    const db = openMemoryDb();
    seed.session(db, { id: "s", started_at: at(2026, 10, 9, 22) });
    [at(2026, 10, 9, 22, 5), at(2026, 10, 9, 23, 59), at(2026, 10, 10, 0, 0), at(2026, 10, 15, 14, 0)].forEach((ts, i) => seed.modelCall(db, { session_id: "s", id: `m${i}`, ts_start: ts }));
    [at(2026, 10, 11, 12), at(2026, 10, 11, 13)].forEach((ts, i) => seed.toolCall(db, { session_id: "s", id: `t${i}`, ts_start: ts }));

    const { series } = await dashboard(db, "?range=week");
    expect(values(series.modelCalls)).toEqual([2, 1, 0, 0, 0, 0, 1]);
    expect(values(series.toolCalls)).toEqual([0, 0, 2, 0, 0, 0, 0]);
  });

  test("year: columns are calendar months", async () => {
    const db = openMemoryDb();
    seed.session(db, { id: "s", started_at: at(2025, 11, 30, 23) });
    [at(2025, 11, 30, 23, 30), at(2025, 12, 1, 0, 0), at(2026, 2, 28, 12), at(2026, 10, 15, 10)].forEach((ts, i) => seed.modelCall(db, { session_id: "s", id: `m${i}`, ts_start: ts }));
    expect(values((await dashboard(db, "?range=year")).series.modelCalls)).toEqual([1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  test("the chart has only calls of the window's sessions and only inside the window", async () => {
    const db = openMemoryDb();
    // Started before the window and continued in it: its calls belong to the previous window entirely.
    seed.session(db, { id: "earlier", started_at: at(2026, 9, 9, 23) });
    seed.modelCall(db, { session_id: "earlier", id: "m", ts_start: at(2026, 9, 10, 1) });
    seed.toolCall(db, { session_id: "earlier", id: "t", ts_start: at(2026, 9, 10, 1) });
    // Started on the last day of the window and continued after it: a call beyond the window has no column.
    seed.session(db, { id: "late", started_at: at(2026, 9, 19, 23) });
    seed.modelCall(db, { session_id: "late", id: "m1", ts_start: at(2026, 9, 19, 23, 30) });
    seed.modelCall(db, { session_id: "late", id: "m2", ts_start: at(2026, 9, 20, 0, 30) });
    seed.toolCall(db, { session_id: "late", id: "t1", ts_start: at(2026, 9, 19, 23, 40) });
    seed.toolCall(db, { session_id: "late", id: "t2", ts_start: at(2026, 9, 20, 0, 40) });

    const { series } = await dashboard(db, "?range=custom&from=2026-09-10&to=2026-09-19");
    expect(values(series.modelCalls)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(values(series.toolCalls)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });
});

describe("tool and model tables", () => {
  function seeded(): Database {
    const db = openMemoryDb();
    seed.session(db, { id: "a", started_at: at(2026, 10, 12) });
    seed.session(db, { id: "b", started_at: at(2026, 10, 14) });
    seed.session(db, { id: "prev", started_at: at(2026, 10, 5) });
    const tools: [string, string, string, "ok" | "error" | "denied" | "interrupted" | "pending"][] = [
      ["a", "t1", "Read", "ok"],
      ["a", "t2", "Read", "error"],
      ["b", "t3", "Read", "ok"],
      ["a", "t4", "Bash", "error"],
      ["b", "t5", "Bash", "denied"],
      ["b", "t6", "Bash", "interrupted"],
      ["b", "t7", "Edit", "pending"],
      ["a", "t8", "Agent", "ok"],
      ["prev", "t9", "Glob", "error"],
    ];
    for (const [session_id, id, name, status] of tools) seed.toolCall(db, { session_id, id, name, status, ts_start: at(2026, 10, 14, 1) });
    const calls: [string, string, string, number, number | null][] = [
      ["a", "m1", "claude-opus-5-5", 1000, 0.101],
      ["b", "m2", "claude-opus-5-5", 2000, 0.202],
      ["b", "m3", "claude-opus-5-5", 3000, 0.303],
      ["a", "m4", "claude-sonnet-4-5", 500, 0.05],
      ["a", "m5", "mystery-model", 70, null],
      ["b", "m6", "mystery-model", 30, null],
      ["prev", "m7", "claude-haiku-4-5", 9999, 9],
    ];
    for (const [session_id, id, model, input, cost] of calls) {
      seed.modelCall(db, { session_id, id, model, ts_start: at(2026, 10, 14, 1), tok_input: input, tok_output: 1, tok_cache_read: 2, tok_cache_write_5m: 3, tok_cache_write_1h: 4, tok_thinking: 100, cost_usd: cost });
    }
    return db;
  }

  test("tools: calls of the window's sessions by descending count, ties by name; an error is only the error status", async () => {
    expect((await dashboard(seeded())).tools).toEqual([
      { name: "Bash", calls: 3, errors: 1 },
      { name: "Read", calls: 3, errors: 1 },
      { name: "Agent", calls: 1, errors: 0 },
      { name: "Edit", calls: 1, errors: 0 },
    ]);
  });

  test("models: calls, tokens without thinking and cost; an unknown model has cost null", async () => {
    expect((await dashboard(seeded())).models).toEqual([
      { model: "claude-opus-5-5", calls: 3, tokens: 6030, costUsd: 0.61 },
      { model: "mystery-model", calls: 2, tokens: 120, costUsd: null },
      { model: "claude-sonnet-4-5", calls: 1, tokens: 510, costUsd: 0.05 },
    ]);
  });

  test("model cost is null if it is unknown for at least one call", async () => {
    const db = openMemoryDb();
    seed.session(db, { id: "s", started_at: at(2026, 10, 12) });
    seed.modelCall(db, { session_id: "s", id: "m1", model: "m", cost_usd: 1 });
    seed.modelCall(db, { session_id: "s", id: "m2", model: "m", cost_usd: null });
    expect((await dashboard(db)).models).toEqual([{ model: "m", calls: 2, tokens: 0, costUsd: null }]);
  });
});

describe("temporary directories", () => {
  function seeded(): Database {
    const db = openMemoryDb();
    seed.session(db, { id: "work", started_at: at(2026, 10, 12), model_calls: 1, tool_calls: 1, tool_errors: 0, tok_input: 10, tok_total: 10, cost_usd: 1 });
    seed.modelCall(db, { session_id: "work", id: "m", model: "claude-opus-5-5", ts_start: at(2026, 10, 12, 1), tok_input: 10 });
    seed.toolCall(db, { session_id: "work", id: "t", name: "Read", ts_start: at(2026, 10, 12, 1) });
    seed.session(db, { id: "scratch", cwd: "/private/tmp/scratch", is_temp_dir: 1, started_at: at(2026, 10, 13), model_calls: 2, tool_calls: 2, tool_errors: 1, tok_input: 50, tok_total: 50, cost_usd: 5 });
    for (const n of [1, 2]) {
      seed.modelCall(db, { session_id: "scratch", id: `m${n}`, model: "claude-haiku-4-5", ts_start: at(2026, 10, 13, n), tok_input: 25 });
      seed.toolCall(db, { session_id: "scratch", id: `t${n}`, name: "Bash", status: n === 1 ? "error" : "ok", ts_start: at(2026, 10, 13, n) });
    }
    seed.session(db, { id: "scratch-prev", cwd: "/private/tmp/older", is_temp_dir: 1, started_at: at(2026, 10, 5), model_calls: 4, tool_calls: 4, tok_total: 4, cost_usd: 4 });
    return db;
  }

  test.each(["", "&temp=false"])("excluded by default from totals, series, leaderboards and tables (%s)", async (temp) => {
    const body = await dashboard(seeded(), `?range=week${temp}`);
    expect(body.totals).toEqual({
      sessions: { value: 1, prev: 0 },
      modelCalls: { value: 1, prev: 0 },
      toolCalls: { value: 1, prev: 0 },
      tokens: { value: 10, prev: 0 },
      costUsd: { value: 1, prev: 0 },
      errors: { value: 0, prev: 0 },
    });
    expect(body.tokenMix.total).toBe(10);
    expect(values(body.series.modelCalls)).toEqual([0, 0, 0, 1, 0, 0, 0]);
    expect(values(body.series.toolCalls)).toEqual([0, 0, 0, 1, 0, 0, 0]);
    expect(ids(body.top.cost)).toEqual(["work"]);
    expect(body.top.errors).toEqual([]);
    expect(body.tools).toEqual([{ name: "Read", calls: 1, errors: 0 }]);
    expect(body.models).toEqual([{ model: "claude-opus-5-5", calls: 1, tokens: 10, costUsd: 0 }]);
  });

  test("temp=true includes them in every block of the response", async () => {
    const body = await dashboard(seeded(), "?range=week&temp=true");
    expect(body.totals).toEqual({
      sessions: { value: 2, prev: 1 },
      modelCalls: { value: 3, prev: 4 },
      toolCalls: { value: 3, prev: 4 },
      tokens: { value: 60, prev: 4 },
      costUsd: { value: 6, prev: 4 },
      errors: { value: 1, prev: 0 },
    });
    expect(body.tokenMix.total).toBe(60);
    expect(values(body.series.modelCalls)).toEqual([0, 0, 0, 1, 2, 0, 0]);
    expect(values(body.series.toolCalls)).toEqual([0, 0, 0, 1, 2, 0, 0]);
    expect(ids(body.top.cost)).toEqual(["scratch", "work"]);
    expect(ids(body.top.errors)).toEqual(["scratch"]);
    expect(body.tools).toEqual([
      { name: "Bash", calls: 2, errors: 1 },
      { name: "Read", calls: 1, errors: 0 },
    ]);
    expect(body.models).toEqual([
      { model: "claude-haiku-4-5", calls: 2, tokens: 50, costUsd: 0 },
      { model: "claude-opus-5-5", calls: 1, tokens: 10, costUsd: 0 },
    ]);
  });
});

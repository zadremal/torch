// Dashboard page logic (W6) on the test/fixtures/dto responses: deltas, window and bar labels,
// error-rate highlighting, leaderboard and table rows.
import { describe, expect, test } from "bun:test";
import type { DashboardRange, DashboardResponse } from "../../src/contracts/api.ts";
import { LEADERBOARD_SIZE } from "../../src/contracts/constants.ts";
import { formatBucket } from "../../web/src/lib/format.ts";
import {
  BOARDS,
  NO_PREVIOUS,
  cacheHitRate,
  countDelta,
  errorRate,
  formatWindow,
  isHighErrorRate,
  leaderboardRows,
  modelRows,
  percentDelta,
  toolRows,
  totalTiles,
} from "../../web/src/pages/dashboard/model.ts";
import custom from "../fixtures/dto/dashboard.custom.json";
import day from "../fixtures/dto/dashboard.day.json";
import month from "../fixtures/dto/dashboard.month.json";
import week from "../fixtures/dto/dashboard.week.json";
import year from "../fixtures/dto/dashboard.year.json";

const dto = { day, week, month, year, custom } as unknown as Record<DashboardRange, DashboardResponse>;
const ranges = Object.keys(dto) as DashboardRange[];

describe("delta against the previous window", () => {
  test("percentDelta: sign, rounding, zero", () => {
    expect(percentDelta({ value: 114, prev: 100 })).toBe("+14%");
    expect(percentDelta({ value: 96, prev: 100 })).toBe("−4%");
    expect(percentDelta({ value: 100, prev: 100 })).toBe("0%");
    expect(percentDelta({ value: 1004, prev: 1000 })).toBe("0%");
    expect(percentDelta({ value: 0, prev: 50 })).toBe("−100%");
  });

  test("percentDelta: zero in the previous window means no percentage", () => {
    expect(percentDelta({ value: 12, prev: 0 })).toBeNull();
    expect(percentDelta({ value: 0, prev: 0 })).toBeNull();
  });

  test("countDelta: signed counts", () => {
    expect(countDelta({ value: 5, prev: 2 })).toBe("+3");
    expect(countDelta({ value: 5, prev: 7 })).toBe("−2");
    expect(countDelta({ value: 5, prev: 5 })).toBe("0");
  });
});

describe("summary tiles", () => {
  test("six tiles in artboard order on every range", () => {
    for (const range of ranges) {
      expect(totalTiles(dto[range].totals).map((t) => t.label)).toEqual([
        "Sessions",
        "Model calls",
        "Tool calls",
        "Total tokens",
        "Cost",
        "Errors",
      ]);
    }
  });

  test("day: values and deltas from the response", () => {
    const tiles = totalTiles(day.totals);
    expect(tiles[0]).toMatchObject({ value: "2", helper: "−1 vs previous period" });
    expect(tiles[1]).toMatchObject({ value: "193", helper: "−51% vs previous period" });
    expect(tiles[3]).toMatchObject({ value: "10.15M", helper: "+59% vs previous period" });
    expect(tiles[4]).toMatchObject({ value: "$12.58" });
    expect(tiles[5]).toMatchObject({ value: "10", helper: "4.0% of tool calls · −10", error: true });
  });

  test("custom: zero in the previous window gives a note about it, no delta", () => {
    const tiles = totalTiles(custom.totals);
    for (const tile of tiles.slice(0, 5)) expect(tile.helper).toBe(NO_PREVIOUS);
    expect(tiles[5]?.helper).toBe("3.6% of tool calls");
  });

  test("the Errors tile without errors is not flagged", () => {
    const totals = { ...day.totals, errors: { value: 0, prev: 0 }, toolCalls: { value: 0, prev: 0 } };
    expect(totalTiles(totals)[5]).toMatchObject({ value: "0", helper: "0.0% of tool calls", error: false });
  });
});

describe("labels", () => {
  test("bar labels by bar kind", () => {
    expect(day.bucket).toBe("hours");
    expect(week.bucket).toBe("day");
    expect(year.bucket).toBe("month");
    const at = (y: number, m: number, d: number, h = 0) => new Date(y, m, d, h).getTime();
    expect(formatBucket(at(2026, 9, 31, 14), "hours")).toBe("14:00");
    expect(formatBucket(at(2026, 9, 25), "day")).toBe("Oct 25");
    expect(formatBucket(at(2025, 10, 1), "month")).toBe("Nov 2025");
  });

  test("window: one day, a range of days, months, Custom", () => {
    const at = (y: number, m: number, d: number) => new Date(y, m, d).getTime();
    expect(formatWindow({ range: "day", bucket: "hours", from: at(2026, 9, 31), to: at(2026, 10, 1) })).toBe(
      "Oct 31, 2026",
    );
    expect(formatWindow({ range: "week", bucket: "day", from: at(2026, 9, 25), to: at(2026, 10, 1) })).toBe(
      "Oct 25 – Oct 31, 2026",
    );
    expect(formatWindow({ range: "year", bucket: "month", from: at(2025, 10, 1), to: at(2026, 10, 1) })).toBe(
      "Nov 2025 – Oct 2026",
    );
    expect(formatWindow({ range: "custom", bucket: "day", from: at(2026, 9, 1), to: at(2026, 10, 1) })).toBe(
      "Oct 1 – Oct 31, 2026 (custom)",
    );
    expect(formatWindow({ range: "week", bucket: "day", from: at(2025, 11, 28), to: at(2026, 0, 4) })).toBe(
      "Dec 28, 2025 – Jan 3, 2026",
    );
  });

  test("window from the response: a label exists for all five ranges", () => {
    for (const range of ranges) expect(formatWindow(dto[range]).length).toBeGreaterThan(0);
    expect(formatWindow(custom as unknown as DashboardResponse)).toEndWith("(custom)");
  });
});

describe("error rate", () => {
  test("highlighted strictly above 5%", () => {
    expect(isHighErrorRate(0.05)).toBe(false);
    expect(isHighErrorRate(0.0501)).toBe(true);
    expect(isHighErrorRate(0)).toBe(false);
  });

  test("errorRate: without calls it is 0", () => {
    expect(errorRate(0, 0)).toBe(0);
    expect(errorRate(5, 100)).toBe(0.05);
  });

  test("tool rows: highlight by threshold, share and bar", () => {
    const rows = toolRows([
      { name: "Read", calls: 100, errors: 5 },
      { name: "Bash", calls: 50, errors: 5 },
      { name: "Glob", calls: 0, errors: 0 },
    ]);
    expect(rows.map((r) => r.rate)).toEqual(["5.0%", "10.0%", "0.0%"]);
    expect(rows.map((r) => r.highRate)).toEqual([false, true, false]);
    expect(rows.map((r) => r.callsRatio)).toEqual([1, 0.5, 0]);
  });

  test("tools on the data: exactly those with a share above the threshold are highlighted", () => {
    for (const range of ranges) {
      const rows = toolRows(dto[range].tools);
      expect(rows.map((r) => r.highRate)).toEqual(dto[range].tools.map((t) => t.errors / t.calls > 0.05));
    }
    expect(toolRows(week.tools).some((r) => r.highRate)).toBe(true);
  });
});

describe("leaderboards", () => {
  test("five leaderboards in artboard order, no longer than LEADERBOARD_SIZE", () => {
    expect(BOARDS.map((b) => b.title)).toEqual([
      "Most expensive sessions",
      "Longest sessions",
      "Most tokens used",
      "Most tool calls",
      "Most errors",
    ]);
    for (const range of ranges) {
      for (const board of BOARDS) {
        expect(dto[range].top[board.key].length).toBeLessThanOrEqual(LEADERBOARD_SIZE);
      }
    }
  });

  test("row: rank, name, short id with the project, value, link to the session overview", () => {
    const [first] = leaderboardRows(
      [{ sessionId: "8f3c1a2e-61b0-4c7e-9d2a-000000000142", name: "Migrate", project: "billing-web", value: 18.42 }],
      BOARDS[0]!.format,
    );
    expect(first).toEqual({
      rank: 1,
      name: "Migrate",
      meta: "8f3c1a2e · billing-web",
      value: "$18.42",
      href: "/sessions/8f3c1a2e-61b0-4c7e-9d2a-000000000142",
    });
  });

  test("session without a project: meta holds only the id", () => {
    const [row] = leaderboardRows([{ sessionId: "abcdef012345", name: "x", project: null, value: 3 }], BOARDS[4]!.format);
    expect(row?.meta).toBe("abcdef01");
  });

  test("values are formatted by the kind of metric", () => {
    const item = { sessionId: "s", name: "n", project: null, value: 668000 };
    const byKey = Object.fromEntries(BOARDS.map((b) => [b.key, leaderboardRows([item], b.format)[0]?.value]));
    expect(byKey).toEqual({
      cost: "$668,000.00",
      duration: "11m 08s",
      tokens: "668.0K",
      toolCalls: "668.0K",
      errors: "668.0K",
    });
  });

  test("leaderboards on the data: links lead to the session overview, ranks are consecutive", () => {
    for (const range of ranges) {
      for (const board of BOARDS) {
        const rows = leaderboardRows(dto[range].top[board.key], board.format);
        expect(rows.map((r) => r.rank)).toEqual(rows.map((_, i) => i + 1));
        for (const row of rows) expect(row.href).toMatch(/^\/sessions\/[^/]+$/);
      }
    }
  });
});

describe("tables", () => {
  test("models: the cost of an unknown model is a dash", () => {
    expect(
      modelRows([
        { model: "claude-opus-5-5", calls: 1383, tokens: 26635274, costUsd: 216.27 },
        { model: "mystery", calls: 3, tokens: 900, costUsd: null },
      ]),
    ).toEqual([
      { model: "claude-opus-5-5", calls: "1,383", tokens: "26.64M", cost: "$216.27" },
      { model: "mystery", calls: "3", tokens: "900", cost: "—" },
    ]);
  });

  test("tables are built on every range, one row per response element", () => {
    for (const range of ranges) {
      expect(toolRows(dto[range].tools)).toHaveLength(dto[range].tools.length);
      expect(modelRows(dto[range].models)).toHaveLength(dto[range].models.length);
    }
  });
});

describe("Token mix", () => {
  test("cacheHitRate: cache reads among input, cache reads and cache writes", () => {
    expect(cacheHitRate({ input: 8, output: 5, cacheRead: 79, cacheWrite: 8, thinking: 0, total: 100 })).toBeCloseTo(
      79 / 95,
    );
    expect(cacheHitRate({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0, total: 5 })).toBeNull();
  });
});

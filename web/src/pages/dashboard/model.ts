// Dashboard page logic: pure functions from the API response to what the screen shows (plan §9.3).
// The server computes all the numbers; here only formatting: deltas, window labels, rows of tops and tables.
import type { DashboardResponse, LeaderboardItem, Metric, TokenTotals } from "@contracts/api.ts";
import { ERROR_RATE_HIGHLIGHT } from "@contracts/constants.ts";
import {
  formatBucket,
  formatCount,
  formatDuration,
  formatMoney,
  formatPercent,
  formatTokens,
} from "../../lib/format.ts";
import { sessionHref } from "../../lib/routes.ts";

const MINUS = "−";

/** Caption under a value when the previous window has nothing and there is nothing to compute a delta from. */
export const NO_PREVIOUS = "No data in previous period";

/** Sign and magnitude: "+14%", "−4%"; zero has no sign. */
function signed(amount: number, suffix = ""): string {
  if (amount === 0) return `0${suffix}`;
  return `${amount > 0 ? "+" : MINUS}${Math.abs(amount)}${suffix}`;
}

/**
  * Delta against the previous window in percent: "+14%", "−4%", "0%".
  * null if the previous window is zero: a percentage of zero is undefined.
 */
export function percentDelta(metric: Metric): string | null {
  if (metric.prev === 0) return null;
  return signed(Math.round(((metric.value - metric.prev) / metric.prev) * 100), "%");
}

/** Delta in units: "+3", "−2", "0". For counters where percentages say little (Sessions, Errors). */
export function countDelta(metric: Metric): string {
  return signed(metric.value - metric.prev);
}

/** Share of errors among tool calls; with no calls, 0. */
export function errorRate(errors: number, calls: number): number {
  return calls === 0 ? 0 : errors / calls;
}

/** A share above the threshold is highlighted with the error color (plan §9.3, ERROR_RATE_HIGHLIGHT). */
export function isHighErrorRate(rate: number): boolean {
  return rate > ERROR_RATE_HIGHLIGHT;
}

/** Share of cache reads in all input: input, cache read and cache write. null — there is no input. */
export function cacheHitRate(tokens: TokenTotals): number | null {
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return input === 0 ? null : tokens.cacheRead / input;
}

export interface TileModel {
  label: string;
  value: string;
  helper: string;
  error?: boolean;
}

/** Six totals tiles in artboard order. */
export function totalTiles(totals: DashboardResponse["totals"]): TileModel[] {
  const vsPrevious = (metric: Metric) => {
    const delta = percentDelta(metric);
    return delta === null ? NO_PREVIOUS : `${delta} vs previous period`;
  };
  const rate = formatPercent(errorRate(totals.errors.value, totals.toolCalls.value), 1);
  return [
    {
      label: "Sessions",
      value: formatCount(totals.sessions.value),
      helper: totals.sessions.prev === 0 ? NO_PREVIOUS : `${countDelta(totals.sessions)} vs previous period`,
    },
    { label: "Model calls", value: formatCount(totals.modelCalls.value), helper: vsPrevious(totals.modelCalls) },
    { label: "Tool calls", value: formatCount(totals.toolCalls.value), helper: vsPrevious(totals.toolCalls) },
    { label: "Total tokens", value: formatTokens(totals.tokens.value), helper: vsPrevious(totals.tokens) },
    { label: "Cost", value: formatMoney(totals.costUsd.value), helper: vsPrevious(totals.costUsd) },
    {
      label: "Errors",
      value: formatCount(totals.errors.value),
      helper: `${rate} of tool calls${totals.errors.prev === 0 ? "" : ` · ${countDelta(totals.errors)}`}`,
      error: totals.errors.value > 0,
    },
  ];
}

/** Window date: the day of the "Oct 25" bar with the year "Oct 25, 2026". */
function dateWithYear(ts: number): string {
  return `${formatBucket(ts, "day")}, ${new Date(ts).getFullYear()}`;
}

/**
  * Window caption under the heading: "Oct 31, 2026", "Oct 25 – Oct 31, 2026", "Nov 2025 – Oct 2026".
  * The window is [from, to) in local time: the last day is a millisecond before `to`.
 */
export function formatWindow(d: Pick<DashboardResponse, "range" | "from" | "to" | "bucket">): string {
  const last = d.to - 1;
  let text: string;
  if (d.bucket === "hours") {
    text = dateWithYear(d.from);
  } else if (d.bucket === "month") {
    text = `${formatBucket(d.from, "month")} – ${formatBucket(last, "month")}`;
  } else if (new Date(d.from).getFullYear() === new Date(last).getFullYear()) {
    text = `${formatBucket(d.from, "day")} – ${dateWithYear(last)}`;
  } else {
    text = `${dateWithYear(d.from)} – ${dateWithYear(last)}`;
  }
  return d.range === "custom" ? `${text} (custom)` : text;
}

export type BoardKey = keyof DashboardResponse["top"];

interface BoardSpec {
  key: BoardKey;
  title: string;
  metric: string;
  format: (value: number) => string;
}

/** Five tops in artboard order. */
export const BOARDS: readonly BoardSpec[] = [
  { key: "cost", title: "Most expensive sessions", metric: "Cost", format: formatMoney },
  { key: "duration", title: "Longest sessions", metric: "Duration", format: formatDuration },
  { key: "tokens", title: "Most tokens used", metric: "Tokens", format: formatTokens },
  { key: "toolCalls", title: "Most tool calls", metric: "Tool calls", format: formatCount },
  { key: "errors", title: "Most errors", metric: "Errors", format: formatCount },
];

export interface LeaderboardRow {
  rank: number;
  name: string;
  /** Short identifier and project: "8f3c1a2e · billing-web". */
  meta: string;
  value: string;
  /** Session overview. */
  href: string;
}

export function leaderboardRows(items: readonly LeaderboardItem[], format: (value: number) => string): LeaderboardRow[] {
  return items.map((item, index) => ({
    rank: index + 1,
    name: item.name,
    meta: [item.sessionId.slice(0, 8), item.project].filter(Boolean).join(" · "),
    value: format(item.value),
    href: sessionHref("session", item.sessionId),
  }));
}

export interface ToolRow {
  name: string;
  calls: string;
  /** Share of calls relative to the most frequent tool, 0…1: the bar length. */
  callsRatio: number;
  errors: string;
  rate: string;
  highRate: boolean;
}

export function toolRows(tools: DashboardResponse["tools"]): ToolRow[] {
  const max = tools.reduce((m, tool) => Math.max(m, tool.calls), 0);
  return tools.map((tool) => {
    const rate = errorRate(tool.errors, tool.calls);
    return {
      name: tool.name,
      calls: formatCount(tool.calls),
      callsRatio: max === 0 ? 0 : tool.calls / max,
      errors: formatCount(tool.errors),
      rate: formatPercent(rate, 1),
      highRate: isHighErrorRate(rate),
    };
  });
}

export interface ModelRow {
  model: string;
  calls: string;
  tokens: string;
  cost: string;
}

export function modelRows(models: DashboardResponse["models"]): ModelRow[] {
  return models.map((m) => ({
    model: m.model,
    calls: formatCount(m.calls),
    tokens: formatTokens(m.tokens),
    cost: formatMoney(m.costUsd),
  }));
}

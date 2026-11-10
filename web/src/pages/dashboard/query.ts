// Dashboard page state ↔ address string ↔ API request parameters (plan §8, §9.3).
// Pure functions: the page only calls them. Default values do not go into the address.
import type { DashboardQuery, DashboardRange } from "@contracts/api.ts";

export const RANGES: readonly DashboardRange[] = ["day", "week", "month", "year", "custom"];
export const DEFAULT_RANGE: DashboardRange = "week";

/** Screen state. Custom dates are input field strings, an empty string means "not set". */
export interface DashboardState {
  range: DashboardRange;
  from: string;
  to: string;
  temp: boolean;
}

export const DEFAULT_STATE: DashboardState = { range: DEFAULT_RANGE, from: "", to: "", temp: false };

/** A date in `YYYY-MM-DD` format that exists in the calendar. */
export function isDateString(raw: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
  * What is wrong with the Custom dates: the server answers 400 to any of these, so the request is not sent.
  * The format is checked by `parseState`: a string that does not look like a date does not get into the state.
 */
export type CustomIssue = "missing" | "reversed";

export function customIssue(state: Pick<DashboardState, "from" | "to">): CustomIssue | null {
  if (state.from === "" || state.to === "") return "missing";
  // The YYYY-MM-DD format is compared as a string.
  return state.to < state.from ? "reversed" : null;
}

/** Explanation for a date state for which no data is requested. */
export const CUSTOM_ISSUE_TEXT: Record<CustomIssue, string> = {
  missing: "Select both dates to see this range.",
  reversed: "The end date can't be earlier than the start date.",
};

/** Address → state. Unintelligible values are replaced with the default: hand-editing the address does not break the page. */
export function parseState(search: string | URLSearchParams): DashboardState {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const raw = params.get("range");
  const range = RANGES.includes(raw as DashboardRange) ? (raw as DashboardRange) : DEFAULT_RANGE;
  const date = (key: string) => {
    const value = params.get(key) ?? "";
    return isDateString(value) ? value : "";
  };
  return {
    range,
    from: range === "custom" ? date("from") : "",
    to: range === "custom" ? date("to") : "",
    temp: params.get("temp") === "true",
  };
}

/** State → address (without "?"); defaults are omitted, dates only for Custom. */
export function stateToSearch(state: DashboardState): string {
  const params = new URLSearchParams();
  if (state.range !== DEFAULT_RANGE) params.set("range", state.range);
  if (state.range === "custom") {
    if (state.from !== "") params.set("from", state.from);
    if (state.to !== "") params.set("to", state.to);
  }
  if (state.temp) params.set("temp", "true");
  return params.toString();
}

/**
  * State → `GET /api/dashboard` request parameters; what is omitted matches the server default.
  * null — there is nothing to request: the Custom dates are not set or are inconsistent.
 */
export function stateToQuery(state: DashboardState): DashboardQuery | null {
  const query: DashboardQuery = {};
  if (state.range === "custom") {
    if (customIssue(state)) return null;
    query.range = "custom";
    query.from = state.from;
    query.to = state.to;
  } else if (state.range !== DEFAULT_RANGE) {
    query.range = state.range;
  }
  if (state.temp) query.temp = true;
  return query;
}

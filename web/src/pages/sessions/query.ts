// Sessions page state ↔ address string ↔ API request parameters (plan §8, §9.3).
// Pure functions: the page only calls them. Default values do not go into the address.
import type { AgentsBucket, SessionSortKey, SessionsQuery, SortDir } from "@contracts/api.ts";

export const RANGE_KEYS = ["tcMin", "tcMax", "erMin", "erMax", "tkMin", "tkMax"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

export const AGENTS_BUCKETS: readonly AgentsBucket[] = ["any", "one", "few", "many"];
export const SORT_KEYS: readonly SessionSortKey[] = [
  "name",
  "started",
  "duration",
  "agents",
  "tokens",
  "toolCalls",
  "errors",
  "cost",
];
const SORT_DIRS: readonly SortDir[] = ["asc", "desc"];

export const DEFAULT_SORT: SessionSortKey = "started";
export const DEFAULT_DIR: SortDir = "desc";

/** Screen state. Range bounds are input field strings, an empty string means "not set". */
export interface SessionsState extends Record<RangeKey, string> {
  q: string;
  agents: AgentsBucket;
  project: string;
  temp: boolean;
  sort: SessionSortKey;
  dir: SortDir;
  page: number;
}

export const DEFAULT_STATE: SessionsState = {
  q: "",
  agents: "any",
  tcMin: "",
  tcMax: "",
  erMin: "",
  erMax: "",
  tkMin: "",
  tkMax: "",
  project: "",
  temp: false,
  sort: DEFAULT_SORT,
  dir: DEFAULT_DIR,
  page: 1,
};

/** Direction on the first click on a header: name ascending, numbers and dates descending. */
export function firstDir(key: SessionSortKey): SortDir {
  return key === "name" ? "asc" : "desc";
}

/** A non-negative number from an address string; otherwise an empty string. */
function cleanNumber(raw: string | null): string {
  if (raw === null || raw.trim() === "") return "";
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? raw.trim() : "";
}

function pick<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

/** Address → state. Unintelligible values are replaced with the default: hand-editing the address does not break the page. */
export function parseState(search: string | URLSearchParams): SessionsState {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const page = Number(params.get("page"));
  const state: SessionsState = {
    ...DEFAULT_STATE,
    q: params.get("q") ?? "",
    agents: pick(params.get("agents"), AGENTS_BUCKETS, "any"),
    project: params.get("project") ?? "",
    temp: params.get("temp") === "true",
    sort: pick(params.get("sort"), SORT_KEYS, DEFAULT_SORT),
    dir: pick(params.get("dir"), SORT_DIRS, DEFAULT_DIR),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
  for (const key of RANGE_KEYS) state[key] = cleanNumber(params.get(key));
  return state;
}

/** State → address (without "?"); defaults are omitted. */
export function stateToSearch(state: SessionsState): string {
  const params = new URLSearchParams();
  if (state.q !== "") params.set("q", state.q);
  if (state.agents !== "any") params.set("agents", state.agents);
  for (const key of RANGE_KEYS) if (state[key] !== "") params.set(key, state[key]);
  if (state.project !== "") params.set("project", state.project);
  if (state.temp) params.set("temp", "true");
  if (state.sort !== DEFAULT_SORT) params.set("sort", state.sort);
  if (state.dir !== DEFAULT_DIR) params.set("dir", state.dir);
  if (state.page > 1) params.set("page", String(state.page));
  return params.toString();
}

/** State → `GET /api/sessions` request parameters; what is omitted matches the server default. */
export function stateToQuery(state: SessionsState): SessionsQuery {
  const query: SessionsQuery = {};
  const q = state.q.trim();
  if (q !== "") query.q = q;
  if (state.agents !== "any") query.agents = state.agents;
  for (const key of RANGE_KEYS) if (state[key] !== "") query[key] = Number(state[key]);
  if (state.project !== "") query.project = state.project;
  if (state.temp) query.temp = true;
  if (state.sort !== DEFAULT_SORT) query.sort = state.sort;
  if (state.dir !== DEFAULT_DIR) query.dir = state.dir;
  if (state.page > 1) query.page = state.page;
  return query;
}

/** A filter change returns to the first page; a page change itself does not. */
export function withFilter(state: SessionsState, change: Partial<SessionsState>): SessionsState {
  return { ...state, ...change, page: 1 };
}

/** A click on a column header: the same key flips the direction, a different one sets its own first one. */
export function withSort(state: SessionsState, key: SessionSortKey): SessionsState {
  const dir = state.sort === key ? (state.dir === "asc" ? "desc" : "asc") : firstDir(key);
  return { ...state, sort: key, dir, page: 1 };
}

/** Filter reset: search, agents bucket, ranges and project. Sorting and temp directories stay. */
export function resetFilters(state: SessionsState): SessionsState {
  return { ...DEFAULT_STATE, temp: state.temp, sort: state.sort, dir: state.dir };
}

/** Whether there is anything to reset. */
export function hasFilters(state: SessionsState): boolean {
  return stateToSearch({ ...state, page: 1 }) !== stateToSearch(resetFilters(state));
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

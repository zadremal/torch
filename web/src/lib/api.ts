// API client typed by @contracts/api.ts. Addresses are built from API_ROUTES.
// Fixture mode: with VITE_TORCH_FIXTURES=1 responses come from test/fixtures/dto (see fixtures.ts),
// no server needed.
import {
  API_ROUTES,
  type AgentPanel,
  type ApiError,
  type ApiRouteName,
  type ContentResponse,
  type DashboardQuery,
  type DashboardResponse,
  type FilePanel,
  type NetworkKind,
  type NetworkPanel,
  type ProjectsResponse,
  type PromptPanel,
  type SessionExport,
  type SessionOverview,
  type SessionsQuery,
  type SessionsResponse,
  type SettingsResponse,
  type SettingsUpdate,
  type TimelineResponse,
  type ToolCallPanel,
} from "@contracts/api.ts";

/** Response of every route that returns data (plan §8). */
export interface ApiResponses {
  dashboard: DashboardResponse;
  sessions: SessionsResponse;
  projects: ProjectsResponse;
  session: SessionOverview;
  sessionExport: SessionExport;
  timeline: TimelineResponse;
  agent: AgentPanel;
  toolCall: ToolCallPanel;
  prompt: PromptPanel;
  file: FilePanel;
  network: NetworkPanel;
  content: ContentResponse;
  settings: SettingsResponse;
}

export type DataRoute = keyof ApiResponses;
export type PathParams = Record<string, string | number>;
/** Query string parameters; undefined, an empty string and false are left out of the address. */
export type QueryParams = object;

/** Server response with an error code; `message` is the `error` field from the body. */
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

/** Route address: substitutes path parameters into the Hono pattern and appends the query string. */
export function apiPath(route: ApiRouteName, params: PathParams = {}, query: QueryParams = {}): string {
  const path = API_ROUTES[route].replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Route ${route}: parameter ${name} is not set`);
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Fixture mode is switched on by a Vite environment variable. */
export function isFixtureMode(): boolean {
  return Boolean(import.meta.env.VITE_TORCH_FIXTURES);
}

async function request<R extends DataRoute>(
  route: R,
  params: PathParams = {},
  query: QueryParams = {},
  body?: unknown,
): Promise<ApiResponses[R]> {
  if (isFixtureMode()) {
    // A separate module: in a regular build the fixtures stay in a chunk that is never loaded.
    const { fixtureResponse } = await import("./fixtures.ts");
    return fixtureResponse(route, params, query, body);
  }
  const init: RequestInit | undefined =
    body === undefined
      ? undefined
      : { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(apiPath(route, params, query), init);
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(response.status, error?.error ?? response.statusText);
  }
  return (await response.json()) as ApiResponses[R];
}

export const api = {
  dashboard: (query: DashboardQuery = {}) => request("dashboard", {}, query),
  sessions: (query: SessionsQuery = {}) => request("sessions", {}, query),
  projects: (query: { temp?: boolean } = {}) => request("projects", {}, query),
  session: (id: string) => request("session", { id }),
  sessionExport: (id: string) => request("sessionExport", { id }),
  timeline: (id: string) => request("timeline", { id }),
  agent: (id: string, agentId: string) => request("agent", { id, agentId }),
  toolCall: (id: string, callId: string) => request("toolCall", { id, callId }),
  prompt: (id: string, promptId: string) => request("prompt", { id, promptId }),
  file: (id: string, path: string) => request("file", { id }, { path }),
  network: (id: string, kind: NetworkKind, netId: string) => request("network", { id, kind, netId }),
  content: (contentId: number) => request("content", { id: contentId }),
  settings: () => request("settings"),
  saveSettings: (update: SettingsUpdate) => request("settings", {}, {}, update),
};

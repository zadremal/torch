// Fixture mode of the API client: responses from test/fixtures/dto for every plan §8 route.
// Which file answers which route and by which key the response is picked: test/fixtures/dto/README.md.
// Paths are relative rather than through the @fixtures alias: this module is also checked by the root
// tsconfig (via test/web), where the alias does not exist.
import type { DashboardRange, SettingsUpdate } from "@contracts/api.ts";
import { ApiRequestError, type ApiResponses, type DataRoute, type PathParams, type QueryParams } from "./api.ts";

/** A request for the session with this id returns it as running (sessionRunning.json); any other id returns the baseline one. */
export const FIXTURE_RUNNING_SESSION_ID = "running";

type JsonModule = Promise<{ default: unknown }>;

async function whole<T>(file: JsonModule): Promise<T> {
  return (await file).default as T;
}

async function keyed<T>(file: JsonModule, key: string | number | undefined, what: string): Promise<T> {
  const map = (await file).default as Record<string, T>;
  const value = key === undefined ? undefined : map[String(key)];
  if (value === undefined) throw new ApiRequestError(404, `Not found in fixtures: ${what} ${key}`);
  return value;
}

const DASHBOARDS: Record<DashboardRange, () => JsonModule> = {
  day: () => import("../../../test/fixtures/dto/dashboard.day.json"),
  week: () => import("../../../test/fixtures/dto/dashboard.week.json"),
  month: () => import("../../../test/fixtures/dto/dashboard.month.json"),
  year: () => import("../../../test/fixtures/dto/dashboard.year.json"),
  custom: () => import("../../../test/fixtures/dto/dashboard.custom.json"),
};

type Loader<R extends DataRoute> = (
  params: PathParams,
  query: Record<string, unknown>,
  body: unknown,
) => Promise<ApiResponses[R]>;

const FIXTURES: { [R in DataRoute]: Loader<R> } = {
  dashboard: (_params, query) => {
    const range = (query.range ?? "week") as DashboardRange;
    const load = DASHBOARDS[range];
    if (!load) throw new ApiRequestError(400, `Unknown range: ${range}`);
    return whole(load());
  },
  sessions: () => whole(import("../../../test/fixtures/dto/sessions.json")),
  projects: () => whole(import("../../../test/fixtures/dto/projects.json")),
  session: (params) =>
    params.id === FIXTURE_RUNNING_SESSION_ID
      ? whole(import("../../../test/fixtures/dto/sessionRunning.json"))
      : whole(import("../../../test/fixtures/dto/session.json")),
  sessionExport: () => whole(import("../../../test/fixtures/dto/sessionExport.json")),
  timeline: () => whole(import("../../../test/fixtures/dto/timeline.json")),
  agent: (params) => keyed(import("../../../test/fixtures/dto/agents.json"), params.agentId, "agent"),
  toolCall: (params) => keyed(import("../../../test/fixtures/dto/toolCalls.json"), params.callId, "tool call"),
  prompt: (params) => keyed(import("../../../test/fixtures/dto/prompts.json"), params.promptId, "prompt"),
  file: (_params, query) =>
    keyed(import("../../../test/fixtures/dto/files.json"), query.path as string | undefined, "file"),
  network: (params) =>
    keyed(import("../../../test/fixtures/dto/network.json"), `${params.kind}:${params.netId}`, "network call"),
  content: (params) => keyed(import("../../../test/fixtures/dto/contents.json"), params.id, "body"),
  settings: async (_params, _query, body) => {
    const settings = await whole<ApiResponses["settings"]>(import("../../../test/fixtures/dto/settings.json"));
    // PUT: the saved prices are returned in the response, the fixture itself does not change.
    return body === undefined ? settings : { ...settings, prices: (body as SettingsUpdate).prices };
  },
};

/** Route response from the fixtures; an unknown key gives an ApiRequestError with code 404. */
export async function fixtureResponse<R extends DataRoute>(
  route: R,
  params: PathParams = {},
  query: QueryParams = {},
  body?: unknown,
): Promise<ApiResponses[R]> {
  return FIXTURES[route](params, query as Record<string, unknown>, body);
}

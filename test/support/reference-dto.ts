// API responses for screens: what the server returns on the reference database (reference-seed.ts). Each example
// is obtained by calling the real route, so the examples do not diverge from the server. The files in
// test/fixtures/dto are written by build-dto.ts; their contents are described in test/fixtures/dto/README.md.

import type {
  AgentPanel,
  ContentResponse,
  DashboardRange,
  DashboardResponse,
  FilePanel,
  NetworkPanel,
  ProjectsResponse,
  PromptPanel,
  SessionExport,
  SessionOverview,
  SessionsResponse,
  SettingsResponse,
  TimelineResponse,
  ToolCallPanel,
} from "../../src/contracts/api.ts";
import { CLEANUP_PERIOD_DAYS } from "../../src/contracts/constants.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { testApi } from "./api.ts";
import { REF_PRICES, REF_SESSION_ID } from "./reference.ts";
import { seedListSessions, seedReference } from "./reference-seed.ts";

/** The dashboard examples' "today": the day of the reference session. Examples are built in the UTC time zone. */
export const FIXTURE_TODAY = Date.UTC(2026, 9, 31);
/** The server's "now" when building the examples: mid-day, so the window does not depend on the time of day. */
const FIXTURE_NOW = FIXTURE_TODAY + 15 * 3_600_000;

const DASHBOARD_QUERIES: Record<DashboardRange, string> = {
  day: "?range=day",
  week: "?range=week",
  month: "?range=month",
  year: "?range=year",
  // October, as in the mockup.
  custom: "?range=custom&from=2026-10-01&to=2026-10-31",
};

export interface DtoFixtures {
  sessions: SessionsResponse;
  projects: ProjectsResponse;
  session: SessionOverview;
  /** The same session as running, with partial enrichment and unknown cost. */
  sessionRunning: SessionOverview;
  sessionExport: SessionExport;
  timeline: TimelineResponse;
  /** Key is agentId. */
  agents: Record<string, AgentPanel>;
  /** Key is the call identifier. */
  toolCalls: Record<string, ToolCallPanel>;
  /** Key is the prompt identifier. */
  prompts: Record<string, PromptPanel>;
  /** Key is the file path. */
  files: Record<string, FilePanel>;
  /** Key is `<kind>:<id>`, as in the selection record `net:<kind>:<id>`. */
  network: Record<string, NetworkPanel>;
  /** Key is the content identifier. */
  contents: Record<string, ContentResponse>;
  dashboard: Record<DashboardRange, DashboardResponse>;
  settings: SettingsResponse;
}

/** Identifiers of the contents referenced by the responses: `contentId` fields at any depth. */
function contentIds(value: unknown, found = new Set<number>()): Set<number> {
  if (Array.isArray(value)) for (const item of value) contentIds(item, found);
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key === "contentId" && typeof item === "number") found.add(item);
      else contentIds(item, found);
    }
  }
  return found;
}

/** Builds all responses on a database from the reference session and the other mockup sessions. */
export async function buildDtoFixtures(): Promise<DtoFixtures> {
  // The server computes dashboard windows in local time: the examples are pinned to UTC.
  const zone = process.env.TZ;
  process.env.TZ = "UTC";
  const db = openMemoryDb();
  try {
    seedReference(db);
    seedListSessions(db);
    const api = testApi(db, () => FIXTURE_NOW);
    const of = `/api/sessions/${REF_SESSION_ID}`;
    const keyed = async <T>(keys: string[], path: (key: string) => string): Promise<Record<string, T>> =>
      Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await api.get<T>(path(key))] as const)));

    const session = await api.get<SessionOverview>(of);
    const timeline = await api.get<TimelineResponse>(`${of}/timeline`);
    const agents = await keyed<AgentPanel>(session.agents.map((agent) => agent.agentId), (id) => `${of}/agents/${encodeURIComponent(id)}`);
    const toolCalls = await keyed<ToolCallPanel>(timeline.tools.map((tool) => tool.id), (id) => `${of}/tool-calls/${encodeURIComponent(id)}`);
    const prompts = await keyed<PromptPanel>(session.prompts.map((prompt) => prompt.id), (id) => `${of}/prompts/${encodeURIComponent(id)}`);
    const files = await keyed<FilePanel>([...new Set(timeline.files.map((op) => op.path))].sort(), (path) => `${of}/files?path=${encodeURIComponent(path)}`);
    const network = await keyed<NetworkPanel>(
      [
        ...timeline.modelCalls.map((call) => `model:${call.id}`),
        ...timeline.apiErrors.map((error) => `error:${error.id}`),
        ...timeline.external.map((request) => `external:${request.id}`),
      ],
      (key) => {
        const [kind, ...id] = key.split(":");
        return `${of}/network/${kind}/${encodeURIComponent(id.join(":"))}`;
      },
    );
    const bodies = [...contentIds([agents, toolCalls, prompts, network])].sort((a, b) => a - b).map(String);

    return {
      sessions: await api.get<SessionsResponse>("/api/sessions"),
      projects: await api.get<ProjectsResponse>("/api/projects"),
      session,
      sessionRunning: { ...session, status: "running", enrichment: "partial", costUsd: null },
      sessionExport: await api.get<SessionExport>(`${of}/export`),
      timeline,
      agents,
      toolCalls,
      prompts,
      files,
      network,
      contents: await keyed<ContentResponse>(bodies, (id) => `/api/contents/${id}`),
      dashboard: {
        day: await api.get<DashboardResponse>(`/api/dashboard${DASHBOARD_QUERIES.day}`),
        week: await api.get<DashboardResponse>(`/api/dashboard${DASHBOARD_QUERIES.week}`),
        month: await api.get<DashboardResponse>(`/api/dashboard${DASHBOARD_QUERIES.month}`),
        year: await api.get<DashboardResponse>(`/api/dashboard${DASHBOARD_QUERIES.year}`),
        custom: await api.get<DashboardResponse>(`/api/dashboard${DASHBOARD_QUERIES.custom}`),
      },
      // The settings route will appear in stage C (package W7): the example is set by hand according to the contract.
      settings: {
        prices: REF_PRICES,
        paths: {
          dataDir: "/Users/dev/.torch",
          db: "/Users/dev/.torch/torch.db",
          transcripts: "/Users/dev/.claude/projects",
          desktopSessions: "/Users/dev/Library/Application Support/Claude/claude-code-sessions",
          spool: "/Users/dev/.torch/spool",
          claudeSettings: "/Users/dev/.claude/settings.json",
        },
        channels: { otel: { configured: true, lastEventAt: session.endedAt }, hooks: { configured: false, lastEventAt: null } },
        cleanupPeriodDays: CLEANUP_PERIOD_DAYS,
      },
    };
  } finally {
    db.close();
    process.env.TZ = zone ?? "UTC";
  }
}

/** File names in test/fixtures/dto: response key → file. */
export function fixtureFiles(fixtures: DtoFixtures): Record<string, unknown> {
  const { dashboard: byRange, ...rest } = fixtures;
  return {
    ...Object.fromEntries(Object.entries(rest).map(([key, value]) => [`${key}.json`, value])),
    ...Object.fromEntries(Object.entries(byRange).map(([range, value]) => [`dashboard.${range}.json`, value])),
  };
}

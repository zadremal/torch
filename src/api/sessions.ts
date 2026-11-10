// Session list and session overview. Session and agent columns are computed by the reducers: here they are
// read, not recomputed. Package A1.
import type { Database } from "bun:sqlite";
import type {
  AgentsBucket,
  AgentSummary,
  SessionListItem,
  SessionOverview,
  SessionSortKey,
  SessionsQuery,
  SessionsResponse,
  SortDir,
  ToolUsageEntry,
} from "../contracts/api.ts";
import { AGENT_BUCKETS, MAIN_AGENT_ID, SESSIONS_PAGE_SIZE } from "../contracts/constants.ts";
import type { AgentRow, PromptRow, SessionRow } from "../contracts/rows.ts";
import { getContent } from "../ingest/reduce/contents.ts";
import { type Handler, notFound } from "./context.ts";
import { badQuery, enumParam, flagParam, numberParam, QueryError, type SessionFilter, sessionFilterSql, textParam } from "./filters.ts";

// ── List ────────────────────────────────────────────────────────────────────────────────────

/** Sort expression for each list column. */
const SORT_SQL: Record<SessionSortKey, string> = {
  name: "COALESCE(sessions.name_lower, sessions.id)",
  started: "sessions.started_at",
  duration: "sessions.active_ms",
  agents: "sessions.agents_count",
  tokens: "sessions.tok_total",
  toolCalls: "sessions.tool_calls",
  errors: "sessions.tool_errors",
  cost: "sessions.cost_usd",
};
const SORT_DIRS: readonly SortDir[] = ["asc", "desc"];

function parseSessionsQuery(raw: Record<string, string>): SessionsQuery {
  const page = numberParam("page", raw.page);
  if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
    throw new QueryError(`Parameter page: expected an integer not less than 1, got “${raw.page}”`);
  }
  return {
    q: textParam(raw.q),
    agents: enumParam("agents", raw.agents, Object.keys(AGENT_BUCKETS) as AgentsBucket[]),
    tcMin: numberParam("tcMin", raw.tcMin),
    tcMax: numberParam("tcMax", raw.tcMax),
    erMin: numberParam("erMin", raw.erMin),
    erMax: numberParam("erMax", raw.erMax),
    tkMin: numberParam("tkMin", raw.tkMin),
    tkMax: numberParam("tkMax", raw.tkMax),
    project: textParam(raw.project),
    temp: flagParam("temp", raw.temp),
    sort: enumParam("sort", raw.sort, Object.keys(SORT_SQL) as SessionSortKey[]),
    dir: enumParam("dir", raw.dir, SORT_DIRS),
    page,
  };
}

type ListRow = Pick<
  SessionRow,
  "id" | "name" | "project" | "is_temp_dir" | "status" | "started_at" | "active_ms" | "agents_count" | "tok_total" | "tool_calls" | "tool_errors" | "cost_usd"
>;

const listItem = (row: ListRow): SessionListItem => ({
  id: row.id,
  name: row.name ?? row.id,
  project: row.project,
  isTempDir: row.is_temp_dir === 1,
  status: row.status,
  startedAt: row.started_at,
  activeMs: row.active_ms,
  agents: row.agents_count,
  tokens: row.tok_total,
  toolCalls: row.tool_calls,
  errors: row.tool_errors,
  costUsd: row.cost_usd,
});

function countSessions(db: Database, filter: SessionFilter): number {
  const { where, params } = sessionFilterSql(filter);
  return db.query<{ n: number }, (string | number)[]>(`SELECT COUNT(*) AS n FROM sessions WHERE ${where}`).get(...params)!.n;
}

export const listSessions: Handler = (c) => {
  let query: SessionsQuery;
  try {
    query = parseSessionsQuery(c.req.query());
  } catch (error) {
    return badQuery(c, error);
  }
  const { sort = "started", dir = "desc", page = 1, ...filter } = query;
  const db = c.get("db");
  const { where, params } = sessionFilterSql(filter);
  const order = SORT_SQL[sort];
  // An unknown value (no start time, no cost) goes last in either direction;
  // equal rows are ordered by start and id so that pages do not overlap.
  const rows = db
    .query<ListRow, (string | number)[]>(
      `SELECT id, name, project, is_temp_dir, status, started_at, active_ms, agents_count, tok_total, tool_calls, tool_errors, cost_usd
       FROM sessions
       WHERE ${where}
       ORDER BY (${order}) IS NULL, ${order} ${dir === "asc" ? "ASC" : "DESC"}, sessions.started_at DESC, sessions.id
       LIMIT ? OFFSET ?`,
    )
    .all(...params, SESSIONS_PAGE_SIZE, (page - 1) * SESSIONS_PAGE_SIZE);

  return c.json<SessionsResponse>({
    items: rows.map(listItem),
    total: countSessions(db, filter),
    totalAll: countSessions(db, { temp: filter.temp }),
    page,
    pageSize: SESSIONS_PAGE_SIZE,
  });
};

// ── Overview ────────────────────────────────────────────────────────────────────────────────

export function getSessionRow(db: Database, sessionId: string): SessionRow | null {
  return db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(sessionId);
}

/** Session agents as a tree: the main one first, a nested one right after its parent, siblings by launch time. */
export function agentsInTreeOrder(db: Database, sessionId: string): AgentRow[] {
  const rows = db
    .query<AgentRow, [string, string]>(
      "SELECT * FROM agents WHERE session_id = ? ORDER BY agent_id = ? DESC, started_at IS NULL, started_at, agent_id",
    )
    .all(sessionId, MAIN_AGENT_ID);
  const known = new Set(rows.map((row) => row.agent_id));
  const children = new Map<string | null, AgentRow[]>();
  for (const row of rows) {
    // An agent whose parent has not reached the database yet goes to the top level.
    const parent = row.parent_agent_id !== null && known.has(row.parent_agent_id) ? row.parent_agent_id : null;
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const ordered = new Set<AgentRow>();
  const visit = (parent: string | null) => {
    for (const row of children.get(parent) ?? []) {
      if (ordered.has(row)) continue;
      ordered.add(row);
      visit(row.agent_id);
    }
  };
  visit(null);
  // Rows not reachable from the top level (parents reference each other) are not lost.
  for (const row of rows) ordered.add(row);
  return [...ordered];
}

/** Session prompts by time with text from contents. */
export function promptsWithText(db: Database, sessionId: string): (PromptRow & { text: string })[] {
  return db
    .query<PromptRow, [string]>("SELECT * FROM prompts WHERE session_id = ? ORDER BY ts, seq")
    .all(sessionId)
    .map((row) => ({ ...row, text: getContent(db, row.content_id)?.text ?? "" }));
}

/** Tool usage by agent, each by descending call count. */
function toolUsageByAgent(db: Database, sessionId: string): Map<string, ToolUsageEntry[]> {
  const rows = db
    .query<{ agent_id: string; name: string; calls: number; errors: number }, [string]>(
      `SELECT agent_id, name, COUNT(*) AS calls, SUM(status = 'error') AS errors
       FROM tool_calls
       WHERE session_id = ?
       GROUP BY agent_id, name
       ORDER BY calls DESC, name`,
    )
    .all(sessionId);
  const byAgent = new Map<string, ToolUsageEntry[]>();
  for (const row of rows) {
    byAgent.set(row.agent_id, [...(byAgent.get(row.agent_id) ?? []), { name: row.name, count: row.calls, errors: row.errors }]);
  }
  return byAgent;
}

export const getSession: Handler = (c) => {
  const db = c.get("db");
  const id = c.req.param("id") ?? "";
  const session = getSessionRow(db, id);
  if (!session) return notFound(c, `session ${id}`);

  const agents = agentsInTreeOrder(db, id);
  const toolUsage = toolUsageByAgent(db, id);
  const agentSummary = (agent: AgentRow): AgentSummary => ({
    agentId: agent.agent_id,
    parentAgentId: agent.parent_agent_id,
    depth: agent.depth,
    type: agent.type,
    description: agent.description,
    model: agent.model,
    ctxPeak: agent.ctx_peak,
    ctxWindow: agent.ctx_window,
    runMs: agent.run_ms,
    toolCalls: agent.tool_calls,
    toolErrors: agent.tool_errors,
    apiErrors: agent.api_errors,
    filesRead: agent.files_read,
    toolUsage: toolUsage.get(agent.agent_id) ?? [],
  });

  return c.json<SessionOverview>({
    id: session.id,
    name: session.name ?? session.id,
    nameSource: session.name_source,
    project: session.project,
    cwd: session.cwd,
    isTempDir: session.is_temp_dir === 1,
    status: session.status,
    enrichment: session.enrichment,
    transcriptPresent: session.transcript_present === 1,
    primaryModel: session.primary_model,
    ccVersion: session.cc_version,
    gitBranch: session.git_branch,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    activeMs: session.active_ms,
    modelMs: session.model_ms,
    modelMsExact: session.model_ms_exact === 1,
    tokens: {
      input: session.tok_input,
      output: session.tok_output,
      cacheRead: session.tok_cache_read,
      cacheWrite: session.tok_cache_write,
      thinking: session.tok_thinking,
      total: session.tok_total,
    },
    agentsCount: session.agents_count,
    modelCalls: session.model_calls,
    toolCalls: session.tool_calls,
    toolErrors: session.tool_errors,
    apiErrors: session.api_errors,
    costUsd: session.cost_usd,
    costReportedUsd: session.cost_reported_usd,
    contextWindow: agents.find((agent) => agent.agent_id === MAIN_AGENT_ID)?.ctx_window ?? null,
    prompts: promptsWithText(db, id).map((prompt) => ({
      id: prompt.id,
      ts: prompt.ts,
      kind: prompt.kind,
      text: prompt.text,
      tokensEst: prompt.tokens_est,
      attachments: prompt.attachments_json ? (JSON.parse(prompt.attachments_json) as string[]) : [],
    })),
    agents: agents.map(agentSummary),
  });
};

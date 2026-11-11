// The reference session and the other mockup sessions as database rows. The reference session is obtained by running
// the ingest pipeline over its transcripts (reference-transcript.ts): the database rows are exactly what the
// reducers produce on such a transcript, so the dto examples do not diverge from the real responses.

import type { Database } from "bun:sqlite";
import { MAIN_AGENT_ID, RUNNING_WINDOW_MS } from "../../src/contracts/constants.ts";
import type { AgentMeta } from "../../src/contracts/lines.ts";
import type {
  AgentRow,
  ApiErrorRow,
  ExternalRequestRow,
  FileOpRow,
  InstructionLoadedRow,
  MessageRow,
  ModelCallRow,
  PromptRow,
  SessionRow,
  ToolCallRow,
} from "../../src/contracts/rows.ts";
import { DERIVED_REDUCERS, LINE_REDUCERS } from "../../src/ingest/index.ts";
import { parseLine } from "../../src/ingest/parse.ts";
import { listSessions, referenceScenario, type RefScenario } from "./reference.ts";
import { referenceFiles } from "./reference-transcript.ts";
import { seed } from "./seed.ts";
import { ANTHROPIC_PROVIDER } from "./provider.ts";

export interface ReferenceRows {
  session: SessionRow;
  agents: AgentRow[];
  prompts: PromptRow[];
  modelCalls: ModelCallRow[];
  toolCalls: ToolCallRow[];
  fileOps: FileOpRow[];
  externalRequests: ExternalRequestRow[];
  apiErrors: ApiErrorRow[];
  messages: MessageRow[];
  instructions: InstructionLoadedRow[];
}

const NO_META: AgentMeta = { agentType: null, description: null, toolUseId: null, spawnDepth: null, model: null, parentAgentId: null };

/** Loads the reference session through the pipeline and returns its rows: agents and calls in scenario order. */
export function seedReference(db: Database, scn: RefScenario = referenceScenario()): ReferenceRows {
  const session_id = scn.sessionId;
  const files = referenceFiles(scn);
  for (const file of [{ transcript: files.main, meta: undefined }, ...(files.subagents ?? [])]) {
    const lines = file.transcript.lines.map((line) => parseLine(JSON.stringify(line)).line);
    const ctx = {
      db,
      sessionId: session_id,
      agentId: file.transcript.options.agentId ?? MAIN_AGENT_ID,
      prices: scn.prices,
      provider: ANTHROPIC_PROVIDER,
      prevEventTs: null,
      agentMeta: file.meta ? { ...NO_META, ...file.meta } : null,
      titles: { customFile: null, desktop: null },
    };
    for (const reducer of LINE_REDUCERS) reducer(ctx, lines);
  }
  // "Now" is after the running session's window: the reference session is completed.
  for (const reducer of DERIVED_REDUCERS) reducer({ db, sessionId: session_id, prices: scn.prices, provider: ANTHROPIC_PROVIDER, now: scn.endedAt + RUNNING_WINDOW_MS });

  const all = <Row>(table: string, order: string) => db.query<Row, [string]>(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY ${order}`).all(session_id);
  /** Rows in scenario order: by the identifier from it. */
  const inOrder = <Row>(rows: Row[], key: (row: Row) => string, ids: string[]): Row[] => {
    const byKey = new Map(rows.map((row) => [key(row), row]));
    return ids.map((id) => byKey.get(id)!);
  };
  const toolIds = scn.toolCalls.map((tool) => tool.id);
  return {
    session: db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(session_id)!,
    agents: inOrder(all<AgentRow>("agents", "agent_id"), (row) => row.agent_id, scn.agents.map((agent) => agent.id)),
    prompts: all<PromptRow>("prompts", "seq"),
    modelCalls: inOrder(all<ModelCallRow>("model_calls", "id"), (row) => row.id, scn.modelCalls.map((call) => call.id)),
    toolCalls: inOrder(all<ToolCallRow>("tool_calls", "id"), (row) => row.id, toolIds),
    fileOps: inOrder(all<FileOpRow>("file_ops", "id"), (row) => row.id, toolIds).filter(Boolean),
    externalRequests: inOrder(all<ExternalRequestRow>("external_requests", "id"), (row) => row.id, toolIds).filter(Boolean),
    apiErrors: all<ApiErrorRow>("api_errors", "ts, id"),
    messages: all<MessageRow>("messages", "ts, id"),
    instructions: all<InstructionLoadedRow>("instructions_loaded", "id"),
  };
}

/** Tool and model shares from the dashboard mockup, in percent: the session list's calls are distributed by them. */
const TOOL_MIX: [string, number][] = [["Read", 31], ["Bash", 22], ["Edit", 17], ["Grep", 10], ["Glob", 6], ["Write", 5], ["Agent", 4], ["WebFetch", 3], ["TodoWrite", 2]];
const MODEL_MIX: [string, number][] = [["claude-opus-5-5", 58], ["claude-sonnet-4-5", 27], ["claude-haiku-4-5", 15]];

/** Name by call number: the numbers go around the percentages evenly, so the shares come out as in the list. */
function pick(mix: [string, number][], index: number): string {
  let point = (index * 37) % 100;
  for (const [name, share] of mix) {
    if (point < share) return name;
    point -= share;
  }
  return mix[0]![0];
}

/** Divides an integer into `parts` integer parts: the remainder goes to the last one, the sum is preserved. */
function share(total: number, parts: number, index: number): number {
  const each = Math.floor(total / parts);
  return index === parts - 1 ? total - each * (parts - 1) : each;
}

/**
  * Inserts the fifteen other mockup sessions: the session row, agent rows and the main
  * agent's calls, evenly distributed over the session time. The number of calls, errors, tokens and cost
  * of the calls add up to the session row's values, so the dashboard agrees with the list.
 */
export function seedListSessions(db: Database): SessionRow[] {
  return listSessions().map((item) => {
    const split = { tok_input: Math.round(item.tokens * 0.08), tok_output: Math.round(item.tokens * 0.05), tok_cache_write: Math.round(item.tokens * 0.08) };
    const session = seed.session(db, {
      id: item.id,
      cwd: `/Users/dev/code/${item.project}`,
      project: item.project,
      name: item.name,
      name_source: "ai",
      started_at: item.startedAt,
      ended_at: item.startedAt + item.activeMs,
      active_ms: item.activeMs,
      model_ms: Math.round(item.activeMs * 0.6),
      agents_count: item.agents,
      model_calls: Math.round(item.toolCalls * 0.71) + 6,
      tool_calls: item.toolCalls,
      tool_errors: item.errors,
      ...split,
      tok_cache_read: item.tokens - split.tok_input - split.tok_output - split.tok_cache_write,
      tok_thinking: Math.round(item.tokens * 0.01),
      tok_total: item.tokens,
      cost_usd: item.costUsd,
    });
    for (let n = 0; n < item.agents; n++) {
      seed.agent(db, {
        session_id: item.id,
        agent_id: n === 0 ? MAIN_AGENT_ID : `agent-${n}`,
        parent_agent_id: n === 0 ? null : MAIN_AGENT_ID,
        depth: n === 0 ? 0 : 1,
        type: n === 0 ? null : "general-purpose",
        description: n === 0 ? null : `Subtask ${n}`,
        started_at: item.startedAt,
        ended_at: item.startedAt + item.activeMs,
        run_ms: item.activeMs,
      });
    }
    const modelCalls = session.model_calls;
    for (let i = 0; i < modelCalls; i++) {
      seed.modelCall(db, {
        session_id: item.id,
        id: `${item.id}-m${i}`,
        turn_index: i + 1,
        model: pick(MODEL_MIX, i),
        ts_start: item.startedAt + Math.floor((item.activeMs * i) / modelCalls),
        duration_ms: Math.floor((item.activeMs * 0.6) / modelCalls),
        tok_input: share(session.tok_input, modelCalls, i),
        tok_output: share(session.tok_output, modelCalls, i),
        tok_cache_read: share(session.tok_cache_read, modelCalls, i),
        tok_cache_write_5m: share(session.tok_cache_write, modelCalls, i),
        tok_thinking: share(session.tok_thinking, modelCalls, i),
        cost_usd: item.costUsd / modelCalls,
      });
    }
    // Errors are placed at equal intervals among the calls.
    const errorEvery = item.errors > 0 ? Math.floor(item.toolCalls / item.errors) : 0;
    for (let i = 0; i < item.toolCalls; i++) {
      seed.toolCall(db, {
        session_id: item.id,
        id: `${item.id}-t${i}`,
        name: pick(TOOL_MIX, i),
        ts_start: item.startedAt + Math.floor((item.activeMs * i) / item.toolCalls),
        status: errorEvery > 0 && i % errorEvery === 0 && i / errorEvery < item.errors ? "error" : "ok",
      });
    }
    return session;
  });
}

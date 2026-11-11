// deriveTotals: agent and session totals — counters, tokens, cost, model (plan §4.2, §6.2).
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AgentRow, SessionRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { deriveTotals } from "../../../src/ingest/reduce/totals.ts";
import { REF_PRICES, REF_SESSION_ID } from "../../support/reference.ts";
import { seedReference } from "../../support/reference-seed.ts";
import { SEED_TIME, seed } from "../../support/seed.ts";
import { ANTHROPIC_PROVIDER } from "../../support/provider.ts";

const derive = (db: Database, sessionId = "s1") => deriveTotals({ db, sessionId, prices: REF_PRICES, provider: ANTHROPIC_PROVIDER, now: 0 });
const sessionRow = (db: Database, id = "s1") => db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id)!;
const agentRows = (db: Database, id = "s1") => db.query<AgentRow, [string]>("SELECT * FROM agents WHERE session_id = ? ORDER BY agent_id").all(id);
const agentRow = (db: Database, agentId = "main", id = "s1") => agentRows(db, id).find((agent) => agent.agent_id === agentId)!;

/** Deliberately wrong totals: the recalculation must replace each one. */
const STALE = { model_calls: 91, tool_calls: 92, tool_errors: 93, api_errors: 94, tok_input: 95, tok_output: 96, tok_cache_read: 97, tok_cache_write: 98, tok_thinking: 99, tok_total: 100, cost_usd: 101 };

/** A session with a main agent and a subagent, without calls. */
function twoAgents(id = "s1"): Database {
  const db = openMemoryDb();
  seed.session(db, { id, ...STALE, agents_count: 90, primary_model: "stale-model" });
  seed.agent(db, { session_id: id, ...STALE, files_read: 90, model: "stale-model" });
  seed.agent(db, { session_id: id, agent_id: "sub-1", parent_agent_id: "main", depth: 1, ...STALE, files_read: 90, model: "stale-model" });
  return db;
}

describe("agent totals", () => {
  test("model calls and tokens: cache write is the sum of two terms, thinking is not included in the total", () => {
    const db = twoAgents();
    seed.modelCall(db, { session_id: "s1", id: "m1", tok_input: 10, tok_output: 200, tok_cache_read: 3000, tok_cache_write_5m: 40_000, tok_cache_write_1h: 500_000, tok_thinking: 60 });
    seed.modelCall(db, { session_id: "s1", id: "m2", tok_input: 1, tok_output: 20, tok_cache_read: 300, tok_cache_write_5m: 4000, tok_cache_write_1h: 50_000, tok_thinking: 6 });
    seed.modelCall(db, { session_id: "s1", id: "m3", agent_id: "sub-1", tok_input: 7, tok_output: 70, tok_cache_read: 700, tok_cache_write_5m: 7000, tok_thinking: 0 });
    derive(db);
    expect(agentRow(db)).toMatchObject({ model_calls: 2, tok_input: 11, tok_output: 220, tok_cache_read: 3300, tok_cache_write: 594_000, tok_thinking: 66, tok_total: 11 + 220 + 3300 + 594_000 });
    expect(agentRow(db, "sub-1")).toMatchObject({ model_calls: 1, tok_input: 7, tok_output: 70, tok_cache_read: 700, tok_cache_write: 7000, tok_thinking: 0, tok_total: 7777 });
  });

  test("tool errors are only the error status; denied (rejected by the user), interrupted and pending are not errors", () => {
    const db = twoAgents();
    seed.toolCall(db, { session_id: "s1", id: "t1", status: "ok" });
    seed.toolCall(db, { session_id: "s1", id: "t2", status: "error" });
    seed.toolCall(db, { session_id: "s1", id: "t3", status: "error" });
    seed.toolCall(db, { session_id: "s1", id: "t4", status: "denied" });
    seed.toolCall(db, { session_id: "s1", id: "t5", status: "interrupted" });
    seed.toolCall(db, { session_id: "s1", id: "t6", status: "pending", duration_ms: null });
    seed.toolCall(db, { session_id: "s1", id: "t7", agent_id: "sub-1", status: "error" });
    derive(db);
    expect(agentRow(db)).toMatchObject({ tool_calls: 6, tool_errors: 2 });
    expect(agentRow(db, "sub-1")).toMatchObject({ tool_calls: 1, tool_errors: 1 });
  });

  test("API errors are counted separately from tool errors, from both sources", () => {
    const db = twoAgents();
    seed.apiError(db, { session_id: "s1", id: "e1" });
    seed.apiError(db, { session_id: "s1", id: "otel:7", source: "otel" });
    seed.apiError(db, { session_id: "s1", id: "e3", agent_id: "sub-1" });
    derive(db);
    expect(agentRow(db)).toMatchObject({ api_errors: 2, tool_errors: 0 });
    expect(agentRow(db, "sub-1")).toMatchObject({ api_errors: 1, tool_errors: 0 });
  });

  test("files read: distinct paths of this agent's read operations", () => {
    const db = twoAgents();
    seed.fileOp(db, { session_id: "s1", tool_call_id: "t1", path: "/repo/a.ts", op: "read" });
    seed.fileOp(db, { session_id: "s1", tool_call_id: "t2", path: "/repo/a.ts", op: "read" });
    seed.fileOp(db, { session_id: "s1", tool_call_id: "t3", path: "/repo/b.ts", op: "read" });
    seed.fileOp(db, { session_id: "s1", tool_call_id: "t4", path: "/repo/c.ts", op: "edit" });
    seed.fileOp(db, { session_id: "s1", tool_call_id: "t5", path: "/repo/d.ts", op: "write" });
    seed.fileOp(db, { session_id: "s1", tool_call_id: "t6", agent_id: "sub-1", path: "/repo/a.ts", op: "read" });
    derive(db);
    expect(agentRow(db).files_read).toBe(2);
    expect(agentRow(db, "sub-1").files_read).toBe(1);
  });

  test("cost is the sum of call costs", () => {
    const db = twoAgents();
    seed.modelCall(db, { session_id: "s1", id: "m1", cost_usd: 0.125 });
    seed.modelCall(db, { session_id: "s1", id: "m2", cost_usd: 0.25 });
    seed.modelCall(db, { session_id: "s1", id: "m3", agent_id: "sub-1", cost_usd: 1.5 });
    derive(db);
    expect(agentRow(db).cost_usd).toBe(0.375);
    expect(agentRow(db, "sub-1").cost_usd).toBe(1.5);
  });

  test("a call of an unknown model (cost_usd = NULL) zeroes the cost of its own agent only", () => {
    const db = twoAgents();
    seed.modelCall(db, { session_id: "s1", id: "m1", cost_usd: 0.5 });
    seed.modelCall(db, { session_id: "s1", id: "m2", agent_id: "sub-1", cost_usd: 0.25 });
    seed.modelCall(db, { session_id: "s1", id: "m3", agent_id: "sub-1", model: "claude-unknown-9", cost_usd: null });
    derive(db);
    expect(agentRow(db).cost_usd).toBe(0.5);
    expect(agentRow(db, "sub-1").cost_usd).toBeNull();
  });

  test("the agent's model is the one with more calls; on a tie, the one used later", () => {
    const db = twoAgents();
    seed.modelCall(db, { session_id: "s1", id: "m1", model: "claude-opus-5-5", ts_start: SEED_TIME });
    seed.modelCall(db, { session_id: "s1", id: "m2", model: "claude-haiku-4-5", ts_start: SEED_TIME + 1000 });
    seed.modelCall(db, { session_id: "s1", id: "m3", model: "claude-opus-5-5", ts_start: SEED_TIME + 2000 });
    seed.modelCall(db, { session_id: "s1", id: "m4", agent_id: "sub-1", model: "claude-sonnet-4-5", ts_start: SEED_TIME });
    seed.modelCall(db, { session_id: "s1", id: "m5", agent_id: "sub-1", model: "claude-haiku-4-5", ts_start: SEED_TIME + 1000 });
    derive(db);
    expect(agentRow(db).model).toBe("claude-opus-5-5");
    expect(agentRow(db, "sub-1").model).toBe("claude-haiku-4-5");
  });

  test("an agent without calls and events: zeros, zero cost, no model", () => {
    const db = twoAgents();
    derive(db);
    for (const agent of agentRows(db)) {
      expect(agent).toMatchObject({ model: null, model_calls: 0, tool_calls: 0, tool_errors: 0, api_errors: 0, files_read: 0, tok_input: 0, tok_output: 0, tok_cache_read: 0, tok_cache_write: 0, tok_thinking: 0, tok_total: 0, cost_usd: 0 });
    }
  });
});

describe("session totals", () => {
  /** The main agent and two subagents, one of them nested. */
  function seeded(): Database {
    const db = twoAgents();
    seed.agent(db, { session_id: "s1", agent_id: "sub-2", parent_agent_id: "sub-1", depth: 2 });
    seed.modelCall(db, { session_id: "s1", id: "m1", model: "claude-opus-5-5", tok_input: 100, tok_output: 10, tok_cache_read: 1000, tok_cache_write_1h: 50, tok_thinking: 4, cost_usd: 0.5 });
    seed.modelCall(db, { session_id: "s1", id: "m2", agent_id: "sub-1", model: "claude-haiku-4-5", tok_input: 200, tok_output: 20, tok_cache_read: 2000, tok_cache_write_5m: 60, cost_usd: 0.25 });
    seed.modelCall(db, { session_id: "s1", id: "m3", agent_id: "sub-1", model: "claude-haiku-4-5", tok_input: 300, tok_output: 30, tok_cache_read: 3000, cost_usd: 0.125 });
    seed.modelCall(db, { session_id: "s1", id: "m4", agent_id: "sub-2", model: "claude-haiku-4-5", tok_input: 400, tok_output: 40, tok_thinking: 1, cost_usd: 0.0625 });
    seed.toolCall(db, { session_id: "s1", id: "t1", status: "error" });
    seed.toolCall(db, { session_id: "s1", id: "t2", agent_id: "sub-1" });
    seed.toolCall(db, { session_id: "s1", id: "t3", agent_id: "sub-2", status: "error" });
    seed.toolCall(db, { session_id: "s1", id: "t4", agent_id: "sub-2", status: "denied" });
    seed.apiError(db, { session_id: "s1", id: "e1", agent_id: "sub-2" });
    return db;
  }

  test("counters, tokens and cost across all agents, number of agents", () => {
    const db = seeded();
    derive(db);
    expect(sessionRow(db)).toMatchObject({
      agents_count: 3,
      model_calls: 4,
      tool_calls: 4,
      tool_errors: 2,
      api_errors: 1,
      tok_input: 1000,
      tok_output: 100,
      tok_cache_read: 6000,
      tok_cache_write: 110,
      tok_thinking: 5,
      tok_total: 7210,
      cost_usd: 0.9375,
    });
  });

  test("session totals equal the sum of its agents' totals", () => {
    const db = seeded();
    derive(db);
    const session = sessionRow(db);
    const agents = agentRows(db);
    for (const column of ["model_calls", "tool_calls", "tool_errors", "api_errors", "tok_input", "tok_output", "tok_cache_read", "tok_cache_write", "tok_thinking", "tok_total", "cost_usd"] as const) {
      expect([column, session[column]]).toEqual([column, agents.reduce((total, agent) => total + agent[column]!, 0)]);
    }
  });

  test("the session's model is the main agent's model, not the most frequent", () => {
    const db = seeded();
    derive(db);
    expect(sessionRow(db).primary_model).toBe("claude-opus-5-5");
  });

  test("a call of an unknown model for any agent: session cost is NULL, the other totals are computed", () => {
    const db = seeded();
    seed.modelCall(db, { session_id: "s1", id: "m5", agent_id: "sub-2", model: "claude-unknown-9", tok_input: 1, cost_usd: null });
    derive(db);
    expect(sessionRow(db)).toMatchObject({ cost_usd: null, model_calls: 5, tok_input: 1001 });
  });

  test("a session without agents and calls: zeros, zero cost, no model", () => {
    const db = openMemoryDb();
    seed.session(db, { id: "s1", ...STALE, agents_count: 90, primary_model: "stale-model" });
    derive(db);
    expect(sessionRow(db)).toMatchObject({ primary_model: null, agents_count: 0, model_calls: 0, tool_calls: 0, tool_errors: 0, api_errors: 0, tok_input: 0, tok_output: 0, tok_cache_read: 0, tok_cache_write: 0, tok_thinking: 0, tok_total: 0, cost_usd: 0 });
  });
});

describe("recalculation boundaries", () => {
  /** Two sessions with identical row identifiers: they are unique only within a session. */
  function twoSessions(): Database {
    const db = openMemoryDb();
    for (const [id, tokens] of [["s1", 10], ["s2", 70]] as const) {
      seed.session(db, { id, ...STALE, agents_count: 90, primary_model: "stale-model" });
      seed.agent(db, { session_id: id, ...STALE, files_read: 90, model: "stale-model" });
      seed.modelCall(db, { session_id: id, id: "m1", tok_input: tokens, cost_usd: tokens / 1000 });
      seed.toolCall(db, { session_id: id, id: "t1", status: "error" });
      seed.fileOp(db, { session_id: id, tool_call_id: "t1", path: "/repo/a.ts" });
      seed.apiError(db, { session_id: id, id: "e1" });
    }
    return db;
  }

  test("only the session from the context is recalculated, from its own rows", () => {
    const db = twoSessions();
    derive(db, "s1");
    const own = { model_calls: 1, tool_calls: 1, tool_errors: 1, api_errors: 1, tok_input: 10, tok_total: 10, cost_usd: 0.01 };
    expect(sessionRow(db, "s1")).toMatchObject({ ...own, agents_count: 1, primary_model: "claude-opus-5-5" });
    expect(agentRow(db, "main", "s1")).toMatchObject({ ...own, files_read: 1, model: "claude-opus-5-5" });
    expect(sessionRow(db, "s2")).toMatchObject({ ...STALE, agents_count: 90, primary_model: "stale-model" });
    expect(agentRow(db, "main", "s2")).toMatchObject({ ...STALE, files_read: 90, model: "stale-model" });
  });

  test("the recalculation is idempotent", () => {
    const db = twoSessions();
    derive(db, "s1");
    const once = [sessionRow(db, "s1"), agentRows(db, "s1")];
    derive(db, "s1");
    expect([sessionRow(db, "s1"), agentRows(db, "s1")]).toEqual(once);
  });

  test("new rows of the next pass change the totals", () => {
    const db = twoSessions();
    derive(db, "s1");
    seed.modelCall(db, { session_id: "s1", id: "m2", tok_output: 5, cost_usd: 0.5 });
    seed.toolCall(db, { session_id: "s1", id: "t2" });
    derive(db, "s1");
    expect(sessionRow(db, "s1")).toMatchObject({ model_calls: 2, tool_calls: 2, tool_errors: 1, tok_total: 15, cost_usd: 0.51 });
  });
});

test("fixture session: the recalculation reproduces its totals", () => {
  const db = openMemoryDb();
  const ref = seedReference(db);
  db.query("UPDATE sessions SET primary_model = 'stale-model', agents_count = 90, model_calls = 91, tool_calls = 92, tool_errors = 93, api_errors = 94, tok_input = 95, tok_output = 96, tok_cache_read = 97, tok_cache_write = 98, tok_thinking = 99, tok_total = 100, cost_usd = 101").run();
  db.query("UPDATE agents SET model = 'stale-model', files_read = 90, model_calls = 91, tool_calls = 92, tool_errors = 93, api_errors = 94, tok_input = 95, tok_output = 96, tok_cache_read = 97, tok_cache_write = 98, tok_thinking = 99, tok_total = 100, cost_usd = 101").run();
  derive(db, REF_SESSION_ID);

  expect(sessionRow(db, REF_SESSION_ID)).toEqual(ref.session);

  const refAgents = new Map(ref.agents.map((agent) => [agent.agent_id, agent]));
  for (const { cost_usd, ...agent } of agentRows(db, REF_SESSION_ID)) {
    const { cost_usd: refCost, ...refAgent } = refAgents.get(agent.agent_id)!;
    expect(agent).toEqual(refAgent);
    expect(cost_usd).toBeCloseTo(refCost!, 6);
  }
});

// deriveContext: First / Last / Peak and the agent's context window (plan §6.2). The breakdown is in context.breakdown.test.ts.
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AgentRow, ModelCallRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { deriveContext } from "../../../src/ingest/reduce/context.ts";
import { REF_PRICES, REF_SESSION_ID } from "../../support/reference.ts";
import { seedReference } from "../../support/reference-seed.ts";
import { SEED_TIME, seed } from "../../support/seed.ts";

/** Second `n` from the start of the example. */
const at = (n: number) => SEED_TIME + n * 1000;

// In REF_PRICES each model's window is 200K, the known sizes are 200K and 1M.
const derive = (db: Database, sessionId = "s1") => deriveContext({ db, sessionId, prices: REF_PRICES, now: 0 });
const agentRows = (db: Database, id = "s1") => db.query<AgentRow, [string]>("SELECT * FROM agents WHERE session_id = ? ORDER BY agent_id").all(id);
const agentRow = (db: Database, agentId = "main", id = "s1") => agentRows(db, id).find((agent) => agent.agent_id === agentId)!;

/** A deliberately wrong context: the recalculation must replace every column. */
const STALE = { ctx_window: 1, ctx_first: 2, ctx_last: 3, ctx_peak: 4, ctx_peak_call_id: "stale", ctx_breakdown_json: "[]", ctx_breakdown_exact: 1 } as const;

function withAgents(...agentIds: string[]): Database {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  for (const agent_id of agentIds) seed.agent(db, { session_id: "s1", agent_id, ...STALE });
  return db;
}

/** A model call at second `second` with context `ctx_tokens`. */
function call(db: Database, id: string, second: number, ctx_tokens: number, extra: Partial<ModelCallRow> = {}): void {
  seed.modelCall(db, { session_id: "s1", id, ts_start: at(second), ctx_tokens, ...extra });
}

describe("First / Last / Peak", () => {
  test("context of the agent's first, last and largest call", () => {
    const db = withAgents("main");
    call(db, "m1", 0, 18_400);
    call(db, "m2", 10, 90_000);
    call(db, "m3", 20, 148_200);
    call(db, "m4", 30, 131_000);
    derive(db);
    expect(agentRow(db)).toMatchObject({ ctx_first: 18_400, ctx_last: 131_000, ctx_peak: 148_200, ctx_peak_call_id: "m3" });
  });

  test("calls are ordered by time, not by identifier or insertion order", () => {
    const db = withAgents("main");
    call(db, "c-last", 30, 500);
    call(db, "a-peak", 20, 900);
    call(db, "z-first", 0, 100);
    derive(db);
    expect(agentRow(db)).toMatchObject({ ctx_first: 100, ctx_last: 500, ctx_peak: 900, ctx_peak_call_id: "a-peak" });
  });

  test("calls with the same start time are ordered by call number", () => {
    const db = withAgents("main");
    call(db, "a", 0, 300, { turn_index: 2 });
    call(db, "b", 0, 100, { turn_index: 1 });
    derive(db);
    expect(agentRow(db)).toMatchObject({ ctx_first: 100, ctx_last: 300 });
  });

  test("several calls with the largest context: the peak is the first of them", () => {
    const db = withAgents("main");
    call(db, "m1", 0, 100);
    call(db, "m2", 10, 700);
    call(db, "m3", 20, 700);
    derive(db);
    expect(agentRow(db)).toMatchObject({ ctx_peak: 700, ctx_peak_call_id: "m2" });
  });

  test("one call: First, Last and Peak coincide", () => {
    const db = withAgents("main");
    call(db, "m1", 0, 12_100);
    derive(db);
    expect(agentRow(db)).toMatchObject({ ctx_first: 12_100, ctx_last: 12_100, ctx_peak: 12_100, ctx_peak_call_id: "m1" });
  });

  test("each agent is computed from its own calls", () => {
    const db = withAgents("main", "sub-1");
    call(db, "m1", 0, 1000);
    call(db, "m2", 30, 5000);
    call(db, "s1", 10, 200, { agent_id: "sub-1" });
    call(db, "s2", 20, 9000, { agent_id: "sub-1" });
    call(db, "s3", 25, 300, { agent_id: "sub-1" });
    derive(db);
    expect(agentRow(db)).toMatchObject({ ctx_first: 1000, ctx_last: 5000, ctx_peak: 5000, ctx_peak_call_id: "m2" });
    expect(agentRow(db, "sub-1")).toMatchObject({ ctx_first: 200, ctx_last: 300, ctx_peak: 9000, ctx_peak_call_id: "s2" });
  });

  test("an agent without calls: no context, window or breakdown", () => {
    const db = withAgents("main", "sub-1");
    call(db, "m1", 0, 1000);
    derive(db);
    expect(agentRow(db, "sub-1")).toMatchObject({ ctx_window: null, ctx_first: null, ctx_last: null, ctx_peak: null, ctx_peak_call_id: null, ctx_breakdown_json: null, ctx_breakdown_exact: 0 });
  });
});

describe("context window", () => {
  test("the model's window size from the price table", () => {
    const db = withAgents("main");
    call(db, "m1", 0, 150_000, { model: "claude-haiku-4-5" });
    derive(db);
    expect(agentRow(db).ctx_window).toBe(200_000);
  });

  test("a call with a context larger than the window raises the agent's window to the next known size", () => {
    const db = withAgents("main", "sub-1");
    call(db, "m1", 0, 150_000);
    call(db, "m2", 10, 200_001);
    call(db, "m3", 20, 90_000);
    // The same session neighbor fits in the window: its window does not change.
    call(db, "s1", 0, 200_000, { agent_id: "sub-1" });
    derive(db);
    expect(agentRow(db).ctx_window).toBe(1_000_000);
    expect(agentRow(db, "sub-1").ctx_window).toBe(200_000);
  });

  test("unknown model: no window, First / Last / Peak are computed", () => {
    const db = withAgents("main");
    call(db, "m1", 0, 1000, { model: "claude-unknown-9" });
    call(db, "m2", 10, 3000, { model: "claude-unknown-9" });
    derive(db);
    expect(agentRow(db)).toMatchObject({ ctx_window: null, ctx_first: 1000, ctx_last: 3000, ctx_peak: 3000 });
  });
});

describe("recalculation boundaries", () => {
  /** Two sessions with identical row identifiers: they are unique only within a session. */
  function twoSessions(): Database {
    const db = openMemoryDb();
    for (const [id, ctx] of [["s1", 1000], ["s2", 7000]] as const) {
      seed.session(db, { id });
      seed.agent(db, { session_id: id, ...STALE });
      seed.prompt(db, { session_id: id, id: "p1", ts: at(0), tokens_est: 50 });
      seed.instruction(db, { session_id: id, id: "i1", file_path: "/repo/CLAUDE.md", ts: at(0), tokens_est: 100 });
      seed.modelCall(db, { session_id: id, id: "m1", ts_start: at(0), ctx_tokens: ctx, tok_output: 40 });
      seed.toolCall(db, { session_id: id, id: "t1", ts_start: at(1), duration_ms: 1000, output_bytes: ctx });
      seed.modelCall(db, { session_id: id, id: "m2", ts_start: at(10), ctx_tokens: ctx * 2 });
    }
    return db;
  }

  test("only the session from the context is recalculated, from its own rows", () => {
    const db = twoSessions();
    derive(db, "s1");
    expect(agentRow(db, "main", "s1")).toMatchObject({ ctx_window: 200_000, ctx_first: 1000, ctx_last: 2000, ctx_peak: 2000, ctx_peak_call_id: "m2", ctx_breakdown_exact: 0 });
    expect(agentRow(db, "main", "s2")).toMatchObject(STALE);
  });

  test("only the context columns change", () => {
    const db = twoSessions();
    const before = agentRow(db, "main", "s1");
    derive(db, "s1");
    const { ctx_window, ctx_first, ctx_last, ctx_peak, ctx_peak_call_id, ctx_breakdown_json, ctx_breakdown_exact, ...rest } = agentRow(db, "main", "s1");
    expect(before).toMatchObject(rest);
  });

  test("the recalculation is idempotent", () => {
    const db = twoSessions();
    derive(db, "s1");
    const once = agentRows(db, "s1");
    derive(db, "s1");
    expect(agentRows(db, "s1")).toEqual(once);
  });

  test("a new call of the next pass shifts Last and Peak", () => {
    const db = twoSessions();
    derive(db, "s1");
    seed.modelCall(db, { session_id: "s1", id: "m3", ts_start: at(20), ctx_tokens: 9000 });
    derive(db, "s1");
    expect(agentRow(db, "main", "s1")).toMatchObject({ ctx_first: 1000, ctx_last: 9000, ctx_peak: 9000, ctx_peak_call_id: "m3" });
  });
});

test("fixture session: the recalculation reproduces each agent's window and First / Last / Peak", () => {
  const db = openMemoryDb();
  const ref = seedReference(db);
  db.query("UPDATE agents SET ctx_window = 1, ctx_first = 2, ctx_last = 3, ctx_peak = 4, ctx_peak_call_id = 'stale'").run();
  derive(db, REF_SESSION_ID);
  const context = (agent: AgentRow) => [agent.agent_id, agent.ctx_window, agent.ctx_first, agent.ctx_last, agent.ctx_peak, agent.ctx_peak_call_id];
  const byId = (a: AgentRow, b: AgentRow) => a.agent_id.localeCompare(b.agent_id);
  expect(agentRows(db, REF_SESSION_ID).sort(byId).map(context)).toEqual([...ref.agents].sort(byId).map(context));
});

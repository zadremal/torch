// deriveDurations: active time, model time and agent work duration (plan §6.2, decision 30).
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AgentRow, SessionRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { deriveDurations } from "../../../src/ingest/reduce/durations.ts";
import { REF_PRICES, REF_SESSION_ID } from "../../support/reference.ts";
import { seedReference } from "../../support/reference-seed.ts";
import { SEED_TIME, seed } from "../../support/seed.ts";
import { ANTHROPIC_PROVIDER } from "../../support/provider.ts";

/** Second `n` from the start of the example. */
const at = (n: number) => SEED_TIME + n * 1000;

const derive = (db: Database, sessionId = "s1") => deriveDurations({ db, sessionId, prices: REF_PRICES, provider: ANTHROPIC_PROVIDER, now: 0 });
const sessionRow = (db: Database, id = "s1") => db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id)!;
const agentRows = (db: Database, id = "s1") => db.query<AgentRow, [string]>("SELECT * FROM agents WHERE session_id = ? ORDER BY agent_id").all(id);

/** A session with deliberately wrong derived values: the recalculation must replace them. */
function emptySession(id = "s1"): Database {
  const db = openMemoryDb();
  seed.session(db, { id, active_ms: 999_999, model_ms: 999_999, model_ms_exact: 1 });
  return db;
}

describe("active time", () => {
  test("one prompt: from the prompt to the last event", () => {
    const db = emptySession();
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0) });
    seed.modelCall(db, { session_id: "s1", id: "m1", ts_start: at(0), duration_ms: 4000 });
    seed.toolCall(db, { session_id: "s1", id: "t1", ts_start: at(4), duration_ms: 6000 });
    seed.modelCall(db, { session_id: "s1", id: "m2", ts_start: at(10), duration_ms: 5000 });
    derive(db);
    expect(sessionRow(db).active_ms).toBe(15_000);
  });

  test("several prompts: the idle time between the end of a reply and the next prompt is not counted", () => {
    const db = emptySession();
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0) });
    seed.modelCall(db, { session_id: "s1", id: "m1", ts_start: at(0), duration_ms: 30_000 });
    // An hour of idle time before the second prompt.
    seed.prompt(db, { session_id: "s1", id: "p2", ts: at(3600), seq: 1, kind: "follow_up" });
    seed.modelCall(db, { session_id: "s1", id: "m2", ts_start: at(3600), duration_ms: 20_000 });
    seed.toolCall(db, { session_id: "s1", id: "t2", ts_start: at(3620), duration_ms: 25_000 });
    derive(db);
    expect(sessionRow(db).active_ms).toBe(30_000 + 45_000);
  });

  test("an event belongs to the interval of the prompt after which it happened: insertion order and identifiers do not matter", () => {
    const db = emptySession();
    seed.prompt(db, { session_id: "s1", id: "z-first", ts: at(100), seq: 0 });
    seed.prompt(db, { session_id: "s1", id: "a-second", ts: at(200), seq: 1, kind: "follow_up" });
    seed.modelCall(db, { session_id: "s1", id: "m2", ts_start: at(200), duration_ms: 7000 });
    seed.modelCall(db, { session_id: "s1", id: "m1", ts_start: at(100), duration_ms: 3000 });
    derive(db);
    expect(sessionRow(db).active_ms).toBe(3000 + 7000);
  });

  test("subagent events extend the interval", () => {
    const db = emptySession();
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0) });
    seed.modelCall(db, { session_id: "s1", id: "m1", ts_start: at(0), duration_ms: 5000 });
    // A background subagent works after the main agent's last reply.
    seed.modelCall(db, { session_id: "s1", id: "m-sub", agent_id: "sub-1", ts_start: at(5), duration_ms: 55_000 });
    seed.toolCall(db, { session_id: "s1", id: "t-sub", agent_id: "sub-1", ts_start: at(60), duration_ms: 30_000 });
    derive(db);
    expect(sessionRow(db).active_ms).toBe(90_000);
  });

  test("a failed API attempt and a compaction are events", () => {
    const db = emptySession();
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0) });
    seed.apiError(db, { session_id: "s1", id: "e1", ts: at(12) });
    seed.prompt(db, { session_id: "s1", id: "p2", ts: at(100), seq: 1, kind: "follow_up" });
    seed.compaction(db, { session_id: "s1", id: "c1", ts: at(140) });
    derive(db);
    expect(sessionRow(db).active_ms).toBe(12_000 + 40_000);
  });

  test("a tool call without a result is counted by its start", () => {
    const db = emptySession();
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0) });
    seed.toolCall(db, { session_id: "s1", id: "t1", ts_start: at(8), duration_ms: null, status: "pending" });
    derive(db);
    expect(sessionRow(db).active_ms).toBe(8000);
  });

  test("a call started before the next prompt and finished after it: the start is in the old interval, the end in the new one", () => {
    const db = emptySession();
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0) });
    seed.toolCall(db, { session_id: "s1", id: "t1", ts_start: at(10), duration_ms: 50_000 });
    seed.prompt(db, { session_id: "s1", id: "p2", ts: at(40), seq: 1, kind: "follow_up" });
    derive(db);
    // 0 → 10 and 40 → 60.
    expect(sessionRow(db).active_ms).toBe(10_000 + 20_000);
  });

  test("events before the first prompt belong to no interval", () => {
    const db = emptySession();
    seed.modelCall(db, { session_id: "s1", id: "m0", ts_start: at(0), duration_ms: 9000 });
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(60) });
    seed.modelCall(db, { session_id: "s1", id: "m1", ts_start: at(60), duration_ms: 2000 });
    derive(db);
    expect(sessionRow(db).active_ms).toBe(2000);
  });

  test("a prompt with no events after it and a session with no prompts give zero", () => {
    const db = emptySession();
    seed.modelCall(db, { session_id: "s1", id: "m0", ts_start: at(0), duration_ms: 9000 });
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(60) });
    derive(db);
    expect(sessionRow(db).active_ms).toBe(0);

    const noPrompts = emptySession();
    seed.modelCall(noPrompts, { session_id: "s1", id: "m1", ts_start: at(0), duration_ms: 9000 });
    derive(noPrompts);
    expect(sessionRow(noPrompts).active_ms).toBe(0);
  });
});

describe("model time", () => {
  test("sum of call durations across all agents; all exact — model_ms_exact = 1", () => {
    const db = emptySession();
    db.query("UPDATE sessions SET model_ms_exact = 0").run();
    seed.modelCall(db, { session_id: "s1", id: "m1", duration_ms: 1200, duration_exact: 1 });
    seed.modelCall(db, { session_id: "s1", id: "m2", duration_ms: 800, duration_exact: 1 });
    seed.modelCall(db, { session_id: "s1", id: "m3", agent_id: "sub-1", duration_ms: 3000, duration_exact: 1 });
    derive(db);
    expect(sessionRow(db)).toMatchObject({ model_ms: 5000, model_ms_exact: 1 });
  });

  test("a session with one inexact call gets model_ms_exact = 0", () => {
    const db = emptySession();
    seed.modelCall(db, { session_id: "s1", id: "m1", duration_ms: 1200, duration_exact: 1 });
    seed.modelCall(db, { session_id: "s1", id: "m2", agent_id: "sub-1", duration_ms: 800, duration_exact: 0 });
    seed.modelCall(db, { session_id: "s1", id: "m3", duration_ms: 3000, duration_exact: 1 });
    derive(db);
    expect(sessionRow(db)).toMatchObject({ model_ms: 5000, model_ms_exact: 0 });
  });

  test("no calls: zero and inexact", () => {
    const db = emptySession();
    derive(db);
    expect(sessionRow(db)).toMatchObject({ model_ms: 0, model_ms_exact: 0 });
  });
});

describe("agent work duration", () => {
  test("a subagent — from the start to the end of its file; without time — zero", () => {
    const db = emptySession();
    seed.agent(db, { session_id: "s1", started_at: at(0), ended_at: at(1122), run_ms: 1 });
    seed.agent(db, { session_id: "s1", agent_id: "sub-1", started_at: at(64), ended_at: at(210), run_ms: 1 });
    seed.agent(db, { session_id: "s1", agent_id: "sub-2", started_at: null, ended_at: null, run_ms: 1 });
    seed.agent(db, { session_id: "s1", agent_id: "sub-3", started_at: at(5), ended_at: null, run_ms: 1 });
    derive(db);
    expect(agentRows(db).filter((agent) => agent.agent_id !== "main").map((agent) => [agent.agent_id, agent.run_ms])).toEqual([
      ["sub-1", 146_000],
      ["sub-2", 0],
      ["sub-3", 0],
    ]);
  });

  test("the main agent — the session's active time: idle periods between replies are not included", () => {
    const db = emptySession();
    // The main agent's file stretches for an hour, but the work went in two ten-second intervals.
    seed.agent(db, { session_id: "s1", started_at: at(0), ended_at: at(3600), run_ms: 1 });
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0) });
    seed.modelCall(db, { session_id: "s1", id: "m1", ts_start: at(0), duration_ms: 10_000 });
    seed.prompt(db, { session_id: "s1", id: "p2", ts: at(3590), seq: 1, kind: "follow_up" });
    seed.modelCall(db, { session_id: "s1", id: "m2", ts_start: at(3590), duration_ms: 10_000 });
    derive(db);
    expect(sessionRow(db, "s1").active_ms).toBe(20_000);
    expect(agentRows(db)[0]).toMatchObject({ agent_id: "main", run_ms: 20_000 });
  });
});

describe("recalculation boundaries", () => {
  /** Two sessions with identical row identifiers: they are unique only within a session. */
  function twoSessions(): Database {
    const db = openMemoryDb();
    for (const [id, seconds] of [["s1", 10], ["s2", 70]] as const) {
      seed.session(db, { id, active_ms: 111, model_ms: 222, model_ms_exact: 1 });
      seed.agent(db, { session_id: id, started_at: at(0), ended_at: at(seconds), run_ms: 333 });
      seed.prompt(db, { session_id: id, id: "p1", ts: at(0) });
      seed.modelCall(db, { session_id: id, id: "m1", ts_start: at(0), duration_ms: seconds * 1000 });
    }
    return db;
  }

  test("only the session from the context is recalculated, from its own rows", () => {
    const db = twoSessions();
    derive(db, "s1");
    expect(sessionRow(db, "s1")).toMatchObject({ active_ms: 10_000, model_ms: 10_000, model_ms_exact: 0 });
    expect(agentRows(db, "s1")[0]!.run_ms).toBe(10_000);
    expect(sessionRow(db, "s2")).toMatchObject({ active_ms: 111, model_ms: 222, model_ms_exact: 1 });
    expect(agentRows(db, "s2")[0]!.run_ms).toBe(333);
  });

  test("the recalculation is idempotent", () => {
    const db = twoSessions();
    derive(db, "s1");
    const once = [sessionRow(db, "s1"), agentRows(db, "s1")];
    derive(db, "s1");
    expect([sessionRow(db, "s1"), agentRows(db, "s1")]).toEqual(once);
  });

  test("new rows of the next pass change the result", () => {
    const db = twoSessions();
    derive(db, "s1");
    seed.toolCall(db, { session_id: "s1", id: "t1", ts_start: at(10), duration_ms: 5000 });
    seed.modelCall(db, { session_id: "s1", id: "m2", ts_start: at(15), duration_ms: 2000, duration_exact: 1 });
    derive(db, "s1");
    expect(sessionRow(db, "s1")).toMatchObject({ active_ms: 17_000, model_ms: 12_000, model_ms_exact: 0 });
  });
});

test("fixture session: the recalculation reproduces its durations", () => {
  const db = openMemoryDb();
  const ref = seedReference(db);
  db.query("UPDATE sessions SET active_ms = -1, model_ms = -1, model_ms_exact = 1").run();
  db.query("UPDATE agents SET run_ms = -1").run();
  derive(db, REF_SESSION_ID);
  const { active_ms, model_ms, model_ms_exact } = ref.session;
  expect(sessionRow(db, REF_SESSION_ID)).toMatchObject({ active_ms, model_ms, model_ms_exact });
  const expected = new Map(ref.agents.map((agent) => [agent.agent_id, agent.run_ms]));
  for (const agent of agentRows(db, REF_SESSION_ID)) expect([agent.agent_id, agent.run_ms]).toEqual([agent.agent_id, expected.get(agent.agent_id)!]);
});

// GET /api/sessions/:id/timeline: six tracks and the gap map.
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { ApiError, TimelineResponse } from "../../src/contracts/api.ts";
import { IDLE_GAP_MS } from "../../src/contracts/constants.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import timelineFixture from "../fixtures/dto/timeline.json";
import { testApi } from "../support/api.ts";
import { REF_SESSION_ID } from "../support/reference.ts";
import { seedReference } from "../support/reference-seed.ts";
import { seed } from "../support/seed.ts";

const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);
const MIN = 60_000;

const timeline = (db: Database, id = "s1") => testApi(db).get<TimelineResponse>(`/api/sessions/${encodeURIComponent(id)}/timeline`);

test("the response contains all six tracks: Session, Prompts, Agents, Tools, Files, Network", async () => {
  const db = openMemoryDb();
  seed.session(db, {
    id: "s1",
    name: "Speed up checkout",
    status: "running",
    started_at: T0,
    ended_at: T0 + 4 * MIN,
    active_ms: 3 * MIN,
    model_calls: 2,
    tool_calls: 4,
    tool_errors: 1,
    api_errors: 1,
  });
  seed.agent(db, { session_id: "s1", started_at: T0, ended_at: T0 + 4 * MIN, tool_calls: 2, tool_errors: 0 });
  seed.agent(db, {
    session_id: "s1",
    agent_id: "explore-1",
    parent_agent_id: "main",
    depth: 1,
    type: "Explore",
    description: "Find slow queries",
    model: "claude-haiku-4-5",
    started_at: T0 + 10_000,
    ended_at: T0 + 70_000,
    tool_calls: 2,
    tool_errors: 1,
  });
  seed.prompt(db, { session_id: "s1", id: "p1", ts: T0, seq: 0, kind: "original" });
  seed.prompt(db, { session_id: "s1", id: "p2", ts: T0 + 3 * MIN, seq: 1, kind: "follow_up" });
  seed.modelCall(db, { session_id: "s1", id: "req-1", ts_start: T0, duration_ms: 10_000 });
  seed.modelCall(db, { session_id: "s1", id: "req-2", agent_id: "explore-1", ts_start: T0 + 10_000, duration_ms: 5_000 });
  seed.toolCall(db, { session_id: "s1", id: "t-agent", name: "Agent", target: "Find slow queries", ts_start: T0 + 10_000, duration_ms: 60_000, spawned_agent_id: "explore-1" });
  seed.toolCall(db, { session_id: "s1", id: "t-read", agent_id: "explore-1", name: "Read", target: "/app/db.ts", ts_start: T0 + 15_000, duration_ms: 200, status: "error" });
  seed.toolCall(db, { session_id: "s1", id: "t-fetch", agent_id: "explore-1", name: "WebFetch", target: "https://example.com/docs", ts_start: T0 + 20_000, duration_ms: 900 });
  seed.toolCall(db, { session_id: "s1", id: "t-bash", name: "Bash", target: "bun test", ts_start: T0 + 3 * MIN + 5_000, duration_ms: null, status: "pending" });
  seed.fileOp(db, { session_id: "s1", tool_call_id: "t-read", agent_id: "explore-1", path: "/app/db.ts", op: "read", ts: T0 + 15_000 });
  seed.externalRequest(db, { session_id: "s1", tool_call_id: "t-fetch", agent_id: "explore-1", kind: "web_fetch", status_code: 404, duration_ms: 850, ts: T0 + 20_000 });
  seed.apiError(db, { session_id: "s1", id: "err-1", agent_id: "explore-1", ts: T0 + 12_000 });

  expect(await timeline(db)).toEqual({
    session: {
      id: "s1",
      name: "Speed up checkout",
      status: "running",
      startedAt: T0,
      endedAt: T0 + 4 * MIN,
      activeMs: 3 * MIN,
      modelCalls: 2,
      toolCalls: 4,
      toolErrors: 1,
      apiErrors: 1,
    },
    gaps: [],
    prompts: [
      { id: "p1", ts: T0, kind: "original" },
      { id: "p2", ts: T0 + 3 * MIN, kind: "follow_up" },
    ],
    agents: [
      { agentId: "main", parentAgentId: null, depth: 0, type: null, description: null, model: "claude-opus-5-5", start: T0, end: T0 + 4 * MIN, toolCalls: 2, toolErrors: 0 },
      {
        agentId: "explore-1",
        parentAgentId: "main",
        depth: 1,
        type: "Explore",
        description: "Find slow queries",
        model: "claude-haiku-4-5",
        start: T0 + 10_000,
        end: T0 + 70_000,
        toolCalls: 2,
        toolErrors: 1,
      },
    ],
    tools: [
      { id: "t-agent", agentId: "main", name: "Agent", target: "Find slow queries", start: T0 + 10_000, durationMs: 60_000, status: "ok" },
      { id: "t-read", agentId: "explore-1", name: "Read", target: "/app/db.ts", start: T0 + 15_000, durationMs: 200, status: "error" },
      { id: "t-fetch", agentId: "explore-1", name: "WebFetch", target: "https://example.com/docs", start: T0 + 20_000, durationMs: 900, status: "ok" },
      { id: "t-bash", agentId: "main", name: "Bash", target: "bun test", start: T0 + 3 * MIN + 5_000, durationMs: null, status: "pending" },
    ],
    files: [{ toolCallId: "t-read", agentId: "explore-1", path: "/app/db.ts", op: "read", ts: T0 + 15_000, error: true }],
    modelCalls: [
      { id: "req-1", agentId: "main", start: T0, durationMs: 10_000 },
      { id: "req-2", agentId: "explore-1", start: T0 + 10_000, durationMs: 5_000 },
    ],
    apiErrors: [{ id: "err-1", agentId: "explore-1", ts: T0 + 12_000 }],
    external: [{ id: "t-fetch", agentId: "explore-1", kind: "web_fetch", ts: T0 + 20_000, durationMs: 850, error: true }],
  } satisfies TimelineResponse);
});

test("an external request is marked as an error on a status of 400 or higher or on a tool call error", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  const fetch = (id: string, status: "ok" | "error", status_code: number | null, offset: number) => {
    seed.toolCall(db, { session_id: "s1", id, name: "WebFetch", ts_start: T0 + offset, status });
    seed.externalRequest(db, { session_id: "s1", tool_call_id: id, status_code, ts: T0 + offset });
  };
  fetch("ok-200", "ok", 200, 0);
  fetch("ok-399", "ok", 399, 1);
  fetch("ok-400", "ok", 400, 2);
  fetch("ok-unknown", "ok", null, 3);
  fetch("failed-unknown", "error", null, 4);

  const { external } = await timeline(db);
  expect(external.map((request) => [request.id, request.error])).toEqual([
    ["ok-200", false],
    ["ok-399", false],
    ["ok-400", true],
    ["ok-unknown", false],
    ["failed-unknown", true],
  ]);
});

// ── Gaps ────────────────────────────────────────────────────────────────────────────────────

test("an idle period longer than 5 minutes collapses into a gap, exactly 5 minutes does not", async () => {
  expect(IDLE_GAP_MS).toBe(5 * MIN);
  const db = openMemoryDb();
  seed.session(db, { id: "s1", started_at: T0, ended_at: T0 + 30 * MIN });
  seed.prompt(db, { session_id: "s1", id: "p1", ts: T0, seq: 0 });
  seed.modelCall(db, { session_id: "s1", id: "req-1", ts_start: T0, duration_ms: MIN });
  seed.toolCall(db, { session_id: "s1", id: "t1", ts_start: T0 + MIN, duration_ms: MIN });
  // Exactly 5 minutes after the end of call t1: the threshold is not exceeded.
  seed.prompt(db, { session_id: "s1", id: "p2", ts: T0 + 7 * MIN, seq: 1, kind: "follow_up" });
  seed.modelCall(db, { session_id: "s1", id: "req-2", ts_start: T0 + 7 * MIN, duration_ms: MIN });
  // A millisecond longer than the threshold after the end of req-2.
  seed.prompt(db, { session_id: "s1", id: "p3", ts: T0 + 13 * MIN + 1, seq: 2, kind: "follow_up" });
  seed.modelCall(db, { session_id: "s1", id: "req-3", ts_start: T0 + 13 * MIN + 1, duration_ms: MIN });

  // The second gap is the tail from the last call to the last session event.
  expect((await timeline(db)).gaps).toEqual([
    { start: T0 + 8 * MIN, end: T0 + 13 * MIN + 1 },
    { start: T0 + 14 * MIN + 1, end: T0 + 30 * MIN },
  ]);
});

test("an idle period during which a call runs does not become a gap", async () => {
  const db = openMemoryDb();
  // Three sessions with the same events; in the second and third a long call runs between them.
  for (const id of ["idle", "tool-running", "model-running"]) {
    seed.session(db, { id, started_at: T0, ended_at: T0 + 25 * MIN });
    seed.prompt(db, { session_id: id, id: "p1", ts: T0, seq: 0 });
    seed.toolCall(db, { session_id: id, id: "short", ts_start: T0 + MIN, duration_ms: MIN });
    seed.prompt(db, { session_id: id, id: "p2", ts: T0 + 24 * MIN, seq: 1, kind: "follow_up" });
    seed.modelCall(db, { session_id: id, id: "req-2", ts_start: T0 + 24 * MIN, duration_ms: MIN });
  }
  // The long call started earlier than the short one and ended 4 minutes before the next event.
  seed.toolCall(db, { session_id: "tool-running", id: "long", name: "Bash", ts_start: T0 + 30_000, duration_ms: 19 * MIN + 30_000 });
  seed.modelCall(db, { session_id: "model-running", id: "long", ts_start: T0 + 30_000, duration_ms: 19 * MIN + 30_000 });

  expect((await timeline(db, "idle")).gaps).toEqual([{ start: T0 + 2 * MIN, end: T0 + 24 * MIN }]);
  expect((await timeline(db, "tool-running")).gaps).toEqual([]);
  expect((await timeline(db, "model-running")).gaps).toEqual([]);
});

test("an idle period after the end of a long call is counted from its end", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", started_at: T0, ended_at: T0 + 30 * MIN });
  seed.toolCall(db, { session_id: "s1", id: "long", name: "Bash", ts_start: T0, duration_ms: 10 * MIN });
  seed.toolCall(db, { session_id: "s1", id: "short", ts_start: T0 + MIN, duration_ms: MIN });
  seed.prompt(db, { session_id: "s1", id: "p2", ts: T0 + 30 * MIN, seq: 1, kind: "follow_up" });

  expect((await timeline(db)).gaps).toEqual([{ start: T0 + 10 * MIN, end: T0 + 30 * MIN }]);
});

test("a call without a result runs to the end of a running session; in a finished one it occupies only its own moment", async () => {
  const pending = async (status: "running" | "completed") => {
    const db = openMemoryDb();
    seed.session(db, { id: "s1", status, started_at: T0, ended_at: T0 + 60 * MIN });
    seed.prompt(db, { session_id: "s1", id: "p1", ts: T0, seq: 0 });
    seed.toolCall(db, { session_id: "s1", id: "pending", name: "Bash", ts_start: T0 + 10 * MIN, duration_ms: null, status: "pending" });
    seed.prompt(db, { session_id: "s1", id: "p2", ts: T0 + 40 * MIN, seq: 1, kind: "follow_up" });
    return timeline(db);
  };

  const running = await pending("running");
  expect(running.tools).toEqual([{ id: "pending", agentId: "main", name: "Bash", target: null, start: T0 + 10 * MIN, durationMs: null, status: "pending" }]);
  expect(running.gaps).toEqual([{ start: T0, end: T0 + 10 * MIN }]);

  expect((await pending("completed")).gaps).toEqual([
    { start: T0, end: T0 + 10 * MIN },
    { start: T0 + 10 * MIN, end: T0 + 40 * MIN },
    { start: T0 + 40 * MIN, end: T0 + 60 * MIN },
  ]);
});

test("times out of order: gaps do not overlap and lie inside the session", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", started_at: T0, ended_at: T0 + 30 * MIN });
  // The clock jumped back: the result is recorded earlier than the call.
  db.run("INSERT INTO tool_calls (session_id, id, agent_id, name, ts_start, ts_end, duration_ms, status) VALUES ('s1', 'back', 'main', 'Bash', ?, ?, 0, 'ok')", [T0 + 10 * MIN, T0 + 9 * MIN]);
  // An event beyond the session bounds.
  seed.apiError(db, { session_id: "s1", id: "late", ts: T0 + 50 * MIN });
  seed.prompt(db, { session_id: "s1", id: "p1", ts: T0 + 20 * MIN, seq: 0 });

  expect((await timeline(db)).gaps).toEqual([
    { start: T0, end: T0 + 10 * MIN },
    { start: T0 + 10 * MIN, end: T0 + 20 * MIN },
    { start: T0 + 20 * MIN, end: T0 + 30 * MIN },
  ]);
});

test("agent bar edges and an API error are events: a gap does not cover them", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", started_at: T0, ended_at: T0 + 30 * MIN });
  seed.agent(db, { session_id: "s1", started_at: T0, ended_at: T0 + 30 * MIN });
  seed.agent(db, { session_id: "s1", agent_id: "bg-1", parent_agent_id: "main", depth: 1, started_at: T0 + 8 * MIN, ended_at: T0 + 12 * MIN });
  seed.apiError(db, { session_id: "s1", id: "err-1", ts: T0 + 20 * MIN });

  expect((await timeline(db)).gaps).toEqual([
    { start: T0, end: T0 + 8 * MIN },
    { start: T0 + 12 * MIN, end: T0 + 20 * MIN },
    { start: T0 + 20 * MIN, end: T0 + 30 * MIN },
  ]);
});

test("a session without idle periods and a session without timestamps have no gaps", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "short", started_at: T0, ended_at: T0 + 5 * MIN });
  seed.session(db, { id: "empty", started_at: null, ended_at: null });
  seed.agent(db, { session_id: "empty", started_at: null, ended_at: null });

  expect((await timeline(db, "short")).gaps).toEqual([]);
  const empty = await timeline(db, "empty");
  expect(empty.gaps).toEqual([]);
  expect([empty.session.startedAt, empty.session.endedAt]).toEqual([0, 0]);
  expect(empty.agents.map((agent) => [agent.start, agent.end])).toEqual([[0, 0]]);
});

// ── Order, session bounds, volume ───────────────────────────────────────────────────────────

test("each track is returned by time, agents as a tree", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", started_at: T0, ended_at: T0 + MIN });
  seed.agent(db, { session_id: "s1" });
  seed.agent(db, { session_id: "s1", agent_id: "b", parent_agent_id: "main", depth: 1, started_at: T0 + 2_000 });
  seed.agent(db, { session_id: "s1", agent_id: "a", parent_agent_id: "main", depth: 1, started_at: T0 + 5_000 });
  seed.agent(db, { session_id: "s1", agent_id: "b-child", parent_agent_id: "b", depth: 2, started_at: T0 + 6_000 });
  // Inserted not in time order; agent "b" works interleaved with the main one.
  seed.toolCall(db, { session_id: "s1", id: "t3", ts_start: T0 + 3_000 });
  seed.toolCall(db, { session_id: "s1", id: "t1", agent_id: "b", ts_start: T0 + 1_000 });
  seed.toolCall(db, { session_id: "s1", id: "t2b", ts_start: T0 + 2_000 });
  seed.toolCall(db, { session_id: "s1", id: "t2a", agent_id: "b", ts_start: T0 + 2_000 });
  for (const id of ["t3", "t1", "t2b", "t2a"]) seed.fileOp(db, { session_id: "s1", tool_call_id: id, path: "/app/a.ts", ts: T0 + Number(id[1]) * 1_000 });
  seed.modelCall(db, { session_id: "s1", id: "req-2", ts_start: T0 + 2_000 });
  seed.modelCall(db, { session_id: "s1", id: "req-1", agent_id: "b", ts_start: T0 + 1_000 });
  seed.apiError(db, { session_id: "s1", id: "err-2", ts: T0 + 2_000 });
  seed.apiError(db, { session_id: "s1", id: "err-1", agent_id: "b", ts: T0 + 1_000 });
  seed.prompt(db, { session_id: "s1", id: "p2", ts: T0 + 9_000, seq: 1, kind: "follow_up" });
  seed.prompt(db, { session_id: "s1", id: "p1", ts: T0, seq: 0 });

  const body = await timeline(db);
  expect(body.agents.map((agent) => agent.agentId)).toEqual(["main", "b", "b-child", "a"]);
  expect(body.tools.map((tool) => tool.id)).toEqual(["t1", "t2a", "t2b", "t3"]);
  expect(body.files.map((op) => op.toolCallId)).toEqual(["t1", "t2a", "t2b", "t3"]);
  expect(body.modelCalls.map((call) => call.id)).toEqual(["req-1", "req-2"]);
  expect(body.apiErrors.map((error) => error.id)).toEqual(["err-1", "err-2"]);
  expect(body.prompts.map((prompt) => prompt.id)).toEqual(["p1", "p2"]);
});

test("events of another session with the same ids do not get into the response", async () => {
  const db = openMemoryDb();
  // A continued session copies the history of the original: ids match.
  for (const [id, offset] of [["s1", 0], ["s2", 60 * MIN]] as const) {
    seed.session(db, { id, started_at: T0 + offset, ended_at: T0 + offset + MIN });
    seed.agent(db, { session_id: id, started_at: T0 + offset, ended_at: T0 + offset + MIN });
    seed.prompt(db, { session_id: id, id: "p1", ts: T0 + offset });
    seed.modelCall(db, { session_id: id, id: "req-1", ts_start: T0 + offset });
    seed.toolCall(db, { session_id: id, id: "t1", ts_start: T0 + offset, status: id === "s2" ? "error" : "ok" });
    seed.fileOp(db, { session_id: id, tool_call_id: "t1", path: "/app/a.ts", ts: T0 + offset });
    seed.externalRequest(db, { session_id: id, tool_call_id: "t1", ts: T0 + offset });
    seed.apiError(db, { session_id: id, id: "err-1", ts: T0 + offset });
  }

  const body = await timeline(db, "s1");
  expect(body.gaps).toEqual([]);
  expect(body.prompts).toEqual([{ id: "p1", ts: T0, kind: "original" }]);
  expect(body.agents.map((agent) => agent.start)).toEqual([T0]);
  expect(body.tools.map((tool) => [tool.start, tool.status])).toEqual([[T0, "ok"]]);
  expect(body.files).toEqual([{ toolCallId: "t1", agentId: "main", path: "/app/a.ts", op: "read", ts: T0, error: false }]);
  expect(body.modelCalls.map((call) => call.start)).toEqual([T0]);
  expect(body.apiErrors.map((error) => error.ts)).toEqual([T0]);
  expect(body.external.map((request) => [request.ts, request.error])).toEqual([[T0, false]]);
});

test("a model call with an exact duration ends at the end of the response, one with an estimated duration starts at the estimate", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", started_at: T0, ended_at: T0 + 10_000 });
  seed.agent(db, { session_id: "s1" });
  seed.modelCall(db, { session_id: "s1", id: "exact", ts_start: T0, ts_end: T0 + 5000, duration_ms: 3000, duration_exact: 1 });
  seed.modelCall(db, { session_id: "s1", id: "estimated", ts_start: T0 + 6000, ts_end: T0 + 9000, duration_ms: 3000, duration_exact: 0 });

  const body = await timeline(db);
  expect(body.modelCalls.map((call) => [call.id, call.start - T0, call.durationMs])).toEqual([
    ["exact", 2000, 3000],
    ["estimated", 6000, 3000],
  ]);
});

test("the number of database queries does not grow with the number of calls", async () => {
  const queries = async (calls: number): Promise<number> => {
    const db = openMemoryDb();
    seed.session(db, { id: "s1", started_at: T0, ended_at: T0 + calls * 2_000 });
    seed.agent(db, { session_id: "s1" });
    for (let n = 0; n < calls; n++) {
      seed.modelCall(db, { session_id: "s1", id: `req-${n}`, ts_start: T0 + n * 2_000 });
      seed.toolCall(db, { session_id: "s1", id: `t-${n}`, ts_start: T0 + n * 2_000 + 1_000 });
      seed.fileOp(db, { session_id: "s1", tool_call_id: `t-${n}`, path: `/app/${n}.ts`, ts: T0 + n * 2_000 + 1_000 });
    }
    let count = 0;
    const query = db.query.bind(db);
    db.query = ((sql: string) => {
      count++;
      return query(sql);
    }) as typeof db.query;
    expect((await timeline(db)).tools).toHaveLength(calls);
    return count;
  };

  const few = await queries(3);
  expect(few).toBeGreaterThan(0);
  expect(await queries(300)).toBe(few);
});

test("no session — 404", async () => {
  const response = await testApi(openMemoryDb()).request("/api/sessions/missing/timeline");
  expect(response.status).toBe(404);
  expect(((await response.json()) as ApiError).error).toContain("missing");
});

// ── Reference session ───────────────────────────────────────────────────────────────────────

test("the reference session timeline matches the dto example", async () => {
  const db = openMemoryDb();
  seedReference(db);
  const fixture = timelineFixture as TimelineResponse;
  const byTime = <Mark>(marks: Mark[], ts: (mark: Mark) => number, id: (mark: Mark) => string): Mark[] =>
    [...marks].sort((a, b) => ts(a) - ts(b) || (id(a) < id(b) ? -1 : 1));

  // The example generator returns calls in scenario order (by agent), the API — by time: the composition
  // of the tracks is compared as a whole, the example's order is brought to the API order.
  expect(await timeline(db, REF_SESSION_ID)).toEqual({
    ...fixture,
    tools: byTime(fixture.tools, (tool) => tool.start, (tool) => tool.id),
    files: byTime(fixture.files, (op) => op.ts, (op) => op.toolCallId),
    modelCalls: byTime(fixture.modelCalls, (call) => call.start, (call) => call.id),
  });
  expect(fixture.gaps).toEqual([]);
});

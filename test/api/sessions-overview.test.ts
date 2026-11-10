// GET /api/sessions/:id: session overview.
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createApi } from "../../src/api/routes.ts";
import type { ApiError, SessionOverview } from "../../src/contracts/api.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import sessionFixture from "../fixtures/dto/session.json";
import { testConfig } from "../support/api.ts";
import { REF_SESSION_ID } from "../support/reference.ts";
import { seedReference } from "../support/reference-seed.ts";
import { seed } from "../support/seed.ts";

const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);

function api(db: Database) {
  const app = createApi({ db, config: testConfig(), now: () => 0 });
  return {
    request: (id: string) => app.request(`/api/sessions/${encodeURIComponent(id)}`),
    async overview(id: string): Promise<SessionOverview> {
      const response = await this.request(id);
      expect(response.status).toBe(200);
      return (await response.json()) as SessionOverview;
    },
  };
}

test("the response fills every SessionOverview field with values from the database", async () => {
  const db = openMemoryDb();
  seed.session(db, {
    id: "s1",
    cwd: "/private/tmp/work/shop",
    project: "shop",
    is_temp_dir: 1,
    name: "Speed up checkout",
    name_source: "custom",
    cc_version: "2.1.300",
    git_branch: "feat/checkout",
    primary_model: "claude-sonnet-4-5",
    started_at: T0,
    ended_at: T0 + 900_000,
    active_ms: 420_000,
    model_ms: 310_000,
    model_ms_exact: 1,
    status: "running",
    agents_count: 2,
    model_calls: 12,
    tool_calls: 4,
    tool_errors: 1,
    api_errors: 2,
    tok_input: 1_100,
    tok_output: 2_200,
    tok_cache_read: 33_000,
    tok_cache_write: 4_400,
    tok_thinking: 550,
    tok_total: 40_700,
    cost_usd: 1.23,
    cost_reported_usd: 1.31,
    enrichment: "partial",
    transcript_present: 0,
  });
  seed.agent(db, { session_id: "s1", model: "claude-sonnet-4-5", ctx_window: 1_000_000, ctx_peak: 250_000, run_ms: 880_000, tool_calls: 3, tool_errors: 1, api_errors: 2, files_read: 2 });
  seed.agent(db, {
    session_id: "s1",
    agent_id: "explore-1",
    parent_agent_id: "main",
    depth: 1,
    type: "Explore",
    description: "Find slow queries",
    model: "claude-haiku-4-5",
    started_at: T0 + 60_000,
    ctx_window: 200_000,
    ctx_peak: 31_000,
    run_ms: 45_000,
    tool_calls: 1,
    tool_errors: 0,
    api_errors: 0,
    files_read: 1,
  });
  seed.prompt(db, { session_id: "s1", id: "p1", ts: T0, seq: 0, kind: "original", text: "Make checkout faster", tokens_est: 5, attachments_json: JSON.stringify(["trace.json", "notes.md"]) });
  seed.prompt(db, { session_id: "s1", id: "p2", ts: T0 + 300_000, seq: 1, kind: "follow_up", text: "Keep the public API", tokens_est: 4 });
  seed.toolCall(db, { session_id: "s1", id: "t1", name: "Read", ts_start: T0 + 1_000 });
  seed.toolCall(db, { session_id: "s1", id: "t2", name: "Bash", ts_start: T0 + 2_000, status: "error" });
  seed.toolCall(db, { session_id: "s1", id: "t3", name: "Read", ts_start: T0 + 3_000 });
  seed.toolCall(db, { session_id: "s1", id: "t4", agent_id: "explore-1", name: "Grep", ts_start: T0 + 61_000 });

  expect(await api(db).overview("s1")).toEqual({
    id: "s1",
    name: "Speed up checkout",
    nameSource: "custom",
    project: "shop",
    cwd: "/private/tmp/work/shop",
    isTempDir: true,
    status: "running",
    enrichment: "partial",
    transcriptPresent: false,
    primaryModel: "claude-sonnet-4-5",
    ccVersion: "2.1.300",
    gitBranch: "feat/checkout",
    startedAt: T0,
    endedAt: T0 + 900_000,
    activeMs: 420_000,
    modelMs: 310_000,
    modelMsExact: true,
    tokens: { input: 1_100, output: 2_200, cacheRead: 33_000, cacheWrite: 4_400, thinking: 550, total: 40_700 },
    agentsCount: 2,
    modelCalls: 12,
    toolCalls: 4,
    toolErrors: 1,
    apiErrors: 2,
    costUsd: 1.23,
    costReportedUsd: 1.31,
    contextWindow: 1_000_000,
    prompts: [
      { id: "p1", ts: T0, kind: "original", text: "Make checkout faster", tokensEst: 5, attachments: ["trace.json", "notes.md"] },
      { id: "p2", ts: T0 + 300_000, kind: "follow_up", text: "Keep the public API", tokensEst: 4, attachments: [] },
    ],
    agents: [
      {
        agentId: "main",
        parentAgentId: null,
        depth: 0,
        type: null,
        description: null,
        model: "claude-sonnet-4-5",
        ctxPeak: 250_000,
        ctxWindow: 1_000_000,
        runMs: 880_000,
        toolCalls: 3,
        toolErrors: 1,
        apiErrors: 2,
        filesRead: 2,
        toolUsage: [
          { name: "Read", count: 2, errors: 0 },
          { name: "Bash", count: 1, errors: 1 },
        ],
      },
      {
        agentId: "explore-1",
        parentAgentId: "main",
        depth: 1,
        type: "Explore",
        description: "Find slow queries",
        model: "claude-haiku-4-5",
        ctxPeak: 31_000,
        ctxWindow: 200_000,
        runMs: 45_000,
        toolCalls: 1,
        toolErrors: 0,
        apiErrors: 0,
        filesRead: 1,
        toolUsage: [{ name: "Grep", count: 1, errors: 0 }],
      },
    ],
  } satisfies SessionOverview);
});

test("the reference session overview matches the dto/session.json example", async () => {
  const db = openMemoryDb();
  seedReference(db);
  const body = await api(db).overview(REF_SESSION_ID);
  expect(body).toEqual(sessionFixture as SessionOverview);
  expect(body.agents).toHaveLength(5);
  expect(body.prompts.map((prompt) => prompt.kind)).toEqual(["original", "follow_up", "follow_up"]);
});

test("agents form a tree: the main one first, a nested one right after its parent, siblings by launch time", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", agents_count: 6 });
  // Inserted in a jumble: the response order depends neither on row order nor on ids.
  seed.agent(db, { session_id: "s1", agent_id: "b-late", parent_agent_id: "main", depth: 1, started_at: T0 + 50_000 });
  seed.agent(db, { session_id: "s1", agent_id: "a-nested-2", parent_agent_id: "z-early", depth: 2, started_at: T0 + 30_000 });
  seed.agent(db, { session_id: "s1", agent_id: "z-early", parent_agent_id: "main", depth: 1, started_at: T0 + 10_000 });
  seed.agent(db, { session_id: "s1", agent_id: "c-deep", parent_agent_id: "a-nested-1", depth: 3, started_at: T0 + 25_000 });
  seed.agent(db, { session_id: "s1", agent_id: "a-nested-1", parent_agent_id: "z-early", depth: 2, started_at: T0 + 20_000 });
  seed.agent(db, { session_id: "s1", agent_id: "main", started_at: T0 });

  const { agents } = await api(db).overview("s1");
  expect(agents.map((agent) => [agent.agentId, agent.depth])).toEqual([
    ["main", 0],
    ["z-early", 1],
    ["a-nested-1", 2],
    ["c-deep", 3],
    ["a-nested-2", 2],
    ["b-late", 1],
  ]);
});

test("an agent whose parent did not reach the database stays in the response after the main one", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1", agent_id: "orphan", parent_agent_id: "missing", depth: 2, started_at: T0 + 5_000 });
  seed.agent(db, { session_id: "s1", agent_id: "main", started_at: T0 + 9_000 });
  expect((await api(db).overview("s1")).agents.map((agent) => agent.agentId)).toEqual(["main", "orphan"]);
});

test("toolUsage is computed from tool_calls: by agent, by descending call count, errors are only the error status", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.session(db, { id: "other" });
  // The counters in the agent row deliberately differ from the calls: toolUsage is taken from tool_calls.
  seed.agent(db, { session_id: "s1", tool_calls: 99, tool_errors: 99 });
  seed.agent(db, { session_id: "s1", agent_id: "sub", parent_agent_id: "main", depth: 1 });
  seed.agent(db, { session_id: "s1", agent_id: "idle", parent_agent_id: "main", depth: 1, started_at: T0 + 1 });
  const statuses = ["ok", "error", "denied", "interrupted", "pending", "error"] as const;
  statuses.forEach((status, n) => seed.toolCall(db, { session_id: "s1", id: `bash-${n}`, name: "Bash", status }));
  seed.toolCall(db, { session_id: "s1", id: "edit-1", name: "Edit" });
  seed.toolCall(db, { session_id: "s1", id: "edit-2", name: "Edit", status: "error" });
  seed.toolCall(db, { session_id: "s1", id: "write-1", name: "Write" });
  seed.toolCall(db, { session_id: "s1", id: "agent-1", name: "Agent" });
  seed.toolCall(db, { session_id: "s1", id: "sub-1", agent_id: "sub", name: "Bash" });
  seed.toolCall(db, { session_id: "other", id: "bash-0", name: "Bash", status: "error" });

  const { agents } = await api(db).overview("s1");
  expect(agents.map((agent) => [agent.agentId, agent.toolUsage])).toEqual([
    [
      "main",
      [
        { name: "Bash", count: 6, errors: 2 },
        { name: "Edit", count: 2, errors: 1 },
        { name: "Agent", count: 1, errors: 0 },
        { name: "Write", count: 1, errors: 0 },
      ],
    ],
    ["sub", [{ name: "Bash", count: 1, errors: 0 }]],
    ["idle", []],
  ]);
  expect(agents[0]).toMatchObject({ toolCalls: 99, toolErrors: 99 });
});

test("prompts go by time, text is read from contents, including compressed", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  const long = "A long prompt with non-ASCII text café. ".repeat(400);
  seed.prompt(db, { session_id: "s1", id: "p-late", ts: T0 + 2_000, seq: 2, kind: "follow_up", text: "third" });
  seed.prompt(db, { session_id: "s1", id: "p-first", ts: T0, seq: 0, kind: "original", text: long });
  seed.prompt(db, { session_id: "s1", id: "p-mid", ts: T0 + 1_000, seq: 1, kind: "follow_up", text: "second" });
  seed.prompt(db, { session_id: "other", id: "p-other", text: "foreign prompt" });

  const { prompts } = await api(db).overview("s1");
  expect(prompts.map((prompt) => [prompt.id, prompt.kind])).toEqual([
    ["p-first", "original"],
    ["p-mid", "follow_up"],
    ["p-late", "follow_up"],
  ]);
  expect(prompts[0]!.text).toBe(long);
  expect(prompts[2]!.text).toBe("third");
});

test("a session with an unknown model has costUsd: null", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", primary_model: "claude-unknown-9", cost_usd: null, cost_reported_usd: null });
  seed.agent(db, { session_id: "s1", model: "claude-unknown-9", cost_usd: null, ctx_window: null });
  seed.modelCall(db, { session_id: "s1", id: "r1", model: "claude-unknown-9", cost_usd: null });
  expect(await api(db).overview("s1")).toMatchObject({ costUsd: null, costReportedUsd: null, contextWindow: null, primaryModel: "claude-unknown-9" });
});

test("contextWindow is the main agent's window, not the largest in the session", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1", agent_id: "big", parent_agent_id: "main", depth: 1, ctx_window: 1_000_000 });
  seed.agent(db, { session_id: "s1", ctx_window: 200_000 });
  expect((await api(db).overview("s1")).contextWindow).toBe(200_000);
});

test("a session without agents, prompts and a name: empty lists, the name is the id", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "bare", name: null, name_source: null, project: null, cwd: null, started_at: null, ended_at: null });
  expect(await api(db).overview("bare")).toMatchObject({
    id: "bare",
    name: "bare",
    nameSource: null,
    project: null,
    cwd: null,
    startedAt: null,
    endedAt: null,
    contextWindow: null,
    prompts: [],
    agents: [],
  });
});

test("unknown session — 404 with ApiError", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  const response = await api(db).request("nope");
  expect(response.status).toBe(404);
  expect(((await response.json()) as ApiError).error).toContain("nope");
});

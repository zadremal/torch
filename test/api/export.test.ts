// GET /api/sessions/:id/export: normalized session.
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createApi } from "../../src/api/routes.ts";
import type { ApiError, SessionExport } from "../../src/contracts/api.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { getContent } from "../../src/ingest/reduce/contents.ts";
import { testConfig } from "../support/api.ts";
import { REF_SESSION_ID } from "../support/reference.ts";
import { seedReference } from "../support/reference-seed.ts";
import { seed } from "../support/seed.ts";

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);

function api(db: Database) {
  const app = createApi({ db, config: testConfig(), now: () => NOW });
  return {
    request: (id: string) => app.request(`/api/sessions/${encodeURIComponent(id)}/export`),
    async export(id: string): Promise<SessionExport> {
      const response = await this.request(id);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      return (await response.json()) as SessionExport;
    },
  };
}

const byId = <Row extends { id: string }>(rows: Row[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

test("export of the reference session returns the session with all agents and calls — database rows as they are", async () => {
  const db = openMemoryDb();
  const ref = seedReference(db);
  const body = await api(db).export(REF_SESSION_ID);

  expect(body.exportedAt).toBe(NOW);
  expect(body.session).toEqual(ref.session);
  expect(body.agents).toEqual(ref.agents);
  expect(body.agents).toHaveLength(5);
  expect(body.modelCalls).toHaveLength(142);
  expect(byId(body.modelCalls)).toEqual(byId(ref.modelCalls));
  expect(body.toolCalls).toHaveLength(186);
  expect(byId(body.toolCalls)).toEqual(byId(ref.toolCalls));
  expect(body.toolCalls.filter((call) => call.status === "error")).toHaveLength(7);
  expect(byId(body.fileOps)).toEqual(byId(ref.fileOps));
  expect(byId(body.externalRequests)).toEqual(byId(ref.externalRequests));
  expect(body.apiErrors).toHaveLength(3);
  expect(byId(body.apiErrors)).toEqual(byId(ref.apiErrors));
  expect(byId(body.messages)).toEqual(byId(ref.messages));
  expect(byId(body.instructions)).toEqual(byId(ref.instructions));
  expect(body.compactions).toEqual([]);
  expect(body.prompts).toEqual(ref.prompts.map((prompt) => ({ ...prompt, text: getContent(db, prompt.content_id)!.text })));
  // Calls of each agent are in place, not only the main one.
  for (const agent of ref.agents) {
    expect({ agent: agent.agent_id, tools: body.toolCalls.filter((call) => call.agent_id === agent.agent_id).length }).toEqual({ agent: agent.agent_id, tools: agent.tool_calls });
    expect({ agent: agent.agent_id, calls: body.modelCalls.filter((call) => call.agent_id === agent.agent_id).length }).toEqual({ agent: agent.agent_id, calls: agent.model_calls });
  }
});

test("each session table lands in its own section, rows by time, another session is not mixed in", async () => {
  const db = openMemoryDb();
  const session = seed.session(db, { id: "s1", name: "Export me" });
  const agents = [
    seed.agent(db, { session_id: "s1" }),
    seed.agent(db, { session_id: "s1", agent_id: "sub", parent_agent_id: "main", depth: 1, type: "Explore", started_at: T0 + 500 }),
  ];
  const prompt = seed.prompt(db, { session_id: "s1", id: "p1", text: "Make an export", attachments_json: JSON.stringify(["a.txt"]) });
  const modelCalls = [
    seed.modelCall(db, { session_id: "s1", id: "r1", ts_start: T0 + 100, tok_input: 10, tok_output: 20 }),
    seed.modelCall(db, { session_id: "s1", id: "r2", agent_id: "sub", ts_start: T0 + 600 }),
  ];
  const toolCalls = [
    seed.toolCall(db, { session_id: "s1", id: "t1", model_call_id: "r1", name: "Read", ts_start: T0 + 200, input: '{"file_path":"/a"}', output: "body" }),
    seed.toolCall(db, { session_id: "s1", id: "t2", agent_id: "sub", model_call_id: "r2", name: "WebFetch", ts_start: T0 + 700, status: "error", error_title: "404" }),
    seed.toolCall(db, { session_id: "s1", id: "t3", name: "Bash", ts_start: T0 + 800, duration_ms: null, status: "pending" }),
  ];
  const fileOp = seed.fileOp(db, { session_id: "s1", tool_call_id: "t1", path: "/a", ts: T0 + 200 });
  const external = seed.externalRequest(db, { session_id: "s1", tool_call_id: "t2", agent_id: "sub", status_code: 404, ts: T0 + 700 });
  const apiError = seed.apiError(db, { session_id: "s1", id: "e1", ts: T0 + 50 });
  const messages = [
    seed.message(db, { session_id: "s1", id: "m1", model_call_id: "r1", kind: "thinking", ts: T0 + 150, text: "hmm" }),
    seed.message(db, { session_id: "s1", id: "m2", model_call_id: "r1", ts: T0 + 160, text: "done" }),
  ];
  const compaction = seed.compaction(db, { session_id: "s1", id: "c1", ts: T0 + 900 });
  const instruction = seed.instruction(db, { session_id: "s1", id: "i1", file_path: "/repo/CLAUDE.md" });

  // Another session with the same event ids: it does not get into the s1 export.
  seed.session(db, { id: "s2" });
  seed.agent(db, { session_id: "s2" });
  seed.prompt(db, { session_id: "s2", id: "p1", text: "foreign" });
  seed.modelCall(db, { session_id: "s2", id: "r1" });
  seed.toolCall(db, { session_id: "s2", id: "t1" });
  seed.fileOp(db, { session_id: "s2", tool_call_id: "t1", path: "/b" });
  seed.externalRequest(db, { session_id: "s2", tool_call_id: "t1" });
  seed.apiError(db, { session_id: "s2", id: "e1" });
  seed.message(db, { session_id: "s2", id: "m1" });
  seed.compaction(db, { session_id: "s2", id: "c1" });
  seed.instruction(db, { session_id: "s2", id: "i1", file_path: "/other/CLAUDE.md" });

  expect(await api(db).export("s1")).toEqual({
    exportedAt: NOW,
    session,
    agents,
    prompts: [{ ...prompt, text: "Make an export" }],
    modelCalls,
    toolCalls,
    fileOps: [fileOp],
    externalRequests: [external],
    apiErrors: [apiError],
    messages,
    compactions: [compaction],
    instructions: [instruction],
  } satisfies SessionExport);
});

test("agents in the export form a tree, calls go by start time", async () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1", agent_id: "nested", parent_agent_id: "sub", depth: 2, started_at: T0 + 2_000 });
  seed.agent(db, { session_id: "s1", agent_id: "sub", parent_agent_id: "main", depth: 1, started_at: T0 + 1_000 });
  seed.agent(db, { session_id: "s1" });
  seed.toolCall(db, { session_id: "s1", id: "a-late", ts_start: T0 + 300 });
  seed.toolCall(db, { session_id: "s1", id: "z-early", ts_start: T0 + 100 });
  seed.modelCall(db, { session_id: "s1", id: "a-late", ts_start: T0 + 250 });
  seed.modelCall(db, { session_id: "s1", id: "z-early", ts_start: T0 + 50 });

  const body = await api(db).export("s1");
  expect(body.agents.map((agent) => agent.agent_id)).toEqual(["main", "sub", "nested"]);
  expect(ids(body.toolCalls)).toEqual(["z-early", "a-late"]);
  expect(ids(body.modelCalls)).toEqual(["z-early", "a-late"]);
});

test("session without events: empty sections", async () => {
  const db = openMemoryDb();
  const session = seed.session(db, { id: "empty" });
  expect(await api(db).export("empty")).toEqual({
    exportedAt: NOW,
    session,
    agents: [],
    prompts: [],
    modelCalls: [],
    toolCalls: [],
    fileOps: [],
    externalRequests: [],
    apiErrors: [],
    messages: [],
    compactions: [],
    instructions: [],
  } satisfies SessionExport);
});

test("unknown session — 404 with ApiError", async () => {
  const response = await api(openMemoryDb()).request("nope");
  expect(response.status).toBe(404);
  expect(((await response.json()) as ApiError).error).toContain("nope");
});

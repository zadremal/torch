// Session agents: an agent row from its file and meta.json, the link of a subagent to the parent call
// by meta.json and by agentId, depth and parent of a nested one (plan §3.1).
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { MAIN_AGENT_ID } from "../../../src/contracts/constants.ts";
import type { AgentMeta } from "../../../src/contracts/lines.ts";
import type { DeriveContext } from "../../../src/contracts/pipeline.ts";
import type { AgentRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { linkAgents, reduceAgents } from "../../../src/ingest/reduce/agents.ts";
import { REF_PRICES } from "../../support/reference.ts";
import { seed } from "../../support/seed.ts";
import { text, transcript, type Transcript } from "../../support/transcript.ts";
import { context, contentText, parsed, rows } from "./session.support.ts";

const START = Date.UTC(2026, 9, 1, 10, 0, 0);

const meta = (fields: Partial<AgentMeta>): AgentMeta => ({ agentType: null, description: null, toolUseId: null, spawnDepth: null, model: null, parentAgentId: null, ...fields });

const derive = (db: Database, sessionId = "s1"): DeriveContext => ({ db, sessionId, prices: REF_PRICES, now: START });

type Link = Pick<AgentRow, "agent_id" | "parent_agent_id" | "depth" | "spawn_tool_call_id">;

const links = (db: Database, sessionId = "s1"): Link[] =>
  rows<Link>(db, `SELECT agent_id, parent_agent_id, depth, spawn_tool_call_id FROM agents WHERE session_id = '${sessionId}' ORDER BY agent_id`);

const agentRow = (db: Database, agentId: string) => rows<AgentRow>(db, `SELECT * FROM agents WHERE session_id = 's1' AND agent_id = '${agentId}'`)[0]!;

/** Main agent file with one prompt. */
function mainFile(db: Database): Transcript {
  const t = transcript({ sessionId: "s1", startAt: START });
  t.prompt("Fix the bug");
  reduceAgents(context(db, t), parsed(t));
  return t;
}

/** Subagent file with a task from the parent and one reply. */
function subagentFile(db: Database, agentId: string, agentMeta: AgentMeta | null, sessionId = "s1"): Transcript {
  const t = transcript({ sessionId, agentId, startAt: START + 10_000 });
  t.prompt(`Task for ${agentId}`);
  t.tick(5000).assistant({ blocks: [text("Report")] });
  reduceAgents(context(db, t, { agentMeta }), parsed(t));
  return t;
}

// ── Agent row ───────────────────────────────────────────────────────────────────────────────

test("main agent: identifier main, depth 0, no parent, prompt is the user's first message", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", startAt: START });
  t.prompt("Fix the bug");
  t.tick(3000).assistant({ blocks: [text("Done")] });
  t.tick(1000).prompt("Now the docs");
  reduceAgents(context(db, t), parsed(t));

  const row = agentRow(db, MAIN_AGENT_ID);
  expect(row).toMatchObject({ parent_agent_id: null, depth: 0, spawn_tool_call_id: null, type: null, description: null, started_at: START, ended_at: START + 4000 });
  expect(contentText(db, row.prompt_content_id)).toBe("Fix the bug");
});

test("subagent: kind, description, parent call and depth come from meta.json, prompt is the task from the parent", () => {
  const db = openMemoryDb();
  subagentFile(db, "a1", meta({ agentType: "Explore", description: "Find billing imports", toolUseId: "toolu_spawn", spawnDepth: 1 }));

  const row = agentRow(db, "a1");
  expect(row).toMatchObject({
    parent_agent_id: null,
    depth: 1,
    spawn_tool_call_id: "toolu_spawn",
    type: "Explore",
    description: "Find billing imports",
    started_at: START + 10_000,
    ended_at: START + 15_000,
  });
  expect(contentText(db, row.prompt_content_id)).toBe("Task for a1");
});

test("a subagent without meta.json gets depth 1 and stays without a kind and parent", () => {
  const db = openMemoryDb();
  subagentFile(db, "a1", null);
  expect(agentRow(db, "a1")).toMatchObject({ parent_agent_id: null, depth: 1, spawn_tool_call_id: null, type: null, description: null });
});

test("parentAgentId from meta.json becomes the parent even before linking", () => {
  const db = openMemoryDb();
  subagentFile(db, "a2", meta({ toolUseId: "toolu_nested", spawnDepth: 2, parentAgentId: "a1" }));
  expect(links(db)).toEqual([{ agent_id: "a2", parent_agent_id: "a1", depth: 2, spawn_tool_call_id: "toolu_nested" }]);
});

test("the reducer does not touch the derived columns", () => {
  const db = openMemoryDb();
  const t = mainFile(db);
  db.exec("UPDATE agents SET model = 'claude-opus-5-5', run_ms = 900, tool_calls = 7, ctx_peak = 1000");
  reduceAgents(context(db, t), parsed(t));
  expect(agentRow(db, MAIN_AGENT_ID)).toMatchObject({ model: "claude-opus-5-5", run_ms: 900, tool_calls: 7, ctx_peak: 1000 });
});

// ── Link to the parent call ─────────────────────────────────────────────────────────────────

test("link by meta.json: toolUseId is the parent's Agent call", () => {
  const db = openMemoryDb();
  mainFile(db);
  subagentFile(db, "a1", meta({ agentType: "Explore", toolUseId: "toolu_spawn", spawnDepth: 1 }));
  // The call row has no spawned_agent_id: the link rests only on meta.json.
  seed.toolCall(db, { session_id: "s1", id: "toolu_spawn", name: "Agent", agent_id: MAIN_AGENT_ID, spawned_agent_id: null });

  linkAgents(derive(db));
  expect(links(db)).toEqual([
    { agent_id: "a1", parent_agent_id: MAIN_AGENT_ID, depth: 1, spawn_tool_call_id: "toolu_spawn" },
    { agent_id: MAIN_AGENT_ID, parent_agent_id: null, depth: 0, spawn_tool_call_id: null },
  ]);
});

test("link by agentId: without meta.json the parent is found by the Agent call result", () => {
  const db = openMemoryDb();
  mainFile(db);
  subagentFile(db, "a1", null);
  seed.toolCall(db, { session_id: "s1", id: "toolu_spawn", name: "Agent", agent_id: MAIN_AGENT_ID, spawned_agent_id: "a1" });
  seed.toolCall(db, { session_id: "s1", id: "toolu_other", name: "Agent", agent_id: MAIN_AGENT_ID, spawned_agent_id: "a9" });

  linkAgents(derive(db));
  expect(links(db)).toContainEqual({ agent_id: "a1", parent_agent_id: MAIN_AGENT_ID, depth: 1, spawn_tool_call_id: "toolu_spawn" });
});

test("a nested subagent gets a parent and depth 2 — by meta.json and by agentId", () => {
  const db = openMemoryDb();
  mainFile(db);
  subagentFile(db, "a1", meta({ toolUseId: "toolu_spawn_a1", spawnDepth: 1 }));
  subagentFile(db, "a2", meta({ toolUseId: "toolu_spawn_a2", spawnDepth: 2 }));
  subagentFile(db, "a3", null);
  seed.toolCall(db, { session_id: "s1", id: "toolu_spawn_a1", name: "Agent", agent_id: MAIN_AGENT_ID });
  // Both nested ones were launched by subagent a1: the calls are recorded in its file.
  seed.toolCall(db, { session_id: "s1", id: "toolu_spawn_a2", name: "Agent", agent_id: "a1" });
  seed.toolCall(db, { session_id: "s1", id: "toolu_spawn_a3", name: "Agent", agent_id: "a1", spawned_agent_id: "a3" });

  linkAgents(derive(db));
  expect(links(db)).toEqual([
    { agent_id: "a1", parent_agent_id: MAIN_AGENT_ID, depth: 1, spawn_tool_call_id: "toolu_spawn_a1" },
    { agent_id: "a2", parent_agent_id: "a1", depth: 2, spawn_tool_call_id: "toolu_spawn_a2" },
    { agent_id: "a3", parent_agent_id: "a1", depth: 2, spawn_tool_call_id: "toolu_spawn_a3" },
    { agent_id: MAIN_AGENT_ID, parent_agent_id: null, depth: 0, spawn_tool_call_id: null },
  ]);
});

test("depth is computed along the chain of parents when meta.json does not name it", () => {
  const db = openMemoryDb();
  mainFile(db);
  subagentFile(db, "a1", null);
  subagentFile(db, "a2", null);
  subagentFile(db, "a3", null);
  seed.toolCall(db, { session_id: "s1", id: "t1", name: "Agent", agent_id: MAIN_AGENT_ID, spawned_agent_id: "a1" });
  seed.toolCall(db, { session_id: "s1", id: "t2", name: "Agent", agent_id: "a1", spawned_agent_id: "a2" });
  seed.toolCall(db, { session_id: "s1", id: "t3", name: "Agent", agent_id: "a2", spawned_agent_id: "a3" });

  linkAgents(derive(db));
  expect(links(db).map((row) => [row.agent_id, row.parent_agent_id, row.depth])).toEqual([
    ["a1", MAIN_AGENT_ID, 1],
    ["a2", "a1", 2],
    ["a3", "a2", 3],
    [MAIN_AGENT_ID, null, 0],
  ]);
});

test("until the parent's file is loaded, the nested one keeps the depth from meta.json; the link appears with the next pass", () => {
  const db = openMemoryDb();
  mainFile(db);
  subagentFile(db, "a2", meta({ toolUseId: "toolu_spawn_a2", spawnDepth: 2 }));
  linkAgents(derive(db));
  expect(links(db)).toContainEqual({ agent_id: "a2", parent_agent_id: null, depth: 2, spawn_tool_call_id: "toolu_spawn_a2" });

  // The parent's file arrived: its agent row and the Agent call from its file.
  subagentFile(db, "a1", meta({ toolUseId: "toolu_spawn_a1", spawnDepth: 1 }));
  seed.toolCall(db, { session_id: "s1", id: "toolu_spawn_a1", name: "Agent", agent_id: MAIN_AGENT_ID });
  seed.toolCall(db, { session_id: "s1", id: "toolu_spawn_a2", name: "Agent", agent_id: "a1" });
  linkAgents(derive(db));
  expect(links(db)).toContainEqual({ agent_id: "a2", parent_agent_id: "a1", depth: 2, spawn_tool_call_id: "toolu_spawn_a2" });
});

test("a call with the same identifier in another session does not count as a link", () => {
  const db = openMemoryDb();
  mainFile(db);
  subagentFile(db, "a1", meta({ toolUseId: "toolu_spawn", spawnDepth: 1 }));
  // A continued session copies the history: the same tool_use.id and the same agentId in a foreign session.
  seed.toolCall(db, { session_id: "s2", id: "toolu_spawn", name: "Agent", agent_id: "b7", spawned_agent_id: "a1" });

  linkAgents(derive(db));
  expect(links(db)).toContainEqual({ agent_id: "a1", parent_agent_id: null, depth: 1, spawn_tool_call_id: "toolu_spawn" });
});

test("linking does not touch the agents of another session", () => {
  const db = openMemoryDb();
  mainFile(db);
  subagentFile(db, "a1", null, "s2");
  seed.toolCall(db, { session_id: "s2", id: "t1", name: "Agent", agent_id: MAIN_AGENT_ID, spawned_agent_id: "a1" });

  linkAgents(derive(db, "s1"));
  expect(links(db, "s2")).toEqual([{ agent_id: "a1", parent_agent_id: null, depth: 1, spawn_tool_call_id: null }]);
});

test("depth is computed over the agents of its own session: same-named agents of another session are not in the chain", () => {
  const db = openMemoryDb();
  mainFile(db);
  subagentFile(db, "a1", null);
  subagentFile(db, "a2", null);
  seed.toolCall(db, { session_id: "s1", id: "t1", name: "Agent", agent_id: MAIN_AGENT_ID, spawned_agent_id: "a1" });
  // In the other session agent a2 is listed as a descendant of a1. In s1 a2's parent is not found: depth stays 1.
  seed.agent(db, { session_id: "s2", agent_id: "a2", parent_agent_id: "a1", depth: 2 });

  linkAgents(derive(db, "s1"));
  expect(links(db)).toContainEqual({ agent_id: "a2", parent_agent_id: null, depth: 1, spawn_tool_call_id: null });
});

test("a prompt of a later pass leaves no extra body in contents", () => {
  const db = openMemoryDb();
  subagentFile(db, "a1", null);
  const bodies = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM contents")[0]!.n;
  const next = transcript({ sessionId: "s1", agentId: "a1", startAt: START + 60_000 });
  next.prompt("A later message in the same file");
  reduceAgents(context(db, next), parsed(next));

  expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM contents")[0]!.n).toBe(bodies);
});

test("repeated linking and repeated processing of a file change nothing", () => {
  const db = openMemoryDb();
  mainFile(db);
  const sub = subagentFile(db, "a1", null);
  seed.toolCall(db, { session_id: "s1", id: "toolu_spawn", name: "Agent", agent_id: MAIN_AGENT_ID, spawned_agent_id: "a1" });
  linkAgents(derive(db));
  const before = rows<AgentRow>(db, "SELECT * FROM agents ORDER BY agent_id");

  // New rows of the subagent file arrive without meta.json: the link found earlier is kept.
  reduceAgents(context(db, sub), parsed(sub));
  linkAgents(derive(db));
  linkAgents(derive(db));
  expect(rows<AgentRow>(db, "SELECT * FROM agents ORDER BY agent_id")).toEqual(before);
});

test("an agent's time bounds are widened by new rows, the prompt stays the first", () => {
  const db = openMemoryDb();
  const first = subagentFile(db, "a1", null);
  const next = transcript({ sessionId: "s1", agentId: "a1", startAt: START + 60_000 });
  next.prompt("A later message in the same file");
  reduceAgents(context(db, next), parsed(next));
  reduceAgents(context(db, first), []);

  const row = agentRow(db, "a1");
  expect(row).toMatchObject({ started_at: START + 10_000, ended_at: START + 60_000 });
  expect(contentText(db, row.prompt_content_id)).toBe("Task for a1");
});

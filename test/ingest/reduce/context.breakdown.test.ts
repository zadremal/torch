// deriveContext: estimate of the context breakdown at the peak call (plan §6.2, decision 16).
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ContextBreakdownEntry } from "../../../src/contracts/api.ts";
import type { AgentRow, ModelCallRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { putContent } from "../../../src/ingest/reduce/contents.ts";
import { deriveContext } from "../../../src/ingest/reduce/context.ts";
import { REF_PRICES, REF_SESSION_ID } from "../../support/reference.ts";
import { seedReference } from "../../support/reference-seed.ts";
import { SEED_TIME, seed } from "../../support/seed.ts";

/** Second `n` from the start of the example. */
const at = (n: number) => SEED_TIME + n * 1000;

const derive = (db: Database, sessionId = "s1") => deriveContext({ db, sessionId, prices: REF_PRICES, now: 0 });
const agentRow = (db: Database, agentId = "main", id = "s1") =>
  db.query<AgentRow, [string, string]>("SELECT * FROM agents WHERE session_id = ? AND agent_id = ?").get(id, agentId)!;
const entries = (agent: AgentRow) => JSON.parse(agent.ctx_breakdown_json!) as ContextBreakdownEntry[];
/** Agent breakdown: category → tokens. */
const breakdown = (db: Database, agentId = "main") => Object.fromEntries(entries(agentRow(db, agentId)).map((entry) => [entry.category, entry.tokens]));
const total = (agent: AgentRow) => entries(agent).reduce((sum, entry) => sum + entry.tokens, 0);

function withMain(): Database {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1", ctx_breakdown_exact: 1 });
  return db;
}

/** A model call: starts at second `second`, replies for two seconds. */
function call(db: Database, id: string, second: number, ctx_tokens: number, tok_output: number, extra: Partial<ModelCallRow> = {}): void {
  seed.modelCall(db, { session_id: "s1", id, ts_start: at(second), duration_ms: 2000, ctx_tokens, tok_output, ...extra });
}

/** A tool call with a result at second `end`; `tokens` is the estimate of the output size. */
function tool(db: Database, id: string, end: number, tokens: number, agent_id = "main"): void {
  seed.toolCall(db, { session_id: "s1", id, agent_id, ts_start: at(end - 2), duration_ms: 2000, output_bytes: tokens * 4 });
}

function instruction(db: Database, id: string, second: number, tokens_est: number, agent_id = "main"): void {
  seed.instruction(db, { session_id: "s1", id, agent_id, file_path: `/repo/${id}.md`, ts: at(second), tokens_est });
}

describe("categories", () => {
  /**
   * Main agent: a 100-token prompt, 2000 of instructions, first call with a context of 20 000,
   * a peak of 50 000 at the third call. Before the peak the model wrote 400 + 500 tokens, the tools returned
   * 1000 + 2000.
   */
  function seeded(): Database {
    const db = withMain();
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0), tokens_est: 100 });
    instruction(db, "user-memory", 0, 1500);
    instruction(db, "project-memory", 0, 500);
    call(db, "m1", 0, 20_000, 400);
    tool(db, "t1", 4, 1000);
    call(db, "m2", 10, 30_000, 500);
    tool(db, "t2", 14, 2000);
    call(db, "m3", 20, 50_000, 600);
    call(db, "m4", 30, 40_000, 700);
    return db;
  }

  test("'System and tools' is the first call's context minus the estimates of the first prompt and instructions", () => {
    const db = seeded();
    derive(db);
    expect(breakdown(db).system_tools).toBe(20_000 - 100 - 2000);
  });

  test("'Instructions' is the sum of the estimates of the instructions_loaded files", () => {
    const db = seeded();
    derive(db);
    expect(breakdown(db).instructions).toBe(2000);
  });

  test("an instructions file loaded again is counted once", () => {
    const db = seeded();
    // The same file arrived again before the peak, for example after a compaction.
    seed.instruction(db, { session_id: "s1", id: "user-memory-again", file_path: "/repo/user-memory.md", ts: at(12), tokens_est: 1500 });
    derive(db);
    expect(breakdown(db).instructions).toBe(2000);
  });

  test("the remainder is split between 'Messages' and 'Tool results' in proportion to volume", () => {
    const db = seeded();
    derive(db);
    // Remainder 50 000 − 17 900 − 2000 = 30 100; messages 100 + 400 + 500 = 1000, results 3000.
    expect(breakdown(db)).toMatchObject({ messages: 7525, tool_results: 22_575 });
  });

  test("four categories in the mockup's order, the sum equals the peak, the estimate flag", () => {
    const db = seeded();
    derive(db);
    const agent = agentRow(db);
    expect(entries(agent)).toEqual([
      { category: "system_tools", tokens: 17_900 },
      { category: "instructions", tokens: 2000 },
      { category: "messages", tokens: 7525 },
      { category: "tool_results", tokens: 22_575 },
    ]);
    expect(total(agent)).toBe(agent.ctx_peak!);
    expect(agent.ctx_breakdown_exact).toBe(0);
  });

  test("subagent: the first prompt is its task text, the instructions and calls are its own only", () => {
    const db = seeded();
    // A task of 800 bytes is 200 tokens.
    seed.agent(db, { session_id: "s1", agent_id: "sub-1", parent_agent_id: "main", depth: 1, prompt_content_id: putContent(db, "x".repeat(800)) });
    instruction(db, "sub-memory", 5, 300, "sub-1");
    call(db, "s1", 5, 10_000, 100, { agent_id: "sub-1" });
    tool(db, "st1", 9, 1200, "sub-1");
    call(db, "s2", 15, 30_000, 900, { agent_id: "sub-1" });
    derive(db);
    // Remainder 30 000 − 9500 − 300 = 20 200; messages 200 + 100 = 300, results 1200.
    expect(breakdown(db, "sub-1")).toEqual({ system_tools: 9500, instructions: 300, messages: 4040, tool_results: 16_160 });
    // The subagent's rows do not change the main agent's breakdown.
    expect(breakdown(db)).toEqual({ system_tools: 17_900, instructions: 2000, messages: 7525, tool_results: 22_575 });
  });
});

describe("what goes into the peak call's context", () => {
  test("instructions loaded after the first call are not subtracted from 'System and tools'; those loaded after the peak are not counted", () => {
    const db = withMain();
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0), tokens_est: 100 });
    instruction(db, "project-memory", 0, 2000);
    call(db, "m1", 0, 20_000, 0);
    // Nested memory was loaded when a file was read between the first call and the peak.
    instruction(db, "nested-memory", 5, 1000);
    call(db, "m2", 10, 40_000, 0);
    instruction(db, "late-memory", 25, 4000);
    call(db, "m3", 30, 30_000, 0);
    derive(db);
    expect(breakdown(db)).toMatchObject({ system_tools: 17_900, instructions: 3000 });
    expect(total(agentRow(db))).toBe(40_000);
  });

  test("the peak call's own reply, its tools and everything after it are not in the volume", () => {
    const db = withMain();
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0), tokens_est: 100 });
    call(db, "m1", 0, 10_000, 100);
    tool(db, "t1", 4, 100);
    call(db, "m2", 10, 20_000, 9999);
    tool(db, "t2", 16, 999_999);
    seed.prompt(db, { session_id: "s1", id: "p2", ts: at(18), seq: 1, kind: "follow_up", tokens_est: 5000 });
    call(db, "m3", 20, 15_000, 7777);
    seed.toolCall(db, { session_id: "s1", id: "t3", ts_start: at(22), duration_ms: null, status: "pending" });
    derive(db);
    // Remainder 20 000 − 9900 = 10 100; messages 100 + 100 = 200, results 100: the share of results is a third.
    expect(breakdown(db)).toEqual({ system_tools: 9900, instructions: 0, messages: 6733, tool_results: 3367 });
  });

  test("follow-up prompts before the peak are included in the message volume", () => {
    const db = withMain();
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0), tokens_est: 100 });
    call(db, "m1", 0, 10_000, 100);
    tool(db, "t1", 4, 1000);
    seed.prompt(db, { session_id: "s1", id: "p2", ts: at(8), seq: 1, kind: "follow_up", tokens_est: 800 });
    call(db, "m2", 10, 20_000, 0);
    derive(db);
    // Messages 100 + 100 + 800 = 1000, results 1000: the remainder 10 100 is split in half.
    expect(breakdown(db)).toMatchObject({ messages: 5050, tool_results: 5050 });
  });

  test("the volume is counted from the last compaction before the peak", () => {
    const db = withMain();
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0), tokens_est: 100 });
    call(db, "m1", 0, 20_000, 5000);
    tool(db, "t1", 4, 100_000);
    seed.compaction(db, { session_id: "s1", id: "c0", ts: at(5) });
    tool(db, "t-between", 6, 50_000);
    seed.compaction(db, { session_id: "s1", id: "c1", ts: at(8) });
    seed.prompt(db, { session_id: "s1", id: "p2", ts: at(9), seq: 1, kind: "follow_up", tokens_est: 200 });
    call(db, "m2", 10, 30_000, 600);
    tool(db, "t2", 14, 800);
    call(db, "m3", 20, 60_000, 0);
    // A compaction after the peak and a subagent's compaction do not affect the peak breakdown.
    seed.compaction(db, { session_id: "s1", id: "c2", ts: at(25) });
    seed.compaction(db, { session_id: "s1", id: "c-sub", agent_id: "sub-1", ts: at(15) });
    call(db, "m4", 30, 25_000, 0);
    derive(db);
    // Remainder 60 000 − 19 900 = 40 100; after the compaction: messages 200 + 600 = 800, results 800.
    expect(breakdown(db)).toEqual({ system_tools: 19_900, instructions: 0, messages: 20_050, tool_results: 20_050 });
  });

  test("a subagent's task compressed by a compaction is not in the volume", () => {
    const db = withMain();
    seed.agent(db, { session_id: "s1", agent_id: "sub-1", prompt_content_id: putContent(db, "x".repeat(800)) });
    call(db, "s1", 0, 10_000, 100, { agent_id: "sub-1" });
    tool(db, "st1", 4, 1000, "sub-1");
    seed.compaction(db, { session_id: "s1", id: "c1", agent_id: "sub-1", ts: at(6) });
    tool(db, "st2", 9, 500, "sub-1");
    call(db, "s2", 10, 30_000, 0, { agent_id: "sub-1" });
    derive(db);
    // After the compaction only the second tool's result is in the volume: the remainder 30 000 − 9800 is entirely its.
    expect(breakdown(db, "sub-1")).toEqual({ system_tools: 9800, instructions: 0, messages: 0, tool_results: 20_200 });
  });
});

describe("the sum of categories equals the peak size", () => {
  test("peak at the first call: the remainder is the first prompt", () => {
    const db = withMain();
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0), tokens_est: 100 });
    instruction(db, "project-memory", 0, 2000);
    call(db, "m1", 0, 20_000, 300);
    call(db, "m2", 10, 15_000, 300);
    derive(db);
    expect(breakdown(db)).toEqual({ system_tools: 17_900, instructions: 2000, messages: 100, tool_results: 0 });
  });

  test("the estimate of the prompt and instructions exceeds the first call's context: 'System and tools' is zero, 'Instructions' is at most the peak", () => {
    const db = withMain();
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0), tokens_est: 100 });
    instruction(db, "huge-memory", 0, 8000);
    call(db, "m1", 0, 5000, 300);
    tool(db, "t1", 4, 500);
    call(db, "m2", 10, 6000, 300);
    derive(db);
    expect(breakdown(db)).toEqual({ system_tools: 0, instructions: 6000, messages: 0, tool_results: 0 });
  });

  test("no prompt, no instructions, no results: the whole context is 'System and tools'", () => {
    const db = withMain();
    call(db, "m1", 0, 12_000, 300);
    derive(db);
    expect(breakdown(db)).toEqual({ system_tools: 12_000, instructions: 0, messages: 0, tool_results: 0 });
  });

  test("nothing to compare (no messages or results before the peak): the whole remainder goes to 'Messages'", () => {
    const db = withMain();
    call(db, "m1", 0, 1000, 0);
    call(db, "m2", 10, 3000, 0);
    derive(db);
    expect(breakdown(db)).toEqual({ system_tools: 1000, instructions: 0, messages: 2000, tool_results: 0 });
  });

  test("an uneven split does not lose tokens to rounding", () => {
    const db = withMain();
    call(db, "m1", 0, 1000, 1);
    tool(db, "t1", 4, 1);
    tool(db, "t2", 5, 1);
    call(db, "m2", 10, 1100, 0);
    derive(db);
    // Remainder 100 is split 1 : 2.
    expect(breakdown(db)).toEqual({ system_tools: 1000, instructions: 0, messages: 33, tool_results: 67 });
  });

  test("fixture session: for each agent the sum equals the peak, the categories are non-negative integers", () => {
    const db = openMemoryDb();
    const ref = seedReference(db);
    db.query("UPDATE agents SET ctx_breakdown_json = NULL, ctx_breakdown_exact = 1").run();
    derive(db, REF_SESSION_ID);
    for (const refAgent of ref.agents) {
      const agent = agentRow(db, refAgent.agent_id, REF_SESSION_ID);
      expect([agent.agent_id, total(agent)]).toEqual([agent.agent_id, agent.ctx_peak!]);
      expect(agent.ctx_breakdown_exact).toBe(0);
      for (const entry of entries(agent)) {
        expect(Number.isInteger(entry.tokens)).toBe(true);
        expect(entry.tokens).toBeGreaterThanOrEqual(0);
      }
      // 'System and tools' and 'Instructions' of the fixture rows are computed by the same rules; the remainder split there is nominal.
      const [systemTools, instructions, messages, toolResults] = entries(agent);
      expect([systemTools, instructions]).toEqual((JSON.parse(refAgent.ctx_breakdown_json!) as ContextBreakdownEntry[]).slice(0, 2));
      expect(messages!.tokens).toBeGreaterThan(0);
      expect(toolResults!.tokens).toBeGreaterThan(0);
    }
  });
});

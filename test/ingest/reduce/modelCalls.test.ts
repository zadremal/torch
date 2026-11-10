// Model calls: the rules of plan §6.2 and §3.1 (one record per requestId, duration estimate, cost).
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { SYNTHETIC_MODEL } from "../../../src/contracts/constants.ts";
import type { ModelCallRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { text, thinking, toolUse, transcript } from "../../support/transcript.ts";
import { lastEventTs, parsed, reduce, rows, setTime, START } from "./modelCalls.support.ts";

const modelCalls = (db: Database) => rows<ModelCallRow>(db, "model_calls");
const byId = (db: Database) => Object.fromEntries(modelCalls(db).map((call) => [call.id, call]));

test("a reply of several rows with one requestId — one call with tokens from the last row", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", startAt: START });
  t.prompt("Fix it");
  const { requestId } = t.assistant({
    blocks: [thinking("hm"), text("Reading"), toolUse("Read", { file_path: "/a.ts" })],
    usage: { input: 10, output: 500, cacheRead: 2000, cacheWrite5m: 100, cacheWrite1h: 300, thinking: 40 },
  });
  // The reply rows are written as the blocks become ready: 4, 5 and 7 seconds after the prompt.
  [4000, 5000, 7000].forEach((offset, index) => setTime(t.lines[index + 1]!, START + offset));
  // The builder writes a growing output_tokens and an empty stop reason into the non-last rows.
  const answer = parsed(t).slice(1);
  expect(answer.map((line) => line.kind === "assistant" && [line.usage!.outputTokens, line.stopReason])).toEqual([[1, null], [2, null], [500, "tool_use"]]);

  reduce(db, t);

  expect(modelCalls(db)).toEqual([
    {
      session_id: "s1",
      id: requestId,
      agent_id: "main",
      turn_index: 1,
      model: "claude-opus-5-5",
      ts_start: START,
      ts_end: START + 7000,
      duration_ms: 7000,
      duration_exact: 0,
      stop_reason: "tool_use",
      tok_input: 10,
      tok_output: 500,
      tok_cache_read: 2000,
      tok_cache_write_5m: 100,
      tok_cache_write_1h: 300,
      tok_thinking: 40,
      ctx_tokens: 2410,
      // (10·5 + 500·25 + 2000·0,5 + 100·6,25 + 300·10) / 1 000 000
      cost_usd: 0.017175,
      query_source: null,
    },
  ]);
});

test("rows with the <synthetic> model and rows without requestId are not model calls", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.prompt("Go");
  const message = { role: "assistant", content: [{ type: "text", text: "API Error" }], usage: { input_tokens: 7, output_tokens: 9 } };
  t.envelope({ type: "assistant", requestId: "req_failed", isApiErrorMessage: true, error: "overloaded", apiErrorStatus: 529, message: { ...message, model: SYNTHETIC_MODEL } });
  t.envelope({ type: "assistant", requestId: "req_synthetic", message: { ...message, model: SYNTHETIC_MODEL } });
  t.envelope({ type: "assistant", message: { ...message, model: "claude-opus-5-5" } });
  const { requestId } = t.assistant({ blocks: [text("Done")] });

  reduce(db, t);

  expect(modelCalls(db).map((call) => call.id)).toEqual([requestId]);
});

test("the duration is an estimate: from the agent's previous event to the last row of the reply", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", startAt: START });
  t.prompt("Fix it");
  const first = t.tick(4000).assistant({ blocks: [toolUse("Bash", { command: "ls" })] });
  t.tick(1500).toolResult(first.toolUseIds[0]!, { content: "a.ts" });
  const second = t.tick(2500).assistant({ blocks: [text("Retrying")] });
  // A failed attempt is also an agent event: the successful one is counted from it.
  t.tick(600).apiError({ message: "Connection error." });
  const third = t.tick(900).assistant({ blocks: [text("Done")] });

  reduce(db, t);

  const calls = byId(db);
  expect(calls[first.requestId]).toMatchObject({ ts_start: START, ts_end: START + 4000, duration_ms: 4000, duration_exact: 0 });
  expect(calls[second.requestId]).toMatchObject({ ts_start: START + 5500, ts_end: START + 8000, duration_ms: 2500, duration_exact: 0 });
  expect(calls[third.requestId]).toMatchObject({ ts_start: START + 8600, ts_end: START + 9500, duration_ms: 900, duration_exact: 0 });
});

test("the first call of a pass is counted from the last event of the previous pass; without it the duration is 0", () => {
  const t = transcript({ sessionId: "s1", startAt: START });
  t.assistant({ blocks: [text("Hello")] });

  const first = openMemoryDb();
  reduce(first, t, { prevEventTs: null });
  expect(modelCalls(first)[0]).toMatchObject({ ts_start: START, ts_end: START, duration_ms: 0 });

  const next = openMemoryDb();
  reduce(next, t, { prevEventTs: START - 3000 });
  expect(modelCalls(next)[0]).toMatchObject({ ts_start: START - 3000, ts_end: START, duration_ms: 3000 });
});

test("turn_index is the agent's call sequence number starting at 1, continuing across passes", () => {
  const db = openMemoryDb();
  const main = transcript({ sessionId: "s1" });
  main.prompt("Go");
  const m1 = main.assistant({ blocks: [text("one")] });
  const m2 = main.assistant({ blocks: [thinking("two"), text("two")] });
  const m3 = main.assistant({ blocks: [text("three")] });
  const sub = transcript({ sessionId: "s1", agentId: "a1" });
  sub.prompt("Explore");
  const s1 = sub.assistant({ blocks: [text("sub one")] });

  // The main file arrives in two passes, the boundary is between the second and third call.
  const lines = parsed(main);
  reduce(db, main, { lines: lines.slice(0, 4) });
  reduce(db, sub);
  reduce(db, main, { lines: lines.slice(4), prevEventTs: lastEventTs(lines.slice(0, 4)) });

  const turns = Object.fromEntries(modelCalls(db).map((call) => [call.id, [call.agent_id, call.turn_index]]));
  expect(turns).toEqual({ [m1.requestId]: ["main", 1], [m2.requestId]: ["main", 2], [m3.requestId]: ["main", 3], [s1.requestId]: ["a1", 1] });
});

test("context size is input + cache read and write; thinking without the field equals 0", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.assistant({ blocks: [text("x")], usage: { input: 12, output: 30, cacheRead: 9000, cacheWrite5m: 400, cacheWrite1h: 600 } });

  reduce(db, t);

  expect(modelCalls(db)[0]).toMatchObject({ tok_input: 12, tok_output: 30, tok_cache_read: 9000, tok_cache_write_5m: 400, tok_cache_write_1h: 600, tok_thinking: 0, ctx_tokens: 10012 });
});

test("cost is tokens by kind × the model's price; NULL for an unknown model", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  const usage = { input: 1000, output: 2000, cacheRead: 100_000, cacheWrite5m: 10_000, cacheWrite1h: 20_000 };
  const known = t.assistant({ blocks: [text("x")], model: "claude-opus-5-5", usage });
  const unknown = t.assistant({ blocks: [text("y")], model: "claude-unknown-9", usage });

  reduce(db, t);

  const calls = byId(db);
  // 0,005 + 0,05 + 0,05 + 0,0625 + 0,2
  expect(calls[known.requestId]!.cost_usd).toBeCloseTo(0.3675, 10);
  expect(calls[unknown.requestId]!.cost_usd).toBeNull();
});

test("one requestId in the files of two sessions — one call in each", () => {
  const db = openMemoryDb();
  for (const sessionId of ["s1", "s2"]) {
    const t = transcript({ sessionId });
    t.assistant({ blocks: [text("copied history")], requestId: "req_shared" });
    reduce(db, t);
  }
  expect(modelCalls(db).map((call) => [call.session_id, call.id, call.turn_index])).toEqual([["s1", "req_shared", 1], ["s2", "req_shared", 1]]);
});

test("reprocessing rows does not overwrite the duration refined by enrichment", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.prompt("Go");
  t.tick(4000).assistant({ blocks: [thinking("hm"), text("Done")], usage: { output: 50 } });
  reduce(db, t);
  // This is how enrich/merge.ts applies the api_request event.
  db.run("UPDATE model_calls SET duration_ms = 3210, duration_exact = 1, query_source = 'repl_main_thread'");
  const enriched = modelCalls(db);

  reduce(db, t);

  expect(modelCalls(db)).toEqual(enriched);
  expect(enriched[0]).toMatchObject({ duration_ms: 3210, duration_exact: 1, tok_output: 50 });
});

// The whole gateway chain through runIndex: transcripts keyed by message.id, gateway model names and OTel
// api_request events without request_id, joined by the bedrock provider (src/providers/bedrock.ts).
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { MAIN_AGENT_ID } from "../../src/contracts/constants.ts";
import { OTEL_EVENT_NAMES } from "../../src/contracts/enrich.ts";
import type { ProviderId } from "../../src/contracts/provider.ts";
import type { SessionRow } from "../../src/contracts/rows.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { runIndex } from "../../src/ingest/index.ts";
import { REF_PRICES } from "../support/reference.ts";
import { seed } from "../support/seed.ts";
import { text, toolUse, transcript, writeSession, type Transcript } from "../support/transcript.ts";

const START = Date.UTC(2026, 9, 1, 10, 0, 0);
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** One transcript call with the OTel event its exporter sends for it. */
interface Call {
  agentId: string;
  id: string;
  /** Time of the call's last transcript line. */
  end: number;
  usage: Usage;
  querySource: string;
  durationMs: number;
}

/**
 * A gateway-shaped session: the main agent spawns a subagent on the same model, and the subagent's calls end
 * within the match window of the main agent's calls, so time alone could not tell them apart.
 */
function gatewayWorld() {
  const root = mkdtempSync(join(tmpdir(), "torch-bedrock-chain-"));
  const calls: Call[] = [];
  const answer = (t: Transcript, agentId: string, blocks: Parameters<Transcript["assistant"]>[0]["blocks"], usage: Usage, querySource: string) => {
    const { requestId, toolUseIds } = t.assistant({ blocks, usage });
    const last = t.lines.at(-1) as { timestamp: string };
    calls.push({ agentId, id: requestId, end: Date.parse(last.timestamp), usage, querySource, durationMs: 1000 + calls.length * 111 });
    return toolUseIds;
  };

  const main = transcript({ sessionId: "g1", startAt: START, gateway: true });
  main.prompt("Find the usages");
  const [spawn] = answer(main.tick(3000), MAIN_AGENT_ID, [text("Delegating"), toolUse("Agent", { description: "Find usages", prompt: "Find usages of a" }, "toolu_spawn")], { input: 10, output: 80, cacheRead: 4000, cacheWrite5m: 300, cacheWrite1h: 0 }, "repl_main_thread");
  main.tick(100).toolResult(spawn!, { content: "Launched", toolUseResult: { agentId: "a1", isAsync: true, status: "async_launched" } });
  answer(main.tick(2000), MAIN_AGENT_ID, [text("Waiting for the agent")], { input: 12, output: 40, cacheRead: 4300, cacheWrite5m: 0, cacheWrite1h: 50 }, "repl_main_thread");
  answer(main.tick(3000), MAIN_AGENT_ID, [text("Done")], { input: 8, output: 30, cacheRead: 5000, cacheWrite5m: 0, cacheWrite1h: 0 }, "repl_main_thread");

  const sub = transcript({ sessionId: "g1", agentId: "a1", startAt: START + 3500, gateway: true });
  sub.prompt("Find usages of a");
  answer(sub.tick(1500), "a1", [text("Searching")], { input: 5, output: 20, cacheRead: 900, cacheWrite5m: 120, cacheWrite1h: 0 }, "agent:custom");
  answer(sub.tick(1200), "a1", [text("Found 3")], { input: 7, output: 25, cacheRead: 1020, cacheWrite5m: 0, cacheWrite1h: 0 }, "agent:custom");

  writeSession(join(root, "projects"), { main, subagents: [{ transcript: sub, meta: { agentType: "Explore", description: "Find usages", toolUseId: "toolu_spawn", spawnDepth: 1 } }] });

  const configOf = (provider: ProviderId) => ({
    ...loadConfig({ dataDir: join(root, "torch"), transcriptsDir: join(root, "projects"), desktopSessionsDir: join(root, "desktop"), claudeSettingsPath: join(root, "settings.json") }),
    provider,
  });

  /** A database holding the OTel events the gateway's exporter sent, before any pass. */
  function database(): { db: Database; eventOf: Map<number, Call>; sideEvent: number } {
    const db = openMemoryDb();
    const eventOf = new Map<number, Call>();
    for (const [index, call] of calls.entries()) {
      // Some exporters send numbers as strings.
      const n = (value: number) => (index % 2 === 0 ? value : String(value));
      const row = seed.otelEvent(db, {
        session_id: "g1",
        ts: call.end + 150,
        name: OTEL_EVENT_NAMES.apiRequest,
        attrs: {
          model: "align-aws-opus-5-5",
          duration_ms: n(call.durationMs),
          query_source: call.querySource,
          input_tokens: n(call.usage.input),
          output_tokens: n(call.usage.output),
          cache_read_tokens: n(call.usage.cacheRead),
          cache_creation_tokens: n(call.usage.cacheWrite5m + call.usage.cacheWrite1h),
        },
      });
      eventOf.set(row.id, call);
    }
    // A side request (a title) on another model: the transcript has no call for it.
    const side = seed.otelEvent(db, {
      session_id: "g1",
      ts: calls[0]!.end + 400,
      name: OTEL_EVENT_NAMES.apiRequest,
      attrs: { model: "align-aws-haiku-4-5", duration_ms: 640, query_source: "generate_session_title", input_tokens: 150, output_tokens: 12, cache_read_tokens: 0, cache_creation_tokens: 0 },
    });
    return { db, eventOf, sideEvent: side.id };
  }

  return { calls, configOf, database };
}

interface CallRow {
  id: string;
  agent_id: string;
  duration_ms: number;
  duration_exact: number;
  query_source: string | null;
}

const modelCalls = (db: Database) =>
  db.query<CallRow, []>("SELECT id, agent_id, duration_ms, duration_exact, query_source FROM model_calls ORDER BY agent_id, turn_index").all();
const applied = (db: Database) => new Map(db.query<{ id: number; applied: number }, []>("SELECT id, applied FROM otel_events").all().map((row) => [row.id, row.applied]));

test("bedrock: every gateway call gets its own OTel event, the subagent's events land on the subagent, a rebuild repeats it", () => {
  const w = gatewayWorld();
  const config = w.configOf("bedrock");
  const { db, eventOf, sideEvent } = w.database();
  const index = (options?: { rebuild?: boolean }) => runIndex({ db, config, prices: REF_PRICES, now: () => NOW }, options);

  index();

  const rows = modelCalls(db);
  expect(rows).toHaveLength(w.calls.length);
  // The event of each call carries its own duration: a call refined by another call's event would show it.
  expect(rows).toEqual(
    expect.arrayContaining(w.calls.map((call) => ({ id: call.id, agent_id: call.agentId, duration_ms: call.durationMs, duration_exact: 1, query_source: call.querySource }))),
  );
  const state = applied(db);
  for (const id of eventOf.keys()) expect(state.get(id)).toBe(1);
  expect(state.get(sideEvent)).toBe(0);

  const s = db.query<SessionRow, []>("SELECT * FROM sessions WHERE id = 'g1'").get()!;
  expect(s.tok_total).toBeGreaterThan(0);
  expect(s.cost_usd).not.toBeNull();
  expect(s.primary_model).toBe("claude-align-aws-opus-5-5");

  // A rebuild sets every event back to applied = 0 and joins them again from scratch.
  index({ rebuild: true });
  expect(modelCalls(db)).toEqual(rows);
  expect(applied(db)).toEqual(state);
});

test("anthropic: the same gateway world has no model calls and no api_request event is applied", () => {
  const w = gatewayWorld();
  const { db } = w.database();
  runIndex({ db, config: w.configOf("anthropic"), prices: REF_PRICES, now: () => NOW });

  expect(modelCalls(db)).toEqual([]);
  expect([...applied(db).values()].every((value) => value === 0)).toBe(true);
});

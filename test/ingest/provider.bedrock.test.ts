// Indexing a gateway-shaped history (AWS Bedrock, a corporate proxy): no requestId, gateway model names.
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { MAIN_AGENT_ID } from "../../src/contracts/constants.ts";
import type { ProviderId } from "../../src/contracts/provider.ts";
import type { AgentRow, SessionRow } from "../../src/contracts/rows.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { runIndex } from "../../src/ingest/index.ts";
import { REF_PRICES } from "../support/reference.ts";
import { text, toolUse, transcript, writeSession } from "../support/transcript.ts";

const START = Date.UTC(2026, 9, 1, 10, 0, 0);
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);

/** A transcripts directory with one gateway-shaped session: the main agent spawns a subagent. */
function gatewayDir(): string {
  const root = mkdtempSync(join(tmpdir(), "torch-bedrock-"));
  const main = transcript({ sessionId: "g1", startAt: START, gateway: true });
  main.prompt("Find the usages");
  const spawn = main.tick(3000).assistant({ blocks: [text("Delegating"), toolUse("Agent", { description: "Find usages", prompt: "Find usages of a" }, "toolu_spawn")], usage: { input: 10, output: 80, cacheRead: 4000 } });
  main.tick(100).toolResult(spawn.toolUseIds[0]!, { content: "Launched", toolUseResult: { agentId: "a1", isAsync: true, status: "async_launched" } });
  main.tick(5000).assistant({ blocks: [text("Done")], usage: { input: 8, output: 30, cacheRead: 5000 } });

  const sub = transcript({ sessionId: "g1", agentId: "a1", startAt: START + 3500, gateway: true });
  sub.prompt("Find usages of a");
  sub.tick(1500).assistant({ blocks: [text("Found 3")], usage: { input: 5, output: 20, cacheRead: 900 } });

  writeSession(join(root, "projects"), { main, subagents: [{ transcript: sub, meta: { agentType: "Explore", description: "Find usages", toolUseId: "toolu_spawn", spawnDepth: 1 } }] });
  return root;
}

function indexAs(root: string, provider: ProviderId): Database {
  const config = {
    ...loadConfig({ dataDir: join(root, "torch"), transcriptsDir: join(root, "projects"), desktopSessionsDir: join(root, "desktop"), claudeSettingsPath: join(root, "settings.json") }),
    provider,
  };
  const db = openMemoryDb();
  runIndex({ db, config, prices: REF_PRICES, now: () => NOW });
  return db;
}

const callsOf = (db: Database) => db.query<{ agent_id: string; n: number }, []>("SELECT agent_id, COUNT(*) AS n FROM model_calls GROUP BY agent_id ORDER BY agent_id").all();
const session = (db: Database) => db.query<SessionRow, []>("SELECT * FROM sessions WHERE id = 'g1'").get()!;
const agents = (db: Database) => db.query<AgentRow, []>("SELECT * FROM agents WHERE session_id = 'g1' ORDER BY agent_id").all();

test("with provider bedrock a gateway session indexes fully: calls, tokens, primary model, cost, context", () => {
  const db = indexAs(gatewayDir(), "bedrock");

  expect(callsOf(db)).toEqual([
    { agent_id: "a1", n: 1 },
    { agent_id: MAIN_AGENT_ID, n: 2 },
  ]);
  const s = session(db);
  expect(s.tok_total).toBeGreaterThan(0);
  expect(s.primary_model).toBe("claude-align-aws-opus-5-5");
  expect(s.cost_usd).not.toBeNull();
  const rows = agents(db);
  expect(rows.map((agent) => agent.agent_id)).toEqual(["a1", MAIN_AGENT_ID]);
  for (const agent of rows) {
    expect(agent.cost_usd).not.toBeNull();
    expect(agent.ctx_peak).not.toBeNull();
    expect(agent.ctx_window).toBe(200_000);
  }
});

test("with the default provider anthropic the same gateway session has no model calls", () => {
  const db = indexAs(gatewayDir(), "anthropic");
  expect(callsOf(db)).toEqual([]);
  expect(session(db)).toMatchObject({ tok_total: 0, primary_model: null });
});

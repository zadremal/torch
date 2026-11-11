// Rows that arrive in two passes give the same database as in one: all structure reducers
// together, in LINE_REDUCERS order, on the main file and the subagent file.
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { MAIN_AGENT_ID } from "../../../src/contracts/constants.ts";
import type { AgentMeta, ParsedLine } from "../../../src/contracts/lines.ts";
import type { LineReducer, ReduceContext } from "../../../src/contracts/pipeline.ts";
import type { AgentRow, MessageRow, PromptRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { linkAgents, reduceAgents } from "../../../src/ingest/reduce/agents.ts";
import { reduceInstructions } from "../../../src/ingest/reduce/instructions.ts";
import { reduceMessages } from "../../../src/ingest/reduce/messages.ts";
import { reducePrompts } from "../../../src/ingest/reduce/prompts.ts";
import { reduceSession } from "../../../src/ingest/reduce/session.ts";
import { REF_PRICES } from "../../support/reference.ts";
import { seed } from "../../support/seed.ts";
import { text, thinking, toolUse, transcript } from "../../support/transcript.ts";
import { context, contentText, parsed, rows } from "./session.support.ts";
import { ANTHROPIC_PROVIDER } from "../../support/provider.ts";

const START = Date.UTC(2026, 9, 1, 10, 0, 0);

/** Package reducers in the order the indexer calls them. */
const REDUCERS: LineReducer[] = [reduceSession, reduceAgents, reducePrompts, reduceMessages, reduceInstructions];

const SUB_META: AgentMeta = { agentType: "Explore", description: "Find billing imports", toolUseId: "toolu_spawn", spawnDepth: 1, model: null, parentAgentId: null };

function mainFile() {
  const t = transcript({ sessionId: "s1", cwd: "/private/tmp/claude-501/scratch", startAt: START });
  t.instructions([{ path: "/Users/dev/.claude/CLAUDE.md", type: "User", content: "user rules" }]);
  t.prompt("Fix the flaky billing test");
  t.tick(3000).assistant({ blocks: [thinking("Need to look around"), text("Delegating"), toolUse("Agent", { description: "Find billing imports" }, "toolu_spawn")] });
  t.tick(500).toolResult("toolu_spawn", { content: "launched", toolUseResult: { agentId: "a1", isAsync: true, status: "async_launched" } });
  t.aiTitle("Stabilise billing tests");
  t.tick(60_000).prompt("Also update the docs", { images: 1 });
  t.nestedMemory({ path: "/private/tmp/claude-501/scratch/docs/CLAUDE.md", type: "Nested", content: "docs rules" });
  t.tick(2000).assistant({ blocks: [text("Docs updated")] });
  t.costState({ totalCostUSD: 0.42, modelUsage: {} });
  t.customTitle("Billing: Flaky Test");
  t.tick(30_000).prompt("Thanks");
  t.tick(1000).assistant({ blocks: [text("You are welcome")] });
  return t;
}

function subagentFile() {
  const t = transcript({ sessionId: "s1", agentId: "a1", cwd: "/private/tmp/claude-501/scratch", startAt: START + 4000 });
  t.prompt("Find every import of src/api/billing");
  t.instructions([{ path: "/private/tmp/claude-501/scratch/CLAUDE.md", type: "Project", content: "project rules" }]);
  t.tick(5000).assistant({ blocks: [thinking("grep first"), toolUse("Grep", { pattern: "billing" })] });
  t.tick(90_000).assistant({ blocks: [text("Found 7 files")] });
  return t;
}

/** Everything the package reducers write; body identifiers are replaced by the bodies themselves. */
function dump(db: Database) {
  return {
    sessions: rows(db, "SELECT * FROM sessions ORDER BY id"),
    agents: rows<AgentRow>(db, "SELECT * FROM agents ORDER BY agent_id").map(({ prompt_content_id, ...row }) => ({ ...row, prompt: contentText(db, prompt_content_id) })),
    prompts: rows<PromptRow>(db, "SELECT * FROM prompts ORDER BY seq").map(({ content_id, ...row }) => ({ ...row, text: contentText(db, content_id) })),
    messages: rows<MessageRow>(db, "SELECT * FROM messages ORDER BY id").map(({ content_id, ...row }) => ({ ...row, text: contentText(db, content_id) })),
    instructions: rows(db, "SELECT * FROM instructions_loaded ORDER BY id"),
    contents: rows(db, "SELECT sha256, bytes FROM contents ORDER BY sha256"),
  };
}

interface FilePass {
  ctx: (db: Database) => ReduceContext;
  lines: ParsedLine[];
}

/** Indexer passes: each has new file rows, then agent linking. */
function index(passes: FilePass[][]) {
  const db = openMemoryDb();
  // The Agent call is written by the call reducer (I1); here its row is already in the database.
  seed.toolCall(db, { session_id: "s1", id: "toolu_spawn", name: "Agent", agent_id: MAIN_AGENT_ID, spawned_agent_id: "a1" });
  for (const files of passes) {
    for (const file of files) {
      for (const reduce of REDUCERS) reduce(file.ctx(db), file.lines);
    }
    linkAgents({ db, sessionId: "s1", prices: REF_PRICES, provider: ANTHROPIC_PROVIDER, now: START });
  }
  return dump(db);
}

const main = mainFile();
const sub = subagentFile();
const mainLines = parsed(main);
const subLines = parsed(sub);
const titles = { customFile: null, desktop: "Desktop title" };
const mainPass = (lines: ParsedLine[]): FilePass => ({ ctx: (db) => context(db, main, { titles }), lines });
const subPass = (lines: ParsedLine[]): FilePass => ({ ctx: (db) => context(db, sub, { titles, agentMeta: SUB_META }), lines });

const onePass = index([[mainPass(mainLines), subPass(subLines)]]);

test("one pass: the database is filled by all package reducers", () => {
  expect(onePass.sessions).toHaveLength(1);
  expect(onePass.sessions[0]).toMatchObject({ name: "Billing: Flaky Test", name_source: "custom", is_temp_dir: 1, cost_reported_usd: 0.42, started_at: START, ended_at: START + 99_000 });
  expect(onePass.agents.map((row) => [row.agent_id, row.parent_agent_id, row.depth, row.prompt])).toEqual([
    ["a1", MAIN_AGENT_ID, 1, "Find every import of src/api/billing"],
    [MAIN_AGENT_ID, null, 0, "Fix the flaky billing test"],
  ]);
  expect(onePass.prompts.map((row) => row.kind)).toEqual(["original", "follow_up", "follow_up"]);
  expect(onePass.messages).toHaveLength(6);
  expect(onePass.instructions).toHaveLength(3);
});

test("the main file cut at any point into two passes gives the same database", () => {
  for (let cut = 0; cut <= mainLines.length; cut++) {
    const twoPasses = index([[mainPass(mainLines.slice(0, cut)), subPass(subLines)], [mainPass(mainLines.slice(cut))]]);
    expect(twoPasses, `cut after row ${cut}`).toEqual(onePass);
  }
});

test("both files cut at any point, and any file order, give the same database", () => {
  for (let mainCut = 0; mainCut <= mainLines.length; mainCut++) {
    for (let subCut = 0; subCut <= subLines.length; subCut++) {
      const twoPasses = index([
        [subPass(subLines.slice(0, subCut)), mainPass(mainLines.slice(0, mainCut))],
        [mainPass(mainLines.slice(mainCut)), subPass(subLines.slice(subCut))],
      ]);
      expect(twoPasses, `cuts ${mainCut} and ${subCut}`).toEqual(onePass);
    }
  }
});

test("meta.json and external titles that appear only by the second pass give the same database", () => {
  const bare = { customFile: null, desktop: null };
  const twoPasses = index([
    [
      { ctx: (db) => context(db, main, { titles: bare }), lines: mainLines.slice(0, 6) },
      { ctx: (db) => context(db, sub, { titles: bare }), lines: subLines.slice(0, 2) },
    ],
    [mainPass(mainLines.slice(6)), subPass(subLines.slice(2))],
  ]);
  expect(twoPasses).toEqual(onePass);
});

test("reprocessing the same rows does not change the database", () => {
  const twice = index([[mainPass(mainLines), subPass(subLines)], [mainPass(mainLines), subPass(subLines)]]);
  expect(twice).toEqual(onePass);
});

// mergeEnrichment across passes: an event waits for its row, the order in which sources arrive does not
// affect the result, and a repeated merge and a repeated transcript load lose nothing (plan §6.3).
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MAIN_AGENT_ID } from "../../src/contracts/constants.ts";
import { OTEL_EVENT_NAMES } from "../../src/contracts/enrich.ts";
import type { ReduceContext } from "../../src/contracts/pipeline.ts";
import type { SessionRow } from "../../src/contracts/rows.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { mergeEnrichment } from "../../src/enrich/merge.ts";
import { DERIVED_REDUCERS, LINE_REDUCERS } from "../../src/ingest/index.ts";
import { parseLine } from "../../src/ingest/parse.ts";
import { REF_PRICES } from "../support/reference.ts";
import { SEED_TIME, seed } from "../support/seed.ts";
import { toolUse, transcript, type RawLine, type Transcript } from "../support/transcript.ts";
import { ANTHROPIC_PROVIDER } from "../support/provider.ts";

const START = SEED_TIME;

const all = <Row>(db: Database, sql: string): Row[] => db.query<Row, []>(sql).all();
const flags = (db: Database, table: "otel_events" | "hook_events"): number[] => all<{ applied: number }>(db, `SELECT applied FROM ${table} ORDER BY id`).map((row) => row.applied);

const TABLES = ["sessions", "agents", "model_calls", "tool_calls", "api_errors", "instructions_loaded", "compactions", "otel_events", "hook_events"] as const;

/** Everything the merge reads and writes. */
const dump = (db: Database) => Object.fromEntries(TABLES.map((table) => [table, all(db, `SELECT * FROM ${table} ORDER BY 1, 2`)]));

/** A pass of the row reducers over the main agent's file, as in the indexer: in one transaction. */
function reduce(db: Database, t: Transcript, lines: RawLine[] = t.lines): void {
  const ctx: ReduceContext = {
    db,
    sessionId: t.options.sessionId,
    agentId: MAIN_AGENT_ID,
    prices: REF_PRICES,
    provider: ANTHROPIC_PROVIDER,
    prevEventTs: null,
    agentMeta: null,
    titles: { customFile: null, desktop: null },
  };
  const parsed = lines.map((line) => parseLine(JSON.stringify(line)).line);
  db.transaction(() => {
    for (const reducer of LINE_REDUCERS) reducer(ctx, parsed);
  })();
}

// ── An event without a pair waits ───────────────────────────────────────────────────────────

test("an event without a pair stays with applied = 0 and is applied once the row appears", () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "req_1", duration_ms: 2350 } });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.toolDecision, attrs: { tool_use_id: "toolu_1", decision: "accept", source: "config" } });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.toolResult, attrs: { tool_use_id: "toolu_1", duration_ms: 38 } });
  seed.hookEvent(db, { session_id: "s1", ts: SEED_TIME, name: "PreCompact", attrs: { trigger: "auto" } });
  seed.hookEvent(db, { session_id: "s1", ts: SEED_TIME + 30_000, name: "PostCompact", attrs: { trigger: "auto" } });

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);
  expect(flags(db, "otel_events")).toEqual([0, 0, 0]);
  expect(flags(db, "hook_events")).toEqual([0, 0]);

  // The next indexer pass brought a model call; the other rows are not there yet.
  seed.modelCall(db, { session_id: "s1", id: "req_1", duration_ms: 4000 });
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);
  expect(flags(db, "otel_events")).toEqual([1, 0, 0]);
  expect(flags(db, "hook_events")).toEqual([0, 0]);

  seed.toolCall(db, { session_id: "s1", id: "toolu_1" });
  seed.compaction(db, { session_id: "s1", id: "uuid-1", ts: SEED_TIME + 30_100, trigger: null, duration_ms: null });
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);
  expect(flags(db, "otel_events")).toEqual([1, 1, 1]);
  expect(flags(db, "hook_events")).toEqual([1, 1]);

  expect(all(db, "SELECT duration_ms, duration_exact FROM model_calls")).toEqual([{ duration_ms: 2350, duration_exact: 1 }]);
  expect(all(db, "SELECT duration_ms, duration_exact, permission_decision, permission_source FROM tool_calls")).toEqual([
    { duration_ms: 38, duration_exact: 1, permission_decision: "accept", permission_source: "config" },
  ]);
  expect(all(db, "SELECT trigger, duration_ms FROM compactions")).toEqual([{ trigger: "auto", duration_ms: 30_000 }]);
});

test("an API error arrived from OTel before the transcript row: once the row appears there is one record", () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1", agent_id: "a1" });
  seed.otelEvent(db, { session_id: "s1", ts: SEED_TIME + 20, name: OTEL_EVENT_NAMES.apiError, attrs: { request_id: "req_9", status_code: 529, error: "Overloaded", attempt: 1 } });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);
  expect(all(db, "SELECT source FROM api_errors")).toEqual([{ source: "otel" }]);

  const fromTranscript = seed.apiError(db, { session_id: "s1", id: "uuid-1", agent_id: "a1", ts: SEED_TIME, status_code: null, error: "529 Overloaded", attempt: 1 });
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);

  expect(all(db, "SELECT * FROM api_errors")).toEqual([{ ...fromTranscript, request_id: "req_9", status_code: 529 }]);
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);
});

test("InstructionsLoaded arrived before the transcript row: once the row appears there is one record", () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.hookEvent(db, { session_id: "s1", ts: SEED_TIME, name: "InstructionsLoaded", attrs: { file_path: "/repo/CLAUDE.md", memory_type: "Project", load_reason: "session_start", file_bytes: 4000 } });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);
  expect(all(db, "SELECT source FROM instructions_loaded")).toEqual([{ source: "hook" }]);

  const fromTranscript = seed.instruction(db, { session_id: "s1", id: "uuid-1:0", ts: SEED_TIME + 90_000, file_path: "/repo/CLAUDE.md" });
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);

  expect(all(db, "SELECT * FROM instructions_loaded")).toEqual([{ ...fromTranscript, load_reason: "session_start" }]);
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);
});

// ── A whole session: transcript reducers and merge ──────────────────────────────────────────

/** A session with a model call and a tool call, a failed API attempt, an instructions file and a compaction. */
function scenario() {
  const t = transcript({ sessionId: "s1", startAt: START });
  t.prompt("Go");
  const call = t.tick(4000).assistant({ blocks: [toolUse("Bash", { command: "ls" })] });
  const firstPass = t.lines.length;
  const toolUseId = call.toolUseIds[0]!;
  t.tick(700).toolResult(toolUseId, { content: "ok", permissionDecision: { decision: "accept", source: "user" } });
  const errorUuid = t.tick(300).apiError({ message: "529 Overloaded", retryAttempt: 1 });
  t.tick(100).instructions([{ path: "/repo/CLAUDE.md", type: "Project", content: "# Rules" }]);
  // A compaction row without a trigger and a duration: hooks will name them.
  const compactionUuid = t.tick(60_000).envelope({ type: "system", subtype: "compact_boundary", content: "Conversation compacted", compactMetadata: { preTokens: 150_000, postTokens: 20_000 } });
  return { t, firstPass, requestId: call.requestId, toolUseId, errorUuid, compactionUuid };
}

function seedEvents(db: Database, s: ReturnType<typeof scenario>): void {
  seed.otelEvent(db, { session_id: "s1", ts: START + 4000, name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: s.requestId, duration_ms: 3210, query_source: "repl_main_thread" } });
  seed.otelEvent(db, { session_id: "s1", ts: START + 4010, name: OTEL_EVENT_NAMES.toolDecision, attrs: { tool_use_id: s.toolUseId, decision: "accept", source: "user_temporary" } });
  seed.otelEvent(db, { session_id: "s1", ts: START + 4650, name: OTEL_EVENT_NAMES.toolResult, attrs: { tool_use_id: s.toolUseId, success: "true", duration_ms: 640 } });
  seed.otelEvent(db, { session_id: "s1", ts: START + 5003, name: OTEL_EVENT_NAMES.apiError, attrs: { request_id: "req_failed", status_code: 529, error: "Overloaded", attempt: 1 } });
  seed.hookEvent(db, { session_id: "s1", ts: START - 500, name: "SessionStart", attrs: { source: "startup" } });
  seed.hookEvent(db, { session_id: "s1", ts: START - 400, name: "InstructionsLoaded", attrs: { file_path: "/repo/CLAUDE.md", memory_type: "Project", load_reason: "session_start", file_bytes: 7 } });
  seed.hookEvent(db, { session_id: "s1", ts: START + 35_000, name: "PreCompact", attrs: { trigger: "auto" } });
  seed.hookEvent(db, { session_id: "s1", ts: START + 65_000, name: "PostCompact", attrs: { trigger: "auto" } });
  seed.hookEvent(db, { session_id: "s1", ts: START + 70_000, name: "SessionEnd", attrs: { reason: "other" } });
}

/** Events arrive before the rows: a merge after each of the two transcript passes. */
function eventsFirst(): { db: Database; s: ReturnType<typeof scenario> } {
  const db = openMemoryDb();
  const s = scenario();
  seedEvents(db, s);
  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);
  reduce(db, s.t, s.t.lines.slice(0, s.firstPass));
  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);
  reduce(db, s.t, s.t.lines.slice(s.firstPass));
  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);
  return { db, s };
}

test("each event of the scenario refined its own row", () => {
  const { db, s } = eventsFirst();

  expect(all(db, "SELECT id, duration_ms, duration_exact, query_source FROM model_calls")).toEqual([
    { id: s.requestId, duration_ms: 3210, duration_exact: 1, query_source: "repl_main_thread" },
  ]);
  expect(all(db, "SELECT id, status, duration_ms, duration_exact, permission_decision, permission_source FROM tool_calls")).toEqual([
    { id: s.toolUseId, status: "ok", duration_ms: 640, duration_exact: 1, permission_decision: "accept", permission_source: "user_temporary" },
  ]);
  expect(all(db, "SELECT id, request_id, status_code, attempt, source FROM api_errors")).toEqual([
    { id: s.errorUuid, request_id: "req_failed", status_code: 529, attempt: 1, source: "transcript" },
  ]);
  expect(all(db, "SELECT file_path, load_reason, bytes, source FROM instructions_loaded")).toEqual([
    { file_path: "/repo/CLAUDE.md", load_reason: "session_start", bytes: 7, source: "transcript" },
  ]);
  expect(all(db, "SELECT id, trigger, pre_tokens, post_tokens, duration_ms FROM compactions")).toEqual([
    { id: s.compactionUuid, trigger: "auto", pre_tokens: 150_000, post_tokens: 20_000, duration_ms: 30_000 },
  ]);
  expect(all(db, "SELECT end_reason FROM sessions")).toEqual([{ end_reason: "other" }]);
  expect(flags(db, "otel_events")).toEqual([1, 1, 1, 1]);
  expect(flags(db, "hook_events")).toEqual([1, 1, 1, 1, 1]);
});

test("the result does not depend on what arrived first: events or transcript rows", () => {
  const { db: early } = eventsFirst();

  const late = openMemoryDb();
  const s = scenario();
  reduce(late, s.t);
  seedEvents(late, s);
  mergeEnrichment(late, "s1", ANTHROPIC_PROVIDER);

  expect(dump(late)).toEqual(dump(early));
});

test("a repeated merge changes nothing", () => {
  const { db } = eventsFirst();
  const merged = dump(db);

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);

  expect(dump(db)).toEqual(merged);
});

test("reloading the transcript from the start does not lose refinements from events", () => {
  const { db, s } = eventsFirst();
  const merged = dump(db);

  // The file was replaced and re-read in full: the reducers write all its rows again.
  reduce(db, s.t);
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);

  expect(dump(db)).toEqual(merged);
});

test("after the merge the derived data see the refinements: exact model time, API error count, status", () => {
  const db = openMemoryDb();
  const s = scenario();
  reduce(db, s.t);
  seedEvents(db, s);
  // An error that is not in the transcript: a record with source otel for the main agent.
  seed.otelEvent(db, { session_id: "s1", ts: START + 20_000, name: OTEL_EVENT_NAMES.apiError, attrs: { error: "Connection error.", attempt: 1 } });
  const derive = (): void => {
    // Right after the last session event: without SessionEnd it would count as running.
    for (const reducer of DERIVED_REDUCERS) reducer({ db, sessionId: "s1", prices: REF_PRICES, provider: ANTHROPIC_PROVIDER, now: START + 71_000 });
  };
  derive();
  expect(all<SessionRow>(db, "SELECT * FROM sessions")).toMatchObject([{ model_ms_exact: 0, api_errors: 1, status: "running" }]);

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);
  derive();

  expect(all<SessionRow>(db, "SELECT * FROM sessions")).toMatchObject([{ model_ms: 3210, model_ms_exact: 1, api_errors: 2, status: "completed", end_reason: "other" }]);
});

test("the session was reopened: new transcript rows after SessionEnd return it to running", () => {
  const { db, s } = eventsFirst();
  const derive = (now: number): void => {
    for (const reducer of DERIVED_REDUCERS) reducer({ db, sessionId: "s1", prices: REF_PRICES, provider: ANTHROPIC_PROVIDER, now });
  };
  derive(START + 71_000);
  expect(all(db, "SELECT end_reason, status FROM sessions")).toEqual([{ end_reason: "other", status: "completed" }]);

  // The next day a new turn is appended to the same file.
  const resumedAt = START + 24 * 60 * 60_000;
  const before = s.t.lines.length;
  s.t.at(resumedAt).prompt("Continue");
  reduce(db, s.t, s.t.lines.slice(before));
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);
  derive(resumedAt + 1000);

  expect(all(db, "SELECT end_reason, status FROM sessions")).toEqual([{ end_reason: null, status: "running" }]);
});

// ── Transaction ─────────────────────────────────────────────────────────────────────────────

test("outside an outer transaction the merge is atomic: a failure on one event rolls back those already applied", () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.modelCall(db, { session_id: "s1", id: "req_1", duration_ms: 4000 });
  seed.toolCall(db, { session_id: "s1", id: "toolu_1" });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "req_1", duration_ms: 2350 } });
  seed.otelEvent(db, { session_id: "s1", name: "claude_code.user_prompt", attrs: {} });
  const broken = seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.toolResult, attrs: { tool_use_id: "toolu_1", duration_ms: 38 } });
  db.query("UPDATE otel_events SET attrs_json = '{' WHERE id = ?").run(broken.id);
  const before = dump(db);

  expect(() => mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toThrow();

  expect(db.inTransaction).toBe(false);
  expect(dump(db)).toEqual(before);
});

test("the merge works inside the indexer transaction and is rolled back together with it", () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.modelCall(db, { session_id: "s1", id: "req_1", duration_ms: 4000 });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest, attrs: { request_id: "req_1", duration_ms: 2350 } });
  seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiError, attrs: { error: "Overloaded", attempt: 1 } });
  const before = dump(db);

  db.exec("BEGIN IMMEDIATE");
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);
  expect(db.inTransaction).toBe(true);
  db.exec("ROLLBACK");
  expect(dump(db)).toEqual(before);

  db.exec("BEGIN IMMEDIATE");
  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);
  db.exec("COMMIT");
  expect(flags(db, "otel_events")).toEqual([1, 1]);
  expect(all(db, "SELECT duration_ms, duration_exact FROM model_calls")).toEqual([{ duration_ms: 2350, duration_exact: 1 }]);
});

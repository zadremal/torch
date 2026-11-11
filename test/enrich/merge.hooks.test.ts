// mergeEnrichment: hooks events give instructions, the session end and compaction refinements (plan §6.3).
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { CompactionRow, InstructionLoadedRow, SessionRow } from "../../src/contracts/rows.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { mergeEnrichment } from "../../src/enrich/merge.ts";
import { deriveStatus } from "../../src/ingest/reduce/status.ts";
import { REF_PRICES } from "../support/reference.ts";
import { SEED_TIME, seed } from "../support/seed.ts";
import { ANTHROPIC_PROVIDER } from "../support/provider.ts";

const MINUTE = 60_000;
/** The last transcript event in the session from `sessionDb`. */
const LAST_EVENT = SEED_TIME + MINUTE;

function sessionDb(): Database {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", ended_at: LAST_EVENT, status: "running" });
  seed.agent(db, { session_id: "s1" });
  return db;
}

const all = <Row>(db: Database, sql: string): Row[] => db.query<Row, []>(sql).all();
const applied = (db: Database): number[] => all<{ applied: number }>(db, "SELECT applied FROM hook_events ORDER BY id").map((row) => row.applied);
const instructions = (db: Database) => all<InstructionLoadedRow>(db, "SELECT * FROM instructions_loaded ORDER BY session_id, ts, id");
const compactions = (db: Database) => all<CompactionRow>(db, "SELECT * FROM compactions ORDER BY session_id, ts, id");
const session = (db: Database, id = "s1") => db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id)!;

/** A hooks event of session s1 with a time offset from SEED_TIME. */
const hook = (db: Database, name: string, offset: number, attrs: Record<string, unknown> = {}, sessionId = "s1") =>
  seed.hookEvent(db, { session_id: sessionId, ts: SEED_TIME + offset, name, attrs: { hook_event_name: name, session_id: sessionId, ...attrs } });

const CLAUDE_MD = "/repo/CLAUDE.md";

/** A transcript row about a loaded file: without a load reason. */
const loadedLine = (db: Database, id: string, offset: number, row: Partial<InstructionLoadedRow> = {}) =>
  seed.instruction(db, { session_id: "s1", id, ts: SEED_TIME + offset, file_path: CLAUDE_MD, ...row });

/** A compaction row where the transcript named neither the trigger nor the duration. */
const bareCompaction = (db: Database, id: string, offset: number, sessionId = "s1") =>
  seed.compaction(db, { session_id: sessionId, id, ts: SEED_TIME + offset, trigger: null, duration_ms: null });

// ── InstructionsLoaded → instructions_loaded ────────────────────────────────────────────────

test("InstructionsLoaded without a transcript row gives a record with source hook and the file size", () => {
  const db = sessionDb();
  const event = hook(db, "InstructionsLoaded", 20, { file_path: CLAUDE_MD, memory_type: "Project", load_reason: "session_start", file_bytes: 4097 });

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);

  expect(instructions(db)).toEqual([
    {
      session_id: "s1",
      id: `hook:${event.id}`,
      agent_id: "main",
      ts: SEED_TIME + 20,
      file_path: CLAUDE_MD,
      memory_type: "Project",
      load_reason: "session_start",
      bytes: 4097,
      // The same estimate as for transcript rows: 4 bytes per token, rounded up.
      tokens_est: 1025,
      source: "hook",
    },
  ]);
  expect(applied(db)).toEqual([1]);
});

test("a record of a subagent's event belongs to that subagent", () => {
  const db = sessionDb();
  hook(db, "InstructionsLoaded", 0, { file_path: CLAUDE_MD, load_reason: "session_start", agent_id: "a1", agent_type: "Explore" });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(instructions(db)).toMatchObject([{ agent_id: "a1", source: "hook" }]);
});

test("a file that could not be read when the event was ingested is stored without a size", () => {
  const db = sessionDb();
  hook(db, "InstructionsLoaded", 0, { file_path: CLAUDE_MD, load_reason: "session_start", file_bytes: null });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(instructions(db)).toMatchObject([{ file_path: CLAUDE_MD, memory_type: null, bytes: null, tokens_est: null, source: "hook" }]);
});

test("a transcript row about the same file gets the load reason: there is one record", () => {
  const db = sessionDb();
  const fromTranscript = loadedLine(db, "uuid-1:0", 3 * MINUTE, { bytes: 5000, tokens_est: 1250 });
  hook(db, "InstructionsLoaded", 0, { file_path: CLAUDE_MD, memory_type: "Project", load_reason: "session_start", file_bytes: 4000 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  // The size and time stay from the transcript: it holds the file contents.
  expect(instructions(db)).toEqual([{ ...fromTranscript, load_reason: "session_start" }]);
  expect(applied(db)).toEqual([1]);
});

test("the memory type from the event fills an empty one and does not replace the one recorded by the transcript", () => {
  const db = sessionDb();
  loadedLine(db, "uuid-1:0", 0, { memory_type: null });
  loadedLine(db, "uuid-1:1", 0, { file_path: "/home/CLAUDE.md", memory_type: "User" });
  hook(db, "InstructionsLoaded", 0, { file_path: CLAUDE_MD, memory_type: "Project", load_reason: "session_start" });
  hook(db, "InstructionsLoaded", 0, { file_path: "/home/CLAUDE.md", memory_type: "Managed", load_reason: "session_start" });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(instructions(db).map((row) => [row.file_path, row.memory_type, row.load_reason])).toEqual([
    [CLAUDE_MD, "Project", "session_start"],
    ["/home/CLAUDE.md", "User", "session_start"],
  ]);
});

test("an event about another file is not merged with the transcript row", () => {
  const db = sessionDb();
  loadedLine(db, "uuid-1:0", 0);
  hook(db, "InstructionsLoaded", 5, { file_path: "/repo/web/CLAUDE.md", load_reason: "nested_traversal", file_bytes: 800 });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(instructions(db).map((row) => [row.file_path, row.source, row.load_reason])).toEqual([
    [CLAUDE_MD, "transcript", null],
    ["/repo/web/CLAUDE.md", "hook", "nested_traversal"],
  ]);
});

test("an event of the main agent is not merged with a subagent's row about the same file", () => {
  const db = sessionDb();
  const ofSubagent = loadedLine(db, "uuid-1:0", MINUTE, { agent_id: "a1" });
  hook(db, "InstructionsLoaded", 0, { file_path: CLAUDE_MD, load_reason: "session_start" });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(instructions(db)).toMatchObject([{ agent_id: "main", source: "hook", load_reason: "session_start" }, ofSubagent]);
});

test("a subagent's event is merged with that subagent's row, not with the main agent's or a neighbor's", () => {
  const db = sessionDb();
  loadedLine(db, "uuid-1:0", 10, { agent_id: "main" });
  loadedLine(db, "uuid-2:0", 20, { agent_id: "a2" });
  loadedLine(db, "uuid-3:0", 30_000, { agent_id: "a1" });
  hook(db, "InstructionsLoaded", 0, { file_path: CLAUDE_MD, load_reason: "session_start", agent_id: "a1" });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(instructions(db).map((row) => [row.agent_id, row.source, row.load_reason])).toEqual([
    ["main", "transcript", null],
    ["a2", "transcript", null],
    ["a1", "transcript", "session_start"],
  ]);
});

test("a row more than five minutes from the event is another load: the event stays a record of its own", () => {
  for (const [offset, sources] of [
    [5 * MINUTE, ["transcript"]],
    [5 * MINUTE + 1, ["hook", "transcript"]],
    [-5 * MINUTE - 1, ["transcript", "hook"]],
  ] as const) {
    const db = sessionDb();
    loadedLine(db, "uuid-1:0", offset);
    hook(db, "InstructionsLoaded", 0, { file_path: CLAUDE_MD, load_reason: "session_start" });

    mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

    expect(instructions(db).map((row) => row.source)).toEqual([...sources]);
  }
});

test("two events about a file and one row: the nearest in time gives the reason, the other stays a record of its own", () => {
  const db = sessionDb();
  loadedLine(db, "uuid-1:0", 40 * MINUTE);
  hook(db, "InstructionsLoaded", 0, { file_path: CLAUDE_MD, load_reason: "session_start" });
  hook(db, "InstructionsLoaded", 40 * MINUTE - 50, { file_path: CLAUDE_MD, load_reason: "compact" });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(instructions(db).map((row) => [row.source, row.load_reason])).toEqual([
    ["hook", "session_start"],
    ["transcript", "compact"],
  ]);
});

test("two events within the window of one row: the row accepts the nearest", () => {
  const db = sessionDb();
  loadedLine(db, "uuid-1:0", 2 * MINUTE);
  hook(db, "InstructionsLoaded", 0, { file_path: CLAUDE_MD, load_reason: "session_start" });
  hook(db, "InstructionsLoaded", 2 * MINUTE - 50, { file_path: CLAUDE_MD, load_reason: "nested_traversal" });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(instructions(db).map((row) => [row.source, row.load_reason])).toEqual([
    ["hook", "session_start"],
    ["transcript", "nested_traversal"],
  ]);
});

test("an event within the window of two rows goes to the nearest", () => {
  const db = sessionDb();
  loadedLine(db, "uuid-1:0", MINUTE);
  loadedLine(db, "uuid-2:0", 4 * MINUTE);
  hook(db, "InstructionsLoaded", 3 * MINUTE, { file_path: CLAUDE_MD, load_reason: "compact" });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(instructions(db).map((row) => [row.id, row.load_reason])).toEqual([
    ["uuid-1:0", null],
    ["uuid-2:0", "compact"],
  ]);
});

test("a row that already has a reason does not accept a second event", () => {
  const db = sessionDb();
  loadedLine(db, "uuid-1:0", 0);
  hook(db, "InstructionsLoaded", 0, { file_path: CLAUDE_MD, load_reason: "session_start" });
  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  // The next merge: one more event about the same file near the same row.
  hook(db, "InstructionsLoaded", 1000, { file_path: CLAUDE_MD, load_reason: "include" });
  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(instructions(db).map((row) => [row.source, row.load_reason])).toEqual([
    ["transcript", "session_start"],
    ["hook", "include"],
  ]);
});

test("InstructionsLoaded without a file path gives no record and does not wait for a row", () => {
  const db = sessionDb();
  hook(db, "InstructionsLoaded", 0, { load_reason: "session_start" });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(instructions(db)).toEqual([]);
  expect(applied(db)).toEqual([1]);
});

// ── SessionEnd → sessions.end_reason ────────────────────────────────────────────────────────

test("SessionEnd after the last session event stores the end reason; the merge does not write the status", () => {
  const db = sessionDb();
  const before = session(db);
  hook(db, "SessionEnd", MINUTE + 1000, { reason: "other", prompt_id: "p1" });

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);

  expect(session(db)).toEqual({ ...before, end_reason: "other" });
  expect(applied(db)).toEqual([1]);

  // The last event is fresher than five minutes, but there was a SessionEnd: the status derivation sets completed.
  deriveStatus({ db, sessionId: "s1", prices: REF_PRICES, provider: ANTHROPIC_PROVIDER, now: LAST_EVENT + 2000 });
  expect(session(db).status).toBe("completed");
});

test("SessionEnd at the same moment as the last session event also ends it", () => {
  const db = sessionDb();
  hook(db, "SessionEnd", MINUTE, { reason: "other" });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(session(db).end_reason).toBe("other");
});

test("SessionEnd without a reason still ends the session", () => {
  const db = sessionDb();
  hook(db, "SessionEnd", MINUTE);

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(session(db).end_reason).toBe("unknown");
});

test("the session was reopened: transcript rows arrived after SessionEnd, so the end reason is cleared", () => {
  const db = sessionDb();
  hook(db, "SessionEnd", MINUTE + 1000, { reason: "other" });
  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);
  expect(session(db).end_reason).toBe("other");

  // The app was opened the next day: SessionStart and new rows in the same file.
  const resumedAt = LAST_EVENT + 20 * 60 * MINUTE;
  hook(db, "SessionStart", 21 * 60 * MINUTE - 5000, { source: "resume" });
  db.query("UPDATE sessions SET ended_at = ? WHERE id = 's1'").run(resumedAt);
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);

  expect(session(db).end_reason).toBeNull();
  deriveStatus({ db, sessionId: "s1", prices: REF_PRICES, provider: ANTHROPIC_PROVIDER, now: resumedAt + 1000 });
  expect(session(db).status).toBe("running");

  // A new SessionEnd after the new rows ends the session again.
  hook(db, "SessionEnd", 21 * 60 * MINUTE + 5000, { reason: "logout" });
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);
  expect(session(db).end_reason).toBe("logout");
});

test("SessionEnd before the last session event does not store a reason", () => {
  const db = sessionDb();
  hook(db, "SessionEnd", MINUTE - 1, { reason: "other" });

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);

  expect(session(db).end_reason).toBeNull();
  expect(applied(db)).toEqual([1]);
});

test("an earlier SessionEnd ingested after a later one does not overwrite the reason", () => {
  const db = sessionDb();
  hook(db, "SessionEnd", 3 * MINUTE, { reason: "logout" });
  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  // The event file from the spool was ingested late.
  hook(db, "SessionEnd", 2 * MINUTE, { reason: "clear" });
  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);

  expect(session(db).end_reason).toBe("logout");
  expect(applied(db)).toEqual([1, 1]);
});

test("SessionEnd of another session does not end this one", () => {
  const db = sessionDb();
  seed.session(db, { id: "s2", ended_at: LAST_EVENT });
  hook(db, "SessionEnd", 2 * MINUTE, { reason: "other" }, "s2");

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);
  expect(session(db).end_reason).toBeNull();

  mergeEnrichment(db, "s2", ANTHROPIC_PROVIDER);
  expect(session(db, "s2").end_reason).toBe("other");
  expect(session(db).end_reason).toBeNull();
});

test("SessionStart does not change the session and is marked as applied: it carries no model", () => {
  const db = sessionDb();
  const before = session(db);
  hook(db, "SessionStart", 0, { source: "startup" });

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);

  expect(session(db)).toEqual(before);
  expect(applied(db)).toEqual([1]);
});

// ── PreCompact, PostCompact → compactions ───────────────────────────────────────────────────

test("PreCompact and PostCompact supplement the compaction with what the transcript did not name: trigger and duration", () => {
  const db = sessionDb();
  const before = bareCompaction(db, "uuid-1", 31_000);
  hook(db, "PreCompact", 0, { trigger: "auto" });
  hook(db, "PostCompact", 30_500, { trigger: "auto", compact_summary: "…" });

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(true);

  expect(compactions(db)).toEqual([{ ...before, trigger: "auto", duration_ms: 30_500 }]);
  expect(applied(db)).toEqual([1, 1]);
});

test("the trigger and duration from the transcript's compactMetadata take precedence over hooks", () => {
  const db = sessionDb();
  const before = seed.compaction(db, { session_id: "s1", id: "uuid-1", ts: SEED_TIME + 31_000, trigger: "manual", duration_ms: 29_900 });
  hook(db, "PreCompact", 0, { trigger: "auto" });
  hook(db, "PostCompact", 30_500, { trigger: "auto" });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(compactions(db)).toEqual([before]);
  expect(applied(db)).toEqual([1, 1]);
});

test("PostCompact recorded before or after the transcript row finds the same compaction", () => {
  for (const postAt of [30_000, 32_000]) {
    const db = sessionDb();
    bareCompaction(db, "uuid-1", 31_000);
    hook(db, "PreCompact", 0, { trigger: "manual" });
    hook(db, "PostCompact", postAt, { trigger: "manual" });

    mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

    expect(compactions(db)).toMatchObject([{ trigger: "manual", duration_ms: postAt }]);
  }
});

test("each compaction has its own PreCompact and PostCompact", () => {
  const db = sessionDb();
  bareCompaction(db, "uuid-1", 20_000);
  bareCompaction(db, "uuid-2", 60 * MINUTE + 45_000);
  hook(db, "PreCompact", 0, { trigger: "manual" });
  hook(db, "PostCompact", 20_000);
  hook(db, "PreCompact", 60 * MINUTE, { trigger: "auto" });
  hook(db, "PostCompact", 60 * MINUTE + 44_000);

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(compactions(db).map((row) => [row.id, row.trigger, row.duration_ms])).toEqual([
    ["uuid-1", "manual", 20_000],
    ["uuid-2", "auto", 44_000],
  ]);
});

test("a compaction takes the nearest PreCompact before it: the PreCompact of an aborted compaction stays without a row", () => {
  const db = sessionDb();
  bareCompaction(db, "uuid-1", 3 * MINUTE + 30_000);
  // The first compaction was aborted: there is no transcript row, PostCompact did not arrive.
  hook(db, "PreCompact", 0, { trigger: "manual" });
  hook(db, "PreCompact", 3 * MINUTE, { trigger: "auto" });
  hook(db, "PostCompact", 3 * MINUTE + 30_000);

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(compactions(db)).toMatchObject([{ trigger: "auto", duration_ms: 30_000 }]);
  expect(applied(db)).toEqual([0, 1, 1]);
});

test("a compaction without its own PreCompact does not get the trigger of an aborted compaction started long before it", () => {
  const db = sessionDb();
  // The PreCompact of an aborted compaction; the next compaction an hour later left no events of its own.
  hook(db, "PreCompact", 0, { trigger: "manual" });
  const before = bareCompaction(db, "uuid-1", 60 * MINUTE);

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);

  expect(compactions(db)).toEqual([before]);
  expect(applied(db)).toEqual([0]);
});

test("a compaction row no more than ten minutes from PreCompact is its compaction, farther is not", () => {
  for (const [offset, trigger] of [
    [10 * MINUTE, "auto"],
    [10 * MINUTE + 1, null],
  ] as const) {
    const db = sessionDb();
    bareCompaction(db, "uuid-1", offset);
    hook(db, "PreCompact", 0, { trigger: "auto" });

    mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

    expect(compactions(db)).toMatchObject([{ trigger }]);
  }
});

test("a PreCompact after the compaction row does not belong to it", () => {
  const db = sessionDb();
  const before = bareCompaction(db, "uuid-1", 0);
  hook(db, "PreCompact", 1, { trigger: "auto" });

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(compactions(db)).toEqual([before]);
  expect(applied(db)).toEqual([0]);
});

test("PostCompact without a PreCompact before it within the window is not applied", () => {
  for (const preAt of [null, -10 * MINUTE - 1]) {
    const db = sessionDb();
    const before = bareCompaction(db, "uuid-1", 0);
    if (preAt !== null) hook(db, "PreCompact", preAt, { trigger: "auto" });
    hook(db, "PostCompact", 100);

    expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);

    expect(compactions(db)).toEqual([before]);
    expect(applied(db).at(-1)).toBe(0);
  }
});

test("PostCompact more than ten minutes from PreCompact does not close its compaction", () => {
  for (const [postAt, duration, postApplied] of [
    [10 * MINUTE, 10 * MINUTE, 1],
    [10 * MINUTE + 1, null, 0],
  ] as const) {
    const db = sessionDb();
    bareCompaction(db, "uuid-1", 30_000);
    hook(db, "PreCompact", 0, { trigger: "auto" });
    hook(db, "PostCompact", postAt);

    mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

    expect(compactions(db)).toMatchObject([{ trigger: "auto", duration_ms: duration }]);
    expect(applied(db)).toEqual([1, postApplied]);
  }
});

test("PreCompact and PostCompact with the same time do not store a duration", () => {
  const db = sessionDb();
  bareCompaction(db, "uuid-1", 0);
  hook(db, "PreCompact", 0, { trigger: "auto" });
  hook(db, "PostCompact", 0);

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(compactions(db)).toMatchObject([{ trigger: "auto", duration_ms: null }]);
  expect(applied(db)).toEqual([1, 1]);
});

test("hooks events of another session refine neither the compactions nor the instructions of this one", () => {
  const db = sessionDb();
  seed.session(db, { id: "s2" });
  const compaction = bareCompaction(db, "uuid-1", 30_000);
  const line = loadedLine(db, "uuid-2:0", 0);
  hook(db, "PreCompact", 0, { trigger: "auto" }, "s2");
  hook(db, "PostCompact", 29_000, {}, "s2");
  hook(db, "InstructionsLoaded", 0, { file_path: CLAUDE_MD, load_reason: "session_start" }, "s2");

  expect(mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER)).toBe(false);
  expect(applied(db)).toEqual([0, 0, 0]);

  // Merging its own session: its events do not find rows of another one.
  mergeEnrichment(db, "s2", ANTHROPIC_PROVIDER);
  expect(compactions(db)).toEqual([compaction]);
  expect(instructions(db)).toMatchObject([line, { session_id: "s2", source: "hook" }]);
});

test("a PreCompact of another session between the event and the compaction row does not interfere with the pair", () => {
  const db = sessionDb();
  seed.session(db, { id: "s2" });
  bareCompaction(db, "uuid-1", 30_000);
  hook(db, "PreCompact", 0, { trigger: "auto" });
  hook(db, "PreCompact", 10_000, { trigger: "manual" }, "s2");
  hook(db, "PostCompact", 30_000);

  mergeEnrichment(db, "s1", ANTHROPIC_PROVIDER);

  expect(compactions(db)).toMatchObject([{ trigger: "auto", duration_ms: 30_000 }]);
});

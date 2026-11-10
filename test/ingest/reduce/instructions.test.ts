// instructions and nested_memory rows go into instructions_loaded with the size and token estimate
// (spikes.md §3).
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { MAIN_AGENT_ID } from "../../../src/contracts/constants.ts";
import type { InstructionLoadedRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { reduceInstructions } from "../../../src/ingest/reduce/instructions.ts";
import { transcript } from "../../support/transcript.ts";
import { context, parsed, rows } from "./session.support.ts";

const START = Date.UTC(2026, 9, 1, 10, 0, 0);

const loaded = (db: Database) => rows<InstructionLoadedRow>(db, "SELECT * FROM instructions_loaded ORDER BY ts, id");

test("an instructions row: one record per file with the path, memory kind, size and token estimate", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", startAt: START });
  const uuid = t.instructions([
    { path: "/Users/dev/.claude/CLAUDE.md", type: "User", content: "x".repeat(4096) },
    // 10 bytes: the estimate is rounded up.
    { path: "/Users/dev/code/app/CLAUDE.md", type: "Project", content: "0123456789" },
  ]);
  reduceInstructions(context(db, t), parsed(t));

  expect(loaded(db)).toEqual([
    { session_id: "s1", id: `${uuid}:0`, agent_id: MAIN_AGENT_ID, ts: START, file_path: "/Users/dev/.claude/CLAUDE.md", memory_type: "User", load_reason: null, bytes: 4096, tokens_est: 1024, source: "transcript" },
    { session_id: "s1", id: `${uuid}:1`, agent_id: MAIN_AGENT_ID, ts: START, file_path: "/Users/dev/code/app/CLAUDE.md", memory_type: "Project", load_reason: null, bytes: 10, tokens_est: 3, source: "transcript" },
  ]);
});

test("a nested_memory row: one record; the size is counted in bytes, not characters", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", startAt: START });
  const uuid = t.nestedMemory({ path: "/Users/dev/code/app/src/CLAUDE.md", type: "Nested", content: "日本語日本" });
  reduceInstructions(context(db, t), parsed(t));

  expect(loaded(db)).toEqual([
    { session_id: "s1", id: `${uuid}:0`, agent_id: MAIN_AGENT_ID, ts: START, file_path: "/Users/dev/code/app/src/CLAUDE.md", memory_type: "Nested", load_reason: null, bytes: 15, tokens_est: 4, source: "transcript" },
  ]);
});

test("a subagent's instructions are recorded against its agent", () => {
  const db = openMemoryDb();
  const sub = transcript({ sessionId: "s1", agentId: "a1" });
  sub.instructions([{ path: "/Users/dev/code/app/CLAUDE.md", type: "Project", content: "rules" }]);
  reduceInstructions(context(db, sub), parsed(sub));
  expect(loaded(db).map((row) => [row.agent_id, row.file_path])).toEqual([["a1", "/Users/dev/code/app/CLAUDE.md"]]);
});

test("a row without files gives no records", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.instructions([]);
  t.prompt("Hello");
  reduceInstructions(context(db, t), parsed(t));
  expect(loaded(db)).toEqual([]);
});

test("reprocessing does not create duplicates and keeps the load reason filled in from hooks", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.instructions([{ path: "/Users/dev/code/app/CLAUDE.md", type: "Project", content: "rules" }]);
  reduceInstructions(context(db, t), parsed(t));
  db.exec("UPDATE instructions_loaded SET load_reason = 'session_start'");
  const before = loaded(db);

  reduceInstructions(context(db, t), parsed(t));
  expect(loaded(db)).toEqual(before);
  expect(before.map((row) => row.load_reason)).toEqual(["session_start"]);
});

test("a memory kind filled in from hooks is not lost when the transcript row does not name it", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  // The row has no memory kind: this happens in transcripts, the fixture always writes it.
  t.nestedMemory({ path: "/Users/dev/code/app/src/CLAUDE.md", type: undefined as unknown as string, content: "rules" });
  reduceInstructions(context(db, t), parsed(t));
  expect(loaded(db).map((row) => row.memory_type)).toEqual([null]);

  db.exec("UPDATE instructions_loaded SET memory_type = 'Project'");
  reduceInstructions(context(db, t), parsed(t));
  expect(loaded(db).map((row) => row.memory_type)).toEqual(["Project"]);
});

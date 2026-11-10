// ingestSpool: hooks event files from the spool → hook_events rows (plan §3.4, §7.2; spikes.md §8).
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookPayload } from "../../src/contracts/enrich.ts";
import type { RawEventRow } from "../../src/contracts/rows.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { ingestSpool } from "../../src/enrich/hooks.ts";
import { SEED_TIME } from "../support/seed.ts";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

/** stdin fields shared by all events of a desktop session. */
const COMMON = {
  session_id: SESSION_ID,
  transcript_path: `/Users/dev/.claude/projects/-Users-dev-code-example/${SESSION_ID}.jsonl`,
  cwd: "/Users/dev/code/example",
  scratchpad_dir: "/private/tmp/claude-501/scratchpad",
};

/** A temporary test directory with an empty spool. */
function tempSpool(): { root: string; spool: string } {
  const root = mkdtempSync(join(tmpdir(), "torch-spool-"));
  const spool = join(root, "spool");
  mkdirSync(spool);
  return { root, spool };
}

/** Puts a file into the spool with write time `ts`, as `hooks/record.sh` would have done at that moment. */
function put(spool: string, name: string, content: object | string, ts: number = SEED_TIME): string {
  const path = join(spool, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  utimesSync(path, ts / 1000, ts / 1000);
  return path;
}

const rows = (db: Database) => db.query<RawEventRow, []>("SELECT * FROM hook_events ORDER BY id").all();
const attrs = (row: RawEventRow) => JSON.parse(row.attrs_json) as Record<string, unknown>;

test("events are ingested into hook_events, files are deleted", () => {
  const db = openMemoryDb();
  const { spool } = tempSpool();
  const start: HookPayload = { ...COMMON, hook_event_name: "SessionStart", source: "startup" };
  const end: HookPayload = { ...COMMON, hook_event_name: "SessionEnd", reason: "other", prompt_id: "prompt-0001" };
  put(spool, "0001.json", start, SEED_TIME);
  put(spool, "0002.json", end, SEED_TIME + 90_000);

  expect(ingestSpool(db, spool)).toBe(2);

  expect(rows(db)).toEqual([
    { id: 1, session_id: SESSION_ID, ts: SEED_TIME, name: "SessionStart", attrs_json: JSON.stringify(start), applied: 0 },
    { id: 2, session_id: SESSION_ID, ts: SEED_TIME + 90_000, name: "SessionEnd", attrs_json: JSON.stringify(end), applied: 0 },
  ]);
  expect(readdirSync(spool)).toEqual([]);
});

test("InstructionsLoaded: the instructions file size is read from disk on ingestion", () => {
  const db = openMemoryDb();
  const { root, spool } = tempSpool();
  const instructions = join(root, "CLAUDE.md");
  writeFileSync(instructions, "# Règles\n".repeat(100));
  const payload: HookPayload = { ...COMMON, hook_event_name: "InstructionsLoaded", file_path: instructions, memory_type: "Project", load_reason: "session_start" };
  put(spool, "0001.json", payload);

  expect(ingestSpool(db, spool)).toBe(1);

  const [row] = rows(db);
  expect(row).toMatchObject({ session_id: SESSION_ID, ts: SEED_TIME, name: "InstructionsLoaded", applied: 0 });
  expect(attrs(row!)).toEqual({ ...payload, file_bytes: Buffer.byteLength("# Règles\n") * 100 });
  // Ingestion does not touch the instructions file itself.
  expect(existsSync(instructions)).toBe(true);
});

test("InstructionsLoaded: an inaccessible instructions file gives file_bytes = null", () => {
  const db = openMemoryDb();
  const { root, spool } = tempSpool();
  put(spool, "0001.json", { ...COMMON, hook_event_name: "InstructionsLoaded", file_path: join(root, "missing", "CLAUDE.md"), memory_type: "User", load_reason: "session_start" });
  put(spool, "0002.json", { ...COMMON, hook_event_name: "InstructionsLoaded", file_path: root, memory_type: "Project", load_reason: "session_start" });
  put(spool, "0003.json", { ...COMMON, hook_event_name: "InstructionsLoaded", memory_type: "Project" });

  expect(ingestSpool(db, spool)).toBe(3);
  expect(rows(db).map((row) => attrs(row).file_bytes)).toEqual([null, null, null]);
});

test("other events have no file_bytes attribute", () => {
  const db = openMemoryDb();
  const { spool } = tempSpool();
  put(spool, "0001.json", { ...COMMON, hook_event_name: "PreCompact", trigger: "auto" }, SEED_TIME);
  put(spool, "0002.json", { ...COMMON, hook_event_name: "PostCompact", trigger: "auto", compact_summary: "Summary of the conversation so far." }, SEED_TIME + 1000);

  expect(ingestSpool(db, spool)).toBe(2);
  const stored = rows(db);
  expect(stored.map((row) => row.name)).toEqual(["PreCompact", "PostCompact"]);
  expect(attrs(stored[0]!)).toEqual({ ...COMMON, hook_event_name: "PreCompact", trigger: "auto" });
  expect(attrs(stored[1]!)).toMatchObject({ trigger: "auto", compact_summary: "Summary of the conversation so far." });
});

test("events are ingested in file write order, ties broken by name", () => {
  const db = openMemoryDb();
  const { spool } = tempSpool();
  put(spool, "a.json", { ...COMMON, hook_event_name: "SessionEnd", reason: "other" }, SEED_TIME + 5000);
  put(spool, "c.json", { ...COMMON, hook_event_name: "InstructionsLoaded", file_path: "/nope/CLAUDE.md" }, SEED_TIME);
  put(spool, "b.json", { ...COMMON, hook_event_name: "SessionStart", source: "startup" }, SEED_TIME);

  expect(ingestSpool(db, spool)).toBe(3);
  expect(rows(db).map((row) => [row.name, row.ts])).toEqual([
    ["SessionStart", SEED_TIME],
    ["InstructionsLoaded", SEED_TIME],
    ["SessionEnd", SEED_TIME + 5000],
  ]);
});

test("an event with an unknown name is stored as is", () => {
  const db = openMemoryDb();
  const { spool } = tempSpool();
  put(spool, "0001.json", { ...COMMON, hook_event_name: "BrandNewHook", extra: { nested: true } });

  expect(ingestSpool(db, spool)).toBe(1);
  expect(rows(db)[0]).toMatchObject({ name: "BrandNewHook", session_id: SESSION_ID });
  expect(attrs(rows(db)[0]!).extra).toEqual({ nested: true });
});

test("a file under a temporary name is still being written: it stays in the spool", () => {
  const db = openMemoryDb();
  const { spool } = tempSpool();
  const payload = { ...COMMON, hook_event_name: "SessionStart", source: "startup" };
  put(spool, "0001.json.tmp", payload);
  put(spool, ".0002.json", payload);
  put(spool, "0003.tmp", '{"hook_event_name": "Sess');
  mkdirSync(join(spool, "dir.json"));

  expect(ingestSpool(db, spool)).toBe(0);
  expect(rows(db)).toEqual([]);
  expect(readdirSync(spool).sort()).toEqual([".0002.json", "0001.json.tmp", "0003.tmp", "dir.json"]);
});

test("a file that does not parse as an event is deleted without a record and does not affect the others", () => {
  const db = openMemoryDb();
  const { spool } = tempSpool();
  put(spool, "0001.json", "", SEED_TIME);
  put(spool, "0002.json", '{"hook_event_name": "Sess', SEED_TIME + 1);
  put(spool, "0003.json", "[1, 2]", SEED_TIME + 2);
  put(spool, "0004.json", { hook_event_name: "SessionStart" }, SEED_TIME + 3);
  put(spool, "0005.json", { session_id: SESSION_ID }, SEED_TIME + 4);
  put(spool, "0006.json", { ...COMMON, hook_event_name: "SessionStart", source: "startup" }, SEED_TIME + 5);

  expect(ingestSpool(db, spool)).toBe(1);
  expect(rows(db).map((row) => [row.name, row.ts])).toEqual([["SessionStart", SEED_TIME + 5]]);
  expect(readdirSync(spool)).toEqual([]);
});

test("repeated ingestion adds nothing; new files are appended", () => {
  const db = openMemoryDb();
  const { spool } = tempSpool();
  put(spool, "0001.json", { ...COMMON, hook_event_name: "SessionStart", source: "startup" });
  expect(ingestSpool(db, spool)).toBe(1);
  expect(ingestSpool(db, spool)).toBe(0);
  expect(rows(db)).toHaveLength(1);

  put(spool, "0002.json", { ...COMMON, hook_event_name: "SessionEnd", reason: "other" }, SEED_TIME + 1000);
  expect(ingestSpool(db, spool)).toBe(1);
  expect(rows(db).map((row) => row.name)).toEqual(["SessionStart", "SessionEnd"]);
});

test("the spool directory does not exist yet: 0 events ingested", () => {
  const db = openMemoryDb();
  const { root } = tempSpool();
  expect(ingestSpool(db, join(root, "no-such-dir"))).toBe(0);
  expect(rows(db)).toEqual([]);
});

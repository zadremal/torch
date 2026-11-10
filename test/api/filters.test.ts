import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { enumParam, flagParam, numberParam, QueryError, type SessionFilter, sessionFilterSql, textParam } from "../../src/api/filters.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { seed } from "../support/seed.ts";

const DAY = 86_400_000;
const OCT_1 = Date.UTC(2026, 9, 1);

/** Ids of the sessions that passed the filter, alphabetically. */
function ids(db: Database, filter: SessionFilter): string[] {
  const { where, params } = sessionFilterSql(filter);
  return db
    .query<{ id: string }, (string | number)[]>(`SELECT id FROM sessions WHERE ${where} ORDER BY id`)
    .all(...params)
    .map((row) => row.id);
}

function seeded(): Database {
  const db = openMemoryDb();
  seed.session(db, { id: "a", name: "Fix login bug", project: "web", started_at: OCT_1, agents_count: 3, tool_calls: 10, tool_errors: 3, tok_total: 9_000_000 });
  seed.session(db, { id: "b", name: "billing export", project: "billing", started_at: OCT_1 + DAY, agents_count: 5, tool_calls: 120, tool_errors: 0, tok_total: 1_500_000 });
  seed.session(db, { id: "c", name: "Refactor Login form", project: "web", started_at: OCT_1 + 2 * DAY, agents_count: 1, tool_calls: 40, tool_errors: 20, tok_total: 400_000 });
  seed.session(db, { id: "t", name: "Scratch login", project: "T", cwd: "/private/var/folders/zz/T/scratch", is_temp_dir: 1, started_at: OCT_1 + DAY, agents_count: 1 });
  return db;
}

describe("sessionFilterSql", () => {
  test("empty filter with temporary directories included — condition \"1\" without parameters", () => {
    expect(sessionFilterSql({ temp: true })).toEqual({ where: "1", params: [] });
    expect(ids(seeded(), { temp: true })).toEqual(["a", "b", "c", "t"]);
  });

  test("temporary directories are hidden until temp is true", () => {
    const db = seeded();
    expect(ids(db, {})).toEqual(["a", "b", "c"]);
    expect(ids(db, { temp: false })).toEqual(["a", "b", "c"]);
    expect(ids(db, { temp: true })).toContain("t");
  });

  test("period by started_at: start included, end excluded", () => {
    const db = seeded();
    expect(ids(db, { from: OCT_1 + DAY })).toEqual(["b", "c"]);
    expect(ids(db, { to: OCT_1 + DAY })).toEqual(["a"]);
    expect(ids(db, { from: OCT_1, to: OCT_1 + 2 * DAY })).toEqual(["a", "b"]);
    expect(ids(db, { from: OCT_1 + DAY, to: OCT_1 + 2 * DAY, temp: true })).toEqual(["b", "t"]);
  });

  test("project — exact match", () => {
    const db = seeded();
    expect(ids(db, { project: "web" })).toEqual(["a", "c"]);
    expect(ids(db, { project: "we" })).toEqual([]);
  });

  test("dashboard set: period, project and temporary directories together", () => {
    const db = seeded();
    seed.session(db, { id: "t2", project: "web", is_temp_dir: 1, started_at: OCT_1 + 2 * DAY });
    expect(ids(db, { from: OCT_1 + DAY, to: OCT_1 + 3 * DAY, project: "web" })).toEqual(["c"]);
    expect(ids(db, { from: OCT_1 + DAY, to: OCT_1 + 3 * DAY, project: "web", temp: true })).toEqual(["c", "t2"]);
  });

  test("the condition works in a query with a JOIN: columns are written with the table name", () => {
    const db = seeded();
    seed.toolCall(db, { session_id: "a", id: "t1", name: "Bash" });
    seed.toolCall(db, { session_id: "a", id: "t2", name: "Read" });
    seed.toolCall(db, { session_id: "b", id: "t1", name: "Bash" });
    seed.toolCall(db, { session_id: "t", id: "t1", name: "Bash" });
    // tool_calls has its own name and id, and sessions has a tool_calls column: without the table name the condition would be ambiguous.
    const { where, params } = sessionFilterSql({ q: "login", tcMin: 1, from: OCT_1, to: OCT_1 + DAY });
    const rows = db
      .query<{ name: string; calls: number }, (string | number)[]>(
        `SELECT tool_calls.name AS name, COUNT(*) AS calls
         FROM tool_calls JOIN sessions ON sessions.id = tool_calls.session_id
         WHERE ${where} GROUP BY tool_calls.name ORDER BY tool_calls.name`,
      )
      .all(...params);
    expect(rows).toEqual([
      { name: "Bash", calls: 1 },
      { name: "Read", calls: 1 },
    ]);
  });

  test("q: substring of the name, case-insensitive, surrounding spaces trimmed", () => {
    const db = seeded();
    expect(ids(db, { q: "login" })).toEqual(["a", "c"]);
    expect(ids(db, { q: "LOGIN", temp: true })).toEqual(["a", "c", "t"]);
    expect(ids(db, { q: "  billing " })).toEqual(["b"]);
    expect(ids(db, { q: "   " })).toEqual(["a", "b", "c"]);
  });

  test("q: LIKE wildcards and quotes are ordinary characters", () => {
    const db = openMemoryDb();
    seed.session(db, { id: "p", name: "Cut build time by 50%" });
    seed.session(db, { id: "u", name: "rename snake_case vars" });
    seed.session(db, { id: "s", name: "path C:\\temp cleanup" });
    seed.session(db, { id: "x", name: "Cut build time by 500 ms" });
    seed.session(db, { id: "y", name: "rename snakeXcase vars" });
    expect(ids(db, { q: "50%" })).toEqual(["p"]);
    expect(ids(db, { q: "snake_case" })).toEqual(["u"]);
    expect(ids(db, { q: "C:\\temp" })).toEqual(["s"]);
    expect(ids(db, { q: "%" })).toEqual(["p"]);
    expect(ids(db, { q: "' OR 1=1 --" })).toEqual([]);
  });

  test("q: accented letters are found case-insensitively, including mixed case in the name", () => {
    const db = openMemoryDb();
    seed.session(db, { id: "r1", name: "Fix the Café bug" });
    seed.session(db, { id: "r2", name: "café menu" });
    seed.session(db, { id: "r3", name: "CAFÉ: urgent" });
    expect(ids(db, { q: "fix" })).toEqual(["r1"]);
    expect(ids(db, { q: "FIX THE CAFÉ" })).toEqual(["r1"]);
    expect(ids(db, { q: "Café" })).toEqual(["r1", "r2", "r3"]);
    seed.session(db, { id: "r4", name: "FIX THE Café bug in report" });
    expect(ids(db, { q: "fix the café" })).toEqual(["r1", "r4"]);
  });

  test("agents: AGENT_BUCKETS bucket boundaries inclusive", () => {
    const db = openMemoryDb();
    for (const n of [1, 2, 3, 4, 7]) seed.session(db, { id: `n${n}`, agents_count: n });
    expect(ids(db, { agents: "any" })).toEqual(["n1", "n2", "n3", "n4", "n7"]);
    expect(ids(db, { agents: "one" })).toEqual(["n1"]);
    expect(ids(db, { agents: "few" })).toEqual(["n2", "n3"]);
    expect(ids(db, { agents: "many" })).toEqual(["n4", "n7"]);
  });

  test("tc, er, tk: boundaries inclusive, tk in thousands of tokens", () => {
    const db = seeded();
    expect(ids(db, { tcMin: 40 })).toEqual(["b", "c"]);
    expect(ids(db, { tcMax: 40 })).toEqual(["a", "c"]);
    expect(ids(db, { tcMin: 11, tcMax: 119 })).toEqual(["c"]);
    expect(ids(db, { erMin: 3 })).toEqual(["a", "c"]);
    expect(ids(db, { erMax: 3 })).toEqual(["a", "b"]);
    expect(ids(db, { tkMin: 1500 })).toEqual(["a", "b"]);
    expect(ids(db, { tkMax: 1500 })).toEqual(["b", "c"]);
    expect(ids(db, { tkMin: 400.5, tkMax: 8999 })).toEqual(["b"]);
  });

  test("conditions are combined with AND", () => {
    const db = seeded();
    expect(ids(db, { q: "login", project: "web", erMin: 10 })).toEqual(["c"]);
    expect(ids(db, { q: "login", agents: "one", temp: true })).toEqual(["c", "t"]);
  });
});

describe("query parameter parsing", () => {
  test("an empty string and a missing parameter — no value", () => {
    for (const raw of [undefined, ""]) {
      expect(textParam(raw)).toBeUndefined();
      expect(flagParam("temp", raw)).toBeUndefined();
      expect(numberParam("tcMin", raw)).toBeUndefined();
      expect(enumParam("dir", raw, ["asc", "desc"])).toBeUndefined();
    }
  });

  test("valid values", () => {
    expect(textParam("web")).toBe("web");
    expect([flagParam("temp", "true"), flagParam("temp", "1"), flagParam("temp", "false"), flagParam("temp", "0")]).toEqual([true, true, false, false]);
    expect([numberParam("tcMin", "0"), numberParam("tcMin", "42"), numberParam("tkMin", "1.5")]).toEqual([0, 42, 1.5]);
    expect(enumParam("dir", "asc", ["asc", "desc"])).toBe("asc");
  });

  test("invalid value — QueryError naming the parameter", () => {
    expect(() => flagParam("temp", "yes")).toThrow(QueryError);
    expect(() => flagParam("temp", "yes")).toThrow(/temp/);
    for (const raw of ["-1", "abc", "1e3", "NaN", "Infinity", " 5", "5,5", "0x10", "12345678901"]) {
      expect(() => numberParam("tcMin", raw)).toThrow(QueryError);
    }
    expect(() => enumParam("dir", "up", ["asc", "desc"])).toThrow(/dir/);
  });
});

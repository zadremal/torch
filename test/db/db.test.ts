import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, openMemoryDb, openReadonlyDb, schemaVersion } from "../../src/db/db.ts";
import { referenceScenario } from "../support/reference.ts";
import { seedListSessions, seedReference } from "../support/reference-seed.ts";
import { seed } from "../support/seed.ts";

test("the database file is created with mode 0600, WAL and the current schema", () => {
  const path = join(mkdtempSync(join(tmpdir(), "torch-db-")), "nested", "torch.db");
  const db = openDb(path);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
  expect(schemaVersion(db)).toBe(3);
  db.close();
});

test("reopening does not reapply migrations and keeps the data", () => {
  const path = join(mkdtempSync(join(tmpdir(), "torch-db-")), "torch.db");
  const first = openDb(path);
  seed.session(first, { id: "s1" });
  first.close();
  const second = openDb(path);
  expect(second.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()!.n).toBe(1);
  second.close();
});

test("each table's columns match the row fields from rows.ts", () => {
  const db = openMemoryDb();
  const s = "s1";
  // A row inserted by the support helper with defaults carries all fields of its rows.ts type.
  const rows: Record<string, object> = {
    sessions: seed.session(db, { id: s }),
    agents: seed.agent(db, { session_id: s }),
    prompts: seed.prompt(db, { session_id: s, id: "p1" }),
    model_calls: seed.modelCall(db, { session_id: s, id: "m1" }),
    tool_calls: seed.toolCall(db, { session_id: s, id: "t1", input: "{}", output: "ok" }),
    file_ops: seed.fileOp(db, { session_id: s, tool_call_id: "t1", path: "/a.ts" }),
    external_requests: seed.externalRequest(db, { session_id: s, tool_call_id: "t1" }),
    api_errors: seed.apiError(db, { session_id: s, id: "e1" }),
    messages: seed.message(db, { session_id: s, id: "u1:0" }),
    instructions_loaded: seed.instruction(db, { session_id: s, id: "i1", file_path: "/CLAUDE.md" }),
    compactions: seed.compaction(db, { session_id: s, id: "c1" }),
    otel_events: seed.otelEvent(db, { session_id: s, name: "claude_code.api_request" }),
    hook_events: seed.hookEvent(db, { session_id: s, name: "SessionEnd" }),
    source_files: seed.sourceFile(db, { path: "/x.jsonl", session_id: s }),
  };
  for (const [table, row] of Object.entries(rows)) {
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    expect({ table, columns: columns.sort() }).toEqual({ table, columns: Object.keys(row).sort() });
  }
});

test("the reference session and the remaining mockup sessions are inserted into the database", () => {
  const db = openMemoryDb();
  const scn = referenceScenario();
  const rows = seedReference(db);
  seedListSessions(db);
  const count = (table: string) => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
  expect(count("sessions")).toBe(16);
  expect(rows.modelCalls).toHaveLength(142);
  expect(rows.toolCalls).toHaveLength(186);
  expect(count("api_errors")).toBe(3);
  // For the remaining sessions the calls add up to the values of their rows: the dashboard agrees with the list.
  expect(count("model_calls")).toBe(db.query<{ n: number }, []>("SELECT SUM(model_calls) AS n FROM sessions").get()!.n);
  expect(count("tool_calls")).toBe(db.query<{ n: number }, []>("SELECT SUM(tool_calls) AS n FROM sessions").get()!.n);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tool_calls WHERE status = 'error'").get()!.n).toBe(
    db.query<{ n: number }, []>("SELECT SUM(tool_errors) AS n FROM sessions").get()!.n,
  );
  expect(rows.agents).toHaveLength(5);
  expect(rows.session.tool_errors).toBe(7);
  // Session totals equal the sum over the calls.
  expect(rows.session.tok_total).toBe(scn.modelCalls.reduce((n, c) => n + c.tokInput + c.tokOutput + c.tokCacheRead + c.tokCacheWrite5m + c.tokCacheWrite1h, 0));
  for (const agent of rows.agents) {
    const breakdown = JSON.parse(agent.ctx_breakdown_json!) as { tokens: number }[];
    expect(breakdown.reduce((n, b) => n + b.tokens, 0)).toBe(agent.ctx_peak!);
  }
});

test("read-only open: without a database it returns null and no file is created; data is readable, writes are forbidden", () => {
  const path = join(mkdtempSync(join(tmpdir(), "torch-db-")), "nested", "torch.db");
  expect(openReadonlyDb(path)).toBeNull();
  expect(existsSync(path)).toBe(false);

  const writable = openDb(path);
  seed.session(writable, { id: "s1" });
  writable.close();

  const db = openReadonlyDb(path)!;
  expect(schemaVersion(db)).toBe(3);
  expect(db.query<{ id: string }, []>("SELECT id FROM sessions").all()).toEqual([{ id: "s1" }]);
  expect(() => db.exec("DELETE FROM sessions")).toThrow();
  db.close();
});

test("migration 003: indexed calls blocked by anything but the user become errors, the totals follow", () => {
  const db = openMemoryDb();
  db.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1" });
  const rejected = "The user doesn't want to proceed with this tool use. The tool use was rejected.";
  seed.toolCall(db, { session_id: "s1", id: "t1", status: "error", output: "Exit code 1" });
  seed.toolCall(db, { session_id: "s1", id: "t2", status: "denied", output: rejected });
  seed.toolCall(db, { session_id: "s1", id: "t3", status: "denied", output: "No.", permission_decision: "reject", permission_source: "user_reject" });
  seed.toolCall(db, { session_id: "s1", id: "t4", status: "denied", output: "Permission to use Bash has been denied.", permission_decision: "reject", permission_source: "config" });
  seed.toolCall(db, { session_id: "s1", id: "t5", status: "denied", output: "  Blocked by auto mode.\nReason: …" });
  seed.toolCall(db, { session_id: "s1", id: "t6", status: "denied", output: `To tell you how to proceed, the user said:\n${"x".repeat(5000)}` });

  expect(migrate(db)).toEqual([3]);
  const rows = db.query<{ id: string; status: string; error_title: string | null; permission_decision: string | null }, []>(
    "SELECT id, status, error_title, permission_decision FROM tool_calls ORDER BY id",
  ).all();
  expect(rows.map((r) => [r.id, r.status, r.permission_decision])).toEqual([
    ["t1", "error", null],
    ["t2", "denied", "reject"],
    ["t3", "denied", "reject"],
    ["t4", "error", "reject"],
    ["t5", "error", "reject"],
    ["t6", "denied", "reject"],
  ]);
  expect(rows.find((r) => r.id === "t5")!.error_title).toBe("Blocked by auto mode.");
  expect(db.query<{ n: number }, []>("SELECT tool_errors AS n FROM agents").get()!.n).toBe(3);
  expect(db.query<{ n: number }, []>("SELECT tool_errors AS n FROM sessions").get()!.n).toBe(3);
});

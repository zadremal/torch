// deriveStatus: running or completed (plan §6.2, decision 36).
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { SessionRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { deriveStatus } from "../../../src/ingest/reduce/status.ts";
import { REF_PRICES } from "../../support/reference.ts";
import { SEED_TIME, seed } from "../../support/seed.ts";
import { ANTHROPIC_PROVIDER } from "../../support/provider.ts";

const MINUTE = 60_000;

const derive = (db: Database, now: number, sessionId = "s1") => deriveStatus({ db, sessionId, prices: REF_PRICES, provider: ANTHROPIC_PROVIDER, now });
const sessionRow = (db: Database, id = "s1") => db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id)!;

test("the last event is younger than five minutes and there was no SessionEnd: running", () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", ended_at: SEED_TIME, status: "completed" });
  derive(db, SEED_TIME + 5 * MINUTE - 1);
  expect(sessionRow(db).status).toBe("running");
});

test("the last event exactly five minutes ago or older: completed", () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", ended_at: SEED_TIME, status: "running" });
  derive(db, SEED_TIME + 5 * MINUTE);
  expect(sessionRow(db).status).toBe("completed");

  db.query("UPDATE sessions SET status = 'running'").run();
  derive(db, SEED_TIME + 24 * 60 * MINUTE);
  expect(sessionRow(db).status).toBe("completed");
});

test("SessionEnd arrived (end_reason is filled): completed, even if the event is fresh", () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", ended_at: SEED_TIME, end_reason: "prompt_input_exit", status: "running" });
  derive(db, SEED_TIME + 1000);
  expect(sessionRow(db).status).toBe("completed");
});

test("the session has no event with a time: completed", () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", started_at: null, ended_at: null, status: "running" });
  derive(db, SEED_TIME);
  expect(sessionRow(db).status).toBe("completed");
});

test("a running session ends with time and runs again after a new event", () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", ended_at: SEED_TIME });
  derive(db, SEED_TIME + MINUTE);
  expect(sessionRow(db).status).toBe("running");

  derive(db, SEED_TIME + 6 * MINUTE);
  expect(sessionRow(db).status).toBe("completed");

  // The next pass appended a row: the last event time moved.
  db.query("UPDATE sessions SET ended_at = ?").run(SEED_TIME + 6 * MINUTE);
  derive(db, SEED_TIME + 7 * MINUTE);
  expect(sessionRow(db).status).toBe("running");
});

test("only the session from the context is recalculated, the other columns do not change", () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", ended_at: SEED_TIME, status: "completed" });
  seed.session(db, { id: "s2", ended_at: SEED_TIME, status: "completed" });
  const before = sessionRow(db, "s1");
  derive(db, SEED_TIME + MINUTE, "s1");
  expect(sessionRow(db, "s1")).toEqual({ ...before, status: "running" });
  expect(sessionRow(db, "s2").status).toBe("completed");
});

test("the recalculation is idempotent", () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", ended_at: SEED_TIME, status: "completed" });
  derive(db, SEED_TIME + MINUTE);
  const once = sessionRow(db);
  derive(db, SEED_TIME + MINUTE);
  expect(sessionRow(db)).toEqual(once);
});

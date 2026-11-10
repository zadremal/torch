// Session row: project, temp directory, time bounds, reported cost (plan §6.2).
import { expect, test } from "bun:test";
import type { SessionRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { reduceSession } from "../../../src/ingest/reduce/session.ts";
import { text, transcript } from "../../support/transcript.ts";
import { context, parsed, rows } from "./session.support.ts";

const START = Date.UTC(2026, 9, 1, 10, 0, 0);

const sessionRow = (db: ReturnType<typeof openMemoryDb>, id = "s1") => rows<SessionRow>(db, `SELECT * FROM sessions WHERE id = '${id}'`)[0]!;

/** A session of one prompt in the given working directory. */
function sessionIn(cwd: string): SessionRow {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", cwd });
  t.prompt("Hello");
  reduceSession(context(db, t), parsed(t));
  return sessionRow(db);
}

test("directory, project, version and branch come from the first row of the main file, time from the first and last", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", cwd: "/Users/dev/code/billing-web", version: "2.1.300", gitBranch: "feature/api", startAt: START });
  t.prompt("Fix the bug");
  t.tick(4000).assistant({ blocks: [text("Done")] });
  // The directory and branch changed mid-session: the session stays in the project where it started.
  t.tick(1000).prompt("More");
  Object.assign(t.lines.at(-1)!, { cwd: "/Users/dev/code/other", gitBranch: "main", version: "2.1.321" });
  reduceSession(context(db, t), parsed(t));

  expect(sessionRow(db)).toMatchObject({
    id: "s1",
    source: "local",
    cwd: "/Users/dev/code/billing-web",
    project: "billing-web",
    is_temp_dir: 0,
    entrypoint: "claude-desktop",
    cc_version: "2.1.300",
    git_branch: "feature/api",
    started_at: START,
    ended_at: START + 5000,
    cost_reported_usd: null,
  });
});

test("temp directory: a working directory under /private/var/folders/ or /private/tmp/", () => {
  expect(sessionIn("/private/var/folders/zz/abc123/T/claude-scratch-1")).toMatchObject({ is_temp_dir: 1, project: "claude-scratch-1" });
  expect(sessionIn("/private/tmp/claude-501/scratch")).toMatchObject({ is_temp_dir: 1, project: "scratch" });
});

test("an ordinary directory is not considered temporary, even if it looks like one", () => {
  expect(sessionIn("/Users/dev/code/example").is_temp_dir).toBe(0);
  expect(sessionIn("/private/var/db/app").is_temp_dir).toBe(0);
  expect(sessionIn("/Users/dev/private/tmp/app").is_temp_dir).toBe(0);
});

test("a session with no rows with a directory: no directory and project, not considered temporary", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.aiTitle("Only a title");
  reduceSession(context(db, t), parsed(t));
  expect(sessionRow(db)).toMatchObject({ cwd: null, project: null, is_temp_dir: 0, started_at: null, ended_at: null });
});

test("a subagent file widens the time bounds but does not describe the session", () => {
  const db = openMemoryDb();
  const main = transcript({ sessionId: "s1", cwd: "/Users/dev/code/app", startAt: START });
  main.prompt("Fix the bug");
  main.tick(2000).assistant({ blocks: [text("Delegating")] });
  // The subagent works in its own worktree and finishes later than the main agent.
  const sub = transcript({ sessionId: "s1", agentId: "a1", cwd: "/private/tmp/worktrees/a1", gitBranch: "worktree-a1", startAt: START + 1000 });
  sub.prompt("Explore the repo");
  sub.tick(60_000).assistant({ blocks: [text("Report")] });
  sub.aiTitle("Subagent title");

  reduceSession(context(db, main), parsed(main));
  reduceSession(context(db, sub), parsed(sub));

  expect(sessionRow(db)).toMatchObject({
    cwd: "/Users/dev/code/app",
    project: "app",
    is_temp_dir: 0,
    git_branch: "main",
    name: "Fix the bug",
    name_source: "prompt",
    started_at: START,
    ended_at: START + 61_000,
  });
});

test("a subagent file processed before the main one creates the session row; the directory and name come from the main one", () => {
  const db = openMemoryDb();
  const sub = transcript({ sessionId: "s1", agentId: "a1", cwd: "/private/tmp/worktrees/a1", startAt: START + 1000 });
  sub.prompt("Explore the repo");
  reduceSession(context(db, sub), parsed(sub));
  expect(sessionRow(db)).toMatchObject({ cwd: null, project: null, is_temp_dir: 0, name: null, started_at: START + 1000, ended_at: START + 1000 });

  const main = transcript({ sessionId: "s1", cwd: "/Users/dev/code/app", startAt: START });
  main.prompt("Fix the bug");
  reduceSession(context(db, main), parsed(main));
  expect(sessionRow(db)).toMatchObject({ cwd: "/Users/dev/code/app", project: "app", name: "Fix the bug", started_at: START, ended_at: START + 1000 });
});

test("the reported cost is taken from the last cost-state row", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.prompt("Hello");
  t.costState({ totalCostUSD: 1.25, modelUsage: {} });
  reduceSession(context(db, t), parsed(t));
  expect(sessionRow(db).cost_reported_usd).toBe(1.25);

  // The next pass brings a new total; a pass without cost-state does not erase it.
  const next = transcript({ sessionId: "s1" });
  next.costState({ totalCostUSD: 2.5, modelUsage: {} });
  reduceSession(context(db, next), parsed(next));
  reduceSession(context(db, next), []);
  expect(sessionRow(db).cost_reported_usd).toBe(2.5);
});

test("the reducer does not touch the derived and enrichment columns", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.prompt("Hello");
  reduceSession(context(db, t), parsed(t));
  db.exec("UPDATE sessions SET status = 'running', tool_calls = 7, active_ms = 900, enrichment = 'full', end_reason = 'exit', transcript_present = 0");
  reduceSession(context(db, t), parsed(t));
  expect(sessionRow(db)).toMatchObject({ status: "running", tool_calls: 7, active_ms: 900, enrichment: "full", end_reason: "exit", transcript_present: 0 });
});

// torch commands on a directory of synthetic transcripts (plan §7.3). The transcripts,
// desktop app metadata and torch data directories are always temporary.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliDeps, type RunningTorch, type ServeOptions } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { API_ROUTES, type SessionsResponse } from "../src/contracts/api.ts";
import type { ServerEvent } from "../src/contracts/events.ts";
import { openDb } from "../src/db/db.ts";
import { WATCH_DELAY_MS } from "../src/ingest/watch.ts";
import { seed } from "./support/seed.ts";
import { text, toolUse, transcript, writeSession, type SessionFiles } from "./support/transcript.ts";

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const REPO = join(import.meta.dir, "..");

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';

const PROVIDER_MISMATCH =
  "The database was indexed with provider anthropic, config.json sets bedrock: sessions indexed before keep the anthropic result. To reindex: torch index --rebuild";

/** The command environment: temporary directories and captured output. */
function cli(overrides: Partial<CliDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "torch-cli-"));
  const webDir = join(root, "web-dist");
  mkdirSync(webDir);
  writeFileSync(join(webDir, "index.html"), INDEX_HTML);
  const config = loadConfig({
    dataDir: join(root, "torch"),
    transcriptsDir: join(root, "projects"),
    desktopSessionsDir: join(root, "desktop"),
    claudeSettingsPath: join(root, "settings.json"),
  });
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const opened: string[] = [];
  const state = { answer: false };
  const deps: CliDeps = {
    config,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => NOW,
    confirm: (question) => {
      questions.push(question);
      return state.answer;
    },
    openBrowser: (url) => opened.push(url),
    serve: (options) => {
      const server = Bun.serve(options);
      return { url: server.url, stop: () => void server.stop(true) };
    },
    webDir,
    ...overrides,
  };
  return {
    root,
    config,
    out,
    err,
    questions,
    opened,
    state,
    run: (...argv: string[]) => runCli(argv, deps),
    write: (files: SessionFiles) => writeSession(config.transcriptsDir, files),
    /** All command output as a single string. */
    output: () => [...out, ...err].join("\n"),
  };
}

function sessionFiles(sessionId: string, promptText = "Fix the flaky test"): SessionFiles {
  const main = transcript({ sessionId });
  main.prompt(promptText);
  const { toolUseIds } = main.tick(2000).assistant({ blocks: [text("Reading"), toolUse("Read", { file_path: "/repo/a.ts" })], usage: { input: 10, output: 100, cacheRead: 2000 } });
  main.tick(300).toolResult(toolUseIds[0]!, { content: "file body", toolUseResult: { type: "text", file: { filePath: "/repo/a.ts", content: "file body" } } });
  main.tick(1500).assistant({ blocks: [text("Done")], usage: { input: 5, output: 20, cacheRead: 2500 } });
  return { main };
}

/** All database tables in full, together with file bookkeeping and body numbers. */
function dumpFile(dbPath: string): Record<string, unknown[]> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return Object.fromEntries(tables.map(({ name }) => [name, db.query(`SELECT * FROM ${name}`).all()]));
  } finally {
    db.close();
  }
}

function query<Row>(dbPath: string, sql: string): Row[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<Row, []>(sql).all();
  } finally {
    db.close();
  }
}

describe("torch index", () => {
  test("loads transcripts and prints the pass summary", () => {
    const c = cli();
    c.write(sessionFiles("s1"));
    c.write(sessionFiles("s2"));

    expect(c.run("index")).toBe(0);

    expect(c.out).toEqual(["Files: 2, with new lines: 2, lines parsed: 10, sessions changed: 2"]);
    expect(query(c.config.dbPath, "SELECT id, model_calls, tool_calls, transcript_present FROM sessions ORDER BY id")).toEqual([
      { id: "s1", model_calls: 2, tool_calls: 1, transcript_present: 1 },
      { id: "s2", model_calls: 2, tool_calls: 1, transcript_present: 1 },
    ]);
  });

  test("twice in a row gives the same database", () => {
    const c = cli();
    c.write(sessionFiles("s1"));
    c.write(sessionFiles("s2"));
    expect(c.run("index")).toBe(0);
    const first = dumpFile(c.config.dbPath);

    expect(c.run("index")).toBe(0);

    expect(c.out[1]).toBe("Files: 2, with new lines: 0, lines parsed: 0, sessions changed: 0");
    const second = dumpFile(c.config.dbPath);
    expect(second).toEqual(first);
    expect(second.sessions).toHaveLength(2);
    expect(second.source_files).toHaveLength(2);
  });

  test("a vanished file leaves the session in the database with transcript_present = 0", () => {
    const c = cli();
    const { mainPath } = c.write(sessionFiles("gone"));
    c.write(sessionFiles("kept"));
    c.run("index");
    rmSync(mainPath);

    expect(c.run("index")).toBe(0);

    expect(c.out[1]).toBe("Files: 1, with new lines: 0, lines parsed: 0, sessions changed: 1");
    expect(query(c.config.dbPath, "SELECT id, transcript_present, model_calls FROM sessions ORDER BY id")).toEqual([
      { id: "gone", transcript_present: 0, model_calls: 2 },
      { id: "kept", transcript_present: 1, model_calls: 2 },
    ]);
    expect(query(c.config.dbPath, "SELECT session_id, missing_since FROM source_files ORDER BY session_id")).toEqual([
      { session_id: "gone", missing_since: NOW },
      { session_id: "kept", missing_since: null },
    ]);
  });

  test("the price table is created as a copy of prices.default.json, an existing one is not overwritten", () => {
    const c = cli();
    c.write(sessionFiles("s1"));

    c.run("index");
    expect(readFileSync(c.config.pricesPath, "utf8")).toBe(readFileSync(join(REPO, "prices.default.json"), "utf8"));
    const listPrice = query<{ cost_usd: number }>(c.config.dbPath, "SELECT cost_usd FROM sessions")[0]!.cost_usd;
    expect(listPrice).toBeGreaterThan(0);

    // Prices edited by the owner are read from the data directory and stay in place.
    const edited = JSON.parse(readFileSync(c.config.pricesPath, "utf8"));
    for (const model of Object.values<Record<string, number>>(edited.models)) for (const field of ["input", "output", "cacheRead"]) model[field]! *= 2;
    writeFileSync(c.config.pricesPath, JSON.stringify(edited));
    expect(c.run("index", "--rebuild", "--yes")).toBe(0);
    expect(JSON.parse(readFileSync(c.config.pricesPath, "utf8"))).toEqual(edited);
    expect(query<{ cost_usd: number }>(c.config.dbPath, "SELECT cost_usd FROM sessions")[0]!.cost_usd).toBeCloseTo(listPrice * 2, 9);
  });

  test("no transcripts directory: a warning, sessions stay in the database without a transcript", () => {
    const c = cli();
    c.write(sessionFiles("s1"));
    c.run("index");
    rmSync(c.config.transcriptsDir, { recursive: true });

    expect(c.run("index")).toBe(0);

    expect(c.err).toEqual([`Transcripts directory not found: ${c.config.transcriptsDir}`]);
    expect(query(c.config.dbPath, "SELECT id, transcript_present, model_calls FROM sessions")).toEqual([{ id: "s1", transcript_present: 0, model_calls: 2 }]);
  });

  test("unknown items in new lines: a single line pointing to doctor", () => {
    const c = cli();
    const files = sessionFiles("s1");
    files.main.raw({ type: "mystery-line", payload: "secret payload" });
    c.write(files);

    expect(c.run("index")).toBe(0);

    expect(c.out[1]).toBe("Unknown line types: 1, fields: 0 — details: torch doctor");
    expect(c.output()).not.toContain("secret payload");
  });

  test("the provider in config.json differs from the one the database was indexed with: one line with both and the remedy", () => {
    const c = cli();
    c.write(sessionFiles("s1"));
    expect(c.run("index")).toBe(0);
    expect(c.err).toEqual([]);

    c.config.provider = "bedrock";
    c.write(sessionFiles("s2"));
    expect(c.run("index")).toBe(0);
    expect(c.err).toEqual([PROVIDER_MISMATCH]);
    // New files are indexed regardless; the database is not rebuilt on its own.
    expect(query(c.config.dbPath, "SELECT id FROM sessions ORDER BY id")).toEqual([{ id: "s1" }, { id: "s2" }]);

    expect(c.run("index", "--rebuild", "--yes")).toBe(0);
    expect(c.err).toEqual([PROVIDER_MISMATCH]);
    expect(query(c.config.dbPath, "SELECT value FROM meta WHERE key = 'provider'")).toEqual([{ value: "bedrock" }]);
  });

  test("a file that could not be processed is named in the errors; the rest are loaded, exit code 1", () => {
    const c = cli();
    const locked = c.write(sessionFiles("locked"));
    c.write(sessionFiles("open"));
    chmodSync(locked.mainPath, 0o000);

    try {
      expect(c.run("index")).toBe(1);
    } finally {
      chmodSync(locked.mainPath, 0o600);
    }

    expect(c.err[0]).toBe("Failed to process files: 1:");
    expect(c.err[1]).toContain(locked.mainPath);
    expect(c.out).toEqual(["Files: 2, with new lines: 1, lines parsed: 5, sessions changed: 1"]);
    expect(query(c.config.dbPath, "SELECT id FROM sessions")).toEqual([{ id: "open" }]);
  });
});

describe("torch index --rebuild", () => {
  /** Two sessions in the database; one transcript was deleted after the last pass. */
  function indexedThenLost() {
    const c = cli();
    const { mainPath } = c.write(sessionFiles("gone"));
    c.write(sessionFiles("kept"));
    c.run("index");
    rmSync(mainPath);
    c.out.length = 0;
    return c;
  }

  const WARNING = "The rebuild wipes the database and reloads only what is on disk (transcript files: 1): everything older than the Claude Code retention period will be lost.";
  const LOSS = "Will be lost: sessions without a main file on disk: 1 of 2; subagent files of the remaining sessions that are no longer on disk: 0.";

  test("a transcript was deleted without an intermediate pass: the loss is counted from the disk, not from the previous pass", () => {
    const c = indexedThenLost();
    // The database does not know about the disappearance yet.
    expect(query(c.config.dbPath, "SELECT COUNT(*) AS n FROM sessions WHERE transcript_present = 0")).toEqual([{ n: 0 }]);
    const before = dumpFile(c.config.dbPath);

    expect(c.run("index", "--rebuild")).toBe(1);

    expect(c.out).toEqual([WARNING, LOSS, "Rebuild cancelled."]);
    expect(c.questions).toEqual(["Continue?"]);
    // A refusal leaves the database as it was: nothing is written to it before the question.
    expect(dumpFile(c.config.dbPath)).toEqual(before);
  });

  test("the loss includes subagent files that are no longer on disk", () => {
    const c = cli();
    const sub = transcript({ sessionId: "s1", agentId: "a1" });
    sub.prompt("Sub task");
    const { subagentPaths } = c.write({ ...sessionFiles("s1"), subagents: [{ transcript: sub }] });
    c.run("index");
    rmSync(subagentPaths[0]!);
    c.out.length = 0;

    expect(c.run("index", "--rebuild")).toBe(1);

    expect(c.out[1]).toBe("Will be lost: sessions without a main file on disk: 0 of 1; subagent files of the remaining sessions that are no longer on disk: 1.");
  });

  test("after consent rebuilds the database from the disk", () => {
    const c = indexedThenLost();
    c.state.answer = true;

    expect(c.run("index", "--rebuild")).toBe(0);

    expect(c.questions).toEqual(["Continue?"]);
    expect(c.out).toEqual([WARNING, LOSS, "Files: 1, with new lines: 1, lines parsed: 5, sessions changed: 1"]);
    expect(query(c.config.dbPath, "SELECT id FROM sessions")).toEqual([{ id: "kept" }]);
  });

  test("--yes rebuilds without a question, the warning remains", () => {
    const c = indexedThenLost();

    expect(c.run("index", "--rebuild", "--yes")).toBe(0);

    expect(c.questions).toEqual([]);
    expect(c.out.slice(0, 2)).toEqual([WARNING, LOSS]);
    expect(query(c.config.dbPath, "SELECT id FROM sessions")).toEqual([{ id: "kept" }]);
  });

  test("the transcripts directory exists but is empty: the rebuild is not performed, the database stays", () => {
    const c = indexedThenLost();
    const before = dumpFile(c.config.dbPath);
    rmSync(c.config.transcriptsDir, { recursive: true });
    mkdirSync(c.config.transcriptsDir);

    expect(c.run("index", "--rebuild", "--yes")).toBe(1);

    expect(c.err).toEqual(["No transcripts found on disk, but the database has sessions: 2. Rebuild not performed.", `Transcripts directory: ${c.config.transcriptsDir}`]);
    expect(c.out).toEqual([]);
    expect(c.questions).toEqual([]);
    expect(dumpFile(c.config.dbPath)).toEqual(before);
  });

  test("without a transcripts directory the rebuild is not performed: the database stays", () => {
    const c = indexedThenLost();
    const before = dumpFile(c.config.dbPath);
    rmSync(c.config.transcriptsDir, { recursive: true });

    expect(c.run("index", "--rebuild", "--yes")).toBe(1);

    expect(c.err).toEqual(["No transcripts found on disk, but the database has sessions: 2. Rebuild not performed.", `Transcripts directory: ${c.config.transcriptsDir}`]);
    expect(dumpFile(c.config.dbPath)).toEqual(before);
  });
});

describe("torch doctor", () => {
  test("prints unknown line types and fields with counters, without line contents", () => {
    const c = cli();
    const files = sessionFiles("s1", "PROMPT-TEXT-MUST-NOT-LEAK");
    files.main.raw({ type: "mystery-line", payload: "PAYLOAD-MUST-NOT-LEAK" });
    files.main.raw({ type: "mystery-line", payload: "PAYLOAD-MUST-NOT-LEAK" });
    files.main.raw({ type: "rare-line" });
    files.main.envelope({ type: "user", message: { role: "user", content: "x" }, brandNewField: "FIELD-VALUE-MUST-NOT-LEAK" });
    files.main.envelope({ type: "system", subtype: "api_error", error: { message: "x" }, freshField: 1 });
    const sub = transcript({ sessionId: "s1", agentId: "a1" });
    sub.prompt("Sub task");
    const { mainPath } = c.write({ main: files.main, subagents: [{ transcript: sub }] });
    writeFileSync(mainPath, `${readFileSync(mainPath, "utf8")}{"type": "user", BROKEN-LINE-MUST-NOT-LEAK\n`);

    expect(c.run("doctor")).toBe(0);

    expect(c.out).toEqual([
      `Transcripts: ${c.config.transcriptsDir}`,
      "Files: 2 (main 1, subagent 1), lines: 12",
      "Provider: anthropic",
      "  Model response lines without a call key: 0",
      "Unknown line types: 3",
      "        2  mystery-line",
      "        1  <invalid>",
      "        1  rare-line",
      "Unknown fields: 2",
      "        1  system.freshField",
      "        1  user.brandNewField",
      `Enrichment channels: no database yet (${c.config.dbPath})`,
    ]);
    expect(c.output()).not.toContain("MUST-NOT-LEAK");
    // The check only reads: it creates neither a database nor a data directory.
    expect(existsSync(c.config.dataDir)).toBe(false);
  });

  test("a type or field name that does not look like an identifier is not printed: only the overall counter", () => {
    const c = cli();
    const files = sessionFiles("s1");
    files.main.raw({ type: "ok-type/sub_v2.x" });
    // Text ended up in the type field and in a field name.
    files.main.raw({ type: "Please keep the LEAKED-TYPE-TEXT private" });
    files.main.raw({ type: "Please keep the LEAKED-TYPE-TEXT private" });
    files.main.raw({ type: `odd\u001b[31m\nLEAKED-CONTROL` });
    files.main.raw({ type: `LEAKED-LONG-${"x".repeat(80)}` });
    files.main.raw({ type: "日本語-LEAKED" });
    files.main.envelope({ type: "user", message: { role: "user", content: "x" }, "LEAKED field name": 1, plainField: 1 });
    c.write(files);

    expect(c.run("doctor")).toBe(0);

    expect(c.out.slice(4, 10)).toEqual([
      "Unknown line types: 5",
      "        1  ok-type/sub_v2.x",
      "  nonstandard name: 5",
      "Unknown fields: 2",
      "        1  user.plainField",
      "  nonstandard name: 1",
    ]);
    expect(c.output()).not.toContain("LEAKED");
  });

  test("an unreadable transcript does not abort the check: the file is skipped and counted", () => {
    const c = cli();
    const locked = c.write(sessionFiles("locked"));
    c.write(sessionFiles("open"));
    chmodSync(locked.mainPath, 0o000);

    try {
      expect(c.run("doctor")).toBe(0);
    } finally {
      chmodSync(locked.mainPath, 0o600);
    }

    expect(c.out.slice(0, 4)).toEqual([
      `Transcripts: ${c.config.transcriptsDir}`,
      "Files: 1 (main 1, subagent 0), lines: 5",
      "Files and directories that could not be read: 1",
      "Provider: anthropic",
    ]);
    expect(c.err).toEqual([]);
  });

  test("clean history: nothing unknown; the channel state comes from the database", () => {
    const c = cli();
    c.write(sessionFiles("s1"));
    c.run("index");
    c.out.length = 0;
    const db = openDb(c.config.dbPath);
    seed.otelEvent(db, { session_id: "s1", name: "claude_code.api_request", ts: NOW - 5000, applied: 1 });
    seed.otelEvent(db, { session_id: "s1", name: "claude_code.tool_result", ts: NOW - 4000 });
    seed.receiverWindow(db, { started_at: NOW - 60_000, stopped_at: NOW - 3000 });
    db.close();

    expect(c.run("doctor")).toBe(0);

    expect(c.out).toEqual([
      `Transcripts: ${c.config.transcriptsDir}`,
      "Files: 1 (main 1, subagent 0), lines: 5",
      "Provider: anthropic",
      "  Model response lines without a call key: 0",
      "Unknown line types: none",
      "Unknown fields: none",
      "Enrichment channels:",
      "  OTel: events 2, not applied 1, last 2026-11-09T11:59:56.000Z",
      "  Hooks: no events",
      "  OTel receiver: ran until 2026-11-09T11:59:57.000Z",
    ]);
  });
});

describe("torch doctor: provider", () => {
  /** A session written through a gateway: assistant lines without requestId. */
  function gatewaySession(sessionId: string): SessionFiles {
    const main = transcript({ sessionId, gateway: true });
    main.prompt("GATEWAY-PROMPT-MUST-NOT-LEAK");
    main.tick(2000).assistant({ blocks: [text("Reading"), text("Done")], usage: { input: 10, output: 100 } });
    main.tick(100).assistant({ blocks: [text("No response requested.")], model: "<synthetic>", split: false });
    return { main };
  }

  const HINT =
    '  They give no model calls, tokens or cost. Transcripts written through a gateway need "provider": "bedrock" in config.json, then torch index --rebuild';

  test("gateway transcripts with the default provider: the count of model responses without a call key and the hint", () => {
    const c = cli();
    c.write(gatewaySession("g1"));

    expect(c.run("doctor")).toBe(0);

    expect(c.out.slice(2, 5)).toEqual(["Provider: anthropic", "  Model response lines without a call key: 2", HINT]);
    expect(c.output()).not.toContain("MUST-NOT-LEAK");
  });

  test("the same transcripts with bedrock: every response has a key; the database indexed before names its provider", () => {
    const c = cli();
    c.write(gatewaySession("g1"));
    c.run("index");
    c.out.length = 0;
    c.err.length = 0;
    c.config.provider = "bedrock";

    expect(c.run("doctor")).toBe(0);

    expect(c.out.slice(2, 5)).toEqual(["Provider: bedrock", `  ${PROVIDER_MISMATCH}`, "  Model response lines without a call key: 0"]);
    expect(c.out).not.toContain(HINT);
  });

  test("with bedrock already set, responses without any key are counted without the advice to set bedrock", () => {
    const c = cli();
    const files = gatewaySession("g1");
    // Neither requestId nor message.id: no provider can key these lines.
    for (const line of files.main.lines) delete (line as { message?: { id?: string } }).message?.id;
    c.write(files);
    c.config.provider = "bedrock";

    expect(c.run("doctor")).toBe(0);

    expect(c.out.slice(2, 5)).toEqual(["Provider: bedrock", "  Model response lines without a call key: 2", "  They give no model calls, tokens or cost."]);
  });
});

describe("torch status", () => {
  test("no database yet: says so and does not create it", () => {
    const c = cli();

    expect(c.run("status")).toBe(0);

    expect(c.out).toEqual([`No database yet: ${c.config.dbPath}. torch index or torch start will create it.`]);
    expect(existsSync(c.config.dbPath)).toBe(false);
  });

  test("prints the schema version, session count, database size and the latest receiver windows", () => {
    const c = cli();
    const { mainPath } = c.write(sessionFiles("gone"));
    c.write(sessionFiles("kept"));
    c.run("index");
    rmSync(mainPath);
    c.run("index");
    const db = openDb(c.config.dbPath);
    seed.session(db, { id: "live", status: "running" });
    for (let n = 0; n < 6; n++) seed.receiverWindow(db, { started_at: NOW - (n + 1) * 3_600_000, stopped_at: NOW - (n + 1) * 3_600_000 + 60_000 });
    db.close();
    c.out.length = 0;

    expect(c.run("status")).toBe(0);

    expect(c.out[0]).toBe(`Database: ${c.config.dbPath}`);
    expect(c.out[1]).toBe("Schema version: 2");
    expect(c.out[2]).toBe("Sessions: 3 (running 1, without transcript 1)");
    expect(c.out[3]).toMatch(/^Database size: \d+\.\d (KB|MB)$/);
    expect(c.out.slice(4)).toEqual([
      "Receiver windows: latest 5",
      "  2026-11-09T11:00:00.000Z — 2026-11-09T11:01:00.000Z",
      "  2026-11-09T10:00:00.000Z — 2026-11-09T10:01:00.000Z",
      "  2026-11-09T09:00:00.000Z — 2026-11-09T09:01:00.000Z",
      "  2026-11-09T08:00:00.000Z — 2026-11-09T08:01:00.000Z",
      "  2026-11-09T07:00:00.000Z — 2026-11-09T07:01:00.000Z",
    ]);
  });

  test("the receiver has not run yet", () => {
    const c = cli();
    c.write(sessionFiles("s1"));
    c.run("index");
    c.out.length = 0;

    c.run("status");

    expect(c.out[2]).toBe("Sessions: 1 (running 0, without transcript 0)");
    expect(c.out[4]).toBe("Receiver windows: none");
  });
});

describe("torch start", () => {
  /** Runs `start` in this process on a free port and stops the server after the check. */
  async function started(c: ReturnType<typeof cli>, args: string[], check: (running: RunningTorch) => Promise<void>): Promise<void> {
    const running = c.run("start", "--port", "0", ...args);
    if (typeof running === "number" || running instanceof Promise) throw new Error(`start exited with code ${String(running)}: ${c.output()}`);
    try {
      await check(running);
    } finally {
      running.stop();
    }
  }

  test("catches up the index, starts the server with the API and prints the address", async () => {
    const c = cli();
    c.write(sessionFiles("s1"));

    await started(c, ["--no-open"], async ({ url }) => {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(c.out).toEqual(["Files: 1, with new lines: 1, lines parsed: 5, sessions changed: 1", `torch: ${url}`]);

      const list = (await (await fetch(new URL("/api/sessions", url))).json()) as SessionsResponse;
      expect(list.items.map((item) => [item.id, item.name, item.toolCalls])).toEqual([["s1", "Fix the flaky test", 1]]);
      // The UI page comes from the build directory, including at a screen address.
      for (const path of ["/", "/sessions/s1"]) {
        const page = await fetch(new URL(path, url));
        expect({ path, status: page.status, body: await page.text() }).toEqual({ path, status: 200, body: INDEX_HTML });
      }
    });
  });

  test("the catch-up pass names a provider that differs from the one the database was indexed with", async () => {
    const c = cli();
    c.write(sessionFiles("s1"));
    c.run("index");
    c.config.provider = "bedrock";

    await started(c, ["--no-open"], async () => {
      expect(c.err).toEqual([PROVIDER_MISMATCH]);
    });
  });

  test("watches the transcripts: an appended line arrives as an SSE event and is visible in the API", async () => {
    const c = cli();
    const main = transcript({ sessionId: "s1" });
    main.prompt("Fix the flaky test");
    const { toolUseIds } = main.tick(2000).assistant({ blocks: [text("Reading"), toolUse("Read", { file_path: "/repo/a.ts" })] });
    const { mainPath } = c.write({ main });
    const errors = async (url: string) => ((await (await fetch(new URL("/api/sessions", url))).json()) as SessionsResponse).items.map((item) => [item.id, item.errors]);

    await started(c, ["--no-open"], async ({ url }) => {
      expect(await errors(url)).toEqual([["s1", 0]]);
      const events = await fetch(new URL(API_ROUTES.events, url));
      expect(events.headers.get("content-type")).toBe("text/event-stream");

      const written = main.lines.length;
      main.tick(300).toolResult(toolUseIds[0]!, { content: "ENOENT", isError: true });
      appendFileSync(mainPath, main.lines.slice(written).map((line) => `${JSON.stringify(line)}\n`).join(""));

      // The stream is read up to the pass event: the changed session comes before it.
      const decoder = new TextDecoder();
      let received = "";
      for await (const chunk of events.body!) {
        received += decoder.decode(chunk, { stream: true });
        if (received.includes("index_updated")) break;
      }
      const sent = received.split("\n\n").filter((record) => record.startsWith("data: ")).map((record) => JSON.parse(record.slice("data: ".length)) as ServerEvent);
      expect(sent).toEqual([{ type: "session_changed", sessionId: "s1" }, { type: "index_updated", sessions: 1 }]);
      expect(await errors(url)).toEqual([["s1", 1]]);
      expect(c.err).toEqual([]);
    });

    // Stopping also stops the watching: the database is closed, and a pass triggered by a file change would report a failure.
    appendFileSync(mainPath, "\n");
    await Bun.sleep(WATCH_DELAY_MS * 2);
    expect(c.err).toEqual([]);
  });

  test("accepts hooks events from the spool and keeps the receiver window while running", async () => {
    const c = cli();
    c.write(sessionFiles("s1"));
    mkdirSync(c.config.spoolDir, { recursive: true });
    writeFileSync(join(c.config.spoolDir, "1-1.json"), JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", source: "startup" }));

    await started(c, ["--no-open"], async () => {
      expect(query(c.config.dbPath, "SELECT name, session_id FROM hook_events")).toEqual([{ name: "SessionStart", session_id: "s1" }]);
      expect(readdirSync(c.config.spoolDir)).toEqual([]);
      expect(query(c.config.dbPath, "SELECT COUNT(*) AS n FROM receiver_windows")).toEqual([{ n: 1 }]);
    });
  });

  test("--no-open does not open the browser; without the flag the printed address is opened", async () => {
    const quiet = cli();
    await started(quiet, ["--no-open"], async () => {
      expect(quiet.opened).toEqual([]);
    });

    const c = cli();
    await started(c, [], async ({ url }) => {
      expect(c.opened).toEqual([url]);
    });
  });

  test("--host sets the server address", async () => {
    const c = cli();
    await started(c, ["--no-open", "--host", "localhost"], async ({ url }) => {
      expect(new URL(url).hostname).toBe("localhost");
      expect((await fetch(new URL("/api/projects", url))).status).toBe(200);
    });
  });

  /** A substituted server launch: it remembers what it was given and listens to nothing. */
  function fakeServe() {
    const calls: ServeOptions[] = [];
    const state = { stopped: 0 };
    const serve: CliDeps["serve"] = (options) => {
      calls.push(options);
      return { url: new URL(`http://${options.hostname}:${options.port}/`), stop: () => void state.stopped++ };
    };
    return { calls, state, serve };
  }

  test("a non-loopback address: the server gets a token, the printed address contains it", async () => {
    const fake = fakeServe();
    const c = cli({ serve: fake.serve });
    c.write(sessionFiles("s1"));

    const running = c.run("start", "--no-open", "--host", "0.0.0.0", "--port", "4999") as RunningTorch;

    expect(fake.calls.map(({ hostname, port }) => ({ hostname, port }))).toEqual([{ hostname: "0.0.0.0", port: 4999 }]);
    const token = new URL(running.url).searchParams.get("token")!;
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(c.out.at(-1)).toBe(`torch: http://0.0.0.0:4999/?token=${token}`);

    const request = (path: string, headers: Record<string, string> = {}) => fake.calls[0]!.fetch(new Request(`http://192.168.1.20:4999${path}`, { headers }));
    expect((await request("/api/sessions")).status).toBe(401);
    expect((await request("/api/sessions?token=wrong")).status).toBe(401);
    const entry = await request(`/?token=${token}`);
    expect(entry.status).toBe(302);
    const cookie = entry.headers.get("set-cookie")!.split(";")[0]!;
    const list = (await (await request("/api/sessions", { cookie })).json()) as SessionsResponse;
    expect(list.items.map((item) => item.id)).toEqual(["s1"]);

    running.stop();
    expect(fake.state.stopped).toBe(1);
  });

  test("this machine's address: no token, a foreign name in Host is rejected", async () => {
    const fake = fakeServe();
    const c = cli({ serve: fake.serve });

    const running = c.run("start", "--no-open", "--port", "4999") as RunningTorch;

    expect(running.url).toBe("http://127.0.0.1:4999/");
    const { fetch: handle } = fake.calls[0]!;
    expect((await handle(new Request("http://127.0.0.1:4999/api/sessions"))).status).toBe(200);
    expect((await handle(new Request("http://evil.example:4999/api/sessions"))).status).toBe(403);
    running.stop();
  });

  test("a failure after listening has begun stops the server and closes the database", () => {
    const fake = fakeServe();
    const c = cli({
      serve: fake.serve,
      openBrowser: () => {
        throw new Error("no browser here");
      },
    });

    expect(c.run("start", "--port", "4999")).toBe(1);

    expect(c.err.at(-1)).toBe("torch start: no browser here");
    expect(fake.calls).toHaveLength(1);
    expect(fake.state.stopped).toBe(1);
    // The database is closed: its files can be removed and created anew.
    rmSync(c.config.dataDir, { recursive: true });
    expect(c.run("index")).toBe(0);
  });

  test("an invalid port is a usage error", () => {
    const c = cli();

    expect(c.run("start", "--port", "http")).toBe(2);
    expect(c.run("start", "--port", "70000")).toBe(2);

    expect(c.err[0]).toBe("Invalid port: http");
    expect(existsSync(c.config.dbPath)).toBe(false);
  });

  test("a busy port: an error message and exit code 1, no hanging server", async () => {
    const c = cli();
    await started(c, ["--no-open"], async ({ url }) => {
      const other = cli();

      expect(other.run("start", "--no-open", "--port", new URL(url).port)).toBe(1);

      expect(other.err.join("\n")).toContain("torch start:");
    });
  });

  test("a real process: reads TORCH_HOME and config.json, answers over the network and exits on a signal", async () => {
    const c = cli();
    c.write(sessionFiles("s1"));
    mkdirSync(c.config.dataDir, { recursive: true });
    writeFileSync(join(c.config.dataDir, "config.json"), JSON.stringify({ transcriptsDir: c.config.transcriptsDir, desktopSessionsDir: c.config.desktopSessionsDir, port: 0 }));

    const proc = Bun.spawn(["bun", join(REPO, "src", "cli.ts"), "start", "--no-open"], {
      // The home directory is temporary too: without config.json the process could not reach the real history.
      env: { ...process.env, TORCH_HOME: c.config.dataDir, HOME: c.root },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let printed = "";
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout) {
        printed += decoder.decode(chunk, { stream: true });
        if (/^torch: http/m.test(printed)) break;
      }
      const url = /^torch: (http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(printed)?.[1];
      expect(url).toBeDefined();

      const list = (await (await fetch(new URL("/api/sessions", url))).json()) as SessionsResponse;
      expect(list.items.map((item) => item.id)).toEqual(["s1"]);

      // The UI comes from the real build directory: the page if `bun run build` has been run, otherwise a hint.
      const built = join(REPO, "web", "dist", "index.html");
      const page = await fetch(url!);
      const expected = existsSync(built) ? { status: 200, body: readFileSync(built, "utf8") } : { status: 503, body: "UI is not built: run `bun run build`." };
      expect({ status: page.status, body: await page.text() }).toEqual(expected);

      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill("SIGKILL");
    }
  }, 20_000);
});

describe("command line parsing", () => {
  test("no command, an unknown command or flag: usage and exit code 2", () => {
    for (const argv of [[], ["launch"], ["index", "extra"], ["index", "--force"]]) {
      const c = cli();
      expect({ argv, code: c.run(...argv) }).toEqual({ argv, code: 2 });
      expect(c.err.join("\n")).toContain("Usage: torch <command>");
      expect(c.out).toEqual([]);
    }
  });

  test("a real process: an unknown command prints usage to stderr and exits with code 2", async () => {
    const c = cli();
    const proc = Bun.spawn(["bun", join(REPO, "src", "cli.ts"), "launch"], { env: { ...process.env, TORCH_HOME: c.config.dataDir, HOME: c.root }, stdout: "pipe", stderr: "pipe" });

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("Usage: torch <command>");
    expect(existsSync(c.config.dataDir)).toBe(false);
  });
});

describe("torch setup and torch uninstall", () => {
  const SETTINGS = '{\n  "env": {\n    "CLAUDE_CODE_ENABLE_TELEMETRY": "0"\n  },\n  "model": "opus"\n}\n';

  /** An environment with a settings.json copy in a temporary directory. */
  function configured(text: string = SETTINGS) {
    const c = cli();
    writeFileSync(c.config.claudeSettingsPath, text);
    return { ...c, settings: () => readFileSync(c.config.claudeSettingsPath, "utf8") };
  }

  test("setup prints the difference, asks and after consent writes the file and installs the handler", async () => {
    const c = configured();
    c.state.answer = true;
    const hookPath = join(c.config.dataDir, "hooks", "record.sh");
    const backupPath = join(c.config.backupsDir, "settings.json.2026-11-09T12-00-00-000Z");

    expect(await c.run("setup")).toBe(0);

    expect(c.out[0]).toBe(`Changes in ${c.config.claudeSettingsPath}:`);
    expect(c.out[1]).toContain('-     "CLAUDE_CODE_ENABLE_TELEMETRY": "0"\n+     "CLAUDE_CODE_ENABLE_TELEMETRY": "1",');
    expect(c.questions).toEqual(["Write?"]);
    expect(c.out.slice(2)).toEqual([`Written: ${c.config.claudeSettingsPath}. The edit applies to Claude Code sessions started after it.`, `Copy of the previous file: ${backupPath}`]);
    const settings = JSON.parse(c.settings());
    expect(settings.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`http://127.0.0.1:${c.config.port}/otlp/v1/logs`);
    expect(settings.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: hookPath }] }]);
    expect(readFileSync(hookPath, "utf8")).toBe(readFileSync(join(REPO, "hooks", "record.sh"), "utf8"));
    expect(readFileSync(backupPath, "utf8")).toBe(SETTINGS);
  });

  test("a refusal leaves the file as it was, code 1", async () => {
    const c = configured();

    expect(await c.run("setup")).toBe(1);

    expect(c.questions).toEqual(["Write?"]);
    expect(c.out.at(-1)).toBe("Changes not written.");
    expect(c.settings()).toBe(SETTINGS);
    expect(existsSync(c.config.dataDir)).toBe(false);
  });

  test("a repeated setup asks nothing and changes nothing", async () => {
    const c = configured();
    c.state.answer = true;
    await c.run("setup");
    const first = c.settings();
    c.out.length = 0;

    expect(await c.run("setup")).toBe(0);

    expect(c.out).toEqual([`${c.config.claudeSettingsPath} is already configured: no changes.`]);
    expect(c.questions).toHaveLength(1);
    expect(c.settings()).toBe(first);
  });

  test("uninstall after setup restores the file byte for byte", async () => {
    const c = configured();
    c.state.answer = true;
    await c.run("setup");
    c.out.length = 0;

    expect(await c.run("uninstall")).toBe(0);

    expect(c.out[0]).toBe(`Changes in ${c.config.claudeSettingsPath}:`);
    expect(c.out[1]).toContain('-     "OTEL_LOGS_EXPORTER": "otlp",');
    expect(c.out[1]).toContain('+     "CLAUDE_CODE_ENABLE_TELEMETRY": "0"');
    expect(c.out[2]).toBe(`torch edits removed from ${c.config.claudeSettingsPath}.`);
    expect(c.out[3]).toStartWith(`Copy of the previous file: ${c.config.backupsDir}`);
    expect(c.questions).toEqual(["Write?", "Write?"]);
    expect(c.settings()).toBe(SETTINGS);
  });

  test("--port sets the receiver port in the settings, as for start; uninstall accepts the same flag", async () => {
    const c = configured();
    c.state.answer = true;

    expect(await c.run("setup", "--port", "5001")).toBe(0);

    const env = JSON.parse(c.settings()).env;
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe("http://127.0.0.1:5001/otlp/v1/logs");
    expect(c.out[1]).toContain('+     "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:5001/otlp/v1/logs"');
    // Without the flag the port comes from the configuration: the address changes back.
    expect(await c.run("setup")).toBe(0);
    expect(JSON.parse(c.settings()).env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`http://127.0.0.1:${c.config.port}/otlp/v1/logs`);

    expect(await c.run("uninstall", "--port", "5001")).toBe(0);
    expect(c.settings()).toBe(SETTINGS);
  });

  test("an invalid port for setup and uninstall: usage and exit code 2, the file is left untouched", () => {
    for (const command of ["setup", "uninstall"]) {
      const c = configured();

      expect(c.run(command, "--port", "70000")).toBe(2);

      expect(c.err[0]).toBe("Invalid port: 70000");
      expect(c.err.join("\n")).toContain("Usage: torch <command>");
      expect(c.questions).toEqual([]);
      expect(c.settings()).toBe(SETTINGS);
    }
  });

  test("the handler installed by setup puts the event into the data directory spool", async () => {
    const c = configured();
    c.state.answer = true;
    await c.run("setup");
    const command: string = JSON.parse(c.settings()).hooks.SessionStart[0].hooks[0].command;

    // The hook environment: there is no TORCH_HOME variable in it.
    const run = Bun.spawnSync(["sh", "-c", command], { stdin: Buffer.from('{"hook_event_name":"SessionStart","session_id":"s1"}'), env: { PATH: process.env.PATH, HOME: join(c.root, "home") } });

    expect({ code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(readdirSync(c.config.spoolDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  test("there is no edit record, but the torch edits are present: an error and exit code 1", async () => {
    const c = configured();
    c.state.answer = true;
    await c.run("setup");
    const configuredText = c.settings();
    rmSync(join(c.config.backupsDir, "setup-state.json"));

    expect(await c.run("uninstall")).toBe(1);

    expect(c.err).toHaveLength(1);
    expect(c.err[0]).toStartWith(`torch uninstall: ${c.config.claudeSettingsPath} contains torch setup edits, but there is no record of them`);
    expect(c.err[0]).toContain(`File copies are in ${c.config.backupsDir}; the latest: ${join(c.config.backupsDir, "settings.json.2026-11-09T12-00-00-000Z")}.`);
    expect(c.settings()).toBe(configuredText);
  });

  test("uninstall without setup: nothing to roll back", async () => {
    const c = configured();

    expect(await c.run("uninstall")).toBe(0);

    expect(c.out).toEqual([`${c.config.claudeSettingsPath} has no torch setup edits: nothing to roll back.`]);
    expect(c.questions).toEqual([]);
    expect(c.settings()).toBe(SETTINGS);
  });

  test("a file that does not parse is an error with the path and exit code 1", async () => {
    const c = configured("{ broken");
    c.state.answer = true;

    expect(await c.run("setup")).toBe(1);

    expect(c.err).toHaveLength(1);
    expect(c.err[0]).toStartWith(`torch setup: ${c.config.claudeSettingsPath}: file does not parse as JSON`);
    expect(c.settings()).toBe("{ broken");
  });

  test("a real process: setup with an answer from stdin edits only the file in the temporary directory", async () => {
    const c = cli();
    // The process home directory is temporary: the default settings.json lives in it.
    const settingsPath = join(c.root, ".claude", "settings.json");
    mkdirSync(join(c.root, ".claude"));
    writeFileSync(settingsPath, SETTINGS);
    const env = { ...process.env, TORCH_HOME: c.config.dataDir, HOME: c.root };
    const torch = (command: string) => Bun.spawn(["bun", join(REPO, "src", "cli.ts"), command], { env, stdin: Buffer.from("y\n"), stdout: "pipe", stderr: "pipe" });

    const setup = torch("setup");
    expect({ code: await setup.exited, stderr: await new Response(setup.stderr).text() }).toEqual({ code: 0, stderr: "" });
    expect(await new Response(setup.stdout).text()).toContain(`Written: ${settingsPath}`);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toBe(join(c.config.dataDir, "hooks", "record.sh"));

    expect(await torch("uninstall").exited).toBe(0);
    expect(readFileSync(settingsPath, "utf8")).toBe(SETTINGS);
  });
});

// Incremental indexer pass over a directory of synthetic transcripts: each step of plan §6.1.
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import type { PriceTable } from "../../src/contracts/api.ts";
import { MAIN_AGENT_ID, RUNNING_WINDOW_MS } from "../../src/contracts/constants.ts";
import type { AgentRow, SessionRow, SourceFileRow } from "../../src/contracts/rows.ts";
import { openDb, openMemoryDb, openReadonlyDb } from "../../src/db/db.ts";
import { IndexError, planRebuild, rebuildBlocker, runIndex, scanTranscripts } from "../../src/ingest/index.ts";
import { REF_PRICES, referenceScenario } from "../support/reference.ts";
import { seedReference } from "../support/reference-seed.ts";
import { referenceFiles } from "../support/reference-transcript.ts";
import { seed } from "../support/seed.ts";
import { text, thinking, toolUse, transcript, writeSession, type SessionFiles, type Transcript } from "../support/transcript.ts";

/** The pass's “now”: the synthetic October sessions have long since finished by this time. */
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const START = Date.UTC(2026, 9, 1, 10, 0, 0);

/** A temporary directory with transcripts and desktop app metadata, and an in-memory database. */
function world(prices: PriceTable = REF_PRICES, options: { fileDb?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "torch-index-"));
  const config = loadConfig({
    dataDir: join(root, "torch"),
    transcriptsDir: join(root, "projects"),
    desktopSessionsDir: join(root, "desktop"),
    claudeSettingsPath: join(root, "settings.json"),
  });
  const db = options.fileDb ? openDb(config.dbPath) : openMemoryDb();
  const clock = { now: NOW };
  return {
    config,
    db,
    clock,
    index: (options?: { rebuild?: boolean }) => runIndex({ db, config, prices, now: () => clock.now }, options),
    write: (files: SessionFiles) => writeSession(config.transcriptsDir, files),
    desktopTitle(sessionId: string, title: string) {
      const path = join(config.desktopSessionsDir, "account", "org", `local_${sessionId}.json`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ cliSessionId: sessionId, title }));
    },
  };
}

type World = ReturnType<typeof world>;

const all = <Row>(db: Database, sql: string): Row[] => db.query<Row, []>(sql).all();
const session = (db: Database, id: string): SessionRow => db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id)!;
const sourceFile = (db: Database, path: string): SourceFileRow => db.query<SourceFileRow, [string]>("SELECT * FROM source_files WHERE path = ?").get(path)!;
const count = (db: Database, table: string): number => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;

/**
 * The whole database in a comparable form: body identifiers are replaced by body hashes (the numbers depend on
 * insertion order), table rows are ordered by content. File bookkeeping is tied to the paths and inodes
 * of a specific directory, so databases from different directories are compared without it.
 */
function dump(db: Database, options: { sourceFiles: boolean } = { sourceFiles: true }): Record<string, string[]> {
  const sha = new Map(all<{ id: number; sha256: string }>(db, "SELECT id, sha256 FROM contents").map((row) => [row.id, row.sha256]));
  const tables = all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const result: Record<string, string[]> = {};
  for (const { name } of tables) {
    if (name === "source_files" && !options.sourceFiles) continue;
    const select = name === "contents" ? "SELECT sha256, bytes, encoding FROM contents" : `SELECT * FROM ${name}`;
    result[name] = all<Record<string, unknown>>(db, select)
      .map((row) => JSON.stringify(Object.entries(row).map(([key, value]) => [key, key.endsWith("content_id") && typeof value === "number" ? sha.get(value) : value])))
      .sort();
  }
  return result;
}

/** A pass that must end with a failure of some of the files. */
function failedIndex(w: World): IndexError {
  try {
    w.index();
  } catch (error) {
    if (error instanceof IndexError) return error;
    throw error;
  }
  throw new Error("the pass went through without failures");
}

/** A small session: two turns with a tool and a subagent with meta.json. */
function smallSession(sessionId = "s1", startAt = START): SessionFiles {
  const main = transcript({ sessionId, startAt });
  main.prompt("Fix the flaky test");
  const first = main.tick(3000).assistant({ blocks: [thinking("Look first"), text("Reading"), toolUse("Read", { file_path: "/repo/a.ts" })], usage: { input: 10, output: 200, cacheRead: 4000 } });
  main.tick(200).toolResult(first.toolUseIds[0]!, { content: "one", toolUseResult: { type: "text", file: { filePath: "/repo/a.ts", content: "one" } } });
  const second = main.tick(2000).assistant({ blocks: [toolUse("Agent", { description: "Find usages", prompt: "Find usages of a" }, "toolu_spawn")], usage: { input: 12, output: 80, cacheRead: 4500 } });
  main.tick(100).toolResult(second.toolUseIds[0]!, { content: "Launched", toolUseResult: { agentId: "a1", isAsync: true, status: "async_launched" } });
  main.tick(5000).assistant({ blocks: [text("Done")], usage: { input: 8, output: 30, cacheRead: 5000 } });

  const sub = transcript({ sessionId, agentId: "a1", startAt: startAt + 6000 });
  sub.prompt("Find usages of a");
  sub.tick(1500).assistant({ blocks: [text("Found 3")], usage: { input: 5, output: 20, cacheRead: 900 } });
  return { main, subagents: [{ transcript: sub, meta: { agentType: "Explore", description: "Find usages", toolUseId: "toolu_spawn", spawnDepth: 1 } }] };
}

/** Lines appended to the `smallSession` main file by the next turn. */
function followUp(main: Transcript): string {
  const before = main.lines.length;
  main.tick(60_000).prompt("Also run the linter");
  const { toolUseIds } = main.tick(2500).assistant({ blocks: [text("Running"), toolUse("Bash", { command: "bun lint" })], usage: { input: 9, output: 60, cacheRead: 6000 } });
  main.tick(4000).toolResult(toolUseIds[0]!, { content: "ok", toolUseResult: { stdout: "ok", stderr: "", interrupted: false } });
  return main.lines.slice(before).map((line) => `${JSON.stringify(line)}\n`).join("");
}

describe("step 1: walking the directory and tracking files", () => {
  test("the first pass records every transcript file in source_files", () => {
    const w = world();
    const files = smallSession();
    const { mainPath, subagentPaths } = w.write(files);

    const result = w.index();

    expect(result).toMatchObject({ filesSeen: 2, filesRead: 2, linesParsed: files.main.lines.length + 2, sessionsChanged: ["s1"] });
    const mainStat = statSync(mainPath);
    expect(sourceFile(w.db, mainPath)).toEqual({
      path: mainPath,
      kind: "main",
      session_id: "s1",
      agent_id: MAIN_AGENT_ID,
      size: mainStat.size,
      mtime: Math.trunc(mainStat.mtimeMs),
      inode: mainStat.ino,
      parsed_offset: mainStat.size,
      last_event_ts: START + 10_300,
      missing_since: null,
    });
    expect(sourceFile(w.db, subagentPaths[0]!)).toMatchObject({ kind: "subagent", session_id: "s1", agent_id: "a1", parsed_offset: statSync(subagentPaths[0]!).size, last_event_ts: START + 7500 });
  });

  test("identifiers are unique only within a session: a continued session gets its lines by file name", () => {
    const w = world();
    const original = transcript({ sessionId: "original", startAt: START });
    original.prompt("Start the migration", { uuid: "prompt-1" });
    original.tick(2000).assistant({ blocks: [text("Starting"), toolUse("Bash", { command: "ls" }, "toolu_1")], requestId: "req_1", usage: { input: 5, output: 50 } });
    original.tick(500).toolResult("toolu_1", { content: "a.ts" });
    w.write({ main: original });
    // A continued session: copied lines of the original with its sessionId, and new lines.
    const resumed = transcript({ sessionId: "original", startAt: START + 3_600_000 });
    resumed.prompt("Continue", { uuid: "prompt-2" });
    resumed.tick(1000).assistant({ blocks: [text("Continuing")], requestId: "req_2", usage: { input: 6, output: 20 } });
    const resumedPath = join(dirname(w.write({ main: original }).mainPath), "resumed.jsonl");
    writeFileSync(resumedPath, original.jsonl() + resumed.jsonl());

    expect(w.index().sessionsChanged.sort()).toEqual(["original", "resumed"]);

    expect(all(w.db, "SELECT session_id, id FROM model_calls ORDER BY session_id, id")).toEqual([
      { session_id: "original", id: "req_1" },
      { session_id: "resumed", id: "req_1" },
      { session_id: "resumed", id: "req_2" },
    ]);
    expect(all(w.db, "SELECT id, model_calls, tool_calls FROM sessions ORDER BY id")).toEqual([
      { id: "original", model_calls: 1, tool_calls: 1 },
      { id: "resumed", model_calls: 2, tool_calls: 1 },
    ]);
  });
});

describe("step 1: files without a pair and without lines", () => {
  test("a subagent file without a main file: the session is created from it, it has no transcript", () => {
    const w = world();
    const files = smallSession("orphan");
    const sub = files.subagents![0]!;
    const path = join(w.config.transcriptsDir, "-Users-dev-code-example", "orphan", "subagents", "agent-a1.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, sub.transcript.jsonl());
    writeFileSync(path.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(sub.meta));

    expect(w.index()).toMatchObject({ filesSeen: 1, filesRead: 1, linesParsed: 2, sessionsChanged: ["orphan"] });

    expect(sourceFile(w.db, path)).toMatchObject({ kind: "subagent", session_id: "orphan", agent_id: "a1", missing_since: null });
    expect(session(w.db, "orphan")).toMatchObject({ transcript_present: 0, agents_count: 1, model_calls: 1, started_at: START + 6000, name: null });
    expect(all(w.db, "SELECT agent_id, type, depth, parent_agent_id FROM agents")).toEqual([{ agent_id: "a1", type: "Explore", depth: 1, parent_agent_id: null }]);
    expect(w.index().sessionsChanged).toEqual([]);

    // The main file appeared later: the session gets a transcript and the agent's link to the call.
    writeFileSync(join(w.config.transcriptsDir, "-Users-dev-code-example", "orphan.jsonl"), files.main.jsonl());
    expect(w.index().sessionsChanged).toEqual(["orphan"]);
    expect(session(w.db, "orphan")).toMatchObject({ transcript_present: 1, agents_count: 2, model_calls: 4, name: "Fix the flaky test" });
    expect(all(w.db, "SELECT parent_agent_id FROM agents WHERE agent_id = 'a1'")).toEqual([{ parent_agent_id: MAIN_AGENT_ID }]);
  });

  test("a file without a single complete line does not create a session, even if there is a meta.json and a title next to it", () => {
    const w = world();
    const files = smallSession();
    const dir = join(w.config.transcriptsDir, "-Users-dev-code-example");
    const mainPath = join(dir, "s1.jsonl");
    const subPath = join(dir, "s1", "subagents", "agent-a1.jsonl");
    mkdirSync(dirname(subPath), { recursive: true });
    const mainBody = files.main.jsonl();
    const subBody = files.subagents![0]!.transcript.jsonl();
    // The first line of each file is cut off.
    writeFileSync(mainPath, mainBody.slice(0, 40));
    writeFileSync(subPath, subBody.slice(0, 40));
    writeFileSync(subPath.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(files.subagents![0]!.meta));
    writeFileSync(join(dir, "s1", "custom-title.json"), JSON.stringify({ customTitle: "Named early" }));
    w.desktopTitle("s1", "Desktop title");

    for (let pass = 0; pass < 2; pass++) {
      expect(w.index()).toMatchObject({ filesSeen: 2, filesRead: 0, linesParsed: 0, sessionsChanged: [] });
      expect(count(w.db, "sessions")).toBe(0);
      expect(count(w.db, "agents")).toBe(0);
    }
    expect(sourceFile(w.db, mainPath)).toMatchObject({ size: 40, parsed_offset: 0 });

    appendFileSync(mainPath, mainBody.slice(40));
    appendFileSync(subPath, subBody.slice(40));
    expect(w.index().sessionsChanged).toEqual(["s1"]);
    expect(session(w.db, "s1")).toMatchObject({ name: "Named early", name_source: "custom", agents_count: 2 });
  });
});

describe("step 2: reading from the previous offset to the last complete newline", () => {
  test("an appended file: only the new lines are read, the database is the same as after loading it whole", () => {
    const w = world();
    const files = smallSession();
    const { mainPath } = w.write(files);
    w.index();
    const appended = followUp(files.main);
    appendFileSync(mainPath, appended);

    const result = w.index();

    expect(result).toMatchObject({ filesSeen: 2, filesRead: 1, linesParsed: 4, sessionsChanged: ["s1"] });
    expect(sourceFile(w.db, mainPath).parsed_offset).toBe(statSync(mainPath).size);
    const whole = world();
    whole.write(files);
    whole.index();
    expect(dump(w.db, { sourceFiles: false })).toEqual(dump(whole.db, { sourceFiles: false }));
  });

  test("a truncated last line is left for the next pass", () => {
    const w = world();
    const files = smallSession();
    const { mainPath } = w.write(files);
    w.index();
    const appended = followUp(files.main);
    const cut = appended.indexOf("\n") + 1 + 20;
    appendFileSync(mainPath, appended.slice(0, cut));

    // Only the prompt was fully appended: the response line is cut off in the middle.
    expect(w.index()).toMatchObject({ filesRead: 1, linesParsed: 1 });
    expect(session(w.db, "s1")).toMatchObject({ model_calls: 4, tool_calls: 2 });
    expect(sourceFile(w.db, mainPath)).toMatchObject({ size: statSync(mainPath).size, parsed_offset: statSync(mainPath).size - 20 });

    // The cut-off line did not move the offset: a pass without new complete lines reads nothing.
    expect(w.index()).toMatchObject({ filesRead: 0, linesParsed: 0, sessionsChanged: [] });

    appendFileSync(mainPath, appended.slice(cut));
    expect(w.index()).toMatchObject({ filesRead: 1, linesParsed: 3, sessionsChanged: ["s1"] });
    expect(session(w.db, "s1")).toMatchObject({ model_calls: 5, tool_calls: 3 });
  });
});

describe("step 3: parsing, reducers and offset in one transaction per file", () => {
  test("the reference session from files: session and agent totals match the reference database", () => {
    const scn = referenceScenario();
    const w = world(scn.prices);
    w.write(referenceFiles(scn));

    expect(w.index()).toMatchObject({ filesSeen: 5, filesRead: 5, sessionsChanged: [scn.sessionId], unknown: { types: {}, fields: {} } });

    const reference = seedReference(openMemoryDb(), scn);
    // Outside the comparison: cost (rounded to cents in the reference database) and the status as of the pass.
    const { cost_usd, status: _status, ...expected } = reference.session;
    const actual = session(w.db, scn.sessionId);
    expect(actual).toMatchObject(expected);
    expect(actual.cost_usd).toBeCloseTo(cost_usd!, 2);
    expect(actual.status).toBe("completed");

    // Outside the comparison: the prompt body identifier, rounded cost and context breakdown —
    // in the reference database it is given as fractions, not by the rule of plan §6.2.
    const comparable = ({ prompt_content_id, cost_usd, ctx_breakdown_json, ctx_breakdown_exact, ...row }: AgentRow) => row;
    expect(all<AgentRow>(w.db, "SELECT * FROM agents ORDER BY agent_id").map(comparable)).toEqual(
      [...reference.agents].sort((a, b) => (a.agent_id < b.agent_id ? -1 : 1)).map(comparable),
    );
  });

  test("every line reducer receives the file's lines: all event tables are filled", () => {
    const w = world();
    const main = transcript({ sessionId: "s1", startAt: START });
    main.instructions([{ path: "/Users/dev/.claude/CLAUDE.md", type: "User", content: "rules" }]);
    main.prompt("Fetch the docs and fix the file");
    const { toolUseIds } = main.tick(2000).assistant({
      blocks: [thinking("Plan"), text("Working"), toolUse("Edit", { file_path: "/repo/a.ts", old_string: "1", new_string: "2" }), toolUse("WebFetch", { url: "https://bun.sh/docs", prompt: "Summarise" })],
      usage: { input: 10, output: 100 },
    });
    main.tick(300).toolResult(toolUseIds[0]!, { content: "Updated", toolUseResult: { filePath: "/repo/a.ts", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-1", "+2"] }] } });
    main.tick(900).toolResult(toolUseIds[1]!, { content: "Summary", toolUseResult: { url: "https://bun.sh/docs", code: 200, bytes: 2048, durationMs: 800, result: "Summary" } });
    main.tick(500).apiError({ message: "Connection error" });
    main.tick(60_000).compactBoundary({ trigger: "auto", preTokens: 150_000, postTokens: 20_000 });
    main.tick(1000).assistant({ blocks: [text("Done")], usage: { input: 5, output: 10 } });
    main.aiTitle("Fix the file");
    w.write({ main });

    w.index();

    const counts = Object.fromEntries(
      ["sessions", "agents", "prompts", "model_calls", "tool_calls", "file_ops", "external_requests", "api_errors", "compactions", "messages", "instructions_loaded"].map((table) => [table, count(w.db, table)]),
    );
    expect(counts).toEqual({ sessions: 1, agents: 1, prompts: 1, model_calls: 2, tool_calls: 2, file_ops: 1, external_requests: 1, api_errors: 1, compactions: 1, messages: 3, instructions_loaded: 1 });
    expect(count(w.db, "contents")).toBeGreaterThan(0);
    expect(session(w.db, "s1")).toMatchObject({ name: "Fix the file", name_source: "ai" });
  });

  test("reducer context: subagent meta.json, custom-title.json and the desktop app title", () => {
    const w = world();
    w.write({ ...smallSession("named"), customTitleFile: "Renamed by hand" });
    w.write(smallSession("desktop"));
    w.write(smallSession("plain"));
    w.desktopTitle("named", "Desktop title, loses to the custom one");
    w.desktopTitle("desktop", "Desktop title");

    w.index();

    expect(all(w.db, "SELECT id, name, name_source FROM sessions ORDER BY id")).toEqual([
      { id: "desktop", name: "Desktop title", name_source: "desktop" },
      { id: "named", name: "Renamed by hand", name_source: "custom" },
      { id: "plain", name: "Fix the flaky test", name_source: "prompt" },
    ]);
    expect(all(w.db, "SELECT agent_id, type, description, parent_agent_id, depth, spawn_tool_call_id FROM agents WHERE session_id = 'plain' ORDER BY agent_id")).toEqual([
      { agent_id: "a1", type: "Explore", description: "Find usages", parent_agent_id: MAIN_AGENT_ID, depth: 1, spawn_tool_call_id: "toolu_spawn" },
      { agent_id: MAIN_AGENT_ID, type: null, description: null, parent_agent_id: null, depth: 0, spawn_tool_call_id: null },
    ]);
  });

  test("a title and meta.json that appeared without new lines are applied by the next pass", () => {
    const w = world();
    const files = smallSession();
    const { subagentPaths, sessionDir } = w.write({ main: files.main, subagents: [{ transcript: files.subagents![0]!.transcript }] });
    w.index();
    expect(session(w.db, "s1")).toMatchObject({ name: "Fix the flaky test", name_source: "prompt" });

    w.desktopTitle("s1", "Stabilise the test");
    expect(w.index()).toMatchObject({ filesRead: 0, linesParsed: 0, sessionsChanged: ["s1"] });
    expect(session(w.db, "s1")).toMatchObject({ name: "Stabilise the test", name_lower: "stabilise the test", name_source: "desktop" });
    // The same title on the next pass is not a change.
    expect(w.index().sessionsChanged).toEqual([]);

    writeFileSync(join(sessionDir, "custom-title.json"), JSON.stringify({ customTitle: "Flaky test" }));
    writeFileSync(subagentPaths[0]!.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(files.subagents![0]!.meta));
    expect(w.index().sessionsChanged).toEqual(["s1"]);
    expect(w.index().sessionsChanged).toEqual([]);

    const whole = world();
    whole.write({ ...files, customTitleFile: "Flaky test" });
    whole.desktopTitle("s1", "Stabilise the test");
    whole.index();
    expect(dump(w.db, { sourceFiles: false })).toEqual(dump(whole.db, { sourceFiles: false }));
  });

  test("a meta.json that disagrees with the computed agent linking does not make the session changed on every pass", () => {
    const w = world(REF_PRICES, { fileDb: true });
    const files = smallSession();
    // The depth, parent and call from meta.json do not match what linking by calls gives.
    const meta = { agentType: "Explore", description: "Find usages", toolUseId: "toolu_unknown", spawnDepth: 3, parentAgentId: "a-other" };
    w.write({ main: files.main, subagents: [{ transcript: files.subagents![0]!.transcript, meta }] });
    w.desktopTitle("s1", "Desktop title");

    expect(w.index().sessionsChanged).toEqual(["s1"]);
    expect(all(w.db, "SELECT agent_id, parent_agent_id, depth, spawn_tool_call_id FROM agents WHERE agent_id = 'a1'")).toEqual([
      { agent_id: "a1", parent_agent_id: MAIN_AGENT_ID, depth: 1, spawn_tool_call_id: "toolu_spawn" },
    ]);
    const first = dump(w.db);

    // The data version is visible to another connection and grows with every committed write.
    const observer = openReadonlyDb(w.config.dbPath)!;
    const version = () => observer.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
    const before = version();
    for (let pass = 0; pass < 3; pass++) expect(w.index()).toMatchObject({ filesRead: 0, sessionsChanged: [] });

    expect(version()).toBe(before);
    expect(dump(w.db)).toEqual(first);
    // The counter does catch a write: a file change moves it.
    w.desktopTitle("s1", "Another title");
    expect(w.index().sessionsChanged).toEqual(["s1"]);
    expect(version()).not.toBe(before);
    observer.close();
    w.db.close();
  });

  test("an unreadable file next to a transcript is a failure of that file, the others load", () => {
    const w = world();
    const broken = w.write(smallSession("broken"));
    const titled = w.write(smallSession("titled"));
    w.write(smallSession("fine"));
    // Directories turned out to be in place of meta.json and custom-title.json.
    const metaPath = broken.subagentPaths[0]!.replace(/\.jsonl$/, ".meta.json");
    rmSync(metaPath);
    mkdirSync(metaPath);
    mkdirSync(join(titled.sessionDir, "custom-title.json"));

    const { failures, result } = failedIndex(w);

    // The title belongs to the whole session: without it none of its files loads.
    expect(failures.map((failure) => failure.path)).toEqual([broken.subagentPaths[0]!, titled.mainPath, titled.subagentPaths[0]!]);
    expect(failures.map((failure) => (failure.error as { code?: string }).code)).toEqual(["EISDIR", "EISDIR", "EISDIR"]);
    expect(result).toMatchObject({ filesSeen: 6, filesRead: 3, sessionsChanged: ["broken", "fine"] });
    expect(session(w.db, "fine")).toMatchObject({ model_calls: 4, agents_count: 2 });
    expect(session(w.db, "broken")).toMatchObject({ model_calls: 3, agents_count: 1 });
    expect(count(w.db, "source_files")).toBe(3);

    // The cause is removed: the files finish loading.
    rmSync(metaPath, { recursive: true });
    rmSync(join(titled.sessionDir, "custom-title.json"), { recursive: true });
    expect(w.index()).toMatchObject({ filesRead: 3, sessionsChanged: ["broken", "titled"] });
    expect(session(w.db, "broken")).toMatchObject({ model_calls: 4, agents_count: 2 });
  });

  test("an unreadable project directory is a failure in the pass report: its files did not vanish, the others load", () => {
    const w = world();
    const lockedMain = transcript({ sessionId: "locked", cwd: "/Users/dev/code/locked", startAt: START });
    lockedMain.prompt("In a locked project");
    lockedMain.tick(1000).assistant({ blocks: [text("Ok")], usage: { input: 1, output: 1 } });
    const locked = w.write({ main: lockedMain });
    w.index();
    const open = w.write(smallSession("open"));
    const lockedDir = dirname(locked.mainPath);
    chmodSync(lockedDir, 0o000);

    try {
      const { failures, result } = failedIndex(w);

      expect(failures.map((failure) => failure.path)).toEqual([lockedDir]);
      expect(result).toMatchObject({ filesSeen: 2, filesRead: 2, sessionsChanged: ["open"] });
      expect(sourceFile(w.db, open.mainPath).parsed_offset).toBe(statSync(open.mainPath).size);
      expect(sourceFile(w.db, locked.mainPath).missing_since).toBeNull();
      expect(session(w.db, "locked").transcript_present).toBe(1);
    } finally {
      chmodSync(lockedDir, 0o700);
    }
    expect(w.index()).toMatchObject({ filesSeen: 3, filesRead: 0, sessionsChanged: [] });
  });

  test("a reducer failure on one file rolls back its whole transaction, the other files load", () => {
    const w = world();
    const bad = w.write(smallSession("bad"));
    const good = w.write(smallSession("good"));
    // A failure in the middle of the reducers: the session row and the agent are already written by this point.
    w.db.exec("CREATE TRIGGER poison BEFORE INSERT ON prompts WHEN NEW.session_id = 'bad' BEGIN SELECT RAISE(ABORT, 'poisoned'); END");

    let failure: unknown;
    try {
      w.index();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(IndexError);
    const { failures, result } = failure as IndexError;
    expect(failures.map((f) => f.path)).toEqual([bad.mainPath]);
    expect(String(failures[0]!.error)).toContain("poisoned");
    expect(result).toMatchObject({ filesSeen: 4, filesRead: 3, sessionsChanged: ["bad", "good"] });
    // Nothing is left of the bad file, neither lines nor offset: the next pass will read it from the start.
    expect(sourceFile(w.db, bad.mainPath)).toBeNull();
    expect(all(w.db, "SELECT agent_id FROM agents WHERE session_id = 'bad'")).toEqual([{ agent_id: "a1" }]);
    expect(all(w.db, "SELECT id FROM model_calls WHERE session_id = 'bad' AND agent_id = 'main'")).toEqual([]);
    expect(sourceFile(w.db, good.mainPath).parsed_offset).toBe(statSync(good.mainPath).size);
    expect(session(w.db, "good")).toMatchObject({ model_calls: 4, agents_count: 2 });

    w.db.exec("DROP TRIGGER poison");
    expect(w.index()).toMatchObject({ filesRead: 1, sessionsChanged: ["bad"] });
    expect(dump(w.db, { sourceFiles: false }).model_calls).toHaveLength(8);
  });

  test("derivatives are committed together with the file's lines: no loaded lines are left without totals", () => {
    const w = world();
    const { mainPath } = w.write(smallSession());
    // A failure while recalculating totals — after the line reducers and the offset are already written.
    w.db.exec("CREATE TRIGGER poison BEFORE UPDATE OF model_calls ON sessions WHEN NEW.model_calls > 0 BEGIN SELECT RAISE(ABORT, 'poisoned'); END");

    expect(() => w.index()).toThrow(IndexError);

    expect(count(w.db, "source_files")).toBe(0);
    expect(count(w.db, "sessions")).toBe(0);
    expect(count(w.db, "model_calls")).toBe(0);

    w.db.exec("DROP TRIGGER poison");
    expect(w.index()).toMatchObject({ filesRead: 2, sessionsChanged: ["s1"] });
    expect(session(w.db, "s1")).toMatchObject({ model_calls: 4, agents_count: 2 });
    expect(sourceFile(w.db, mainPath).parsed_offset).toBe(statSync(mainPath).size);
  });

  test("unknown line types and fields pass without an error and reach the pass counter", () => {
    const w = world();
    const main = transcript({ sessionId: "s1", startAt: START });
    main.prompt("Hello");
    main.envelope({ type: "user", message: { role: "user", content: "again" }, brandNewField: "secret payload" });
    main.raw({ type: "mystery-line", payload: "secret payload" });
    main.raw({ type: "mystery-line", payload: "more" });
    const { mainPath } = w.write({ main });
    appendFileSync(mainPath, "{not json}\n");

    expect(w.index()).toMatchObject({ linesParsed: 5, unknown: { types: { "mystery-line": 2, "<invalid>": 1 }, fields: { "user.brandNewField": 1 } } });
    // The pass counter covers only new lines.
    expect(w.index().unknown).toEqual({ types: {}, fields: {} });
  });
});

describe("step 4: recalculating derivatives of affected sessions and agents", () => {
  test("totals are recalculated for the changed session; an untouched session does not count as changed", () => {
    const w = world();
    const files = smallSession("s1");
    const { mainPath } = w.write(files);
    w.write(smallSession("s2"));
    expect(w.index().sessionsChanged).toEqual(["s1", "s2"]);
    expect(session(w.db, "s1")).toMatchObject({ agents_count: 2, model_calls: 4, tool_calls: 2, tok_input: 35, tok_output: 330, tok_cache_read: 14_400, active_ms: 10_300, status: "completed", primary_model: "claude-opus-5-5" });
    expect(all(w.db, "SELECT agent_id, model_calls, tool_calls, ctx_first, ctx_peak FROM agents WHERE session_id = 's1' ORDER BY agent_id")).toEqual([
      { agent_id: "a1", model_calls: 1, tool_calls: 0, ctx_first: 905, ctx_peak: 905 },
      { agent_id: MAIN_AGENT_ID, model_calls: 3, tool_calls: 2, ctx_first: 4010, ctx_peak: 5008 },
    ]);

    appendFileSync(mainPath, followUp(files.main));
    const untouched = session(w.db, "s2");

    expect(w.index().sessionsChanged).toEqual(["s1"]);
    expect(session(w.db, "s1")).toMatchObject({ model_calls: 5, tool_calls: 3, tok_input: 44, active_ms: 10_300 + 6500 });
    expect(session(w.db, "s2")).toEqual(untouched);
  });

  test("a running session is recalculated on every pass and finishes without changes in the files", () => {
    const w = world();
    w.write(smallSession("live", NOW - 60_000));
    w.write(smallSession("old"));

    expect(w.index().sessionsChanged).toEqual(["live", "old"]);
    expect(session(w.db, "live").status).toBe("running");
    expect(session(w.db, "old").status).toBe("completed");

    // Totals of a running session without new lines are not recalculated: only the status changes on the pass.
    w.db.exec("UPDATE sessions SET model_calls = 999 WHERE id = 'live'");
    w.clock.now += 60_000;
    expect(w.index().sessionsChanged).toEqual([]);
    expect(session(w.db, "live")).toMatchObject({ status: "running", model_calls: 999 });

    w.clock.now += RUNNING_WINDOW_MS;
    expect(w.index()).toMatchObject({ filesRead: 0, sessionsChanged: ["live"] });
    expect(session(w.db, "live")).toMatchObject({ status: "completed", model_calls: 999 });
    expect(w.index().sessionsChanged).toEqual([]);
  });
});

describe("step 5: a vanished file", () => {
  test("the session's files vanished: missing_since, transcript_present = 0, the data stays", () => {
    const w = world();
    const gone = w.write(smallSession("gone"));
    w.write(smallSession("kept"));
    w.index();
    const before = dump(w.db, { sourceFiles: false });
    rmSync(gone.mainPath);
    rmSync(gone.sessionDir, { recursive: true });

    w.clock.now += 1000;
    expect(w.index()).toMatchObject({ filesSeen: 2, filesRead: 0, sessionsChanged: ["gone"] });

    expect(all(w.db, "SELECT session_id, kind, missing_since FROM source_files ORDER BY session_id, kind")).toEqual([
      { session_id: "gone", kind: "main", missing_since: NOW + 1000 },
      { session_id: "gone", kind: "subagent", missing_since: NOW + 1000 },
      { session_id: "kept", kind: "main", missing_since: null },
      { session_id: "kept", kind: "subagent", missing_since: null },
    ]);
    expect(session(w.db, "gone").transcript_present).toBe(0);
    expect(session(w.db, "kept").transcript_present).toBe(1);
    const after = dump(w.db, { sourceFiles: false });
    expect(after.sessions).not.toEqual(before.sessions);
    expect({ ...after, sessions: [] }).toEqual({ ...before, sessions: [] });

    // Later passes remember the time of disappearance and no longer touch the session.
    w.clock.now += 1000;
    expect(w.index().sessionsChanged).toEqual([]);
    expect(sourceFile(w.db, gone.mainPath).missing_since).toBe(NOW + 1000);
  });

  test("only a subagent file vanished: the session transcript is in place", () => {
    const w = world();
    const { subagentPaths } = w.write(smallSession());
    w.index();
    rmSync(subagentPaths[0]!);

    expect(w.index().sessionsChanged).toEqual(["s1"]);
    expect(sourceFile(w.db, subagentPaths[0]!).missing_since).toBe(NOW);
    expect(session(w.db, "s1")).toMatchObject({ transcript_present: 1, agents_count: 2 });
  });

  test("a returned file counts as present again and is read on from the previous offset", () => {
    const w = world();
    const files = smallSession();
    const { mainPath } = w.write(files);
    w.index();
    const parked = `${mainPath}.parked`;
    renameSync(mainPath, parked);
    w.index();
    expect(session(w.db, "s1").transcript_present).toBe(0);

    appendFileSync(parked, followUp(files.main));
    renameSync(parked, mainPath);

    expect(w.index()).toMatchObject({ filesRead: 1, linesParsed: 4, sessionsChanged: ["s1"] });
    expect(sourceFile(w.db, mainPath).missing_since).toBeNull();
    expect(session(w.db, "s1")).toMatchObject({ transcript_present: 1, model_calls: 5 });
  });

  test("a file returned unchanged: the session has a transcript again and counts as changed", () => {
    const w = world();
    const { mainPath } = w.write(smallSession());
    w.index();
    const before = dump(w.db);
    const parked = `${mainPath}.parked`;
    renameSync(mainPath, parked);
    expect(w.index().sessionsChanged).toEqual(["s1"]);
    expect(sourceFile(w.db, mainPath).missing_since).toBe(NOW);
    renameSync(parked, mainPath);

    expect(w.index()).toMatchObject({ filesSeen: 2, filesRead: 0, linesParsed: 0, sessionsChanged: ["s1"] });

    expect(sourceFile(w.db, mainPath).missing_since).toBeNull();
    expect(session(w.db, "s1").transcript_present).toBe(1);
    expect(dump(w.db)).toEqual(before);
    expect(w.index().sessionsChanged).toEqual([]);
  });

  test("a file vanished between the walk and the read: the pass does not fail, the file is not recorded", () => {
    const w = world();
    w.write(smallSession());
    // The directory entry exists, but the file can no longer be opened.
    symlinkSync(join(w.config.transcriptsDir, "nowhere.jsonl"), join(w.config.transcriptsDir, "-Users-dev-code-example", "vanished.jsonl"));

    expect(w.index()).toMatchObject({ filesSeen: 3, filesRead: 2, sessionsChanged: ["s1"] });
    expect(all(w.db, "SELECT session_id FROM source_files WHERE session_id = 'vanished'")).toEqual([]);
  });

  test("a file that is unreadable for another reason is a pass error, not a disappearance", () => {
    const w = world();
    const locked = w.write(smallSession("locked"));
    w.write(smallSession("open"));
    w.index();
    chmodSync(locked.mainPath, 0o000);

    try {
      expect(() => w.index()).toThrow(IndexError);
      expect(sourceFile(w.db, locked.mainPath).missing_since).toBeNull();
      expect(session(w.db, "locked").transcript_present).toBe(1);
    } finally {
      chmodSync(locked.mainPath, 0o600);
    }
  });
});

describe("step 6: a file became shorter or changed inode", () => {
  test("a replaced file is re-read from the start and gives the same database as a fresh load", () => {
    const w = world();
    const files = smallSession();
    const { mainPath } = w.write(files);
    w.index();
    const oldInode = sourceFile(w.db, mainPath).inode;
    const fullLines = files.main.lines.length + 4;

    // The same transcript with a continuation is written as a new file over the old one.
    const replacement = `${mainPath}.new`;
    writeFileSync(replacement, files.main.jsonl() + followUp(files.main));
    renameSync(replacement, mainPath);

    expect(w.index()).toMatchObject({ filesRead: 1, linesParsed: fullLines, sessionsChanged: ["s1"] });
    const row = sourceFile(w.db, mainPath);
    expect(row.inode).not.toBe(oldInode);
    expect(row).toMatchObject({ inode: statSync(mainPath).ino, parsed_offset: statSync(mainPath).size });

    const fresh = world();
    fresh.write(files);
    fresh.index();
    expect(dump(w.db, { sourceFiles: false })).toEqual(dump(fresh.db, { sourceFiles: false }));
  });

  test("a shortened file is re-read from the start: writes are idempotent, the earlier data stays", () => {
    const w = world();
    const files = smallSession();
    const firstTurn = files.main.jsonl();
    const firstTurnLines = files.main.lines.length;
    const { mainPath } = w.write(files);
    appendFileSync(mainPath, followUp(files.main));
    w.index();
    const before = dump(w.db, { sourceFiles: false });

    truncateSync(mainPath, Buffer.byteLength(firstTurn));

    expect(w.index()).toMatchObject({ filesRead: 1, linesParsed: firstTurnLines });
    expect(sourceFile(w.db, mainPath)).toMatchObject({ size: Buffer.byteLength(firstTurn), parsed_offset: Buffer.byteLength(firstTurn) });
    expect(dump(w.db, { sourceFiles: false })).toEqual(before);
  });
});

describe("pass idempotence", () => {
  test("a second consecutive pass does not change the database", () => {
    const scn = referenceScenario();
    const w = world(scn.prices);
    w.write(referenceFiles(scn));
    w.write({ ...smallSession(), customTitleFile: "Named" });
    w.desktopTitle(scn.sessionId, "Desktop title");
    w.index();
    const first = dump(w.db);

    expect(w.index()).toEqual({ filesSeen: 7, filesRead: 0, linesParsed: 0, sessionsChanged: [], unknown: { types: {}, fields: {} } });
    expect(dump(w.db)).toEqual(first);
  });

  test("the reference session arriving in passes with a cut at any place in the files gives the same database as one pass", () => {
    const scn = referenceScenario();
    const files = referenceFiles(scn);
    const whole = world(scn.prices);
    whole.write(files);
    whole.index();
    const expected = dump(whole.db, { sourceFiles: false });

    for (const cuts of [[0.5], [0.1, 0.9], [0.25, 0.5, 0.75], [0.33, 0.34]]) {
      const w = world(scn.prices);
      const written = w.write(files);
      const paths = [written.mainPath, ...written.subagentPaths];
      const bodies = [files.main, ...files.subagents!.map((sub) => sub.transcript)].map((t) => Buffer.from(t.jsonl()));
      // A cut by bytes: it usually lands in the middle of a line.
      const bounds = [0, ...cuts, 1];
      for (let pass = 1; pass < bounds.length; pass++) {
        paths.forEach((path, i) => {
          const from = Math.floor(bodies[i]!.length * bounds[pass - 1]!);
          const to = Math.floor(bodies[i]!.length * bounds[pass]!);
          if (pass === 1) writeFileSync(path, bodies[i]!.subarray(from, to));
          else appendFileSync(path, bodies[i]!.subarray(from, to));
        });
        w.index();
      }
      expect(dump(w.db, { sourceFiles: false }), `cuts ${cuts.join(", ")}`).toEqual(expected);
    }
  });
});

describe("enrichment merge in a pass", () => {
  test("an event that arrived after the line is applied by the next pass without file changes", () => {
    const w = world();
    w.write(smallSession());
    w.index();
    // The model call identifier is the transcript's requestId.
    const call = w.db.query<{ id: string }, []>("SELECT id FROM model_calls LIMIT 1").get()!;
    seed.otelEvent(w.db, { session_id: "s1", ts: NOW, name: "claude_code.api_request", attrs: { request_id: call.id, duration_ms: 4321 } });

    expect(w.index()).toMatchObject({ filesRead: 0, sessionsChanged: ["s1"] });
    const refined = w.db.query<{ duration_ms: number; duration_exact: number }, [string]>("SELECT duration_ms, duration_exact FROM model_calls WHERE id = ?").get(call.id);
    expect(refined).toEqual({ duration_ms: 4321, duration_exact: 1 });
    expect(w.index().sessionsChanged).toEqual([]);
  });

  test("an event without a pair older than an hour is not iterated over by passes without file changes", () => {
    const w = world();
    w.write(smallSession());
    w.index();
    seed.hookEvent(w.db, { session_id: "s1", ts: NOW - 2 * 3_600_000, name: "SessionStart" });

    expect(w.index().sessionsChanged).toEqual([]);
    // The session was not merged: an event without a rule was never marked.
    expect(all(w.db, "SELECT applied FROM hook_events")).toEqual([{ applied: 0 }]);
  });
});

describe("full rebuild", () => {
  test("the database is rebuilt from disk: a session without a transcript is lost, raw events are applied again", () => {
    const w = world();
    const gone = w.write(smallSession("gone"));
    w.write(smallSession("kept"));
    w.index();
    rmSync(gone.mainPath);
    rmSync(gone.sessionDir, { recursive: true });
    w.index();
    seed.otelEvent(w.db, { session_id: "kept", name: "claude_code.api_request", applied: 1 });
    seed.hookEvent(w.db, { session_id: "kept", name: "SessionEnd", applied: 1 });
    seed.receiverWindow(w.db, { started_at: NOW - 1000, stopped_at: NOW });
    // A table that is not among the preserved ones is like a table from a future migration.
    w.db.exec("CREATE TABLE future_rollup (session_id TEXT); INSERT INTO future_rollup VALUES ('gone')");
    expect(count(w.db, "sessions")).toBe(2);

    expect(w.index({ rebuild: true })).toMatchObject({ filesSeen: 2, filesRead: 2, sessionsChanged: ["kept"] });

    expect(all(w.db, "SELECT id, transcript_present FROM sessions")).toEqual([{ id: "kept", transcript_present: 1 }]);
    expect(all(w.db, "SELECT DISTINCT session_id FROM source_files")).toEqual([{ session_id: "kept" }]);
    expect(all(w.db, "SELECT DISTINCT session_id FROM model_calls")).toEqual([{ session_id: "kept" }]);
    expect(all(w.db, "SELECT name, applied FROM otel_events")).toEqual([{ name: "claude_code.api_request", applied: 0 }]);
    // The applied marks are reset and the merge went through again: a request without request_id waits again,
    // the session-end event is counted.
    expect(all(w.db, "SELECT name, applied FROM hook_events")).toEqual([{ name: "SessionEnd", applied: 1 }]);
    expect(count(w.db, "receiver_windows")).toBe(1);
    expect(count(w.db, "future_rollup")).toBe(0);
    expect(all(w.db, "SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([{ value: "2" }]);

    const fresh = world();
    fresh.write(smallSession("kept"));
    fresh.index();
    expect(dump(w.db, { sourceFiles: false }).sessions).toEqual(dump(fresh.db, { sourceFiles: false }).sessions);
  });

  test("comparison of disk with the database before clearing: sessions without a main file and vanished subagent files", () => {
    const w = world();
    const gone = w.write(smallSession("gone"));
    const partial = w.write(smallSession("partial"));
    w.write(smallSession("kept"));
    w.index();
    expect(planRebuild(w.db, w.config.transcriptsDir)).toEqual({ transcripts: 6, unreadable: [], sessions: 3, sessionsLost: 0, subagentFilesLost: 0 });

    // The files are deleted, there was no pass after that: the database does not yet know about the loss.
    rmSync(gone.mainPath);
    rmSync(partial.subagentPaths[0]!);

    const plan = planRebuild(w.db, w.config.transcriptsDir);
    expect(plan).toEqual({ transcripts: 4, unreadable: [], sessions: 3, sessionsLost: 1, subagentFilesLost: 1 });
    expect(rebuildBlocker(plan)).toBeNull();
    expect(count(w.db, "sessions")).toBe(3);
  });

  test("there is not a single transcript on disk but the database has sessions: the rebuild refuses and leaves the database alone", () => {
    const w = world();
    const { mainPath, sessionDir } = w.write(smallSession());
    w.index();
    const before = dump(w.db);
    rmSync(mainPath);
    rmSync(sessionDir, { recursive: true });

    // The directory exists but is empty.
    expect(() => w.index({ rebuild: true })).toThrow("No transcripts found on disk, but the database has sessions: 1. Rebuild not performed.");
    expect(dump(w.db)).toEqual(before);

    rmSync(w.config.transcriptsDir, { recursive: true });
    expect(() => w.index({ rebuild: true })).toThrow("Rebuild not performed.");
    expect(dump(w.db)).toEqual(before);
  });

  test("the project directory is unreadable: the rebuild refuses instead of counting its sessions as lost", () => {
    const w = world();
    const { mainPath } = w.write(smallSession());
    w.index();
    const before = dump(w.db);
    chmodSync(dirname(mainPath), 0o000);

    try {
      expect(() => w.index({ rebuild: true })).toThrow(`unreadable: ${dirname(mainPath)}. Rebuild not performed.`);
    } finally {
      chmodSync(dirname(mainPath), 0o700);
    }
    expect(dump(w.db)).toEqual(before);
  });

  test("empty database and empty disk: nothing to rebuild, no refusal", () => {
    const w = world();
    expect(w.index({ rebuild: true })).toMatchObject({ filesSeen: 0, sessionsChanged: [] });
  });
});

describe("parser run for torch doctor", () => {
  test("counts files, lines and the unknown over the whole history from the start, independent of the index", () => {
    const w = world();
    const files = smallSession();
    files.main.raw({ type: "mystery-line", payload: "secret payload" });
    files.main.envelope({ type: "user", message: { role: "user", content: "x" }, brandNewField: 1 });
    w.write(files);
    w.index();

    const scan = scanTranscripts(w.config.transcriptsDir);

    expect(scan).toEqual({ mainFiles: 1, subagentFiles: 1, lines: files.main.lines.length + 2, unreadable: 0, unknown: { types: { "mystery-line": 1 }, fields: { "user.brandNewField": 1 } } });
    expect(scanTranscripts(join(w.config.transcriptsDir, "missing"))).toEqual({ mainFiles: 0, subagentFiles: 0, lines: 0, unreadable: 0, unknown: { types: {}, fields: {} } });
  });

  test("an unreadable transcript and an unreadable directory are skipped and counted", () => {
    const w = world();
    const locked = w.write(smallSession("locked"));
    const files = smallSession("open");
    w.write(files);
    const hiddenMain = transcript({ sessionId: "hidden", cwd: "/Users/dev/code/hidden" });
    hiddenMain.prompt("x");
    const hidden = w.write({ main: hiddenMain });
    chmodSync(locked.mainPath, 0o000);
    chmodSync(dirname(hidden.mainPath), 0o000);

    try {
      expect(scanTranscripts(w.config.transcriptsDir)).toEqual({ mainFiles: 1, subagentFiles: 2, lines: files.main.lines.length + 4, unreadable: 2, unknown: { types: {}, fields: {} } });
    } finally {
      chmodSync(locked.mainPath, 0o600);
      chmodSync(dirname(hidden.mainPath), 0o700);
    }
  });
});

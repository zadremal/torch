// Watching the transcripts directory: a file change and the passage of the clock lead to an indexer pass.
// File changes are checked with real watching, clock-driven passes — with substituted timers.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, jest, test } from "bun:test";
import { appendFileSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { RUNNING_WINDOW_MS } from "../../src/contracts/constants.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { IndexError, runIndex, type IndexDeps } from "../../src/ingest/index.ts";
import { PASS_REST, startWatcher, WATCH_DELAY_MS, WATCH_TICK_MS } from "../../src/ingest/watch.ts";
import { REF_PRICES } from "../support/reference.ts";
import { text, toolUse, transcript, writeSession, type Transcript } from "../support/transcript.ts";

const START = Date.UTC(2026, 9, 1, 10, 0, 0);

/** Longer than any delay in the file system delivering changes. */
const WAIT_MS = 5000;

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  jest.useRealTimers();
});

/** A temporary transcripts directory, an in-memory database and watching that will stop after the test. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "torch-watch-"));
  const config = loadConfig({
    dataDir: join(root, "torch"),
    transcriptsDir: join(root, "projects"),
    desktopSessionsDir: join(root, "desktop"),
    claudeSettingsPath: join(root, "settings.json"),
  });
  const db = openMemoryDb();
  /** `passMs` — how long a pass “lasts”: the clock jumps ahead by that much when it asks for the time. */
  const clock = { now: START + 60_000, passMs: 0 };
  const deps: IndexDeps = { db, config, prices: REF_PRICES, now: () => clock.now };
  const passDeps: IndexDeps = {
    ...deps,
    now: () => {
      const now = clock.now;
      clock.now += clock.passMs;
      clock.passMs = 0;
      return now;
    },
  };
  const indexed: string[][] = [];
  const errors: unknown[] = [];
  let waiting: (() => void) | null = null;
  return {
    config,
    db,
    clock,
    indexed,
    errors,
    index: () => runIndex(deps),
    write: (main: Transcript) => writeSession(config.transcriptsDir, { main }),
    watch() {
      const stop = startWatcher(
        passDeps,
        (ids) => {
          indexed.push(ids);
          waiting?.();
        },
        (error) => errors.push(error),
      );
      stops.push(stop);
      return stop;
    },
    /** Waits for the next watch message about changed sessions. */
    nextIndexed(): Promise<string[]> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Watching did not report a change")), WAIT_MS);
        waiting = () => {
          clearTimeout(timeout);
          waiting = null;
          resolve(indexed.at(-1)!);
        };
      });
    },
  };
}

/** A session of a prompt and a response with a tool call that has no result yet. */
function openSession(sessionId: string) {
  const main = transcript({ sessionId, startAt: START });
  main.prompt("Fix the flaky test");
  const { toolUseIds } = main.tick(2000).assistant({ blocks: [text("Reading"), toolUse("Read", { file_path: "/repo/a.ts" })] });
  return { main, toolUseId: toolUseIds[0]! };
}

/** Lines added to the builder after `from`, in the form in which Claude Code appends them. */
const tail = (main: Transcript, from: number): string => main.lines.slice(from).map((line) => `${JSON.stringify(line)}\n`).join("");

const toolStatus = (db: Database): string[] => db.query<{ status: string }, []>("SELECT status FROM tool_calls ORDER BY id").all().map((row) => row.status);
const sessionStatus = (db: Database, id: string): string | undefined => db.query<{ status: string }, [string]>("SELECT status FROM sessions WHERE id = ?").get(id)?.status;

describe("file changes", () => {
  test("an appended line reaches the database and names the session", async () => {
    const w = world();
    const { main, toolUseId } = openSession("s1");
    const { mainPath } = w.write(main);
    w.index();
    expect(toolStatus(w.db)).toEqual(["pending"]);
    w.watch();

    const written = main.lines.length;
    main.tick(300).toolResult(toolUseId, { content: "file body" });
    const changed = w.nextIndexed();
    appendFileSync(mainPath, tail(main, written));

    expect(await changed).toEqual(["s1"]);
    expect(toolStatus(w.db)).toEqual(["ok"]);
    expect(w.errors).toEqual([]);
  });

  test("a new session and its subagent are named in one message", async () => {
    const w = world();
    w.write(openSession("s1").main);
    w.index();
    w.watch();

    const changed = w.nextIndexed();
    const sub = transcript({ sessionId: "s2", agentId: "a1", startAt: START + 5000 });
    sub.prompt("Look around");
    sub.tick(1000).assistant({ blocks: [text("Nothing here")] });
    writeSession(w.config.transcriptsDir, { main: openSession("s2").main, subagents: [{ transcript: sub, meta: { agentType: "Explore" } }] });

    expect(await changed).toEqual(["s2"]);
    expect(w.db.query<{ agent_id: string }, []>("SELECT agent_id FROM agents WHERE session_id = 's2' ORDER BY agent_id").all()).toEqual([{ agent_id: "a1" }, { agent_id: "main" }]);
    // Changes that arrived in a burst gave one pass with data: there is no second message.
    await Bun.sleep(WATCH_DELAY_MS * 2);
    expect(w.indexed).toEqual([["s2"]]);
  });

  test("an incomplete last line waits to be finished", async () => {
    const w = world();
    const { main, toolUseId } = openSession("s1");
    const { mainPath } = w.write(main);
    w.index();
    w.watch();

    const written = main.lines.length;
    main.tick(300).toolResult(toolUseId, { content: "file body" });
    const line = tail(main, written);
    appendFileSync(mainPath, line.slice(0, 40));
    await Bun.sleep(WATCH_DELAY_MS * 2);
    expect(w.indexed).toEqual([]);

    const changed = w.nextIndexed();
    appendFileSync(mainPath, line.slice(40));
    expect(await changed).toEqual(["s1"]);
    expect(toolStatus(w.db)).toEqual(["ok"]);
  });
});

describe("clock-driven pass", () => {
  test("a running session without new lines becomes finished", () => {
    jest.useFakeTimers();
    const w = world();
    const { main } = openSession("s1");
    w.write(main);
    const lastEvent = START + 2000;
    w.clock.now = lastEvent + RUNNING_WINDOW_MS - WATCH_TICK_MS;
    w.index();
    expect(sessionStatus(w.db, "s1")).toBe("running");
    w.watch();

    // The threshold has not been reached yet: the pass changed nothing and notified no one.
    w.clock.now = lastEvent + RUNNING_WINDOW_MS - 1;
    jest.advanceTimersByTime(WATCH_TICK_MS);
    expect(sessionStatus(w.db, "s1")).toBe("running");
    expect(w.indexed).toEqual([]);

    w.clock.now = lastEvent + RUNNING_WINDOW_MS;
    jest.advanceTimersByTime(WATCH_TICK_MS);
    expect(sessionStatus(w.db, "s1")).toBe("completed");
    expect(w.indexed).toEqual([["s1"]]);
  });

  test("no transcripts directory at startup: its files are picked up once it appears", async () => {
    jest.useFakeTimers();
    const w = world();
    w.watch();
    jest.advanceTimersByTime(WATCH_TICK_MS);
    expect(w.indexed).toEqual([]);

    const { main, toolUseId } = openSession("s1");
    const { mainPath } = w.write(main);
    jest.advanceTimersByTime(WATCH_TICK_MS);
    expect(w.indexed).toEqual([["s1"]]);

    // From this pass on the directory is watched: an appended line arrives without the clock advancing.
    jest.useRealTimers();
    const written = main.lines.length;
    main.tick(300).toolResult(toolUseId, { content: "file body" });
    const changed = w.nextIndexed();
    appendFileSync(mainPath, tail(main, written));
    expect(await changed).toEqual(["s1"]);
    expect(toolStatus(w.db)).toEqual(["ok"]);
  });

  test("a bad file is reported once and does not hinder the others", () => {
    jest.useFakeTimers();
    const w = world();
    const locked = w.write(openSession("locked").main);
    w.watch();
    w.write(openSession("s1").main);
    chmodSync(locked.mainPath, 0o000);
    try {
      jest.advanceTimersByTime(WATCH_TICK_MS);
      expect(w.indexed).toEqual([["s1"]]);
      expect(w.errors).toHaveLength(1);
      expect((w.errors[0] as IndexError).failures.map((failure) => failure.path)).toEqual([locked.mainPath]);

      // The same failure on the next pass is not news.
      jest.advanceTimersByTime(WATCH_TICK_MS);
      expect(w.errors).toHaveLength(1);
    } finally {
      chmodSync(locked.mainPath, 0o600);
    }

    // The file is readable again: the session is loaded, and a repeated failure after that is reported anew.
    jest.advanceTimersByTime(WATCH_TICK_MS);
    expect(w.indexed).toEqual([["s1"], ["locked"]]);
    chmodSync(locked.mainPath, 0o000);
    try {
      appendFileSync(join(w.config.transcriptsDir, "marker"), "");
      jest.advanceTimersByTime(WATCH_TICK_MS);
      expect(w.errors).toHaveLength(2);
    } finally {
      chmodSync(locked.mainPath, 0o600);
    }
  });

  test("a failure of the pass itself is reported, watching continues", () => {
    jest.useFakeTimers();
    const w = world();
    w.write(openSession("s1").main);
    w.watch();
    w.db.exec("ALTER TABLE source_files RENAME TO source_files_gone");
    jest.advanceTimersByTime(WATCH_TICK_MS);
    expect(w.errors).toHaveLength(1);
    expect(w.errors[0]).not.toBeInstanceOf(IndexError);
    expect(w.indexed).toEqual([]);

    w.db.exec("ALTER TABLE source_files_gone RENAME TO source_files");
    jest.advanceTimersByTime(WATCH_TICK_MS);
    expect(w.indexed).toEqual([["s1"]]);
  });

  test("after a long pass watching rests PASS_REST times longer than the pass took", () => {
    jest.useFakeTimers();
    const w = world();
    /** The pass clock moves together with the timers. */
    const advance = (ms: number): void => {
      w.clock.now += ms;
      jest.advanceTimersByTime(ms);
    };
    w.write(openSession("s1").main);
    w.watch();
    const passMs = WATCH_TICK_MS;
    w.clock.passMs = passMs;
    advance(WATCH_TICK_MS);
    expect(w.indexed).toEqual([["s1"]]);

    // The rest is still going: the new session waits, although clock-driven passes came due in the meantime.
    w.write(openSession("s2").main);
    advance(passMs * PASS_REST - WATCH_TICK_MS);
    expect(w.indexed).toEqual([["s1"]]);

    advance(WATCH_TICK_MS * 2);
    expect(w.indexed).toEqual([["s1"], ["s2"]]);
  });

  test("no passes after stopping", async () => {
    jest.useFakeTimers();
    const w = world();
    const stop = w.watch();
    stop();
    w.write(openSession("s1").main);
    jest.advanceTimersByTime(WATCH_TICK_MS * 3);
    jest.useRealTimers();
    await Bun.sleep(WATCH_DELAY_MS * 2);

    expect(w.indexed).toEqual([]);
    expect(w.db.query("SELECT id FROM sessions").all()).toEqual([]);
  });
});

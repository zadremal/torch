// Receiver uptime windows with a heartbeat and the session enrichment marker (plan §5, §6.2).
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, jest, test } from "bun:test";
import { RECEIVER_HEARTBEAT_MS } from "../../src/contracts/constants.ts";
import { OTEL_EVENT_NAMES } from "../../src/contracts/enrich.ts";
import type { Enrichment, ReceiverWindowRow } from "../../src/contracts/rows.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { deriveEnrichment, startReceiverWindow } from "../../src/enrich/coverage.ts";
import { REF_PRICES } from "../support/reference.ts";
import { SEED_TIME, seed } from "../support/seed.ts";
import { ANTHROPIC_PROVIDER } from "../support/provider.ts";

/** Second `n` from the start of the example. */
const at = (n: number) => SEED_TIME + n * 1000;

const windows = (db: Database) => db.query<ReceiverWindowRow, []>("SELECT * FROM receiver_windows ORDER BY id").all();

describe("receiver uptime window", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  /** Test clock: the heartbeat reads time from it, not from the timer. Windows open at moments that are multiples of the heartbeat. */
  function clock(start: number) {
    let time = start;
    jest.useFakeTimers();
    return {
      now: () => time,
      /** Passes `ms`: the heartbeats that fall into this span fire. */
      pass(ms: number) {
        const target = time + ms;
        const pulses = Math.floor(target / RECEIVER_HEARTBEAT_MS) - Math.floor(time / RECEIVER_HEARTBEAT_MS);
        for (let i = 1; i <= pulses; i++) {
          time = (Math.floor(time / RECEIVER_HEARTBEAT_MS) + 1) * RECEIVER_HEARTBEAT_MS;
          jest.advanceTimersByTime(RECEIVER_HEARTBEAT_MS);
        }
        time = target;
      },
    };
  }

  test("opens at start: start and end equal the launch time", () => {
    const db = openMemoryDb();
    const time = clock(0);
    const stop = startReceiverWindow(db, time.now);
    expect(windows(db)).toEqual([{ id: 1, started_at: 0, stopped_at: 0 }]);
    stop();
  });

  test("a heartbeat every RECEIVER_HEARTBEAT_MS moves the window end", () => {
    const db = openMemoryDb();
    const time = clock(0);
    const stop = startReceiverWindow(db, time.now);

    time.pass(RECEIVER_HEARTBEAT_MS - 1);
    expect(windows(db)[0]!.stopped_at).toBe(0);
    time.pass(1);
    expect(windows(db)[0]!.stopped_at).toBe(RECEIVER_HEARTBEAT_MS);
    time.pass(2 * RECEIVER_HEARTBEAT_MS);
    expect(windows(db)).toEqual([{ id: 1, started_at: 0, stopped_at: 3 * RECEIVER_HEARTBEAT_MS }]);
    stop();
  });

  test("crash: the window stays closed at the last heartbeat", () => {
    const db = openMemoryDb();
    const time = clock(0);
    const stop = startReceiverWindow(db, time.now);
    // Two heartbeats and 10 more seconds of work; the stop function is not called: the process was killed.
    time.pass(2 * RECEIVER_HEARTBEAT_MS + 10_000);
    expect(windows(db)).toEqual([{ id: 1, started_at: 0, stopped_at: 2 * RECEIVER_HEARTBEAT_MS }]);
    stop();
  });

  test("stopping closes the window at the current time and stops the heartbeat", () => {
    const db = openMemoryDb();
    const time = clock(0);
    const stop = startReceiverWindow(db, time.now);
    time.pass(RECEIVER_HEARTBEAT_MS + 10_000);
    stop();
    expect(windows(db)[0]!.stopped_at).toBe(RECEIVER_HEARTBEAT_MS + 10_000);

    time.pass(5 * RECEIVER_HEARTBEAT_MS);
    stop();
    expect(windows(db)).toEqual([{ id: 1, started_at: 0, stopped_at: RECEIVER_HEARTBEAT_MS + 10_000 }]);
  });

  test("each launch opens its own window, earlier ones do not change", () => {
    const db = openMemoryDb();
    const time = clock(0);
    startReceiverWindow(db, time.now)();
    time.pass(600_000);
    const stop = startReceiverWindow(db, time.now);
    time.pass(RECEIVER_HEARTBEAT_MS);
    stop();
    expect(windows(db)).toEqual([
      { id: 1, started_at: 0, stopped_at: 0 },
      { id: 2, started_at: 600_000, stopped_at: 600_000 + RECEIVER_HEARTBEAT_MS },
    ]);
  });
});

describe("enrichment marker", () => {
  /** Far after the example: there are no open windows. */
  const LATER = at(100_000);

  const derive = (db: Database, now = LATER, sessionId = "s1") => deriveEnrichment({ db, sessionId, prices: REF_PRICES, provider: ANTHROPIC_PROVIDER, now });
  const enrichment = (db: Database, id = "s1") => db.query<{ enrichment: Enrichment }, [string]>("SELECT enrichment FROM sessions WHERE id = ?").get(id)!.enrichment;

  /** A session with two active spans: seconds 0–60 and 600–660. There is idle time between them. */
  function twoTurns(start: Enrichment = "none"): Database {
    const db = openMemoryDb();
    seed.session(db, { id: "s1", enrichment: start });
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(0) });
    seed.modelCall(db, { session_id: "s1", id: "m1", ts_start: at(0), duration_ms: 20_000 });
    seed.toolCall(db, { session_id: "s1", id: "t1", ts_start: at(20), duration_ms: 40_000 });
    seed.prompt(db, { session_id: "s1", id: "p2", ts: at(600), kind: "follow_up", seq: 1 });
    seed.modelCall(db, { session_id: "s1", id: "m2", ts_start: at(600), duration_ms: 60_000 });
    // The session sent events: window coverage decides the marker.
    seed.otelEvent(db, { session_id: "s1", name: OTEL_EVENT_NAMES.apiRequest });
    return db;
  }

  test("full: one window covers all active spans", () => {
    const db = twoTurns();
    seed.receiverWindow(db, { started_at: at(-10), stopped_at: at(700) });
    derive(db);
    expect(enrichment(db)).toBe("full");
  });

  test("full: window boundaries coincide with span boundaries", () => {
    const db = twoTurns();
    seed.receiverWindow(db, { started_at: at(0), stopped_at: at(60) });
    seed.receiverWindow(db, { started_at: at(600), stopped_at: at(660) });
    derive(db);
    expect(enrichment(db)).toBe("full");
  });

  test("full: the receiver is off only during idle time between spans", () => {
    const db = twoTurns();
    seed.receiverWindow(db, { started_at: at(-10), stopped_at: at(100) });
    seed.receiverWindow(db, { started_at: at(500), stopped_at: at(700) });
    derive(db);
    expect(enrichment(db)).toBe("full");
  });

  test("full: overlapping windows together cover the span", () => {
    const db = twoTurns();
    seed.receiverWindow(db, { started_at: at(-10), stopped_at: at(30) });
    seed.receiverWindow(db, { started_at: at(25), stopped_at: at(700) });
    derive(db);
    expect(enrichment(db)).toBe("full");
  });

  test("partial: one span out of two is covered", () => {
    const db = twoTurns();
    seed.receiverWindow(db, { started_at: at(-10), stopped_at: at(100) });
    derive(db);
    expect(enrichment(db)).toBe("partial");
  });

  test("partial: the receiver was started in the middle of a span", () => {
    const db = twoTurns();
    seed.receiverWindow(db, { started_at: at(30), stopped_at: at(700) });
    derive(db);
    expect(enrichment(db)).toBe("partial");
  });

  test("partial: a receiver restart inside a span leaves a gap", () => {
    const db = twoTurns();
    seed.receiverWindow(db, { started_at: at(-10), stopped_at: at(30) });
    seed.receiverWindow(db, { started_at: at(40), stopped_at: at(700) });
    derive(db);
    expect(enrichment(db)).toBe("partial");
  });

  test("none: no windows", () => {
    const db = twoTurns("full");
    derive(db);
    expect(enrichment(db)).toBe("none");
  });

  test("none: windows lie outside active spans, including directly adjacent to them", () => {
    const db = twoTurns("full");
    seed.receiverWindow(db, { started_at: at(-100), stopped_at: at(0) });
    seed.receiverWindow(db, { started_at: at(100), stopped_at: at(500) });
    seed.receiverWindow(db, { started_at: at(660), stopped_at: at(900) });
    derive(db);
    expect(enrichment(db)).toBe("none");
  });

  test("none: a session without prompts has no active spans", () => {
    const db = openMemoryDb();
    seed.session(db, { id: "s1", enrichment: "full" });
    seed.modelCall(db, { session_id: "s1", id: "m1", ts_start: at(0) });
    seed.receiverWindow(db, { started_at: at(-10), stopped_at: at(700) });
    derive(db);
    expect(enrichment(db)).toBe("none");
  });

  test("a span made of a single prompt with no events is covered by the window it lies inside", () => {
    const db = openMemoryDb();
    seed.session(db, { id: "s1" });
    seed.prompt(db, { session_id: "s1", id: "p1", ts: at(5) });
    seed.otelEvent(db, { session_id: "s1", name: "claude_code.user_prompt" });
    seed.receiverWindow(db, { started_at: at(0), stopped_at: at(10) });
    derive(db);
    expect(enrichment(db)).toBe("full");
  });

  test("subagent events are part of the active span", () => {
    const db = twoTurns();
    seed.toolCall(db, { session_id: "s1", id: "t2", agent_id: "a1", ts_start: at(660), duration_ms: 120_000 });
    seed.receiverWindow(db, { started_at: at(-10), stopped_at: at(700) });
    derive(db);
    // The second span extends to second 780, the window is closed at 700.
    expect(enrichment(db)).toBe("partial");
  });

  test("an open window is extended to the current time: the heartbeat lags behind the events of a running session", () => {
    const db = twoTurns();
    // The last heartbeat is at second 640, the last session event at 660, the recalculation at 661.
    seed.receiverWindow(db, { started_at: at(-10), stopped_at: at(640) });
    derive(db, at(661));
    expect(enrichment(db)).toBe("full");
  });

  test("a window without a fresh heartbeat is closed at it: the receiver crashed", () => {
    const db = twoTurns();
    seed.receiverWindow(db, { started_at: at(-10), stopped_at: at(640) });
    derive(db, at(640) + 2 * RECEIVER_HEARTBEAT_MS + 1);
    expect(enrichment(db)).toBe("partial");
  });

  test("the marker is computed per session and a repeated recalculation does not change it", () => {
    const db = twoTurns();
    seed.session(db, { id: "s2" });
    seed.prompt(db, { session_id: "s2", id: "p1", ts: at(2000) });
    seed.modelCall(db, { session_id: "s2", id: "m1", ts_start: at(2000), duration_ms: 5000 });
    seed.receiverWindow(db, { started_at: at(-10), stopped_at: at(700) });
    derive(db);
    derive(db);
    derive(db, LATER, "s2");
    expect(enrichment(db)).toBe("full");
    expect(enrichment(db, "s2")).toBe("none");
  });
});

test("marker none: the receiver was running but no event arrived from the session", () => {
  const db = openMemoryDb();
  seed.session(db, { id: "s1", enrichment: "full" });
  seed.prompt(db, { session_id: "s1", id: "p1", ts: SEED_TIME });
  seed.modelCall(db, { session_id: "s1", id: "m1", ts_start: SEED_TIME, duration_ms: 1000 });
  seed.receiverWindow(db, { started_at: SEED_TIME - 60_000, stopped_at: SEED_TIME + 60_000 });
  // An event of another session does not change this one's marker.
  seed.otelEvent(db, { session_id: "s2", name: OTEL_EVENT_NAMES.apiRequest });

  deriveEnrichment({ db, sessionId: "s1", prices: REF_PRICES, provider: ANTHROPIC_PROVIDER, now: SEED_TIME + 10 * RECEIVER_HEARTBEAT_MS });
  expect(db.query<{ enrichment: Enrichment }, []>("SELECT enrichment FROM sessions WHERE id = 's1'").get()!.enrichment).toBe("none");
});

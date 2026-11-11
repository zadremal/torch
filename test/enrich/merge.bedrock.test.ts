// mergeEnrichment through a gateway (the bedrock provider): api_request events without request_id are paired with
// model calls by model, time and tokens (src/providers/bedrock.ts).
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { API_REQUEST_MATCH_WINDOW_MS } from "../../src/contracts/constants.ts";
import { OTEL_EVENT_NAMES } from "../../src/contracts/enrich.ts";
import type { ModelCallRow } from "../../src/contracts/rows.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { mergeEnrichment } from "../../src/enrich/merge.ts";
import { providerFor } from "../../src/providers/index.ts";
import { SEED_TIME, seed } from "../support/seed.ts";

const BEDROCK = providerFor("bedrock");

function sessionDb(): Database {
  const db = openMemoryDb();
  seed.session(db, { id: "s1" });
  seed.agent(db, { session_id: "s1" });
  return db;
}

const applied = (db: Database): number[] => db.query<{ applied: number }, []>("SELECT applied FROM otel_events ORDER BY id").all().map((row) => row.applied);
const modelCall = (db: Database, id: string) => db.query<ModelCallRow, [string, string]>("SELECT * FROM model_calls WHERE session_id = ? AND id = ?").get("s1", id)!;

interface Counts {
  input: number;
  output: number;
  cacheRead: number;
  /** 5m and 1h of the call; the event reports their sum. */
  cacheWrite: [number, number];
}

/** A gateway call of the main agent: the model as the gateway names it, ending at `end`. */
const gatewayCall = (db: Database, id: string, end: number, counts: Counts, model = "claude-align-aws-opus-5-5") =>
  seed.modelCall(db, {
    session_id: "s1",
    id,
    model,
    ts_start: end - 4000,
    duration_ms: 4000,
    tok_input: counts.input,
    tok_output: counts.output,
    tok_cache_read: counts.cacheRead,
    tok_cache_write_5m: counts.cacheWrite[0],
    tok_cache_write_1h: counts.cacheWrite[1],
  });

/** An `api_request` event without request_id, as the gateway's exporter sends it: the model wrapped differently. */
const gatewayEvent = (db: Database, ts: number, counts: Counts | null, attrs: Record<string, string | number> = {}) =>
  seed.otelEvent(db, {
    session_id: "s1",
    ts,
    name: OTEL_EVENT_NAMES.apiRequest,
    attrs: {
      model: "align-aws-opus-5-5",
      duration_ms: 3120,
      query_source: "repl_main_thread",
      ...(counts && {
        input_tokens: counts.input,
        output_tokens: counts.output,
        cache_read_tokens: counts.cacheRead,
        cache_creation_tokens: counts.cacheWrite[0] + counts.cacheWrite[1],
      }),
      ...attrs,
    },
  });

const MAIN: Counts = { input: 2, output: 300, cacheRead: 40_000, cacheWrite: [400, 100] };
const SUB: Counts = { input: 6, output: 120, cacheRead: 18_000, cacheWrite: [0, 0] };
const END = SEED_TIME + 10_000;

test("an event without request_id joins its call by model, time and tokens: exact duration and request source", () => {
  const db = sessionDb();
  const before = gatewayCall(db, "msg_bdrk_1", END, MAIN);
  gatewayEvent(db, END + 200, MAIN);

  expect(mergeEnrichment(db, "s1", BEDROCK)).toBe(true);

  expect(modelCall(db, "msg_bdrk_1")).toEqual({ ...before, duration_ms: 3120, duration_exact: 1, query_source: "repl_main_thread" });
  expect(applied(db)).toEqual([1]);
});

test("an event without token counts joins by model and time alone", () => {
  const db = sessionDb();
  gatewayCall(db, "msg_bdrk_1", END, MAIN);
  gatewayEvent(db, END - 300, null);

  mergeEnrichment(db, "s1", BEDROCK);

  expect(modelCall(db, "msg_bdrk_1")).toMatchObject({ duration_ms: 3120, duration_exact: 1, query_source: "repl_main_thread" });
  expect(applied(db)).toEqual([1]);
});

test("one-to-one: parallel calls each get their own event; a surplus event does not take a second call", () => {
  const db = sessionDb();
  gatewayCall(db, "msg_bdrk_main", END, MAIN);
  gatewayCall(db, "msg_bdrk_sub", END + 100, SUB);
  // Each event is nearer in time to the other call; a third one without counts finds no free call.
  gatewayEvent(db, END + 100, MAIN, { duration_ms: 1111 });
  gatewayEvent(db, END, SUB, { duration_ms: 2222 });
  gatewayEvent(db, END + 50, null, { duration_ms: 3333 });

  mergeEnrichment(db, "s1", BEDROCK);

  expect(modelCall(db, "msg_bdrk_main")).toMatchObject({ duration_ms: 1111, duration_exact: 1 });
  expect(modelCall(db, "msg_bdrk_sub")).toMatchObject({ duration_ms: 2222, duration_exact: 1 });
  expect(applied(db)).toEqual([1, 1, 0]);

  // On the next merge both calls are exact: the surplus event still waits.
  expect(mergeEnrichment(db, "s1", BEDROCK)).toBe(false);
  expect(applied(db)).toEqual([1, 1, 0]);
});

test("an event outside the window waits and changes nothing", () => {
  const db = sessionDb();
  const before = gatewayCall(db, "msg_bdrk_1", END, MAIN);
  gatewayEvent(db, END + API_REQUEST_MATCH_WINDOW_MS + 1, MAIN);

  expect(mergeEnrichment(db, "s1", BEDROCK)).toBe(false);

  expect(modelCall(db, "msg_bdrk_1")).toEqual(before);
  expect(applied(db)).toEqual([0]);
});

test("a side request on another model (title generation) stays unapplied and changes nothing", () => {
  const db = sessionDb();
  const before = gatewayCall(db, "msg_bdrk_1", END, MAIN);
  gatewayEvent(db, END + 100, null, { model: "align-aws-haiku-4-5", query_source: "generate_session_title", duration_ms: 640 });

  expect(mergeEnrichment(db, "s1", BEDROCK)).toBe(false);

  expect(modelCall(db, "msg_bdrk_1")).toEqual(before);
  expect(applied(db)).toEqual([0]);
});

test("a subagent's event before its file is indexed waits instead of taking a main-agent call; the next merge applies it", () => {
  const db = sessionDb();
  const main = gatewayCall(db, "msg_bdrk_main", END, MAIN);
  // The main file has been read; the subagent's event is pending, its call is not in the database yet.
  gatewayEvent(db, END + 150, SUB, { query_source: "agent:custom" });

  expect(mergeEnrichment(db, "s1", BEDROCK)).toBe(false);
  expect(modelCall(db, "msg_bdrk_main")).toEqual(main);
  expect(applied(db)).toEqual([0]);

  // The subagent's file is indexed.
  const sub = gatewayCall(db, "msg_bdrk_sub", END + 2000, SUB);

  expect(mergeEnrichment(db, "s1", BEDROCK)).toBe(true);
  expect(modelCall(db, "msg_bdrk_sub")).toEqual({ ...sub, duration_ms: 3120, duration_exact: 1, query_source: "agent:custom" });
  expect(modelCall(db, "msg_bdrk_main")).toEqual(main);
  expect(applied(db)).toEqual([1]);
});

test("nothing pending to match: the merge reports no change", () => {
  const db = sessionDb();
  gatewayCall(db, "msg_bdrk_1", END, MAIN);

  expect(mergeEnrichment(db, "s1", BEDROCK)).toBe(false);
});

// Support for the call reducer tests (package I1): a pass over transcript rows and a table snapshot.
import type { Database } from "bun:sqlite";
import type { PriceTable } from "../../../src/contracts/api.ts";
import { MAIN_AGENT_ID } from "../../../src/contracts/constants.ts";
import type { ParsedLine } from "../../../src/contracts/lines.ts";
import type { LineReducer, ReduceContext } from "../../../src/contracts/pipeline.ts";
import { LINE_REDUCERS } from "../../../src/ingest/index.ts";
import { parseLine } from "../../../src/ingest/parse.ts";
import { reduceApiErrors } from "../../../src/ingest/reduce/apiErrors.ts";
import { reduceCompactions } from "../../../src/ingest/reduce/compactions.ts";
import { reduceExternal } from "../../../src/ingest/reduce/external.ts";
import { reduceFileOps } from "../../../src/ingest/reduce/fileOps.ts";
import { reduceModelCalls } from "../../../src/ingest/reduce/modelCalls.ts";
import { reduceToolCalls } from "../../../src/ingest/reduce/toolCalls.ts";
import type { RawLine, Transcript } from "../../support/transcript.ts";
import { ANTHROPIC_PROVIDER } from "../../support/provider.ts";

/** Default time of the transcript's first row. */
export const START = Date.UTC(2026, 9, 1, 10, 0, 0);

/** Example prices, $ per million tokens. */
export const PRICES: PriceTable = {
  source: "https://example.com/prices",
  updated: "2026-10-01",
  contextWindows: [200_000],
  models: { "claude-opus-5-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, contextWindow: 200_000 } },
};

const OWN = new Set<LineReducer>([reduceModelCalls, reduceToolCalls, reduceFileOps, reduceExternal, reduceApiErrors, reduceCompactions]);

/** Package reducers in the indexer's order: the other row reducers are written by I2. */
const CALL_REDUCERS = LINE_REDUCERS.filter((reducer) => OWN.has(reducer));

export const parsed = (t: Transcript): ParsedLine[] => t.lines.map((line) => parseLine(JSON.stringify(line)).line);

/** Moves the time of an already built row: the builder gives all rows of one reply the same time. */
export function setTime(line: RawLine, ms: number): void {
  line.timestamp = new Date(ms).toISOString();
}

/** Time of the last row with a timestamp: the indexer passes it to the next pass as `prevEventTs`. */
export function lastEventTs(lines: ParsedLine[]): number | null {
  return lines.reduce<number | null>((last, line) => ("timestamp" in line && line.timestamp !== null ? line.timestamp : last), null);
}

export interface Pass {
  /** Rows of the pass; by default the whole transcript. */
  lines?: ParsedLine[];
  prevEventTs?: number | null;
  prices?: PriceTable;
}

/** One pass over a transcript file: the package reducers in the indexer's order, in one transaction. */
export function reduce(db: Database, t: Transcript, pass: Pass = {}): void {
  const ctx: ReduceContext = {
    db,
    sessionId: t.options.sessionId,
    agentId: t.options.agentId ?? MAIN_AGENT_ID,
    prices: pass.prices ?? PRICES,
    provider: ANTHROPIC_PROVIDER,
    prevEventTs: pass.prevEventTs ?? null,
    agentMeta: null,
    titles: { customFile: null, desktop: null },
  };
  const lines = pass.lines ?? parsed(t);
  db.transaction(() => {
    for (const reducer of CALL_REDUCERS) reducer(ctx, lines);
  })();
}

const TABLES = ["model_calls", "tool_calls", "file_ops", "external_requests", "api_errors", "compactions"] as const;

/** All rows of the package table in primary key order. */
export function rows<Row>(db: Database, table: (typeof TABLES)[number]): Row[] {
  return db.query<Row, []>(`SELECT * FROM ${table} ORDER BY session_id, id`).all();
}

/** Snapshot of everything the package writes: its tables and the body accounting. */
export function dump(db: Database): Record<string, unknown[]> {
  const contents = db.query("SELECT id, sha256, bytes, encoding FROM contents ORDER BY id").all();
  return { ...Object.fromEntries(TABLES.map((table) => [table, rows(db, table)])), contents };
}

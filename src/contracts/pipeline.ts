// Signatures of the load stages (plan §6.1): reading → parsing → row reducers → agent linking
// → derived values. The call order is set by the indexer (src/ingest/index.ts); each stage is
// implemented in its own file with the signature from here.

import type { Database } from "bun:sqlite";
import type { PriceTable } from "./api.ts";
import type { AgentMeta, ParsedLine } from "./lines.ts";

// ── Reading (ingest/reader.ts) ──────────────────────────────────────────────────────────────

/** What is known about a file from the previous pass (`source_files`). */
export interface FileState {
  inode: number;
  size: number;
  parsedOffset: number;
}

export interface ReadResult {
  /** Only complete lines, without the newline and without empty ones. */
  lines: string[];
  /** Offset right after the last newline read. */
  nextOffset: number;
  size: number;
  mtime: number;
  inode: number;
  /** The file became shorter or changed inode: read from the start. */
  restarted: boolean;
}

/**
 * Reads the file from `prev.parsedOffset` (or from the start if there is no `prev` or the file was replaced) up to
 * the last complete newline. A truncated last line is left for the next pass.
 */
export type ReadTranscript = (path: string, prev: FileState | null) => ReadResult;

// ── Parsing (ingest/parse.ts) ───────────────────────────────────────────────────────────────

export interface ParseResult {
  line: ParsedLine;
  /** Top-level field names that the decoder of this line type does not know. */
  unknownFields: string[];
}

/** Never throws: broken JSON and an unknown type yield `kind: "unknown"`. */
export type ParseLine = (raw: string) => ParseResult;

/** Counter of unknowns for `torch doctor`. `countUnknown` from ingest/parse.ts adds the parse results to it. */
export interface UnknownStats {
  /** Line type → how many times it was seen. */
  types: Record<string, number>;
  /** `<line type>.<field>` → how many times it was seen. */
  fields: Record<string, number>;
}

// ── Row reducers (ingest/reduce/*.ts) ───────────────────────────────────────────────────────

/** Session names from sources outside the transcript lines (decision 7). */
export interface ExternalTitles {
  /** `customTitle` from `<sessionId>/custom-title.json`. */
  customFile: string | null;
  /** `title` from the desktop app metadata (ingest/titles.ts). */
  desktop: string | null;
}

export interface ReduceContext {
  db: Database;
  /** Transcript file name: the only source of the session identifier. */
  sessionId: string;
  /** `main` for the main file, otherwise the `agentId` from the subagent file name. */
  agentId: string;
  prices: PriceTable;
  /** Time of the last line of this file from previous passes; null on the first pass. */
  prevEventTs: number | null;
  /** Contents of `agent-<agentId>.meta.json`; null for the main file and when the file is missing. */
  agentMeta: AgentMeta | null;
  titles: ExternalTitles;
}

/**
 * Receives the new lines of one file in write order and writes its own tables. Called inside the
 * indexer's transaction. Lines arrive in batches between passes, and again when a file is
 * re-read, so writing is idempotent: an insert or an update by primary key.
 */
export type LineReducer = (ctx: ReduceContext, lines: ParsedLine[]) => void;

// ── Derived values (ingest/reduce/{durations,status,context,totals}.ts, linkAgents) ─────────

export interface DeriveContext {
  db: Database;
  sessionId: string;
  prices: PriceTable;
  /** Current time: the running status is computed from it. */
  now: number;
}

/** Recalculates its own columns of the session and its agents from the database rows. Idempotent. */
export type DerivedReducer = (ctx: DeriveContext) => void;

// ── Cost (ingest/reduce/cost.ts) ────────────────────────────────────────────────────────────

export interface CallTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Cost of a call in dollars; null for a model that is not in the table. */
export type CallCost = (prices: PriceTable, model: string, tokens: CallTokens) => number | null;

/**
 * Context window size of a model; if `observedCtxTokens` exceeds the window, the next known
 * size from `prices.contextWindows`. null for an unknown model.
 */
export type ContextWindow = (prices: PriceTable, model: string, observedCtxTokens?: number) => number | null;

// ── Indexer (ingest/index.ts) ───────────────────────────────────────────────────────────────

export interface IndexResult {
  filesSeen: number;
  filesRead: number;
  linesParsed: number;
  /** Sessions whose data changed. */
  sessionsChanged: string[];
  unknown: UnknownStats;
}

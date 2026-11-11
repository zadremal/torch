// Incremental pass: reading, parsing, reducers, transaction (plan §6.1). Package I4.
import type { Database } from "bun:sqlite";
import { sep } from "node:path";
import type { TorchConfig } from "../config.ts";
import type { PriceTable } from "../contracts/api.ts";
import type { ParsedLine } from "../contracts/lines.ts";
import type { DeriveContext, DerivedReducer, IndexResult, LineReducer, ReadResult, ReduceContext, UnknownStats } from "../contracts/pipeline.ts";
import type { SessionStatus } from "../contracts/rows.ts";
import { deriveEnrichment } from "../enrich/coverage.ts";
import { ingestSpool } from "../enrich/hooks.ts";
import { mergeEnrichment } from "../enrich/merge.ts";
import { providerFor } from "../providers/index.ts";
import { discoverFiles, isMissing, knownFiles, readAgentMeta, readCustomTitle, type DiscoveredFile } from "./discover.ts";
import { countUnknown, parseLine } from "./parse.ts";
import { readTranscript } from "./reader.ts";
import { linkAgents, reduceAgents } from "./reduce/agents.ts";
import { reduceApiErrors } from "./reduce/apiErrors.ts";
import { reduceCompactions } from "./reduce/compactions.ts";
import { deriveContext } from "./reduce/context.ts";
import { deriveDurations } from "./reduce/durations.ts";
import { reduceExternal } from "./reduce/external.ts";
import { reduceFileOps } from "./reduce/fileOps.ts";
import { reduceInstructions } from "./reduce/instructions.ts";
import { reduceMessages } from "./reduce/messages.ts";
import { reduceModelCalls } from "./reduce/modelCalls.ts";
import { reducePrompts } from "./reduce/prompts.ts";
import { reduceSession } from "./reduce/session.ts";
import { deriveStatus } from "./reduce/status.ts";
import { reduceToolCalls } from "./reduce/toolCalls.ts";
import { deriveTotals } from "./reduce/totals.ts";
import { loadDesktopTitles } from "./titles.ts";

/**
 * Line reducers are called for each file in this order, in one transaction.
 * A later one may read the tables of earlier ones: fileOps and external come after toolCalls.
 */
export const LINE_REDUCERS: LineReducer[] = [
  reduceSession,
  reduceAgents,
  reducePrompts,
  reduceModelCalls,
  reduceToolCalls,
  reduceFileOps,
  reduceExternal,
  reduceApiErrors,
  reduceCompactions,
  reduceMessages,
  reduceInstructions,
];

/**
 * Session derivatives are recalculated in this order in the transaction of each of its changed files.
 * For a running session without changes only the status is recalculated on each pass.
 */
export const DERIVED_REDUCERS: DerivedReducer[] = [linkAgents, deriveDurations, deriveContext, deriveTotals, deriveStatus, deriveEnrichment];

/**
 * A file's external data (a subagent's meta.json, titles) with which it last went through
 * the reducers, per database. Lives as long as the process: the first pass after startup applies them again.
 */
/**
 * An enrichment event waits for a transcript line no longer than this: after that it is applied only by a pass
 * over a changed session file. Requests that are absent from the transcript entirely would wait forever, and
 * every watch pass would go through their sessions.
 */
const PENDING_EVENT_WINDOW_MS = 60 * 60_000;

const appliedByDb = new WeakMap<Database, Map<string, string>>();

function appliedExternal(db: Database): Map<string, string> {
  let applied = appliedByDb.get(db);
  if (!applied) appliedByDb.set(db, (applied = new Map()));
  return applied;
}

export interface IndexDeps {
  db: Database;
  config: TorchConfig;
  prices: PriceTable;
  now: () => number;
}

/** A transcript file or directory that could not be processed. */
export interface FileFailure {
  path: string;
  error: unknown;
}

/**
 * Some of the files could not be processed. The remaining files are loaded and derivatives recalculated:
 * one bad file does not stop the history from loading. `result` is the outcome of the pass without those files.
 */
export class IndexError extends Error {
  constructor(
    readonly failures: FileFailure[],
    readonly result: IndexResult,
  ) {
        super(`Failed to process files: ${failures.length}`);
    this.name = "IndexError";
  }
}

// ── Full rebuild ────────────────────────────────────────────────────────────────────────────

/**
 * Tables that a rebuild does not clear: the schema version and what cannot be restored from transcripts.
 * Everything else in the schema is built from transcripts — a new table falls under the clearing on its own.
 */
const KEPT_TABLES: readonly string[] = ["meta", "receiver_windows", "otel_events", "hook_events"];

/** Raw enrichment events are applied again after a rebuild. */
const RAW_EVENT_TABLES = ["otel_events", "hook_events"] as const;

function clearIndex(db: Database): void {
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  db.transaction(() => {
    for (const { name } of tables) if (!KEPT_TABLES.includes(name)) db.exec(`DELETE FROM "${name}"`);
    for (const table of RAW_EVENT_TABLES) db.exec(`UPDATE ${table} SET applied = 0`);
  })();
}

/** What a rebuild will erase irrevocably: a comparison of disk against the database before clearing. */
export interface RebuildPlan {
    /** Transcript files on disk. */
  transcripts: number;
    /** Directories that exist but are unreadable: their transcripts did not make it into the walk. */
  unreadable: FileFailure[];
    /** Sessions in the database. */
  sessions: number;
    /** Database sessions without a main file on disk: a rebuild will not restore them. */
  sessionsLost: number;
    /** Tracked subagent files of other sessions that are no longer on disk. */
  subagentFilesLost: number;
}

function surveyRebuild(db: Database, files: DiscoveredFile[], unreadable: FileFailure[]): RebuildPlan {
  const onDisk = new Set(files.map((file) => file.path));
  const withMainFile = new Set(files.filter((file) => file.kind === "main").map((file) => file.sessionId));
  const sessions = db.query<{ id: string }, []>("SELECT id FROM sessions").all();
  const lostSubagentFiles = [...knownFiles(db).values()].filter((row) => row.kind === "subagent" && withMainFile.has(row.session_id) && !onDisk.has(row.path));
  return {
    transcripts: files.length,
    unreadable,
    sessions: sessions.length,
    sessionsLost: sessions.filter(({ id }) => !withMainFile.has(id)).length,
    subagentFilesLost: lostSubagentFiles.length,
  };
}

/** Walks the transcripts directory and compares it with the database, changing nothing. */
export function planRebuild(db: Database, transcriptsDir: string): RebuildPlan {
  const unreadable: FileFailure[] = [];
  const files = discoverFiles(transcriptsDir, (path, error) => unreadable.push({ path, error }));
  return surveyRebuild(db, files, unreadable);
}

/**
 * Why a rebuild must not be performed; null — it can be. The database is the only copy of old sessions:
 * a rebuild from a directory that is not found, empty or not read completely would erase it for nothing.
 */
export function rebuildBlocker(plan: RebuildPlan): string | null {
  const refused = "Rebuild not performed.";
  if (plan.unreadable.length > 0) return `The transcripts directory was not read completely, unreadable: ${plan.unreadable.map((failure) => failure.path).join(", ")}. ${refused}`;
  if (plan.transcripts === 0 && plan.sessions > 0) return `No transcripts found on disk, but the database has sessions: ${plan.sessions}. ${refused}`;
  return null;
}

// ── Pass ────────────────────────────────────────────────────────────────────────────────────

/** The time of the last line with a timestamp: `prevEventTs` of the next pass over this file. */
function lastEventTs(lines: ParsedLine[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if ("timestamp" in line && line.timestamp !== null) return line.timestamp;
  }
  return null;
}

/**
 * One pass (plan §6.1): walking the directory, reading new lines of each file, tracking vanished
 * files, recalculating the status of running sessions. The transaction is per file: line reducers, the new offset
 * and the derivatives of its session are committed together, so an interrupted pass leaves no loaded
 * lines without totals. `rebuild` first walks the disk and only then clears everything built from
 * transcripts: sessions whose files are no longer on disk are lost in the process.
 */
export function runIndex(deps: IndexDeps, options: { rebuild?: boolean } = {}): IndexResult {
  const { db, config, prices } = deps;
  const now = deps.now();
  const provider = providerFor(config.provider);

  const unreadableDirs: FileFailure[] = [];
  const files = discoverFiles(config.transcriptsDir, (path, error) => unreadableDirs.push({ path, error }));
  if (options.rebuild) {
    const blocker = rebuildBlocker(surveyRebuild(db, files, unreadableDirs));
    if (blocker) throw new Error(blocker);
    clearIndex(db);
  }

  // hooks events accumulated in the spool are accepted at the start of each pass (plan §7.2):
  // at startup and then with each watch pass.
  ingestSpool(db, config.spoolDir);

  const known = knownFiles(db);
  const desktopTitles = loadDesktopTitles(config.desktopSessionsDir);
  const customTitles = new Map<string, string | null>();
  const customTitle = (sessionDir: string): string | null => {
    if (!customTitles.has(sessionDir)) customTitles.set(sessionDir, readCustomTitle(sessionDir));
    return customTitles.get(sessionDir)!;
  };

  const saveFile = db.query(
    `INSERT INTO source_files (path, kind, session_id, agent_id, size, mtime, inode, parsed_offset, last_event_ts, missing_since)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)
     ON CONFLICT (path) DO UPDATE SET
       size = excluded.size, mtime = excluded.mtime, inode = excluded.inode,
       parsed_offset = excluded.parsed_offset, last_event_ts = excluded.last_event_ts, missing_since = NULL`,
  );
  // A session has a transcript as long as its main file is on disk.
  const syncPresent = db.query(
    `UPDATE sessions SET transcript_present =
       EXISTS (SELECT 1 FROM source_files WHERE session_id = ?1 AND kind = 'main' AND missing_since IS NULL)
     WHERE id = ?1`,
  );
  const deriveCtx = (sessionId: string): DeriveContext => ({ db, sessionId, prices, provider, now });
  const derive = (sessionId: string): void => {
    for (const reducer of DERIVED_REDUCERS) reducer(deriveCtx(sessionId));
  };
  const sessionRow = db.query<Record<string, unknown>, [string]>("SELECT * FROM sessions WHERE id = ?");
  const agentRows = db.query<Record<string, unknown>, [string]>("SELECT * FROM agents WHERE session_id = ? ORDER BY agent_id");
  /** Everything reducers change without new lines, and agent linking: the session row and its agents. */
  const snapshot = (sessionId: string): string => JSON.stringify([sessionRow.get(sessionId), agentRows.all(sessionId)]);

  const applied = appliedExternal(db);
  const unknown: UnknownStats = { types: {}, fields: {} };
  const changed = new Set<string>();
  const present = new Set<string>();
  const failures: FileFailure[] = [...unreadableDirs];
  let filesRead = 0;
  let linesParsed = 0;

  /** A pass over one file. An exception is a failure of this file: its transaction is rolled back by the caller. */
  const indexFile = (file: DiscoveredFile): void => {
    const prev = known.get(file.path) ?? null;
    let read: ReadResult;
    try {
      read = readTranscript(file.path, prev && { inode: prev.inode, size: prev.size, parsedOffset: prev.parsed_offset });
    } catch (error) {
      // The file vanished between the walk and the read: tracking of vanished files will mark it.
      if (isMissing(error)) return;
      present.add(file.path);
      throw error;
    }
    present.add(file.path);

    const parsed = read.lines.map(parseLine);
    const lines = parsed.map((result) => result.line);
    const prevEventTs = read.restarted ? null : (prev?.last_event_ts ?? null);
    const ctx: ReduceContext = {
      db,
      sessionId: file.sessionId,
      agentId: file.agentId,
      prices,
      provider,
      prevEventTs,
      agentMeta: file.kind === "subagent" ? readAgentMeta(file.path) : null,
      titles: { customFile: customTitle(file.sessionDir), desktop: desktopTitles.get(file.sessionId) ?? null },
    };

    const returned = prev !== null && prev.missing_since !== null;
    const stateChanged =
      prev === null || returned || prev.size !== read.size || prev.mtime !== read.mtime || prev.inode !== read.inode || prev.parsed_offset !== read.nextOffset;
    // The title and meta.json may appear later than the lines, so a file that already had lines
    // goes through the reducers even with an empty list. A file without a single complete line does not create a session.
    const external = ctx.agentMeta !== null || ctx.titles.customFile !== null || ctx.titles.desktop !== null;
    // The same external data that already went through the reducers in this process is not applied again:
    // otherwise every watch pass would open a transaction for each subagent file.
    const externalKey = JSON.stringify([ctx.agentMeta, ctx.titles]);
    const reapply = lines.length === 0 && external && prev !== null && prev.parsed_offset > 0 && applied.get(file.path) !== externalKey;
    if (lines.length === 0 && !reapply && !stateChanged) return;

    db.exec("BEGIN IMMEDIATE");
    let dataChanged = lines.length > 0;
    if (lines.length > 0) {
      for (const reducer of LINE_REDUCERS) reducer(ctx, lines);
      // Merge — after lines and before derivatives (plan §6.3): it reads the end of the session, while the status and
      // the exact model time are computed from the refined lines.
      mergeEnrichment(db, file.sessionId, provider);
    } else if (reapply) {
      // Comparison — after agent linking: a link computed from calls takes precedence over meta.json,
      // and a discrepancy between them is not a change.
      const before = snapshot(file.sessionId);
      for (const reducer of LINE_REDUCERS) reducer(ctx, lines);
      linkAgents(deriveCtx(file.sessionId));
      dataChanged = before !== snapshot(file.sessionId);
    }
    if (dataChanged || stateChanged) {
      saveFile.run(file.path, file.kind, file.sessionId, file.agentId, read.size, read.mtime, read.inode, read.nextOffset, lastEventTs(lines) ?? prevEventTs);
      syncPresent.run(file.sessionId);
      // Derivatives are idempotent: after the last file of a session they are computed over all of its files.
      if (dataChanged) derive(file.sessionId);
      db.exec("COMMIT");
    } else {
      // A pass without new lines changed nothing: rollback instead of writing the same values.
      db.exec("ROLLBACK");
    }
    if (lines.length > 0 || reapply) applied.set(file.path, externalKey);
    if (dataChanged || returned) changed.add(file.sessionId);

    // Counters grow only for committed files: the lines of a bad file will arrive again.
    for (const result of parsed) countUnknown(unknown, result);
    linesParsed += lines.length;
    if (lines.length > 0) filesRead += 1;
  };

  for (const file of files) {
    try {
      indexFile(file);
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      failures.push({ path: file.path, error });
    }
  }

  // Step 5: a tracked file vanished. The session data stays, only the transcript flag changes.
  // A file under a directory that could not be read has not vanished: nothing is known about it.
  const unseen = (path: string): boolean => unreadableDirs.some((dir) => path.startsWith(dir.path + sep));
  const markMissing = db.query("UPDATE source_files SET missing_since = ? WHERE path = ?");
  db.transaction(() => {
    for (const row of known.values()) {
      if (row.missing_since !== null || present.has(row.path) || unseen(row.path)) continue;
      markMissing.run(now, row.path);
      syncPresent.run(row.session_id);
      changed.add(row.session_id);
    }
  })();

  // An event usually arrives later than the transcript line: sessions with fresh pending events
  // are merged even without file changes.
  const waiting = db
    .query<{ id: string }, [number]>(
      `SELECT session_id AS id FROM otel_events WHERE applied = 0 AND session_id IS NOT NULL AND ts >= ?1
       UNION SELECT session_id FROM hook_events WHERE applied = 0 AND session_id IS NOT NULL AND ts >= ?1`,
    )
    .all(now - PENDING_EVENT_WINDOW_MS);
  for (const { id } of waiting) {
    if (changed.has(id)) continue;
    db.transaction(() => {
      if (!mergeEnrichment(db, id, provider)) return;
      derive(id);
      changed.add(id);
    })();
  }

  // The status is computed as of the pass: for a running session it is recalculated even if its files did not change.
  const status = db.query<{ status: SessionStatus }, [string]>("SELECT status FROM sessions WHERE id = ?");
  for (const { id } of db.query<{ id: string }, []>("SELECT id FROM sessions WHERE status = 'running'").all()) {
    if (changed.has(id)) continue;
    deriveStatus(deriveCtx(id));
    if (status.get(id)!.status !== "running") changed.add(id);
  }
  // A file that vanished or came back without yielding a single line did not create a session.
  const sessionsChanged = [...changed].filter((id) => status.get(id) !== null);

  const result: IndexResult = { filesSeen: files.length, filesRead, linesParsed, sessionsChanged, unknown };
  if (failures.length > 0) throw new IndexError(failures, result);
  return result;
}

/**
 * Runs the parser over all transcripts from the start, writing nothing: counters of the unknown
 * for `torch doctor`. Line content does not leave: only types, field names and numbers.
 * A file or directory that is unreadable is skipped and counted in `unreadable`.
 */
export function scanTranscripts(transcriptsDir: string): { mainFiles: number; subagentFiles: number; lines: number; unreadable: number; unknown: UnknownStats } {
  const scan = { mainFiles: 0, subagentFiles: 0, lines: 0, unreadable: 0, unknown: { types: {}, fields: {} } as UnknownStats };
  const files = discoverFiles(transcriptsDir, () => {
    scan.unreadable += 1;
  });
  for (const file of files) {
    let raw: string[];
    try {
      raw = readTranscript(file.path, null).lines;
    } catch (error) {
      if (!isMissing(error)) scan.unreadable += 1;
      continue;
    }
    if (file.kind === "main") scan.mainFiles += 1;
    else scan.subagentFiles += 1;
    scan.lines += raw.length;
    for (const line of raw) countUnknown(scan.unknown, parseLine(line));
  }
  return scan;
}

// Merging raw OTel and hooks events with transcript data (plan §6.3). Package E2.
//
// An event refines the row written by the transcript reducer and gets `applied = 1`.
// An event whose row does not exist yet stays with `applied = 0` and is applied by the next merge.
// An API error and an instructions load produce a record even without a transcript (source otel and
// hook); when a transcript row about the same thing appears, the event record is folded into it and
// deleted, so the order in which the sources arrive does not affect the result.
import type { Database } from "bun:sqlite";
import { API_ERROR_DEDUP_WINDOW_MS, estimateTokens, MAIN_AGENT_ID } from "../contracts/constants.ts";
import { OTEL_EVENT_NAMES, type HookEventName } from "../contracts/enrich.ts";
import type { Provider } from "../contracts/provider.ts";
import type { ApiErrorRow, InstructionLoadedRow, RawEventRow } from "../contracts/rows.ts";
import { otelNetworkSource } from "./networkSource.ts";

type RawTable = "otel_events" | "hook_events";

interface PendingEvent {
  id: number;
  ts: number;
  attrs: Record<string, unknown>;
}

/** Event rule: true means applied; false means the row does not exist yet and the event waits for the next merge. */
type Rule = (db: Database, sessionId: string, event: PendingEvent) => boolean;

// Attributes of tool and hooks events. Network events are parsed by enrich/networkSource.ts; the parsing
// rules are the same: a number may arrive as a string and is not rounded, an empty string means no value.
function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

interface Timed {
  ts: number;
}

/**
 * One-to-one pairs by ascending distance: the nearest ones pair up first, and each record
 * belongs to at most one pair. `distance` returns null for records that are not a pair.
 */
function matchNearest<L extends Timed, R extends Timed>(left: L[], right: R[], distance: (l: L, r: R) => number | null): [L, R][] {
  const candidates = left.flatMap((l) =>
    right.flatMap((r) => {
      const d = distance(l, r);
      return d === null ? [] : [{ l, r, d }];
    }),
  );
  // The sort is stable: at equal distance the input order of records decides.
  candidates.sort((a, b) => a.d - b.d);
  const taken = new Set<L | R>();
  return candidates.flatMap(({ l, r }): [L, R][] => {
    if (taken.has(l) || taken.has(r)) return [];
    taken.add(l).add(r);
    return [[l, r]];
  });
}

const gap = (a: Timed, b: Timed): number => Math.abs(a.ts - b.ts);

// ── Network events: api_request and api_error ───────────────────────────────────────────────

/**
 * `api_request` → the model call with the same `request_id`: exact duration and request source.
 * `api_error` → a record with source otel. The event does not name an agent: the record belongs to the
 * main one until it is folded into a transcript row (`foldApiErrors`), where the agent is known.
 */
function applyNetworkEvents(db: Database, sessionId: string, _provider: Provider): void {
  const network = otelNetworkSource(db);
  const refineCall = db.query(
    `UPDATE model_calls SET
       duration_ms = COALESCE(?3, duration_ms),
       duration_exact = MAX(duration_exact, ?3 IS NOT NULL),
       query_source = COALESCE(?4, query_source)
     WHERE session_id = ?1 AND id = ?2`,
  );
  const insertError = db.query(
    "INSERT INTO api_errors (session_id, id, agent_id, ts, request_id, status_code, error, attempt, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'otel')",
  );
  const applied: number[] = [];
  for (const event of network.pending(sessionId)) {
    if (event.kind === "api_request") {
      if (refineCall.run(sessionId, event.requestId, event.durationMs, event.querySource).changes === 0) continue;
    } else {
      insertError.run(sessionId, `otel:${event.eventId}`, MAIN_AGENT_ID, event.ts, event.requestId, event.statusCode, event.error, event.attempt);
    }
    applied.push(event.eventId);
  }
  network.markApplied(applied);
}

type ErrorKey = Pick<ApiErrorRow, "id" | "ts" | "request_id" | "status_code" | "attempt">;

/** An attempt number known on both sides must match. */
const sameAttempt = (a: ErrorKey, b: ErrorKey): boolean => a.attempt === null || b.attempt === null || a.attempt === b.attempt;

/**
 * One failed attempt recorded by both the transcript and OTel is one record: the transcript row
 * gets `request_id`, status and attempt number from the event, and the event record is deleted. Records
 * with the same `request_id` pair up first; then those where at least one side has no `request_id`
 * pair with the nearest row in time closer than API_ERROR_DEDUP_WINDOW_MS. A row accepts one event.
 */
function foldApiErrors(db: Database, sessionId: string): void {
  const bySource = db.query<ErrorKey, [string, string]>("SELECT id, ts, request_id, status_code, attempt FROM api_errors WHERE session_id = ? AND source = ? ORDER BY ts, id");
  const fromOtel = bySource.all(sessionId, "otel");
  if (fromOtel.length === 0) return;
  const fromTranscript = bySource.all(sessionId, "transcript");

  const byRequest = matchNearest(fromOtel, fromTranscript, (otel, line) =>
    otel.request_id !== null && otel.request_id === line.request_id && sameAttempt(otel, line) ? gap(otel, line) : null,
  );
  const paired = new Set(byRequest.flat());
  const byTime = matchNearest(
    fromOtel.filter((row) => !paired.has(row)),
    fromTranscript.filter((row) => !paired.has(row)),
    (otel, line) => ((otel.request_id === null || line.request_id === null) && sameAttempt(otel, line) && gap(otel, line) < API_ERROR_DEDUP_WINDOW_MS ? gap(otel, line) : null),
  );

  const fold = db.query(
    `UPDATE api_errors SET request_id = COALESCE(request_id, ?3), status_code = COALESCE(status_code, ?4), attempt = COALESCE(attempt, ?5)
     WHERE session_id = ?1 AND id = ?2`,
  );
  const remove = db.query("DELETE FROM api_errors WHERE session_id = ? AND id = ?");
  for (const [otel, line] of [...byRequest, ...byTime]) {
    fold.run(sessionId, line.id, otel.request_id, otel.status_code, otel.attempt);
    remove.run(sessionId, otel.id);
  }
}

// ── Tool events ─────────────────────────────────────────────────────────────────────────────

/** A tool event → the call with the same `tool_use_id`. Whatever the event lacks stays as in the transcript. */
function refineToolCall(db: Database, sessionId: string, attrs: PendingEvent["attrs"], duration: number | null, decision: unknown, source: unknown): boolean {
  const { changes } = db
    .query(
      `UPDATE tool_calls SET
         duration_ms = COALESCE(?3, duration_ms),
         duration_exact = MAX(duration_exact, ?3 IS NOT NULL),
         permission_decision = COALESCE(?4, permission_decision),
         permission_source = COALESCE(?5, permission_source)
       WHERE session_id = ?1 AND id = ?2`,
    )
    .run(sessionId, str(attrs.tool_use_id), duration, str(decision), str(source));
  return changes > 0;
}

/** `tool_result`: the duration measured by Claude Code takes precedence over the estimate and `toolUseResult.durationMs` (plan §6.2). */
const applyToolResult: Rule = (db, sessionId, { attrs }) => refineToolCall(db, sessionId, attrs, num(attrs.duration_ms), attrs.decision_type, attrs.decision_source);

const applyToolDecision: Rule = (db, sessionId, { attrs }) => refineToolCall(db, sessionId, attrs, null, attrs.decision, attrs.source);

// ── Hooks: instructions ─────────────────────────────────────────────────────────────────────

/**
 * How far a transcript row about a loaded file may be from the hook event about the same
 * load. The delay has not been measured empirically (spikes.md §8 checked only the set of fields). The hook
 * fires at the moment the file is loaded, the row is written with the nearest turn of the same agent; the window
 * equals the threshold after which an idle session counts as a gap (5 minutes): beyond it this is another
 * stretch of work and, more likely, another load of the same file.
 */
const INSTRUCTIONS_PAIR_WINDOW_MS = 5 * 60_000;

/**
 * `InstructionsLoaded` → a record with source hook for the event's agent (without `agent_id`, the main
 * one); the file size was measured when the event was ingested (`file_bytes`).
 */
const applyInstructionsLoaded: Rule = (db, sessionId, { id, ts, attrs }) => {
  const path = str(attrs.file_path);
  // Without a path there is nothing to record, and such an event does not wait for a row.
  if (path === null) return true;
  const bytes = num(attrs.file_bytes);
  db.query(
    `INSERT INTO instructions_loaded (session_id, id, agent_id, ts, file_path, memory_type, load_reason, bytes, tokens_est, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'hook')`,
  ).run(
    sessionId,
    `hook:${id}`,
    str(attrs.agent_id) ?? MAIN_AGENT_ID,
    ts,
    path,
    str(attrs.memory_type),
    str(attrs.load_reason),
    bytes,
    bytes === null ? null : estimateTokens(bytes),
  );
  return true;
};

type InstructionKey = Pick<InstructionLoadedRow, "id" | "agent_id" | "ts" | "file_path" | "memory_type" | "load_reason">;

/**
 * The transcript records a loaded file with its contents but without the load reason (spikes.md §3).
 * A hook record about the same load (same file, same agent, nearest in time within the
 * window) gives the reason to the transcript row and is deleted. A row that already has a reason has
 * got its pair. A hook record without a pair stays: the transcript did not report such a load.
 */
function foldInstructions(db: Database, sessionId: string): void {
  const fromHooks = db
    .query<InstructionKey, [string]>(
      "SELECT id, agent_id, ts, file_path, memory_type, load_reason FROM instructions_loaded WHERE session_id = ? AND source = 'hook' ORDER BY ts, id",
    )
    .all(sessionId);
  if (fromHooks.length === 0) return;
  const fromTranscript = db
    .query<InstructionKey, [string]>(
      `SELECT id, agent_id, ts, file_path, memory_type, load_reason FROM instructions_loaded
       WHERE session_id = ? AND source = 'transcript' AND load_reason IS NULL ORDER BY ts, id`,
    )
    .all(sessionId);
  const pairs = matchNearest(fromHooks, fromTranscript, (hook, line) =>
    hook.file_path === line.file_path && hook.agent_id === line.agent_id && gap(hook, line) <= INSTRUCTIONS_PAIR_WINDOW_MS ? gap(hook, line) : null,
  );

  const fold = db.query("UPDATE instructions_loaded SET load_reason = ?3, memory_type = COALESCE(memory_type, ?4) WHERE session_id = ?1 AND id = ?2");
  const remove = db.query("DELETE FROM instructions_loaded WHERE session_id = ? AND id = ?");
  for (const [hook, line] of pairs) {
    fold.run(sessionId, line.id, hook.load_reason, hook.memory_type);
    remove.run(sessionId, hook.id);
  }
}

// ── Hooks: session end ──────────────────────────────────────────────────────────────────────

const SESSION_END: HookEventName = "SessionEnd";

/**
 * The end reason is the reason of the latest `SessionEnd`, as long as the session has no transcript
 * events after it; otherwise NULL: the session was reopened and continues. Recalculated on every
 * merge from all `SessionEnd` events, whenever they were ingested. reduce/status.ts sets the session
 * status from `end_reason`.
 */
function deriveEndReason(db: Database, sessionId: string, endedAt: number | null): void {
  const last = db
    .query<Pick<RawEventRow, "ts" | "attrs_json">, [string, string]>(
      "SELECT ts, attrs_json FROM hook_events WHERE session_id = ? AND name = ? ORDER BY ts DESC, id DESC LIMIT 1",
    )
    .get(sessionId, SESSION_END);
  const ended = last !== null && (endedAt === null || last.ts >= endedAt);
  // reduce/status.ts learns about the end from a non-empty reason, so an event without a reason gets one of its own.
  const reason = ended ? (str((JSON.parse(last.attrs_json) as PendingEvent["attrs"]).reason) ?? "unknown") : null;
  db.query("UPDATE sessions SET end_reason = ?2 WHERE id = ?1 AND end_reason IS NOT ?2").run(sessionId, reason);
}

// ── Hooks: compactions ──────────────────────────────────────────────────────────────────────

const PRE_COMPACT: HookEventName = "PreCompact";

/**
 * How far a compaction row may be from its `PreCompact`, that is, the maximum
 * compaction duration. Not measured empirically: the checks had no compactions (spikes.md §8).
 * A compaction is one model request, and Claude Code aborts a request after 10 minutes by default
 * (`API_TIMEOUT_MS`). Beyond the window, `PreCompact` counts as the start of a compaction that left no row.
 */
const COMPACTION_WINDOW_MS = 10 * 60_000;

/**
 * The compaction started by a `PreCompact` event at time `preTs`: the first `compactions` row after it
 * within the window. The row is written when the compaction ends and belongs to the nearest
 * `PreCompact` before it: if there is another one between them, this event has no row.
 */
function compactionOf(db: Database, sessionId: string, preTs: number): string | null {
  const row = db
    .query<{ id: string; ts: number }, [string, number, number]>("SELECT id, ts FROM compactions WHERE session_id = ? AND ts BETWEEN ? AND ? ORDER BY ts, id LIMIT 1")
    .get(sessionId, preTs, preTs + COMPACTION_WINDOW_MS);
  if (!row) return null;
  const closer = db
    .query<{ found: 1 }, [string, string, number, number]>("SELECT 1 AS found FROM hook_events WHERE session_id = ? AND name = ? AND ts > ? AND ts <= ? LIMIT 1")
    .get(sessionId, PRE_COMPACT, preTs, row.ts);
  return closer ? null : row.id;
}

// Hooks supplement what the transcript row did not name: values from `compactMetadata` take precedence.

const applyPreCompact: Rule = (db, sessionId, { ts, attrs }) => {
  const id = compactionOf(db, sessionId, ts);
  if (id === null) return false;
  db.query("UPDATE compactions SET trigger = COALESCE(trigger, ?3) WHERE session_id = ?1 AND id = ?2").run(sessionId, id, str(attrs.trigger));
  return true;
};

/** `PostCompact` closes the compaction of the nearest `PreCompact` before it: the time between them is its duration. */
const applyPostCompact: Rule = (db, sessionId, { ts }) => {
  const pre = db
    .query<{ ts: number | null }, [string, string, number, number]>("SELECT MAX(ts) AS ts FROM hook_events WHERE session_id = ? AND name = ? AND ts BETWEEN ? AND ?")
    .get(sessionId, PRE_COMPACT, ts - COMPACTION_WINDOW_MS, ts)!;
  if (pre.ts === null) return false;
  const id = compactionOf(db, sessionId, pre.ts);
  if (id === null) return false;
  if (ts > pre.ts) db.query("UPDATE compactions SET duration_ms = COALESCE(duration_ms, ?3) WHERE session_id = ?1 AND id = ?2").run(sessionId, id, ts - pre.ts);
  return true;
};

// ── Merge ───────────────────────────────────────────────────────────────────────────────────

/** OTel events that refine rows. The network ones among them are read through the network event source. */
const OTEL_RULED: readonly string[] = Object.values(OTEL_EVENT_NAMES);

const TOOL_RULES: Record<string, Rule> = {
  [OTEL_EVENT_NAMES.toolResult]: applyToolResult,
  [OTEL_EVENT_NAMES.toolDecision]: applyToolDecision,
};

// SessionEnd is not here: `deriveEndReason` reads its reason from the event on every merge.
const HOOK_RULES: Partial<Record<HookEventName, Rule>> = {
  InstructionsLoaded: applyInstructionsLoaded,
  PreCompact: applyPreCompact,
  PostCompact: applyPostCompact,
};

const placeholders = (names: readonly string[]): string => names.map(() => "?").join(", ");

/**
 * Marks as applied the events that need no transcript row: service OTel events,
 * `SessionStart` (it carries no `model`, spikes.md §8), `SessionEnd`. Only the events that wait
 * for their row stay pending.
 */
function skipUnruled(db: Database, sessionId: string, table: RawTable, ruled: readonly string[]): void {
  db.query(`UPDATE ${table} SET applied = 1 WHERE applied = 0 AND session_id = ? AND name NOT IN (${placeholders(ruled)})`).run(sessionId, ...ruled);
}

/** Applies the session's pending events with these rules in time order. */
function applyPending(db: Database, sessionId: string, table: RawTable, rules: Partial<Record<string, Rule>>): void {
  const names = Object.keys(rules);
  const events = db
    .query<Pick<RawEventRow, "id" | "ts" | "name" | "attrs_json">, string[]>(
      `SELECT id, ts, name, attrs_json FROM ${table} WHERE applied = 0 AND session_id = ? AND name IN (${placeholders(names)}) ORDER BY ts, id`,
    )
    .all(sessionId, ...names);
  const markApplied = db.query(`UPDATE ${table} SET applied = 1 WHERE id = ?`);
  for (const event of events) {
    const attrs = JSON.parse(event.attrs_json) as PendingEvent["attrs"];
    if (rules[event.name]!(db, sessionId, { id: event.id, ts: event.ts, attrs })) markApplied.run(event.id);
  }
}

const totalChanges = (db: Database): number => db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;

/**
 * Applies events with applied = 0 whose transcript rows already exist. Idempotent.
 * Called after the row reducers and before the derived ones: model time, totals and the session status
 * depend on the refined rows and on `end_reason`. Until the session appears in the database, its events wait.
 * Returns true if the merge changed the session data, in which case its derived data must be recalculated.
 */
export function mergeEnrichment(db: Database, sessionId: string, provider: Provider): boolean {
  return db.transaction((): boolean => {
    const session = db.query<{ ended_at: number | null }, [string]>("SELECT ended_at FROM sessions WHERE id = ?").get(sessionId);
    if (!session) return false;
    skipUnruled(db, sessionId, "otel_events", OTEL_RULED);
    skipUnruled(db, sessionId, "hook_events", Object.keys(HOOK_RULES));
    // Marking events that have no rule does not change session data: it is not counted as a change.
    const before = totalChanges(db);
    applyNetworkEvents(db, sessionId, provider);
    applyPending(db, sessionId, "otel_events", TOOL_RULES);
    applyPending(db, sessionId, "hook_events", HOOK_RULES);
    foldApiErrors(db, sessionId);
    foldInstructions(db, sessionId);
    deriveEndReason(db, sessionId, session.ended_at);
    return totalChanges(db) !== before;
  })();
}

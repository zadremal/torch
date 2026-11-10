// Receiver uptime windows and the session enrichment marker. Package E1.
import type { Database } from "bun:sqlite";
import { RECEIVER_HEARTBEAT_MS } from "../contracts/constants.ts";
import type { DerivedReducer } from "../contracts/pipeline.ts";
import type { Enrichment } from "../contracts/rows.ts";

/**
 * A window whose heartbeat is younger than this counts as open: the receiver is running right now. The
 * margin of one heartbeat covers timer delay while the process is busy with an indexer pass.
 */
const LIVE_WINDOW_MS = 2 * RECEIVER_HEARTBEAT_MS;

/** Opens a receiver uptime window and refreshes it with a heartbeat; returns the stop function. */
export function startReceiverWindow(db: Database, now: () => number): () => void {
  const { id } = db.query<{ id: number }, [number]>("INSERT INTO receiver_windows (started_at, stopped_at) VALUES (?1, ?1) RETURNING id").get(now())!;
  const pulse = db.query("UPDATE receiver_windows SET stopped_at = ? WHERE id = ?");
  // The window end is the time of the last heartbeat: after a crash the window is closed at that point.
  const beat = (): void => void pulse.run(now(), id);
  let timer: ReturnType<typeof setInterval> | null = setInterval(beat, RECEIVER_HEARTBEAT_MS);
  return () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    beat();
  };
}

interface Span {
  start: number;
  end: number;
}

/**
 * Active spans of a session (plan §6.2): from each prompt to the last event before the next one.
 * The rule is the same as for active time in ingest/reduce/durations.ts; there only the sum is computed.
 */
function activeSpans(db: Database, sessionId: string): Span[] {
  const prompts = db.query<{ ts: number }, [string]>("SELECT ts FROM prompts WHERE session_id = ? ORDER BY ts").all(sessionId);
  const events = db
    .query<{ ts: number }, [string]>(
      `SELECT ts_start AS ts FROM model_calls WHERE session_id = ?1
       UNION ALL SELECT ts_end FROM model_calls WHERE session_id = ?1
       UNION ALL SELECT ts_start FROM tool_calls WHERE session_id = ?1
       UNION ALL SELECT ts_end FROM tool_calls WHERE session_id = ?1 AND ts_end IS NOT NULL
       UNION ALL SELECT ts FROM api_errors WHERE session_id = ?1
       UNION ALL SELECT ts FROM compactions WHERE session_id = ?1
       ORDER BY ts`,
    )
    .all(sessionId);
  let e = 0;
  return prompts.map(({ ts: start }, i) => {
    const next = prompts[i + 1]?.ts ?? Number.POSITIVE_INFINITY;
    let end = start;
    for (; e < events.length && events[e]!.ts < next; e++) end = Math.max(end, events[e]!.ts);
    return { start, end };
  });
}

/** Receiver windows without overlaps, ascending. An open window is extended to `now`: its heartbeat lags behind the events of a running session. */
function receiverSpans(db: Database, now: number): Span[] {
  const rows = db.query<Span, []>("SELECT started_at AS start, stopped_at AS end FROM receiver_windows ORDER BY started_at").all();
  const merged: Span[] = [];
  for (const row of rows) {
    const span = now >= row.end && now - row.end <= LIVE_WINDOW_MS ? { start: row.start, end: now } : row;
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** full: every active span lies entirely inside a window; partial: windows touch at least one; none: otherwise, and for a session without prompts. */
function coverage(active: Span[], windows: Span[]): Enrichment {
  const inside = (span: Span) => windows.some((w) => w.start <= span.start && span.end <= w.end);
  const touched = (span: Span) => windows.some((w) => w.start < span.end && span.start < w.end);
  if (active.length > 0 && active.every(inside)) return "full";
  return active.some((span) => inside(span) || touched(span)) ? "partial" : "none";
}

/** Sets sessions.enrichment from how the receiver windows cover the active spans. */
export const deriveEnrichment: DerivedReducer = ({ db, sessionId, now }) => {
  // The receiver may have been running while Claude Code sent nothing (before `torch setup`): without a
  // single event for the session there was nothing to refine it with. The condition on `applied` makes the query use the index.
  const received = db.query("SELECT 1 FROM otel_events WHERE applied IN (0, 1) AND session_id = ? LIMIT 1").get(sessionId) !== null;
  const enrichment = received ? coverage(activeSpans(db, sessionId), receiverSpans(db, now)) : "none";
  db.query("UPDATE sessions SET enrichment = ? WHERE id = ?").run(enrichment, sessionId);
};

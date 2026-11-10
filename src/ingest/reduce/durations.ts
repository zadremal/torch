// Active time and model time of the session, agent work duration (decision 30). Package I3.
import { MAIN_AGENT_ID } from "../../contracts/constants.ts";
import type { DerivedReducer } from "../../contracts/pipeline.ts";

/**
 * Active time (plan §6.2): intervals from each prompt to the last event before the next
 * prompt. An event belongs to the interval of the prompt after which it happened, so the intervals do not
 * overlap and their union is the sum of lengths. Both lists are sorted in ascending order.
 */
function activeMs(prompts: number[], events: number[]): number {
  let total = 0;
  let e = 0;
  prompts.forEach((start, i) => {
    const next = prompts[i + 1] ?? Number.POSITIVE_INFINITY;
    let last = start;
    // Events before the prompt (before the session's first prompt) are skipped: there is no interval for them.
    for (; e < events.length && events[e]! < next; e++) last = Math.max(last, events[e]!);
    total += last - start;
  });
  return total;
}

export const deriveDurations: DerivedReducer = ({ db, sessionId }) => {
  const prompts = db.query<{ ts: number }, [string]>("SELECT ts FROM prompts WHERE session_id = ? ORDER BY ts").all(sessionId);
  // Session events are the starts and ends of all its agents' calls, failed API attempts and compactions.
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
  const active = activeMs(
    prompts.map((row) => row.ts),
    events.map((row) => row.ts),
  );

  // Model time is exact only if the duration of every call is exact; with no calls there is no exact one.
  db.query(
    `UPDATE sessions SET
       active_ms = ?2,
       (model_ms, model_ms_exact) = (
         SELECT COALESCE(SUM(duration_ms), 0), COALESCE(MIN(duration_exact), 0) FROM model_calls WHERE session_id = ?1
       )
     WHERE id = ?1`,
  ).run(sessionId, active);

  // A subagent works from the first to the last row of its file. The main agent's file stretches
  // across all the session's idle periods, so its work time is the session's active time.
  db.query("UPDATE agents SET run_ms = CASE WHEN agent_id = ?2 THEN ?3 ELSE COALESCE(ended_at - started_at, 0) END WHERE session_id = ?1").run(
    sessionId,
    MAIN_AGENT_ID,
    active,
  );
};

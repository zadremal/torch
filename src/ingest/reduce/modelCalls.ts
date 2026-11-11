// Model calls: one record per call key of the provider (plan §6.2). Package I1.
import { SYNTHETIC_MODEL } from "../../contracts/constants.ts";
import type { LineReducer } from "../../contracts/pipeline.ts";
import { callCost } from "./cost.ts";

/**
 * An API response is recorded as several rows with the same call key (`provider.callKey`), one per block, each with its own
 * time, and they can arrive in different passes. So the start of a call (number within the agent, time of the
 * agent's previous event) is written once, by the first row, while the end (usage, stop reason,
 * time) is overwritten by each following row: the final result is in the last one. The duration estimate runs from the previous
 * event to the last row of the response; the exact one, written by enrich/merge.ts, is not touched by a repeat.
 */
const UPSERT = `
  INSERT INTO model_calls (
    session_id, id, agent_id, turn_index, model, ts_start, ts_end, duration_ms, stop_reason,
    tok_input, tok_output, tok_cache_read, tok_cache_write_5m, tok_cache_write_1h, tok_thinking, ctx_tokens, cost_usd
  ) VALUES (
    $session_id, $id, $agent_id, $turn_index, $model, $ts_start, $ts_end, $duration_ms, $stop_reason,
    $tok_input, $tok_output, $tok_cache_read, $tok_cache_write_5m, $tok_cache_write_1h, $tok_thinking, $ctx_tokens, $cost_usd
  )
  ON CONFLICT (session_id, id) DO UPDATE SET
    ts_end = excluded.ts_end,
    duration_ms = CASE WHEN duration_exact = 1 THEN duration_ms ELSE excluded.ts_end - ts_start END,
    stop_reason = excluded.stop_reason,
    tok_input = excluded.tok_input,
    tok_output = excluded.tok_output,
    tok_cache_read = excluded.tok_cache_read,
    tok_cache_write_5m = excluded.tok_cache_write_5m,
    tok_cache_write_1h = excluded.tok_cache_write_1h,
    tok_thinking = excluded.tok_thinking,
    ctx_tokens = excluded.ctx_tokens,
    cost_usd = excluded.cost_usd
  RETURNING turn_index`;

export const reduceModelCalls: LineReducer = ({ db, sessionId, agentId, prices, provider, prevEventTs }, lines) => {
  const upsert = db.query<{ turn_index: number }, Record<string, string | number | null>>(UPSERT);
  let lastTurn = db
    .query<{ turn: number }, [string, string]>("SELECT COALESCE(MAX(turn_index), 0) AS turn FROM model_calls WHERE session_id = ? AND agent_id = ?")
    .get(sessionId, agentId)!.turn;
  // Time of the agent's previous event: the call duration estimate is counted from it.
  let prevTs = prevEventTs;

  for (const line of lines) {
    if (!("timestamp" in line) || line.timestamp === null) continue;
    const ts = line.timestamp;
    const key = line.kind === "assistant" ? provider.callKey(line) : null;
    if (line.kind === "assistant" && key !== null && line.model !== null && line.model !== SYNTHETIC_MODEL && !line.isApiErrorMessage) {
      const tsStart = prevTs !== null && prevTs < ts ? prevTs : ts;
      const usage = line.usage;
      const tokens = {
        input: usage?.inputTokens ?? 0,
        output: usage?.outputTokens ?? 0,
        cacheRead: usage?.cacheReadTokens ?? 0,
        cacheWrite5m: usage?.cacheWrite5mTokens ?? 0,
        cacheWrite1h: usage?.cacheWrite1hTokens ?? 0,
      };
      const row = upsert.get({
        $session_id: sessionId,
        $id: key,
        $agent_id: agentId,
        $turn_index: lastTurn + 1,
        $model: line.model,
        $ts_start: tsStart,
        $ts_end: ts,
        $duration_ms: ts - tsStart,
        $stop_reason: line.stopReason,
        $tok_input: tokens.input,
        $tok_output: tokens.output,
        $tok_cache_read: tokens.cacheRead,
        $tok_cache_write_5m: tokens.cacheWrite5m,
        $tok_cache_write_1h: tokens.cacheWrite1h,
        $tok_thinking: usage?.thinkingTokens ?? 0,
        $ctx_tokens: tokens.input + tokens.cacheRead + (usage?.cacheWriteTokens ?? 0),
        // Priced by the name the price table knows; the stored model stays the reported one.
        $cost_usd: callCost(prices, provider.canonicalModel(line.model), tokens),
      })!;
      // A new record got the next number back, an existing one its previous number.
      lastTurn = Math.max(lastTurn, row.turn_index);
    }
    prevTs = ts;
  }
};

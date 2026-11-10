// Agent and session totals: counters, tokens, cost, model. Package I3.
import { MAIN_AGENT_ID } from "../../contracts/constants.ts";
import type { DerivedReducer } from "../../contracts/pipeline.ts";

/**
 * Agent totals are computed from its call and event rows, session totals as the sum over its agents,
 * so they agree by construction. Cost is NULL if at least one call has it
 * unknown (plan §6.2). Tool errors are only the error status (decision 12).
 * Per-agent indexes are named explicitly: without statistics the planner goes by the primary key, and each
 * agent scans the calls of the whole session.
 */
export const deriveTotals: DerivedReducer = ({ db, sessionId }) => {
  db.query(
    `UPDATE agents SET
       (model_calls, tok_input, tok_output, tok_cache_read, tok_cache_write, tok_thinking, tok_total, cost_usd) = (
         SELECT COUNT(*),
                COALESCE(SUM(tok_input), 0),
                COALESCE(SUM(tok_output), 0),
                COALESCE(SUM(tok_cache_read), 0),
                COALESCE(SUM(tok_cache_write_5m + tok_cache_write_1h), 0),
                COALESCE(SUM(tok_thinking), 0),
                COALESCE(SUM(tok_input + tok_output + tok_cache_read + tok_cache_write_5m + tok_cache_write_1h), 0),
                CASE WHEN COUNT(*) = COUNT(cost_usd) THEN COALESCE(SUM(cost_usd), 0) END
         FROM model_calls c INDEXED BY model_calls_agent WHERE c.session_id = agents.session_id AND c.agent_id = agents.agent_id
       ),
       -- The agent's model is the one with more calls; on a tie, the one used later.
       model = (
         SELECT model FROM model_calls c INDEXED BY model_calls_agent WHERE c.session_id = agents.session_id AND c.agent_id = agents.agent_id
         GROUP BY model ORDER BY COUNT(*) DESC, MAX(ts_start) DESC LIMIT 1
       ),
       (tool_calls, tool_errors) = (
         SELECT COUNT(*), COALESCE(SUM(status = 'error'), 0)
         FROM tool_calls t INDEXED BY tool_calls_agent WHERE t.session_id = agents.session_id AND t.agent_id = agents.agent_id
       ),
       api_errors = (SELECT COUNT(*) FROM api_errors e WHERE e.session_id = agents.session_id AND e.agent_id = agents.agent_id),
       files_read = (
         SELECT COUNT(DISTINCT path) FROM file_ops f
         WHERE f.session_id = agents.session_id AND f.agent_id = agents.agent_id AND f.op = 'read'
       )
     WHERE session_id = ?`,
  ).run(sessionId);

  db.query(
    `UPDATE sessions SET
       (agents_count, model_calls, tool_calls, tool_errors, api_errors,
        tok_input, tok_output, tok_cache_read, tok_cache_write, tok_thinking, tok_total, cost_usd) = (
         SELECT COUNT(*),
                COALESCE(SUM(model_calls), 0),
                COALESCE(SUM(tool_calls), 0),
                COALESCE(SUM(tool_errors), 0),
                COALESCE(SUM(api_errors), 0),
                COALESCE(SUM(tok_input), 0),
                COALESCE(SUM(tok_output), 0),
                COALESCE(SUM(tok_cache_read), 0),
                COALESCE(SUM(tok_cache_write), 0),
                COALESCE(SUM(tok_thinking), 0),
                COALESCE(SUM(tok_total), 0),
                CASE WHEN COUNT(*) = COUNT(cost_usd) THEN COALESCE(SUM(cost_usd), 0) END
         FROM agents WHERE session_id = ?1
       ),
       -- The session's model is the main agent's model.
       primary_model = (SELECT model FROM agents WHERE session_id = ?1 AND agent_id = ?2)
     WHERE id = ?1`,
  ).run(sessionId, MAIN_AGENT_ID);
};

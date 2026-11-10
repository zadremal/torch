// Context window, First / Last / Peak and the breakdown estimate at the peak. Package I3.
import type { Database } from "bun:sqlite";
import type { ContextBreakdownEntry } from "../../contracts/api.ts";
import { MAIN_AGENT_ID, estimateTokens } from "../../contracts/constants.ts";
import type { DerivedReducer } from "../../contracts/pipeline.ts";
import type { AgentRow, ModelCallRow } from "../../contracts/rows.ts";
import { getContent } from "./contents.ts";
import { contextWindow } from "./cost.ts";

type Agent = Pick<AgentRow, "agent_id" | "prompt_content_id">;
type Call = Pick<ModelCallRow, "id" | "model" | "ts_start" | "ts_end" | "ctx_tokens" | "tok_output">;

/**
 * Estimate of the context breakdown at the peak call (plan §6.2). The sum of the categories equals `ctx_tokens`
 * of the peak: "System and tools" and "Instructions" are capped by it from above, the remainder is split between
 * "Messages" and "Tool results" without rounding loss.
 *
 * Message volume is measured in tokens: model output (text, thinking and tool inputs) by its
 * output tokens, user messages by an estimate; tool result volume by an estimate
 * from the output size.
 */
function breakdown(db: Database, sessionId: string, agent: Agent, calls: Call[], peakIndex: number): ContextBreakdownEntry[] {
  const first = calls[0]!;
  const peak = calls[peakIndex]!;
  const isMain = agent.agent_id === MAIN_AGENT_ID;
  const sum = (sql: string, ...bounds: number[]) =>
    db.query<{ total: number }, [string, string, ...number[]]>(sql).get(sessionId, agent.agent_id, ...bounds)!.total;

  // The agent's task: the session's first prompt for the main agent, the task text for a subagent.
  const task = isMain
    ? (db.query<{ tokens_est: number }, [string]>("SELECT tokens_est FROM prompts WHERE session_id = ? ORDER BY seq LIMIT 1").get(sessionId)?.tokens_est ?? 0)
    : estimateTokens(agent.prompt_content_id === null ? 0 : (getContent(db, agent.prompt_content_id)?.bytes ?? 0));

  // The call's context holds the instructions loaded before the end of its reply: while the model is replying, files are not
  // loaded. A file loaded again (after compaction, from hooks and from the transcript) is counted once.
  const instructionsBy = (ts: number) =>
    sum(
      `SELECT COALESCE(SUM(tokens), 0) AS total FROM (
         SELECT MAX(tokens_est) AS tokens FROM instructions_loaded WHERE session_id = ? AND agent_id = ? AND ts <= ? GROUP BY file_path
       )`,
      ts,
    );

  // The volume is counted from the last compaction to the start of the peak call; 0 means there were no compactions.
  const since = sum("SELECT COALESCE(MAX(ts), 0) AS total FROM compactions WHERE session_id = ? AND agent_id = ? AND ts <= ?", peak.ts_start);
  const modelOutput = calls
    .slice(0, peakIndex)
    .filter((call) => call.ts_end > since)
    .reduce((total, call) => total + call.tok_output, 0);
  const userInput = isMain
    ? db
        .query<{ total: number }, [string, number, number]>("SELECT COALESCE(SUM(tokens_est), 0) AS total FROM prompts WHERE session_id = ? AND ts > ? AND ts <= ?")
        .get(sessionId, since, peak.ts_start)!.total
    : since === 0
      ? task
      : 0;
  const messagesVolume = modelOutput + userInput;
  // The index is named explicitly: without statistics the planner goes by the primary key and scans the calls of the whole session.
  const toolResultsVolume = estimateTokens(
    sum(
      "SELECT COALESCE(SUM(output_bytes), 0) AS total FROM tool_calls INDEXED BY tool_calls_agent WHERE session_id = ? AND agent_id = ? AND ts_end > ? AND ts_end <= ?",
      since,
      peak.ts_start,
    ),
  );

  const systemTools = Math.max(0, first.ctx_tokens - task - instructionsBy(first.ts_end));
  const instructions = Math.min(instructionsBy(peak.ts_end), peak.ctx_tokens - systemTools);
  const rest = peak.ctx_tokens - systemTools - instructions;
  // Nothing to compare (peak on the first call with no task): the whole remainder belongs to messages.
  const volume = messagesVolume + toolResultsVolume;
  const toolResults = volume > 0 ? Math.round((rest * toolResultsVolume) / volume) : 0;
  return [
    { category: "system_tools", tokens: systemTools },
    { category: "instructions", tokens: instructions },
    { category: "messages", tokens: rest - toolResults },
    { category: "tool_results", tokens: toolResults },
  ];
}

export const deriveContext: DerivedReducer = ({ db, sessionId, prices }) => {
  const agents = db.query<Agent, [string]>("SELECT agent_id, prompt_content_id FROM agents WHERE session_id = ?").all(sessionId);
  const callsOf = db.query<Call, [string, string]>(
    "SELECT id, model, ts_start, ts_end, ctx_tokens, tok_output FROM model_calls WHERE session_id = ? AND agent_id = ? ORDER BY ts_start, turn_index",
  );
  // The breakdown is always an estimate (decision 16): no source has an exact one.
  const update = db.query<null, [number | null, number | null, number | null, number | null, string | null, string | null, string, string]>(
    `UPDATE agents SET ctx_window = ?, ctx_first = ?, ctx_last = ?, ctx_peak = ?, ctx_peak_call_id = ?, ctx_breakdown_json = ?, ctx_breakdown_exact = 0
     WHERE session_id = ? AND agent_id = ?`,
  );

  for (const agent of agents) {
    const calls = callsOf.all(sessionId, agent.agent_id);
    if (calls.length === 0) {
      update.run(null, null, null, null, null, null, sessionId, agent.agent_id);
      continue;
    }
    // The peak is the first of the calls with the largest context.
    let peakIndex = 0;
    calls.forEach((call, i) => {
      if (call.ctx_tokens > calls[peakIndex]!.ctx_tokens) peakIndex = i;
    });
    const peak = calls[peakIndex]!;
    update.run(
      // The window is by the peak call's model; a context larger than the window raises it to the next known size.
      contextWindow(prices, peak.model, peak.ctx_tokens),
      calls[0]!.ctx_tokens,
      calls.at(-1)!.ctx_tokens,
      peak.ctx_tokens,
      peak.id,
      JSON.stringify(breakdown(db, sessionId, agent, calls, peakIndex)),
      sessionId,
      agent.agent_id,
    );
  }
};

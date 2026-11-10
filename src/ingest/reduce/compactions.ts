// Compactions from system/compact_boundary rows. Package I1.
import type { LineReducer } from "../../contracts/pipeline.ts";

// A transcript row does not change, so a repeat writes nothing: the record could have been refined by enrich/merge.ts.
const INSERT = `
  INSERT INTO compactions (session_id, id, agent_id, ts, trigger, pre_tokens, post_tokens, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (session_id, id) DO NOTHING`;

export const reduceCompactions: LineReducer = ({ db, sessionId, agentId }, lines) => {
  const insert = db.query(INSERT);
  for (const line of lines) {
    if (line.kind !== "compact_boundary" || line.uuid === null || line.timestamp === null) continue;
    insert.run(sessionId, line.uuid, agentId, line.timestamp, line.trigger, line.preTokens, line.postTokens, line.durationMs);
  }
};

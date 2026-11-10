// API errors: failed attempts with a retry (system/api_error rows) and final failures
// (assistant rows with isApiErrorMessage, which have an HTTP status). Package I1.
import type { LineReducer } from "../../contracts/pipeline.ts";

// A transcript row does not change, so a repeat writes nothing: the record could have been refined by enrich/merge.ts.
const INSERT = `
  INSERT INTO api_errors (session_id, id, agent_id, ts, request_id, status_code, error, attempt, max_retries, retry_in_ms, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'transcript')
  ON CONFLICT (session_id, id) DO NOTHING`;

export const reduceApiErrors: LineReducer = ({ db, sessionId, agentId }, lines) => {
  const insert = db.query(INSERT);
  for (const line of lines) {
    if (line.kind === "api_error" && line.uuid !== null && line.timestamp !== null) {
      insert.run(sessionId, line.uuid, agentId, line.timestamp, null, line.statusCode, line.error, line.retryAttempt, line.maxRetries, line.retryInMs);
    } else if (line.kind === "assistant" && line.isApiErrorMessage && line.uuid !== null && line.timestamp !== null) {
      insert.run(sessionId, line.uuid, agentId, line.timestamp, line.requestId, line.apiErrorStatus, line.apiError ?? "", null, null, null);
    }
  }
};

// Session status: running or completed. Package I3.
import { RUNNING_WINDOW_MS } from "../../contracts/constants.ts";
import type { DerivedReducer } from "../../contracts/pipeline.ts";

/**
 * Running if the last session event (`ended_at`) is younger than RUNNING_WINDOW_MS and SessionEnd has not
 * arrived; otherwise completed (plan §6.2). SessionEnd is indicated by `end_reason`: it is written by the
 * enrichment merge.
 */
export const deriveStatus: DerivedReducer = ({ db, sessionId, now }) => {
  db.query(
    `UPDATE sessions SET status =
       CASE WHEN end_reason IS NULL AND ended_at IS NOT NULL AND ?2 - ended_at < ?3 THEN 'running' ELSE 'completed' END
     WHERE id = ?1`,
  ).run(sessionId, now, RUNNING_WINDOW_MS);
};

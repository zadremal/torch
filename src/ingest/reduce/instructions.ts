// Loaded instructions from transcript rows. Package I2.
import { estimateTokens } from "../../contracts/constants.ts";
import type { LineReducer } from "../../contracts/pipeline.ts";

export const reduceInstructions: LineReducer = (ctx, lines) => {
  // The transcript does not name the load reason (`load_reason`): it is filled in by the merge with hooks,
  // so a repeated write of the row does not touch this column.
  const upsert = ctx.db.query<null, [string, string, string, number, string, string | null, number, number]>(
    `INSERT INTO instructions_loaded (session_id, id, agent_id, ts, file_path, memory_type, bytes, tokens_est, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'transcript')
     ON CONFLICT (session_id, id) DO UPDATE SET
       agent_id = excluded.agent_id,
       ts = excluded.ts,
       file_path = excluded.file_path,
       memory_type = COALESCE(excluded.memory_type, memory_type),
       bytes = excluded.bytes,
       tokens_est = excluded.tokens_est`,
  );
  for (const line of lines) {
    if (line.kind !== "instructions" || line.uuid === null || line.timestamp === null) continue;
    for (const [index, file] of line.files.entries()) {
      upsert.run(
        ctx.sessionId,
        `${line.uuid}:${index}`,
        ctx.agentId,
        line.timestamp,
        file.path,
        file.memoryType,
        file.bytes,
        estimateTokens(file.bytes),
      );
    }
  }
};

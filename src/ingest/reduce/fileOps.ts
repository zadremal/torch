// File operations from Read, Edit and Write calls: one record per call. Package I1.
import type { LineReducer } from "../../contracts/pipeline.ts";
import type { FileOp, ToolCallRow } from "../../contracts/rows.ts";
import { toolEvents } from "./toolCalls.ts";

const OPS = new Map<string, FileOp>([
  ["Read", "read"],
  ["Edit", "edit"],
  ["Write", "write"],
]);

const INSERT = `
  INSERT INTO file_ops (session_id, id, agent_id, tool_call_id, path, op, ts, lines_added, lines_removed)
  VALUES (?1, ?2, ?3, ?2, ?4, ?5, ?6, ?7, ?8)
  ON CONFLICT (session_id, id) DO`;

/**
 * Runs after toolCalls and reads its table. The call row creates a record with the path from the input;
 * the result row rewrites it: the path from the structured result if there is one, and the changed
 * lines counted by toolCalls.
 */
export const reduceFileOps: LineReducer = ({ db, sessionId }, lines) => {
  const find = db.query<Pick<ToolCallRow, "name" | "agent_id" | "target" | "ts_start" | "lines_added" | "lines_removed">, [string, string]>(
    "SELECT name, agent_id, target, ts_start, lines_added, lines_removed FROM tool_calls WHERE session_id = ? AND id = ?",
  );
  const add = db.query(`${INSERT} NOTHING`);
  const set = db.query(`${INSERT} UPDATE SET path = excluded.path, lines_added = excluded.lines_added, lines_removed = excluded.lines_removed`);

  for (const { id, result } of toolEvents(lines)) {
    const call = find.get(sessionId, id);
    const op = call && OPS.get(call.name);
    const path = result?.filePath ?? call?.target;
    if (!call || !op || path == null) continue;
    (result === undefined ? add : set).run(sessionId, id, call.agent_id, path, op, call.ts_start, call.lines_added, call.lines_removed);
  }
};

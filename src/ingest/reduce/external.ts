// External requests from WebFetch and WebSearch calls: one record per call. Package I1.
import type { LineReducer } from "../../contracts/pipeline.ts";
import type { ExternalKind, ToolCallRow } from "../../contracts/rows.ts";
import { toolEvents } from "./toolCalls.ts";

const KINDS = new Map<string, ExternalKind>([
  ["WebFetch", "web_fetch"],
  ["WebSearch", "web_search"],
]);

const INSERT = `
  INSERT INTO external_requests (session_id, id, agent_id, tool_call_id, kind, url, status_code, bytes, duration_ms, ts)
  VALUES (?1, ?2, ?3, ?2, ?4, ?5, ?6, ?7, ?8, ?9)
  ON CONFLICT (session_id, id) DO`;

/**
 * Runs after toolCalls and reads its table. The call row creates a record with the address from the input;
 * the result row rewrites it. Without a structured result the address stays from the input,
 * the duration is taken from the tool call, the status and size are unknown.
 */
export const reduceExternal: LineReducer = ({ db, sessionId }, lines) => {
  const find = db.query<Pick<ToolCallRow, "name" | "agent_id" | "target" | "ts_start" | "duration_ms">, [string, string]>(
    "SELECT name, agent_id, target, ts_start, duration_ms FROM tool_calls WHERE session_id = ? AND id = ?",
  );
  const add = db.query(`${INSERT} NOTHING`);
  const set = db.query(
    `${INSERT} UPDATE SET url = excluded.url, status_code = excluded.status_code, bytes = excluded.bytes, duration_ms = excluded.duration_ms`,
  );

  for (const { id, result } of toolEvents(lines)) {
    const call = find.get(sessionId, id);
    const kind = call && KINDS.get(call.name);
    if (!call || !kind) continue;
    const fetch = result?.webFetch;
    const search = result?.webSearch;
    const searchMs = search?.durationSeconds == null ? null : Math.round(search.durationSeconds * 1000);
    (result === undefined ? add : set).run(
      sessionId, id, call.agent_id, kind,
      fetch?.url ?? search?.query ?? call.target,
      fetch?.code ?? null,
      fetch?.bytes ?? null,
      fetch?.durationMs ?? searchMs ?? call.duration_ms,
      call.ts_start,
    );
  }
};

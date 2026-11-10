// Normalized session as JSON: database rows as they are. Package A1.
import type { Database } from "bun:sqlite";
import type { SessionExport } from "../contracts/api.ts";
import { type Handler, notFound } from "./context.ts";
import { agentsInTreeOrder, getSessionRow, promptsWithText } from "./sessions.ts";

/** Session event tables: their rows go into the export whole, by time. */
type EventTable = "model_calls" | "tool_calls" | "file_ops" | "external_requests" | "api_errors" | "messages" | "compactions" | "instructions_loaded";

function eventRows<Row>(db: Database, table: EventTable, timeColumn: "ts" | "ts_start", sessionId: string): Row[] {
  return db.query<Row, [string]>(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY ${timeColumn}, id`).all(sessionId);
}

export const exportSession: Handler = (c) => {
  const db = c.get("db");
  const id = c.req.param("id") ?? "";
  const session = getSessionRow(db, id);
  if (!session) return notFound(c, `session ${id}`);

  return c.json<SessionExport>({
    exportedAt: c.get("now")(),
    session,
    agents: agentsInTreeOrder(db, id),
    prompts: promptsWithText(db, id),
    modelCalls: eventRows(db, "model_calls", "ts_start", id),
    toolCalls: eventRows(db, "tool_calls", "ts_start", id),
    fileOps: eventRows(db, "file_ops", "ts", id),
    externalRequests: eventRows(db, "external_requests", "ts", id),
    apiErrors: eventRows(db, "api_errors", "ts", id),
    messages: eventRows(db, "messages", "ts", id),
    compactions: eventRows(db, "compactions", "ts", id),
    instructions: eventRows(db, "instructions_loaded", "ts", id),
  });
};

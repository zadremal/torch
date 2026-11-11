// Tool calls: link between tool_use and tool_result, status, target, duration. Package I1.
import type { Database } from "bun:sqlite";
import type { ParsedLine, ToolResultBlock, ToolUseResultInfo, UserLine } from "../../contracts/lines.ts";
import type { LineReducer } from "../../contracts/pipeline.ts";
import type { ToolCallRow, ToolStatus } from "../../contracts/rows.ts";
import { PERMISSION_REJECT, PERMISSION_SOURCE_USER_PREFIX, TOOL_DENIAL_USER } from "../../contracts/constants.ts";
import { countLines } from "../parse.ts";
import { getContent, putContent } from "./contents.ts";

/**
 * What the rows report about calls, in order of recording: a call row (`result` not set) or a
 * result row (`result` is its structured result; null if there is none, as in subagent files).
 * fileOps and external maintain their tables from these events.
 */
export interface ToolEvent {
  id: string;
  result?: ToolUseResultInfo | null;
}

export function toolEvents(lines: ParsedLine[]): ToolEvent[] {
  return lines.flatMap((line): ToolEvent[] => {
    if (line.kind === "assistant") return line.blocks.flatMap((block) => (block.type === "tool_use" ? [{ id: block.id }] : []));
    if (line.kind === "user") return line.toolResults.map((result) => ({ id: result.toolUseId, result: line.toolUseResult }));
    return [];
  });
}

function field(input: unknown, name: string): string | null {
  const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>)[name] : undefined;
  return typeof value === "string" ? value : null;
}

function firstLine(text: string): string | null {
  return text.trim().split("\n", 1)[0]!.trimEnd() || null;
}

/** Call target from the input: file path, first line of a command, URL, search pattern, query text, subagent task description. */
function target(input: unknown): string | null {
  const command = field(input, "command");
  return (
    field(input, "file_path") ??
    (command === null ? null : firstLine(command)) ??
    field(input, "url") ??
    field(input, "pattern") ??
    field(input, "query") ??
    field(input, "description")
  );
}

/** Server name for tools of the form `mcp__<server>__<tool>`. */
function mcpServer(name: string): string | null {
  return /^mcp__(.+?)__/.exec(name)?.[1] ?? null;
}

function isDenial(line: UserLine): boolean {
  return line.toolDenialKind !== null || line.permissionDecision?.decision === PERMISSION_REJECT;
}

/** The user rejected the call; otherwise it was blocked by a permission rule, auto mode, a hook or another app. */
function isUserRejection(line: UserLine): boolean {
  return line.toolDenialKind === TOOL_DENIAL_USER || (line.permissionDecision?.source?.startsWith(PERMISSION_SOURCE_USER_PREFIX) ?? false);
}

/**
 * Denial outranks interruption, interruption outranks error: the result of a denied call is also marked `is_error`.
 * Only the user's rejection is the neutral denied; a call blocked by anything else failed (decision 12).
 */
function resultStatus(line: UserLine, result: ToolResultBlock): ToolStatus {
  if (isDenial(line)) return isUserRejection(line) ? "denied" : "error";
  if (line.toolUseResult?.interrupted) return "interrupted";
  return result.isError ? "error" : "ok";
}

/** Estimate of changed lines from the input, for calls without a structured result (plan §6.2). */
function estimateLines(db: Database, call: Pick<ToolCallRow, "name" | "input_content_id">): { added: number; removed: number } | null {
  if ((call.name !== "Edit" && call.name !== "Write") || call.input_content_id === null) return null;
  const input: unknown = JSON.parse(getContent(db, call.input_content_id)!.text);
  if (call.name === "Write") return { added: countLines(field(input, "content") ?? ""), removed: 0 };
  return { added: countLines(field(input, "new_string") ?? ""), removed: countLines(field(input, "old_string") ?? "") };
}

// A call row does not change, so a repeat writes nothing and does not reset a result that already arrived.
const INSERT = `
  INSERT INTO tool_calls (session_id, id, agent_id, model_call_id, turn_index, name, mcp_server, target, ts_start, input_content_id, input_bytes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (session_id, id) DO NOTHING`;

// The exact duration and the permission decision may already have been written by enrich/merge.ts: a repeat does not overwrite them.
const FINISH = `
  UPDATE tool_calls SET
    ts_end = $ts_end,
    duration_ms = CASE WHEN duration_exact = 1 THEN duration_ms ELSE $duration_ms END,
    duration_exact = MAX(duration_exact, $duration_exact),
    status = $status,
    error_title = $error_title,
    permission_decision = COALESCE(permission_decision, $permission_decision),
    permission_source = COALESCE(permission_source, $permission_source),
    spawned_agent_id = $spawned_agent_id,
    output_content_id = $output_content_id,
    output_bytes = $output_bytes,
    lines_added = $lines_added,
    lines_removed = $lines_removed
  WHERE session_id = $session_id AND id = $id`;

export const reduceToolCalls: LineReducer = ({ db, sessionId, agentId, provider }, lines) => {
  const turnOf = db.query<{ turn_index: number }, [string, string]>("SELECT turn_index FROM model_calls WHERE session_id = ? AND id = ?");
  const insert = db.query(INSERT);
  const find = db.query<Pick<ToolCallRow, "name" | "ts_start" | "input_content_id">, [string, string]>(
    "SELECT name, ts_start, input_content_id FROM tool_calls WHERE session_id = ? AND id = ?",
  );
  const finish = db.query(FINISH);

  for (const line of lines) {
    if (line.kind === "assistant" && line.timestamp !== null) {
      const callId = provider.callKey(line);
      for (const block of line.blocks) {
        if (block.type !== "tool_use") continue;
        const input = JSON.stringify(block.input ?? {}, null, 2);
        const turn = callId === null ? null : (turnOf.get(sessionId, callId)?.turn_index ?? null);
        insert.run(
          sessionId, block.id, agentId, callId, turn, block.name, mcpServer(block.name), target(block.input),
          line.timestamp, putContent(db, input), Buffer.byteLength(input),
        );
      }
    } else if (line.kind === "user") {
      for (const result of line.toolResults) {
        const call = find.get(sessionId, result.toolUseId);
        if (!call) continue;
        const info = line.toolUseResult;
        const status = resultStatus(line, result);
        // Changed lines: from the structured result; without it, for a successful call, an estimate from the input.
        const changed =
          info?.linesAdded != null || info?.linesRemoved != null
            ? { added: info.linesAdded, removed: info.linesRemoved }
            : status === "ok"
              ? estimateLines(db, call)
              : null;
        finish.run({
          $session_id: sessionId,
          $id: result.toolUseId,
          $ts_end: line.timestamp,
          // Duration from the result is measured; the difference between row times is an estimate.
          $duration_ms: info?.durationMs ?? (line.timestamp === null ? null : Math.max(0, line.timestamp - call.ts_start)),
          $duration_exact: info?.durationMs != null ? 1 : 0,
          $status: status,
          $error_title: result.isError || status === "error" ? firstLine(result.text) : null,
          // A denial without permissionDecision is still a denial; its kind stands in for the source.
          $permission_decision: line.permissionDecision?.decision ?? (isDenial(line) ? PERMISSION_REJECT : null),
          $permission_source: line.permissionDecision?.source ?? line.toolDenialKind,
          $spawned_agent_id: info?.agentId ?? null,
          $output_content_id: putContent(db, result.text),
          $output_bytes: Buffer.byteLength(result.text),
          $lines_added: changed?.added ?? null,
          $lines_removed: changed?.removed ?? null,
        });
      }
    }
  }
};

// Filling the database with rows for API tests and derivatives. Each function inserts one row:
// only the keys are required, the other columns get defaults. Example data is written right
// in the test (plan §4.2):
//
//   const db = openMemoryDb();
//   seed.session(db, { id: "s1", name: "Fix the bug", tool_calls: 3 });
//   seed.toolCall(db, { session_id: "s1", id: "t1", name: "Bash", status: "error" });

import type { Database } from "bun:sqlite";
import { MAIN_AGENT_ID } from "../../src/contracts/constants.ts";
import type {
  AgentRow,
  ApiErrorRow,
  CompactionRow,
  ExternalRequestRow,
  FileOpRow,
  InstructionLoadedRow,
  MessageRow,
  ModelCallRow,
  PromptRow,
  RawEventRow,
  ReceiverWindowRow,
  SessionRow,
  SourceFileRow,
  ToolCallRow,
} from "../../src/contracts/rows.ts";
import { putContent } from "../../src/ingest/reduce/contents.ts";

/** Default time for rows without an explicit time. */
export const SEED_TIME = Date.UTC(2026, 9, 1, 10, 0, 0);

type SqlValue = string | number | null | Uint8Array;

/** Inserts a row into a table; field names are column names. */
export function insertRow(db: Database, table: string, row: object): void {
  const columns = Object.keys(row);
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  db.query(sql).run(...(Object.values(row) as SqlValue[]));
}

const ZERO_TOKENS = { tok_input: 0, tok_output: 0, tok_cache_read: 0, tok_cache_write: 0, tok_thinking: 0, tok_total: 0 };

type Keys<Row, K extends keyof Row> = Partial<Row> & Pick<Row, K>;

function session(db: Database, row: Keys<SessionRow, "id">): SessionRow {
  const full: SessionRow = {
    source: "local",
    cwd: "/Users/dev/code/example",
    project: "example",
    is_temp_dir: 0,
    name: `Session ${row.id}`,
    name_lower: null,
    name_source: "prompt",
    entrypoint: "claude-desktop",
    cc_version: "2.1.321",
    git_branch: "main",
    primary_model: "claude-opus-5-5",
    started_at: SEED_TIME,
    ended_at: (row.started_at ?? SEED_TIME) + (row.active_ms ?? 60_000),
    active_ms: 60_000,
    model_ms: 0,
    model_ms_exact: 0,
    status: "completed",
    end_reason: null,
    agents_count: 1,
    model_calls: 0,
    tool_calls: 0,
    tool_errors: 0,
    api_errors: 0,
    ...ZERO_TOKENS,
    cost_usd: 0,
    cost_reported_usd: null,
    enrichment: "none",
    transcript_present: 1,
    ...row,
  };
  if (row.name_lower === undefined) full.name_lower = full.name?.toLowerCase() ?? null;
  insertRow(db, "sessions", full);
  return full;
}

function agent(db: Database, row: Keys<AgentRow, "session_id">): AgentRow {
  const full: AgentRow = {
    agent_id: MAIN_AGENT_ID,
    parent_agent_id: null,
    depth: 0,
    spawn_tool_call_id: null,
    type: null,
    description: null,
    model: "claude-opus-5-5",
    started_at: SEED_TIME,
    ended_at: SEED_TIME + 60_000,
    run_ms: 60_000,
    model_calls: 0,
    tool_calls: 0,
    tool_errors: 0,
    api_errors: 0,
    files_read: 0,
    ...ZERO_TOKENS,
    cost_usd: 0,
    ctx_window: 200_000,
    ctx_first: null,
    ctx_last: null,
    ctx_peak: null,
    ctx_peak_call_id: null,
    ctx_breakdown_json: null,
    ctx_breakdown_exact: 0,
    prompt_content_id: null,
    ...row,
  };
  insertRow(db, "agents", full);
  return full;
}

/** `text` is put into contents if `content_id` is not set. */
function prompt(db: Database, row: Keys<PromptRow, "session_id" | "id"> & { text?: string }): PromptRow {
  const { text = "Prompt text", ...rest } = row;
  const full: PromptRow = {
    ts: SEED_TIME,
    seq: 0,
    kind: "original",
    content_id: rest.content_id ?? putContent(db, text),
    tokens_est: Math.ceil(text.length / 4),
    attachments_json: null,
    ...rest,
  };
  insertRow(db, "prompts", full);
  return full;
}

function modelCall(db: Database, row: Keys<ModelCallRow, "session_id" | "id">): ModelCallRow {
  const tsStart = row.ts_start ?? SEED_TIME;
  const duration = row.duration_ms ?? 1000;
  const full: ModelCallRow = {
    agent_id: MAIN_AGENT_ID,
    turn_index: 1,
    model: "claude-opus-5-5",
    ts_start: tsStart,
    ts_end: tsStart + duration,
    duration_ms: duration,
    duration_exact: 0,
    stop_reason: "end_turn",
    tok_input: 0,
    tok_output: 0,
    tok_cache_read: 0,
    tok_cache_write_5m: 0,
    tok_cache_write_1h: 0,
    tok_thinking: 0,
    ctx_tokens: (row.tok_input ?? 0) + (row.tok_cache_read ?? 0) + (row.tok_cache_write_5m ?? 0) + (row.tok_cache_write_1h ?? 0),
    cost_usd: 0,
    query_source: null,
    ...row,
  };
  insertRow(db, "model_calls", full);
  return full;
}

/** `input` and `output` are put into contents if the content identifiers are not set. */
function toolCall(db: Database, row: Keys<ToolCallRow, "session_id" | "id"> & { input?: string; output?: string }): ToolCallRow {
  const { input, output, ...rest } = row;
  const tsStart = rest.ts_start ?? SEED_TIME;
  const duration = rest.duration_ms === undefined ? 100 : rest.duration_ms;
  const full: ToolCallRow = {
    agent_id: MAIN_AGENT_ID,
    model_call_id: null,
    turn_index: null,
    name: "Read",
    mcp_server: null,
    target: null,
    ts_start: tsStart,
    ts_end: duration === null ? null : tsStart + duration,
    duration_ms: duration,
    duration_exact: 0,
    status: "ok",
    error_title: null,
    permission_decision: null,
    permission_source: null,
    spawned_agent_id: null,
    input_content_id: input === undefined ? null : putContent(db, input),
    output_content_id: output === undefined ? null : putContent(db, output),
    input_bytes: input === undefined ? null : Buffer.byteLength(input),
    output_bytes: output === undefined ? null : Buffer.byteLength(output),
    lines_added: null,
    lines_removed: null,
    ...rest,
  };
  insertRow(db, "tool_calls", full);
  return full;
}

function fileOp(db: Database, row: Keys<FileOpRow, "session_id" | "tool_call_id" | "path">): FileOpRow {
  const full: FileOpRow = {
    id: row.tool_call_id,
    agent_id: MAIN_AGENT_ID,
    op: "read",
    ts: SEED_TIME,
    lines_added: null,
    lines_removed: null,
    ...row,
  };
  insertRow(db, "file_ops", full);
  return full;
}

function externalRequest(db: Database, row: Keys<ExternalRequestRow, "session_id" | "tool_call_id">): ExternalRequestRow {
  const full: ExternalRequestRow = {
    id: row.tool_call_id,
    agent_id: MAIN_AGENT_ID,
    kind: "web_fetch",
    url: "https://example.com/",
    status_code: 200,
    bytes: 1024,
    duration_ms: 500,
    ts: SEED_TIME,
    ...row,
  };
  insertRow(db, "external_requests", full);
  return full;
}

function apiError(db: Database, row: Keys<ApiErrorRow, "session_id" | "id">): ApiErrorRow {
  const full: ApiErrorRow = {
    agent_id: MAIN_AGENT_ID,
    ts: SEED_TIME,
    request_id: null,
    status_code: 529,
    error: "Overloaded",
    attempt: 1,
    max_retries: 10,
    retry_in_ms: 1000,
    source: "transcript",
    ...row,
  };
  insertRow(db, "api_errors", full);
  return full;
}

/** `text` is put into contents if `content_id` is not set. */
function message(db: Database, row: Keys<MessageRow, "session_id" | "id"> & { text?: string }): MessageRow {
  const { text = "Message text", ...rest } = row;
  const full: MessageRow = {
    agent_id: MAIN_AGENT_ID,
    model_call_id: null,
    ts: SEED_TIME,
    kind: "text",
    content_id: rest.content_id ?? putContent(db, text),
    ...rest,
  };
  insertRow(db, "messages", full);
  return full;
}

function instruction(db: Database, row: Keys<InstructionLoadedRow, "session_id" | "id" | "file_path">): InstructionLoadedRow {
  const full: InstructionLoadedRow = {
    agent_id: MAIN_AGENT_ID,
    ts: SEED_TIME,
    memory_type: "Project",
    load_reason: null,
    bytes: 4096,
    tokens_est: 1024,
    source: "transcript",
    ...row,
  };
  insertRow(db, "instructions_loaded", full);
  return full;
}

function compaction(db: Database, row: Keys<CompactionRow, "session_id" | "id">): CompactionRow {
  const full: CompactionRow = {
    agent_id: MAIN_AGENT_ID,
    ts: SEED_TIME,
    trigger: "manual",
    pre_tokens: 150_000,
    post_tokens: 20_000,
    duration_ms: 30_000,
    ...row,
  };
  insertRow(db, "compactions", full);
  return full;
}

function rawEvent(table: "otel_events" | "hook_events") {
  return (db: Database, row: { session_id: string | null; name: string; ts?: number; attrs?: Record<string, unknown>; applied?: 0 | 1 }): RawEventRow => {
    const values = { session_id: row.session_id, ts: row.ts ?? SEED_TIME, name: row.name, attrs_json: JSON.stringify(row.attrs ?? {}), applied: row.applied ?? 0 };
    insertRow(db, table, values);
    const { id } = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!;
    return { id, ...values };
  };
}

function receiverWindow(db: Database, row: Omit<ReceiverWindowRow, "id">): void {
  insertRow(db, "receiver_windows", row);
}

function sourceFile(db: Database, row: Keys<SourceFileRow, "path" | "session_id">): SourceFileRow {
  const full: SourceFileRow = {
    kind: "main",
    agent_id: MAIN_AGENT_ID,
    size: 0,
    mtime: SEED_TIME,
    inode: 1,
    parsed_offset: 0,
    last_event_ts: null,
    missing_since: null,
    ...row,
  };
  insertRow(db, "source_files", full);
  return full;
}

export const seed = {
  session,
  agent,
  prompt,
  modelCall,
  toolCall,
  fileOp,
  externalRequest,
  apiError,
  message,
  instruction,
  compaction,
  otelEvent: rawEvent("otel_events"),
  hookEvent: rawEvent("hook_events"),
  receiverWindow,
  sourceFile,
};

// SQLite table rows: the fields match the migration columns (src/db/migrations), so
// `db.query<Row, …>` returns them without conversion. Time is epoch milliseconds, UTC,
// flags are 0 | 1. A comment on a group of columns names the module that fills it.
//
// Call and event identifiers come from Claude Code and are unique only within a session
// (a continued session copies the history of the original), so the primary key of event tables is
// (session_id, id).

export type Flag = 0 | 1;

export type SourceFileKind = "main" | "subagent";
export type SessionStatus = "running" | "completed";
export type Enrichment = "none" | "partial" | "full";
export type NameSource = "custom" | "desktop" | "ai" | "prompt";
export type PromptKind = "original" | "follow_up";
export type ToolStatus = "ok" | "error" | "denied" | "interrupted" | "pending";
export type FileOp = "read" | "edit" | "write";
export type ExternalKind = "web_fetch" | "web_search";
export type MessageKind = "text" | "thinking";
export type ContentEncoding = "raw" | "gzip";
export type EventSource = "transcript" | "otel";
export type InstructionSource = "hook" | "transcript";

/** Read-progress bookkeeping. Filled by the indexer (ingest/index.ts, ingest/discover.ts). */
export interface SourceFileRow {
  path: string;
  kind: SourceFileKind;
  session_id: string;
  agent_id: string;
  size: number;
  mtime: number;
  inode: number;
  parsed_offset: number;
  /** Time of the last processed line with a timestamp: the next pass's `prevEventTs`. */
  last_event_ts: number | null;
  missing_since: number | null;
}

export interface TokenColumns {
  tok_input: number;
  tok_output: number;
  tok_cache_read: number;
  tok_cache_write: number;
  /** Included in tok_output. */
  tok_thinking: number;
  /** input + output + cache_read + cache_write. */
  tok_total: number;
}

export interface SessionRow extends TokenColumns {
  // reduce/session.ts
  id: string;
  source: "local";
  cwd: string | null;
  project: string | null;
  is_temp_dir: Flag;
  name: string | null;
  /** `name` in lower case (`toLowerCase`): search and case-insensitive sorting go by it — SQLite compares case-insensitively only Latin letters. */
  name_lower: string | null;
  name_source: NameSource | null;
  entrypoint: string | null;
  cc_version: string | null;
  git_branch: string | null;
  started_at: number | null;
  /** Time of the last event of any file of the session. */
  ended_at: number | null;
  cost_reported_usd: number | null;
  // reduce/durations.ts
  active_ms: number;
  model_ms: number;
  model_ms_exact: Flag;
  // reduce/status.ts; end_reason — enrich/merge.ts
  status: SessionStatus;
  end_reason: string | null;
  // reduce/totals.ts (and the tokens from TokenColumns)
  primary_model: string | null;
  agents_count: number;
  model_calls: number;
  tool_calls: number;
  tool_errors: number;
  api_errors: number;
  /** NULL if the session has a call of an unknown model. */
  cost_usd: number | null;
  // enrich/coverage.ts
  enrichment: Enrichment;
  // ingest/index.ts
  transcript_present: Flag;
}

export interface AgentRow extends TokenColumns {
  // reduce/agents.ts
  session_id: string;
  /** `main` for the main agent. */
  agent_id: string;
  parent_agent_id: string | null;
  depth: number;
  spawn_tool_call_id: string | null;
  type: string | null;
  description: string | null;
  started_at: number | null;
  ended_at: number | null;
  prompt_content_id: number | null;
  // reduce/durations.ts
  run_ms: number;
  // reduce/totals.ts (and the tokens from TokenColumns)
  model: string | null;
  model_calls: number;
  tool_calls: number;
  tool_errors: number;
  api_errors: number;
  files_read: number;
  cost_usd: number | null;
  // reduce/context.ts
  ctx_window: number | null;
  ctx_first: number | null;
  ctx_last: number | null;
  ctx_peak: number | null;
  ctx_peak_call_id: string | null;
  /** JSON array of `ContextBreakdownEntry` from api.ts. */
  ctx_breakdown_json: string | null;
  ctx_breakdown_exact: Flag;
}

/** User messages. reduce/prompts.ts. */
export interface PromptRow {
  session_id: string;
  /** The line's uuid. */
  id: string;
  ts: number;
  seq: number;
  kind: PromptKind;
  content_id: number;
  tokens_est: number;
  /** JSON array of attachment names. */
  attachments_json: string | null;
}

/** reduce/modelCalls.ts; duration_ms and duration_exact are refined by enrich/merge.ts. */
export interface ModelCallRow {
  session_id: string;
  /** requestId. */
  id: string;
  agent_id: string;
  /** Sequence number of the call within the agent, from 1. */
  turn_index: number;
  model: string;
  ts_start: number;
  ts_end: number;
  duration_ms: number;
  duration_exact: Flag;
  stop_reason: string | null;
  tok_input: number;
  tok_output: number;
  tok_cache_read: number;
  tok_cache_write_5m: number;
  tok_cache_write_1h: number;
  tok_thinking: number;
  /** input + cache_read + cache_write: the context size at the call. */
  ctx_tokens: number;
  /** NULL for an unknown model. */
  cost_usd: number | null;
  query_source: string | null;
}

/** Failed attempts on the Model API track. reduce/apiErrors.ts and enrich/merge.ts. */
export interface ApiErrorRow {
  session_id: string;
  /** The transcript line's uuid or `otel:<event id>`. */
  id: string;
  agent_id: string;
  ts: number;
  request_id: string | null;
  status_code: number | null;
  error: string;
  attempt: number | null;
  max_retries: number | null;
  retry_in_ms: number | null;
  source: EventSource;
}

/** reduce/toolCalls.ts; the duration and permissions are refined by enrich/merge.ts. */
export interface ToolCallRow {
  session_id: string;
  /** tool_use.id. */
  id: string;
  agent_id: string;
  model_call_id: string | null;
  turn_index: number | null;
  name: string;
  /** Server name for tools of the form `mcp__<server>__<tool>`. */
  mcp_server: string | null;
  /** File path, first line of a command, URL, search pattern, subagent task description. */
  target: string | null;
  ts_start: number;
  ts_end: number | null;
  duration_ms: number | null;
  duration_exact: Flag;
  status: ToolStatus;
  /** First line of the error output. */
  error_title: string | null;
  permission_decision: string | null;
  permission_source: string | null;
  spawned_agent_id: string | null;
  input_content_id: number | null;
  output_content_id: number | null;
  input_bytes: number | null;
  output_bytes: number | null;
  lines_added: number | null;
  lines_removed: number | null;
}

/** reduce/fileOps.ts. One record per Read, Edit or Write call. */
export interface FileOpRow {
  session_id: string;
  /** Equals tool_call_id. */
  id: string;
  agent_id: string;
  tool_call_id: string;
  path: string;
  op: FileOp;
  ts: number;
  lines_added: number | null;
  lines_removed: number | null;
}

/** reduce/external.ts. One record per WebFetch or WebSearch call. */
export interface ExternalRequestRow {
  session_id: string;
  /** Equals tool_call_id. */
  id: string;
  agent_id: string;
  tool_call_id: string;
  kind: ExternalKind;
  /** URL for web_fetch, query text for web_search. */
  url: string | null;
  status_code: number | null;
  bytes: number | null;
  duration_ms: number | null;
  ts: number;
}

/** Model text and thinking. reduce/messages.ts. */
export interface MessageRow {
  session_id: string;
  /** `<line uuid>:<block number>`. */
  id: string;
  agent_id: string;
  model_call_id: string | null;
  ts: number;
  kind: MessageKind;
  content_id: number;
}

/** Bodies by hash. reduce/contents.ts is the only module that writes and reads the table. */
export interface ContentRow {
  id: number;
  sha256: string;
  /** Size of the uncompressed body. */
  bytes: number;
  encoding: ContentEncoding;
  body: Uint8Array;
}

/** reduce/instructions.ts (source transcript) and enrich/merge.ts (source hook). */
export interface InstructionLoadedRow {
  session_id: string;
  /** `<line uuid>:<file number>` or `hook:<event id>`. */
  id: string;
  agent_id: string;
  ts: number;
  file_path: string;
  memory_type: string | null;
  load_reason: string | null;
  bytes: number | null;
  tokens_est: number | null;
  source: InstructionSource;
}

/** reduce/compactions.ts; refined by enrich/merge.ts. */
export interface CompactionRow {
  session_id: string;
  /** The line's uuid. */
  id: string;
  agent_id: string;
  ts: number;
  trigger: string | null;
  pre_tokens: number | null;
  post_tokens: number | null;
  duration_ms: number | null;
}

/** Raw received events before the merge: the tables `otel_events` and `hook_events`. enrich/otlp.ts, enrich/hooks.ts. */
export interface RawEventRow {
  id: number;
  session_id: string | null;
  ts: number;
  name: string;
  attrs_json: string;
  applied: Flag;
}

/** When the OTel receiver was running. enrich/coverage.ts. */
export interface ReceiverWindowRow {
  id: number;
  started_at: number;
  /** Updated by the heartbeat. */
  stopped_at: number;
}

export interface MetaRow {
  key: string;
  value: string;
}

-- torch schema (plan §5). Row types are in src/contracts/rows.ts.
-- Time is epoch milliseconds, UTC. Event identifiers are unique within a session,
-- so the primary key of event tables is (session_id, id).

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE source_files (
  path          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('main', 'subagent')),
  session_id    TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  size          INTEGER NOT NULL,
  mtime         INTEGER NOT NULL,
  inode         INTEGER NOT NULL,
  parsed_offset INTEGER NOT NULL DEFAULT 0,
  last_event_ts INTEGER,
  missing_since INTEGER
) WITHOUT ROWID;
CREATE INDEX source_files_session ON source_files (session_id);

CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  source             TEXT NOT NULL DEFAULT 'local',
  cwd                TEXT,
  project            TEXT,
  is_temp_dir        INTEGER NOT NULL DEFAULT 0,
  name               TEXT,
  name_lower         TEXT,
  name_source        TEXT CHECK (name_source IN ('custom', 'desktop', 'ai', 'prompt')),
  entrypoint         TEXT,
  cc_version         TEXT,
  git_branch         TEXT,
  primary_model      TEXT,
  started_at         INTEGER,
  ended_at           INTEGER,
  active_ms          INTEGER NOT NULL DEFAULT 0,
  model_ms           INTEGER NOT NULL DEFAULT 0,
  model_ms_exact     INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('running', 'completed')),
  end_reason         TEXT,
  agents_count       INTEGER NOT NULL DEFAULT 0,
  model_calls        INTEGER NOT NULL DEFAULT 0,
  tool_calls         INTEGER NOT NULL DEFAULT 0,
  tool_errors        INTEGER NOT NULL DEFAULT 0,
  api_errors         INTEGER NOT NULL DEFAULT 0,
  tok_input          INTEGER NOT NULL DEFAULT 0,
  tok_output         INTEGER NOT NULL DEFAULT 0,
  tok_cache_read     INTEGER NOT NULL DEFAULT 0,
  tok_cache_write    INTEGER NOT NULL DEFAULT 0,
  tok_thinking       INTEGER NOT NULL DEFAULT 0,
  tok_total          INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL,
  cost_reported_usd  REAL,
  enrichment         TEXT NOT NULL DEFAULT 'none' CHECK (enrichment IN ('none', 'partial', 'full')),
  transcript_present INTEGER NOT NULL DEFAULT 1
) WITHOUT ROWID;
CREATE INDEX sessions_started ON sessions (started_at);
CREATE INDEX sessions_project ON sessions (project);

CREATE TABLE agents (
  session_id          TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  parent_agent_id     TEXT,
  depth               INTEGER NOT NULL DEFAULT 0,
  spawn_tool_call_id  TEXT,
  type                TEXT,
  description         TEXT,
  model               TEXT,
  started_at          INTEGER,
  ended_at            INTEGER,
  run_ms              INTEGER NOT NULL DEFAULT 0,
  model_calls         INTEGER NOT NULL DEFAULT 0,
  tool_calls          INTEGER NOT NULL DEFAULT 0,
  tool_errors         INTEGER NOT NULL DEFAULT 0,
  api_errors          INTEGER NOT NULL DEFAULT 0,
  files_read          INTEGER NOT NULL DEFAULT 0,
  tok_input           INTEGER NOT NULL DEFAULT 0,
  tok_output          INTEGER NOT NULL DEFAULT 0,
  tok_cache_read      INTEGER NOT NULL DEFAULT 0,
  tok_cache_write     INTEGER NOT NULL DEFAULT 0,
  tok_thinking        INTEGER NOT NULL DEFAULT 0,
  tok_total           INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL,
  ctx_window          INTEGER,
  ctx_first           INTEGER,
  ctx_last            INTEGER,
  ctx_peak            INTEGER,
  ctx_peak_call_id    TEXT,
  ctx_breakdown_json  TEXT,
  ctx_breakdown_exact INTEGER NOT NULL DEFAULT 0,
  prompt_content_id   INTEGER,
  PRIMARY KEY (session_id, agent_id)
) WITHOUT ROWID;

CREATE TABLE prompts (
  session_id       TEXT NOT NULL,
  id               TEXT NOT NULL,
  ts               INTEGER NOT NULL,
  seq              INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('original', 'follow_up')),
  content_id       INTEGER NOT NULL,
  tokens_est       INTEGER NOT NULL DEFAULT 0,
  attachments_json TEXT,
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID;

CREATE TABLE model_calls (
  session_id         TEXT NOT NULL,
  id                 TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  turn_index         INTEGER NOT NULL,
  model              TEXT NOT NULL,
  ts_start           INTEGER NOT NULL,
  ts_end             INTEGER NOT NULL,
  duration_ms        INTEGER NOT NULL,
  duration_exact     INTEGER NOT NULL DEFAULT 0,
  stop_reason        TEXT,
  tok_input          INTEGER NOT NULL DEFAULT 0,
  tok_output         INTEGER NOT NULL DEFAULT 0,
  tok_cache_read     INTEGER NOT NULL DEFAULT 0,
  tok_cache_write_5m INTEGER NOT NULL DEFAULT 0,
  tok_cache_write_1h INTEGER NOT NULL DEFAULT 0,
  tok_thinking       INTEGER NOT NULL DEFAULT 0,
  ctx_tokens         INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL,
  query_source       TEXT,
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID;
CREATE INDEX model_calls_agent ON model_calls (session_id, agent_id, ts_start);
CREATE INDEX model_calls_ts ON model_calls (ts_start);

CREATE TABLE api_errors (
  session_id  TEXT NOT NULL,
  id          TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  request_id  TEXT,
  status_code INTEGER,
  error       TEXT NOT NULL,
  attempt     INTEGER,
  max_retries INTEGER,
  retry_in_ms INTEGER,
  source      TEXT NOT NULL CHECK (source IN ('transcript', 'otel')),
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID;

CREATE TABLE tool_calls (
  session_id          TEXT NOT NULL,
  id                  TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  model_call_id       TEXT,
  turn_index          INTEGER,
  name                TEXT NOT NULL,
  mcp_server          TEXT,
  target              TEXT,
  ts_start            INTEGER NOT NULL,
  ts_end              INTEGER,
  duration_ms         INTEGER,
  duration_exact      INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('ok', 'error', 'denied', 'interrupted', 'pending')),
  error_title         TEXT,
  permission_decision TEXT,
  permission_source   TEXT,
  spawned_agent_id    TEXT,
  input_content_id    INTEGER,
  output_content_id   INTEGER,
  input_bytes         INTEGER,
  output_bytes        INTEGER,
  lines_added         INTEGER,
  lines_removed       INTEGER,
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID;
CREATE INDEX tool_calls_agent ON tool_calls (session_id, agent_id, ts_start);
CREATE INDEX tool_calls_ts ON tool_calls (ts_start);

CREATE TABLE file_ops (
  session_id    TEXT NOT NULL,
  id            TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  tool_call_id  TEXT NOT NULL,
  path          TEXT NOT NULL,
  op            TEXT NOT NULL CHECK (op IN ('read', 'edit', 'write')),
  ts            INTEGER NOT NULL,
  lines_added   INTEGER,
  lines_removed INTEGER,
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID;
CREATE INDEX file_ops_path ON file_ops (session_id, path);

CREATE TABLE external_requests (
  session_id   TEXT NOT NULL,
  id           TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('web_fetch', 'web_search')),
  url          TEXT,
  status_code  INTEGER,
  bytes        INTEGER,
  duration_ms  INTEGER,
  ts           INTEGER NOT NULL,
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID;

CREATE TABLE messages (
  session_id    TEXT NOT NULL,
  id            TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  model_call_id TEXT,
  ts            INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('text', 'thinking')),
  content_id    INTEGER NOT NULL,
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID;
CREATE INDEX messages_call ON messages (session_id, model_call_id);

CREATE TABLE contents (
  id       INTEGER PRIMARY KEY,
  sha256   TEXT NOT NULL UNIQUE,
  bytes    INTEGER NOT NULL,
  encoding TEXT NOT NULL CHECK (encoding IN ('raw', 'gzip')),
  body     BLOB NOT NULL
);

CREATE TABLE instructions_loaded (
  session_id  TEXT NOT NULL,
  id          TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  file_path   TEXT NOT NULL,
  memory_type TEXT,
  load_reason TEXT,
  bytes       INTEGER,
  tokens_est  INTEGER,
  source      TEXT NOT NULL CHECK (source IN ('hook', 'transcript')),
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID;

CREATE TABLE compactions (
  session_id  TEXT NOT NULL,
  id          TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  trigger     TEXT,
  pre_tokens  INTEGER,
  post_tokens INTEGER,
  duration_ms INTEGER,
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID;

CREATE TABLE otel_events (
  id         INTEGER PRIMARY KEY,
  session_id TEXT,
  ts         INTEGER NOT NULL,
  name       TEXT NOT NULL,
  attrs_json TEXT NOT NULL,
  applied    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX otel_events_pending ON otel_events (applied, session_id);

CREATE TABLE hook_events (
  id         INTEGER PRIMARY KEY,
  session_id TEXT,
  ts         INTEGER NOT NULL,
  name       TEXT NOT NULL,
  attrs_json TEXT NOT NULL,
  applied    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX hook_events_pending ON hook_events (applied, session_id);

CREATE TABLE receiver_windows (
  id         INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER NOT NULL
);

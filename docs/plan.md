# torch — implementation plan

A local application for analysing Claude Code sessions: what the agents did, how much it cost, where the context went, where the errors were.

Source of the mockups: the "Session debugger" canvas, five artboards (Dashboard, Sessions list, Session detail, Session timeline + docked panel, Detail panel). Design system: Carbon.

Plan date: 2026-11-09.

---

## 1. Scope of the first wave

**In scope**

- Claude Code sessions on a single machine (macOS), started from the desktop app, the terminal or in headless mode: everything that writes transcripts to `~/.claude/projects`.
- Post-hoc analysis and near-live updating of running sessions. The app only reads; it does not control sessions.
- Three data sources: transcripts (the base), OpenTelemetry (the main enrichment), hooks (what OTel does not have).
- The five screens from the mockups.

**Out of scope**

- Cloud sessions (no official export).
- A combined view across several machines: each installation is standalone.
- Linux.
- An adapter for the logs of a gateway in front of the API (second wave; the gateway on the target system has not been named yet).
- A dedicated proxy, OTel traces, a background service.

---

## 2. Decisions made

| # | Topic | Decision |
|---|---|---|
| 1 | Scope | One machine, standalone installation. The session source is a field in the data model so that others can be added later. |
| 2 | Mode | Post-hoc + updating a running session within seconds. No control. |
| 3 | Capture | Transcripts + OTel + hooks. |
| 4 | Form factor | Local web app, listens on `127.0.0.1`. |
| 5 | Mockups | A specification of layout and navigation. Discrepancies with the data are resolved in favour of the data (see section 9). |
| 6 | Temporary directories | Sessions whose working directory is in `/private/var/folders/.../T/` are indexed but hidden by default behind the "Temporary-directory sessions" switch. |
| 7 | Session name | `custom-title` → title from the desktop app → `ai-title` → the beginning of the first prompt. |
| 8 | Cost | Tokens × an editable price table, labelled "Estimated at list prices". If the transcript has a ready-made total, we show the discrepancy. |
| 9 | Installation | `git clone`, `./setup.sh`, `torch start`. |
| 10 | Stack | TypeScript; Bun; Hono; SSE; `bun:sqlite`; React + Vite + `@carbon/react` + Carbon Charts. |
| 11, 21, 28 | Storage | SQLite is the primary store, not a rebuildable index. All content is copied into the database: prompts, inputs and outputs of all calls, model responses, thinking. A session stays in the database after its transcript is deleted. |
| 12 | Errors | Errors = tool calls with `is_error`. API errors are counted separately. Denied and Interrupted are separate neutral statuses. |
| 13, 18, 24 | Network | The track is built from OTel; for sessions without OTel, an estimate from the transcript. A "network event source" interface with one implementation; the gateway adapter is the second wave. |
| 14 | Name | torch, in the interface too. |
| 16 | Context at peak | First / Last / Peak are exact. The breakdown by category is an estimate marked "Estimated". |
| 17 | Network exposure | `127.0.0.1` by default. `--host` opens access and requires a generated token. |
| 20, 25 | Channels | OTel: `api_request`, `api_error`, `tool_result`, `tool_decision`. Hooks: `InstructionsLoaded`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`. The flags with texts in OTel are off. |
| 22 | Sessions list | Sorting by any column, pages, a project filter, a temporary-directory switch. |
| 26, 32 | Process | Started manually. OTel events are lost while torch is off; such sessions are marked "no enrichment" or "partial enrichment". |
| 27 | Setup | Shows the changes, asks for confirmation, makes a backup, is idempotent, reversible via `torch uninstall`. |
| 29 | Periods | Windows ending today in local time: today, 7 days, 30 days, 12 months. The delta is against the previous window of the same length. |
| 30 | Duration | Active time: the sum of "prompt → end of response" intervals. Model time is the sum of API call durations. |
| 31 | Timeline | Idle periods longer than 5 minutes collapse into a gap with a label. |
| 34 | Tests | The core through tests on synthetic transcripts; a check command against real history; an end-to-end run of the five screens. |
| 35 | Repository | Real transcripts do not enter the repository. The GitHub repository is private, created by a separate owner command. |
| 36 | Model | A session = one `sessionId` with all its subagents. Status Running or Completed. Nested subagents are indented. |
| 37 | Defaults | See sections 9 and 10. |
| 38 | Principles | The code follows DRY, KISS and YAGNI (section 4.2). The interface is built by atomic design (section 9.4). |
| 39 | Charts | Carbon Charts (React). What counts as a chart and which component is used: section 9.4. |

---

## 3. What is known about the data

Checked on this machine on 2026-11-09 (Claude Code 2.1.221–2.1.321) and against the `code.claude.com` documentation.

### 3.1 Transcripts

```
~/.claude/projects/<cwd-with-dashes>/<sessionId>.jsonl
~/.claude/projects/<cwd-with-dashes>/<sessionId>/subagents/agent-<agentId>.jsonl
~/.claude/projects/<cwd-with-dashes>/<sessionId>/subagents/agent-<agentId>.meta.json   {agentType, description, toolUseId, spawnDepth}
~/.claude/projects/<cwd-with-dashes>/<sessionId>/custom-title.json                      {customTitle}
~/.claude/projects/<cwd-with-dashes>/<sessionId>/tool-results/*                         large outputs
```

Volume: 1001 main sessions, 230 subagent files, 510 MB, since 2026-08-06. All sessions have `entrypoint: claude-desktop`.

Rules that correctness depends on:

- **Token deduplication.** One API response is recorded as several `assistant` lines (one per content block) with the same `requestId`. Their input part of `usage` is identical, `output_tokens` grows towards the last line. A model call = a unique `requestId`; `usage` is taken from the last line of the request.
- **Identifiers are unique within a session.** A continued session copies the history of the original, so one `requestId`, `tool_use.id` or `uuid` appears in the files of two sessions. The session identifier is the name of the transcript file.
- **Linking a call and its result.** `tool_use.id` in an `assistant` line ↔ `tool_result.tool_use_id` in a `user` line. The result line has a `toolUseResult` whose structure depends on the tool.
- **Subagents** live in separate files; the main transcript has no `isSidechain: true` lines. The link: `meta.json.toolUseId` = `tool_use.id` of the parent `Agent` call; `agentId` in the file name = `toolUseResult.agentId`.
- **Context size at a call** = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
- **Thinking**: `usage.output_tokens_details.thinking_tokens`, if the field is present.
- **API errors**: `system` lines with the `api_error` subtype (`error`, `retryAttempt`, `maxRetries`, `retryInMs`) are failed attempts followed by a retry, with no HTTP status; `assistant` lines with `isApiErrorMessage` (`error`, `apiErrorStatus`) are the final failure, with a status.
- **Compaction**: `system` / `compact_boundary` lines with `compactMetadata` (`trigger`, `preTokens`, `postTokens`, `durationMs`).
- **Names**: `custom-title`, `ai-title` lines.
- **Ready-made cost**: `cost-state` lines (`totalCostUSD`, `modelUsage`), rare (34 in the whole history).
- **Denials and interruptions**: the `permissionDecision`, `toolDenialKind` fields in `user` lines; `interrupted` in a Bash result.
- **External requests**: `toolUseResult` of `WebFetch` (`url`, `code`, `bytes`, `durationMs`) and `WebSearch` (`query`, `durationSeconds`).
- **File edits**: `toolUseResult.structuredPatch` of `Edit` and `Write` gives the added and removed lines.

The format is officially called internal and changes between versions. The parser must skip unknown line types and fields rather than crash.

Retention: Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by default, cannot be disabled, the value 0 is rejected).

### 3.2 Desktop app metadata

`~/Library/Application Support/Claude/claude-code-sessions/<uuid>/<uuid>/local_<uuid>.json`: `cliSessionId` (= the transcript file name), `title`, `titleSource`, `model`, `createdAt`, `lastActivityAt`, `isArchived`.

### 3.3 OpenTelemetry

Log events and the attributes torch needs:

| Event | Attributes |
|---|---|
| `claude_code.api_request` | `request_id`, `model`, `duration_ms`, `cost_usd`, tokens by kind, `query_source` |
| `claude_code.api_error` | `request_id`, `status_code`, `error`, `attempt`, `duration_ms` |
| `claude_code.tool_result` | `tool_use_id`, `tool_name`, `success`, `duration_ms`, `decision_type`, `decision_source`, `tool_input_size_bytes`, `tool_result_size_bytes` |
| `claude_code.tool_decision` | `tool_use_id`, `decision`, `source` (`config`, `hook`, `user_permanent`, `user_temporary`, `user_abort`, `user_reject`) |

Every event has `session.id`. The short event name is in the `event.name` attribute (`api_request`), the full one is in the record body. `api_request` also carries `ttft_ms`. The full list of attributes as found by experiment is in spikes.md §8. The `agent_id` and `parent_agent_id` attributes appeared in 2.1.310, so we link to an agent through `request_id` and `tool_use_id` rather than through them.

There is no file export: an OTLP receiver is needed. The variables are set in the `env` block of the user's `settings.json`.

### 3.4 Hooks

| Event | Fields beyond the common ones (`session_id`, `transcript_path`, `cwd`) |
|---|---|
| `InstructionsLoaded` | `file_path`, `memory_type`, `load_reason`, `trigger_file_path`, `parent_file_path` (no size) |
| `SessionStart` | `source`; `model` according to the documentation, did not arrive on 2.1.288 and 2.1.321 |
| `SessionEnd` | `reason` |
| `PreCompact` | `trigger` |
| `PostCompact` | `trigger`, `compact_summary` |

### 3.5 What exists nowhere

- A breakdown of context by category for past sessions.
- The HTTP status of successful requests and the request and response sizes in bytes (they will appear only with the gateway adapter).
- The name of the rule that allowed a call (OTel has only the source of the decision).

---

## 4. Architecture

One Bun process, started with the `torch start` command:

```
                 ┌──────────────────────────── torch (Bun) ───────────────────────────┐
~/.claude/projects ──► file watcher ──► parser ──► reducers ─────────┐                │
~/Library/.../claude-code-sessions ─────────► titles ────────────────┤                │
~/.torch/spool/*.json (hooks) ──────────────► hooks intake ──────────┼──► SQLite ──► API (Hono) ──► React
Claude Code ── OTLP http/json ──► POST /otlp/v1/logs ──► OTel intake ┘     │            │
                                                                           └──► SSE ────┘
                 └────────────────────────────────────────────────────────────────────┘
```

The default port is 4820, one for the interface, the API and the OTLP receiver.

### 4.1 Repository structure

```
torch/
  setup.sh                    install dependencies, build, call `torch setup`
  package.json                workspace root (the second package is web)
  CLAUDE.md                   rules for agents and pointers to the plan
  prices.default.json         table of prices and context window sizes by model
  src/
    contracts/                shared types and constants: lines, rows, pipeline, api, selection, enrich,
                              events, constants
    cli.ts                    start | index | doctor | setup | uninstall | status
    server.ts                 assembling the Hono app, serving the interface
    config.ts                 ~/.torch/config.json, paths, port
    db/
      db.ts                   opening, 0600 permissions, WAL
      migrations/             numbered SQL files, forward only
    ingest/
      discover.ts             walking the roots, file bookkeeping
      index.ts                incremental pass: reading, reducers, transaction
      reader.ts               incremental reading by offset
      parse.ts                tolerant line decoders
      reduce/                 calls: modelCalls, toolCalls, fileOps, external, apiErrors,
                                contents, compactions
                              structure: session, agents, prompts, messages, instructions
                              derived: durations, status, context, totals
                              cost
      titles.ts               desktop app metadata
      watch.ts                watching and launching the incremental pass
    enrich/
      networkSource.ts        the network event source interface
      otlp.ts                 the receiver and parsing of OTLP http/json
      hooks.ts                intake of files from the spool
      merge.ts                merging with transcript data
      coverage.ts             receiver uptime windows → enrichment mark
    api/
      routes.ts               the list of all routes
      context.ts              handler dependencies, shared 404 and 501 responses
      filters.ts              session filters → SQL, shared by the list and the dashboard
      sessions.ts, projects.ts, export.ts, timeline.ts, items.ts, contents.ts,
      dashboard.ts, events.ts, settings.ts, otlp.ts
    setup/                    editing settings.json, backup, rollback
  web/                        Vite + React + @carbon/react, its own package.json
    src/components/
      atoms/                  indivisible elements
      molecules/              combinations of atoms with a single task
      organisms/              self-contained screen blocks, including Timeline/, DetailPanel/
      templates/              layouts without data
    src/pages/                dashboard/, sessions/, session-overview/, session-timeline/,
                              panel/, settings/
    src/lib/                  API client, formatting, live.ts
  hooks/record.sh             hooks handler (POSIX sh, no dependencies)
  test/
    support/                  transcript.ts (building transcripts), seed.ts (filling the database),
                              reference*.ts (the reference session in three forms), build-dto.ts
    fixtures/                 synthetic data only: transcripts and dto/ (API responses for the screens)
    e2e/                      end-to-end run
  docs/
    handoff.md, plan.md, packages.md, references.md, spikes.md
    design/                   the five mockup artboards and canvas.json
```

### 4.2 Code principles

Three principles apply to all the code. Below is what each one means in torch specifically; this is what acceptance checks them against.

**DRY — each piece of knowledge has one place.**

| Knowledge | Where it lives |
|---|---|
| Types of transcript lines, database rows, API responses | `src/contracts/`; the server and the interface import them rather than describing them again |
| Thresholds and constants (5 minutes of idle, 5 minutes for Running, 2-hour bars) | `src/contracts/constants.ts` |
| Cost calculation | `src/ingest/reduce/cost.ts` |
| Agent and session totals | `src/ingest/reduce/totals.ts` |
| Translating session filters to SQL | `src/api/filters.ts`; both the list and the dashboard use it, so their numbers agree by construction |
| Formatting tokens, money, durations | `web/src/lib/format.ts` |
| API route paths | `API_ROUTES` in `src/contracts/api.ts` |
| Writing and reading bodies | `src/ingest/reduce/contents.ts` |
| Recording the selection in the page address | `src/contracts/selection.ts` |

DRY is about knowledge, not similar-looking lines: two blocks that look the same but change for different reasons stay separate. In tests clarity matters more: the example data is written directly in the test.

**KISS — the simplest thing that meets the package's criterion.**

- Modules and functions; classes only where there is state with a lifecycle (the receiver, the file watcher).
- SQL is written by hand through `bun:sqlite` prepared statements, without an ORM or a query builder.
- Interface state is local and in the page address; data is `fetch` and one shared hook, without a state library.
- Charts are built on Carbon Charts (section 9.4), no custom chart rendering is written. The timeline's marks and tracks are ordinary DOM elements with styles, as in the mockup: Carbon Charts has no ready-made chart of this kind.
- A dependency is added when the package grows noticeably without it; the worker names each new one in the report.

**YAGNI — we build what the first-wave screens need.**

- From the second wave (section 13) the code has only two provisions, both already settled: the session's `source` field and the network event source interface. Everything else appears together with its task.
- A parameter, setting, column or route exists only if a first-wave screen, command or test reads it.
- A generalisation is written at the second consumer, not in anticipation of one.

### 4.3 Data directory

```
~/.torch/
  torch.db            0600 permissions
  config.json
  prices.json         a copy of prices.default.json, edited from Settings
  spool/              hooks event files, one per event
  hooks/record.sh     a copy of the hooks handler; settings.json refers to it; it finds the spool relative to its own location
  backups/            copies of settings.json before editing, and setup-state.json — a record of what torch setup installed
```

---

## 5. Data model (SQLite)

Time is in UTC epoch milliseconds. Identifiers are taken from Claude Code where they exist. They are unique only within a session, so the primary key of the event tables (`prompts`, `model_calls`, `api_errors`, `tool_calls`, `file_ops`, `external_requests`, `messages`, `instructions_loaded`, `compactions`) is the pair `session_id` + `id`. The exact schema is `src/db/migrations/`, the row types and the module that fills each column are `src/contracts/rows.ts`.

**`source_files`** — bookkeeping of what has been read.
`path` PK, `kind` (main | subagent), `session_id`, `agent_id`, `size`, `mtime`, `inode`, `parsed_offset`, `last_event_ts` (the time of the last processed line: the duration estimate of the first call of the next pass is computed from it), `missing_since`.

**`sessions`**
`id` PK (sessionId), `source` ('local'), `cwd`, `project`, `is_temp_dir`, `name`, `name_lower` (the name in lower case: case-insensitive search and sorting for any alphabet), `name_source`, `entrypoint`, `cc_version`, `git_branch`, `primary_model`, `started_at`, `ended_at`, `active_ms`, `model_ms`, `model_ms_exact`, `status` (running | completed), `end_reason`, `agents_count`, `model_calls`, `tool_calls`, `tool_errors`, `api_errors`, `tok_input`, `tok_output`, `tok_cache_read`, `tok_cache_write`, `tok_thinking`, `tok_total`, `cost_usd` (NULL if there is an unknown model), `cost_reported_usd`, `enrichment` (none | partial | full), `transcript_present`.

**`agents`**
`session_id` + `agent_id` PK (`main` for the main one), `parent_agent_id`, `depth`, `spawn_tool_call_id`, `type`, `description`, `model`, `started_at`, `ended_at`, `run_ms`, `model_calls`, `tool_calls`, `tool_errors`, `api_errors`, `files_read`, tokens and `cost_usd` as for the session, `ctx_window`, `ctx_first`, `ctx_last`, `ctx_peak`, `ctx_peak_call_id`, `ctx_breakdown_json`, `ctx_breakdown_exact`, `prompt_content_id`.

**`prompts`** — user messages.
`id` PK (uuid), `session_id`, `ts`, `seq`, `kind` (original | follow_up), `content_id`, `tokens_est`, `attachments_json`.

**`model_calls`**
`id` PK (requestId), `session_id`, `agent_id`, `turn_index`, `model`, `ts_start`, `ts_end`, `duration_ms`, `duration_exact`, `stop_reason`, `tok_input`, `tok_output`, `tok_cache_read`, `tok_cache_write_5m`, `tok_cache_write_1h`, `tok_thinking`, `ctx_tokens`, `cost_usd`, `query_source`.

**`api_errors`** — failed attempts on the Model API track.
`id` PK, `session_id`, `agent_id`, `ts`, `request_id`, `status_code`, `error`, `attempt`, `max_retries`, `retry_in_ms`, `source` (transcript | otel).

**`tool_calls`**
`id` PK (tool_use_id), `session_id`, `agent_id`, `model_call_id`, `turn_index`, `name`, `mcp_server`, `target`, `ts_start`, `ts_end`, `duration_ms`, `duration_exact`, `status` (ok | error | denied | interrupted | pending), `error_title`, `permission_decision`, `permission_source`, `spawned_agent_id`, `input_content_id`, `output_content_id`, `input_bytes`, `output_bytes`, `lines_added`, `lines_removed`.

**`file_ops`**
`id` PK, `session_id`, `agent_id`, `tool_call_id`, `path`, `op` (read | edit | write), `ts`, `lines_added`, `lines_removed`.

**`external_requests`**
`id` PK, `session_id`, `agent_id`, `tool_call_id`, `kind` (web_fetch | web_search), `url`, `status_code`, `bytes`, `duration_ms`, `ts`.

**`messages`** — the model's text and thinking.
`id` PK, `session_id`, `agent_id`, `model_call_id`, `ts`, `kind` (text | thinking), `content_id`.

**`contents`** — bodies addressed by hash (repeated reads of the same file are stored once).
`id` PK, `sha256` UNIQUE, `bytes`, `encoding` (raw | gzip), `body` BLOB. Bodies larger than 4 KB are compressed. Images and binary outputs are not copied: `tool_calls` keeps the path and the size.

**`instructions_loaded`**
`id` PK, `session_id`, `agent_id`, `ts`, `file_path`, `memory_type`, `load_reason`, `bytes`, `tokens_est`, `source` (hook | transcript).

**`compactions`**
`id` PK, `session_id`, `agent_id`, `ts`, `trigger`, `pre_tokens`, `post_tokens`, `duration_ms`.

**`otel_events`**, **`hook_events`** — raw received events before merging.
`id` PK, `session_id`, `ts`, `name`, `attrs_json`, `applied`.

**`receiver_windows`** — when the OTel receiver was running.
`started_at`, `stopped_at` (updated by a heartbeat every 30 seconds so that it survives a crash).

**`meta`** — `schema_version`.

There are no separate tables with daily totals: the order of magnitude is tens of thousands of calls, and the dashboard is computed by queries over indexes on `ts`.

---

## 6. Ingestion and computation

### 6.1 Incremental pass

1. Walk `~/.claude/projects`, match against `source_files` by path and inode.
2. For each file, read from `parsed_offset` to the last complete newline.
3. Parse the lines, apply the reducers, write in one transaction together with the new offset.
4. Recalculate the totals of the affected sessions and agents.
5. A file disappeared → `missing_since`, and the session gets `transcript_present = 0`. Data is not deleted.
6. A file became shorter or changed inode → re-read from the start; records are idempotent by primary keys.

A full rebuild is a separate command, `torch index --rebuild`, with a warning that everything older than Claude Code's retention period will be lost.

### 6.2 Rules

- **Project**: `cwd` from the first line that has this field; the project name is the last path segment. `is_temp_dir` if the path starts with `/private/var/folders/` or `/private/tmp/`.
- **Model call**: one record per `requestId`. Lines with `message.model = "<synthetic>"` are not counted as calls.
- **Model call duration**: from `api_request.duration_ms`; otherwise an estimate — the time of the last line of the response minus the time of the previous event of the same agent, `duration_exact = 0`. The lines of one response are written as the blocks become ready and are spread out in time.
- **Tool call duration**: from `tool_result.duration_ms` (OTel); otherwise from `toolUseResult.durationMs` / `totalDurationMs` where present (measured by Claude Code, `duration_exact = 1`); otherwise the difference between the times of the result line and the call line, `duration_exact = 0`.
- **Tool status**, in descending priority: `toolDenialKind` or `reject` in `permissionDecision` → denied; `interrupted` → interrupted; `is_error` → error; otherwise ok; no result → pending. The result of a denied call is also marked `is_error`, so the denial is checked first.
- **Call target** (`target`): the file path, the first line of the command, the URL, the search pattern, the text of the search query, the subagent task description — by input fields, in that order.
- **Prompt**: a `user` line with text or an image without a tool result, not a service line (`isMeta`), not a summary of compacted context (`isCompactSummary`) and not a background task notification (`origin.kind = task-notification`). A message from another session (`peer`) is a prompt. Only the prompts of the main file go into `prompts`; a subagent's task is stored on the agent. Attachments are images (`Image #N`).
- **Calls without a structured result** (subagent files have no `toolUseResult`): the file path and the URL are taken from the tool input; the changed lines are an estimate from the input (the number of lines of `old_string` and `new_string` for Edit, `content` for Write); the status and size of an external request are unknown.
- **Active session time**: the union of intervals from each user prompt to the last event before the next prompt.
- **Model time**: the sum of the calls' `duration_ms`; `model_ms_exact` only if all are exact.
- **Session status**: running if the last event is younger than 5 minutes and there is no `SessionEnd`; otherwise completed.
- **Call cost**: tokens by kind × the model's price from `prices.json`. Unknown model → `cost_usd = NULL` for the call, the agent and the session. If the model has long-context prices (`longContext`), a call with a prompt longer than the threshold is computed with them.
- **Context window**: from `prices.json` by model; if a call with `ctx_tokens` larger than the window is encountered, the window for that agent is raised to the next known size.
- **Context First / Last / Peak**: `ctx_tokens` of the agent's first, last and maximum call.
- **Breakdown at peak (estimate)**:
  - "System and tools" = `ctx_tokens` of the first call minus the estimate of the first prompt and the instructions;
  - "Instructions" = an estimate from the size of the files in `instructions_loaded` loaded before the end of the peak call; a file loaded again is counted once;
  - the remainder is split between "Messages" and "Tool results" in proportion to the volume from the last compaction to the peak call: for messages it is the output tokens of the calls and the estimates of the prompts, for results it is an estimate from the output size.
- **Agent totals**: the model is the one that made more calls; the run duration is from the first to the last line of the agent's file. The session's model is the main agent's model.
- **Enrichment mark**: full if the session's active intervals are entirely covered by `receiver_windows`; partial with partial coverage; none otherwise, and also when no OTel event has arrived from the session (the receiver was running but Claude Code was not configured).

### 6.3 Merging enrichment

- `api_request` → `model_calls` by `request_id`: `duration_ms`, `duration_exact = 1`.
- `api_error` → `api_errors` (source otel); duplicates with the transcript's `api_error` lines are glued by `request_id` + `attempt`, or, when absent, by time within a second.
- `tool_result` and `tool_decision` → `tool_calls` by `tool_use_id`: duration, `permission_decision`, `permission_source`.
- `InstructionsLoaded` → `instructions_loaded`; the file size is read from disk at the moment of receipt.
- `SessionEnd` → `end_reason`, status completed.
- `PreCompact` / `PostCompact` → refine `compactions`.

Events for which the transcript record has not arrived yet wait in the raw table with `applied = 0` and are applied on the next pass.

---

## 7. Setup and enrichment

### 7.1 What `torch setup` changes in `~/.claude/settings.json`

```jsonc
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",                       // the owner has "0": it is changed, the previous value is remembered
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:4820/otlp/v1/logs",
    // only when OTEL_METRICS_EXPORTER is set and there is no protocol for metrics:
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "http://127.0.0.1:4820/otlp/v1/metrics"
  },
  "cleanupPeriodDays": 365,
  "hooks": { /* five events → ~/.torch/hooks/record.sh */ }
}
```

An already configured metrics export (`OTEL_METRICS_EXPORTER`) is not touched: separate variables are used for logs. An experiment showed that `OTEL_METRICS_EXPORTER=otlp` without a protocol breaks the initialisation of all telemetry (spikes.md §8); therefore, when `OTEL_METRICS_EXPORTER` is set and neither `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` nor `OTEL_EXPORTER_OTLP_PROTOCOL` is present, `torch setup` adds the metrics protocol and address pointing at the torch receiver; it answers 200 and stores nothing. If the metrics protocol is already there, metrics are not touched. `CLAUDE_CODE_ENABLE_TELEMETRY` is set to `"1"` from any previous value; `torch uninstall` restores the previous one.

Order of work: read the file, show a line-by-line diff, ask for confirmation, save a backup to `~/.torch/backups/`, write. Running it again duplicates nothing. `cleanupPeriodDays` is never decreased: a value of 365 or more is left as it is. `uninstall` rolls back by the record of edits `backups/setup-state.json` and only where the value in the file still equals the recorded one; it does not delete the handler copy or the settings backups. If there is no record of edits but torch's edits are in the file, the commands do not guess the previous values but name the backups and the keys. `torch uninstall` deletes only the added keys and restores the previous value of `cleanupPeriodDays`.

### 7.2 The hooks handler

`hooks/record.sh` reads JSON from stdin and puts it into a separate file in `~/.torch/spool/` via a temporary name and `mv`, so that the write is atomic. It has no dependencies. On start and on a filesystem event torch picks up the files and deletes them.

### 7.3 Commands

| Command | Action |
|---|---|
| `torch start [--port N] [--host H]` | Catch up the index, start the server and the receiver, open the browser |
| `torch index [--rebuild]` | Only the indexer pass |
| `torch doctor` | Run the parser over the real history, print unknown line types and fields, the state of the channels |
| `torch setup` / `torch uninstall` | Editing and rolling back `settings.json` |
| `torch status` | Schema version, number of sessions, database size, the latest receiver windows |

---

## 8. API

| Method and path | Purpose |
|---|---|
| `GET /api/dashboard?range=&from=&to=&temp=` | Totals with deltas, two series for the charts, token mix, five top lists, tables by tool and model |
| `GET /api/sessions?q=&agents=&tcMin=&tcMax=&erMin=&erMax=&tkMin=&tkMax=&project=&temp=&sort=&dir=&page=` | The list |
| `GET /api/projects` | Values for the filter |
| `GET /api/sessions/:id` | Overview: tiles, tokens, prompts, agents |
| `GET /api/sessions/:id/timeline` | All tracks in compact form and the map of collapsed idle periods |
| `GET /api/sessions/:id/agents/:agentId` | Agent panel |
| `GET /api/sessions/:id/tool-calls/:callId`, `/api/sessions/:id/prompts/:promptId` | Tool call and prompt panels |
| `GET /api/sessions/:id/network/:kind/:netId` | Network call panel; `kind` is `model` (model call), `error` (failed attempt), `external` (external request) |
| `GET /api/sessions/:id/files?path=` | File panel |
| `GET /api/contents/:id` | A body by identifier |
| `GET /api/sessions/:id/export` | The normalised session as JSON |
| `GET /api/events` | SSE: a session changed, the index was updated |
| `GET`, `PUT /api/settings` | Prices, paths, the state of the channels |
| `POST /otlp/v1/logs` | The OTLP http/json receiver |

The route paths are written once, in `API_ROUTES` (`src/contracts/api.ts`); the DTO of each response is there too. The session panel takes the overview data.

---

## 9. Interface

### 9.1 Routes

| Route | Artboard |
|---|---|
| `/` | Dashboard |
| `/sessions` | Sessions list |
| `/sessions/:id` | Session detail (Overview) |
| `/sessions/:id/timeline` | Session timeline + docked panel |
| `/sessions/:id/panel` | Detail panel (detached tab) |
| `/settings` | Not in the mockups; the gear in the header |

The timeline state lives in the address: `sel=tool:<id>` (also `session`, `agent:<id>`, `prompt:<id>`, `file:<path>`, `net:<kind>:<id>`; writing and parsing are in `src/contracts/selection.ts`), `dock=right|left|bottom`, `view=compact|expanded`, `zoom=1|2|4`. This is how "open in a new tab", the back button and links to a specific call work.

### 9.2 Timeline

- Tracks are drawn with absolutely positioned DOM elements, as in the mockup: each mark is a real button, reachable from the keyboard.
- The time axis is piecewise linear: active intervals are to scale, idle periods longer than 5 minutes with no calls in flight take a fixed narrow strip with a duration label.
- In Expanded mode the agent and file tracks are rendered only in the visible area.
- The panel selection stack ("Back to …") is kept in the browser history.

### 9.3 Departures from the mockups

| Place | In the mockup | In torch | Reason |
|---|---|---|---|
| Header | "Session debugger" | "torch" | Decision 14 |
| Sessions | 12 rows without sorting | Sorting, pages, a project filter, a temporary-directory switch | More than a thousand sessions |
| Sessions, Dashboard | All sessions | Temporary directories are hidden by default | 831 service sessions out of 1001 |
| Duration | Difference between start and end | Active time; the full interval in the tooltip | Sessions continue across hours and days |
| Timeline, axis | Linear | Gaps at idle periods | Same |
| Agents, table | Flat | Nested subagents indented | The data has `spawnDepth` |
| Session status | Completed | Running or Completed | Live updating |
| Context at peak | 5 categories, exact numbers | 4 categories ("System and tools" instead of two), marked "Estimated" | The breakdown is not stored anywhere |
| Instructions loaded | Path, type, tokens | Path, type, token estimate from the file size; for sessions without hooks, whatever could be extracted from the transcript | Hooks have no size |
| Tool call, Permission | "Allowed by settings rule Bash(bun:*)" | The decision and its source ("Allowed · config"); without OTel, only Denied if there was a denial | No source has the rule name |
| Network call | Request and Response sizes in KB | Tokens, latency, stop reason; status only for errors | Needs a gateway, second wave |
| Network, External | Including npm from `bun install` | Only `WebFetch` and `WebSearch` | Same |
| Latency, durations | Exact | Exact with enrichment, otherwise marked as an estimate | torch is started manually |
| Session without enrichment | None | A mark "no enrichment" or "partial enrichment" in the session header | Same |
| Cost | A number | A dash with a note for an unknown model | Decision 37 |
| Charts and composite bars | Laid out by hand | Carbon Charts: the look of axes, legends, tooltips and the chart toolbar is set by the library; series colours are taken from the mockup | Decision 39 |
| Texts after the transcript is deleted | None | Taken from the database | Decisions 21 and 28 |

There is one theme: light with a dark header.

### 9.4 Atomic design

The interface is assembled from five levels. Dependencies point only downward: a page knows the template, the template knows organisms, an organism knows molecules, a molecule knows atoms.

| Level | Directory | What it is | What it knows | Examples in torch |
|---|---|---|---|---|
| Atom | `components/atoms/` | An indivisible element | Only its own primitive props | Carbon components as is (Button, Tag, TextInput, Search, Checkbox, Icon); our own: `Swatch`, `Meter`, `Mono`, `TimelineMark` |
| Molecule | `components/molecules/` | Several atoms with a single task | Primitives and simple objects, no API types | `StatTile`, `RangeFilter` (Min and Max), `SegmentedControl`, `KeyValue`, `CallRow` |
| Organism | `components/organisms/` | A self-contained screen block | Types from `@contracts`; receives data through props | `AppHeader`, `StatTiles`, `SessionsTable`, `SessionFilters`, `AgentsTable`, `Leaderboard`, `BarChart`, `ProportionChart`, `Timeline`, `DetailPanel` |
| Template | `components/templates/` | A layout with places for organisms | Nothing about data | `AppShell` (header and content area), `SessionLayout` (breadcrumbs, title, Overview and Timeline tabs) |
| Page | `pages/` | A template filled with data | The route, the page address, API requests | The six pages from section 9.1 |

Rules:

- **Data enters from the top.** API requests, state in the page address and the SSE subscription live only in pages. Everything below receives data through props and reports actions through callbacks. This is why `DetailPanel` works the same in the timeline dock and in a separate tab.
- **Carbon provides ready-made atoms.** A Carbon component is used directly; a wrapper over it appears only if it adds behaviour.
- **Styles.** Each component's styles are a CSS module next to it (`Name.module.css`, plain modern CSS); the generated class name is `Name__class`. Atoms and molecules take colours, spacing and fonts from Carbon tokens as `var(--cds-…)`, which the only Sass file, the Carbon entry `styles/index.scss`, emits on `:root`; values from the mockup that are not in the tokens are set in one variables file, `styles/variables.css`, as `--torch-…` custom properties. A component styles another component only through its props (the `panel` variant of `Section`), not through the other's classes; `test/web/styles.test.ts` checks tokens, classes and module names.
- **A component moves up to a shared level at its second consumer.** Until then it lies next to the page or organism that needs it (`pages/<name>/components/`).
- **Charts are Carbon Charts.** A chart is a block with axes or with a legend. A bar inside a table or list row does not count as a chart and stays the `Meter` atom.

  | Mockup block | Organism | Carbon Charts component |
  |---|---|---|
  | Dashboard: Model calls, Tool calls | `BarChart` | `SimpleBarChart` |
  | Dashboard: Token mix; Session detail: Token usage; agent panel: peak context | `ProportionChart` | `MeterChart` in proportional mode |
  | Peak context in the agents table; Calls in the tools table; First / Last / Peak and Tool usage in the panel | — | The `Meter` atom |

  The `BarChart` and `ProportionChart` organisms are the only places where Carbon Charts is imported: they translate data from `@contracts` into the library's format, set the series colours from the mockup and the number format. The worker takes installation, style import and component parameters from the Carbon server's `get_charts` tool, not from memory.
- **The level name is a check.** An atom that needed an API request, or a molecule that needed a response type, is not on its own level.

---

## 10. Order of work

Development is carried out by subagents under the main session's control. The split into packages, file ownership, readiness criteria and the dependency graph are in [packages.md](packages.md).

Work goes in three stages. Within a stage the packages run in parallel; between stages there is a checkpoint on real data.

| Stage | What appears | Checkpoint |
|---|---|---|
| Foundation | The skeleton, contracts, the database schema, test supports, a skeleton of stubs. Written by the main session. | Typecheck and tests are green on the skeleton |
| A | Parser, reducers, indexer, CLI, the Sessions and Session detail screens | K1: the whole history is loaded, any session opens |
| B | Timeline, Detail panel, Dashboard | K2: the timeline and the dashboard on real data |
| C | Live updating, the OTel receiver, hooks, setup, Settings, README | K3: enrichment works on a new session, rollback restores the settings |

Parallelism rests on three things: contracts are written before code, each file belongs to one package, and each layer is tested on its own synthetic data (reducers on assembled transcripts, the API on a filled database, screens on ready-made API responses).

### 10.1 Checks by experiment

Questions that the documentation does not answer. Run by the main session together with the machine owner, in parallel with stage A. The result is an entry in `docs/spikes.md` and, if needed, an edit to the plan.

1. Do the hooks from `~/.claude/settings.json` fire in desktop app sessions.
2. Does a desktop session export OTel logs with the variables from the `env` block.
3. Does Claude Code accept `http://127.0.0.1` as the OTLP address and the `http/json` format.
4. Does `request_id` in `api_request` match the transcript's `requestId`, and `tool_use_id` in `tool_result` match `tool_use.id`.
5. How Claude Code behaves when the receiver is unavailable (noise, delays).
6. The exact format of the `hooks` section in `settings.json` for the current version.
7. What the `attachment` lines with the `instructions` type contain.

If item 1 or 2 is not confirmed for the desktop app, enrichment on this machine will work only for terminal sessions; the rest of the plan does not change.

---

## 11. Testing

Tests are written by the same package as the code; which cases are mandatory for each package is stated in its readiness criterion in [packages.md](packages.md). Below is the overall composition.

- **The core — through tests.** Synthetic transcripts in `test/fixtures/`: one for each line type and for each known version discrepancy. Mandatory cases: a response of several lines with one `requestId`; a call without a result; a denial and an interruption; a subagent and a nested subagent; a compaction; an API error with a retry; a truncated last line; a file appended between passes; a disappeared file; an unknown line type; an unknown model.
- **Merging enrichment.** Synthetic OTLP batches and hooks files: an event earlier than the transcript line, an event without a pair, a duplicate.
- **Real history.** `torch doctor`, output to the terminal only.
- **Setup.** Tests of editing and rollback on a temporary copy of `settings.json`, including a repeated run and a file with someone else's hooks.
- **Interface.** An end-to-end run in the browser: five screens on a database built from synthetic transcripts.

Real transcripts, prompts and user paths do not enter the repository: `.gitignore` covers `*.db`, and `~/.torch` is outside the repository.

---

## 12. Risks

| Risk | What we do |
|---|---|
| The transcript format changes with every version | A tolerant parser, `torch doctor`, the Claude Code version in every session |
| OTel or hooks do not work in the desktop app | Checks by experiment (section 10.1) before stage C; all screens work on transcripts alone |
| The database is the only copy of old sessions | Forward-only migrations, a copy of the database file before every migration |
| The database holds prompts and command outputs | 0600 permissions, `127.0.0.1`, a token with `--host` |
| torch is off while work is going on | An enrichment mark on the session, estimates instead of exact values |
| The retention period is raised too late | `torch setup` appears in stage C; until then the history is limited to what is still on disk, so the initial load is done at checkpoint K1 |
| A contract turned out wrong after packages were launched | The worker returns a change request, only the main session edits; stages B and C start after the contracts are verified on real data |
| A subagent reported readiness but the package is not ready | Acceptance by the branch, not by the report: paths within ownership, typecheck, tests, the package criterion; for the core, an independent reviewer |

---

## 13. Second wave

- A gateway log adapter as the second implementation of the network event source: request sizes, HTTP statuses, an exact context breakdown. First we need to find out which gateway is on the target system and where its logs are.
- The OTel receiver as a separate background service, if gaps in enrichment start to get in the way.
- Linux.
- Several machines in one interface.
- Cloud sessions, when an export appears.
- OTel traces (time to first token).

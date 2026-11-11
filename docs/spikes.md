# torch — experimental checks and findings on real data

Results of the plan.md §10.1 checks and of a structural read of the owner's history. Only field names, line types and counters are recorded here: transcript contents do not enter the repository.

---

## 1. Status of the plan §10.1 checks

| # | Question | Status |
|---|---|---|
| 1 | Do hooks from `~/.claude/settings.json` fire in desktop sessions | Yes, section 8 |
| 2 | Does a desktop session export OTel logs | Yes (2.1.321), section 8 |
| 3 | Does Claude Code accept `http://127.0.0.1` and `http/json` | Yes (CLI 2.1.288), section 8 |
| 4 | Do `request_id` and `tool_use_id` in OTel match the transcript | Yes, they match; tokens too (2.1.321), section 8 |
| 5 | Behavior when the receiver is unavailable | No noise and no delays (CLI 2.1.288 and desktop 2.1.321), section 8 |
| 6 | Format of the `hooks` section for the current version | Verified on 2.1.288 and 2.1.321, section 8 |
| 7 | What `attachment` lines of type `instructions` contain | Verified, section 3 |

---

## 2. Transcript structure (2026-11-09)

Read 1233 files (1002 main, 231 subagent), 105,075 lines, no broken lines. Claude Code versions 2.1.221–2.1.321, all sessions with `entrypoint: claude-desktop`.

### Identifiers

- The `sessionId` of every line matches the file name, `agentId` matches the subagent file name. No exceptions.
- **`requestId`, `tool_use.id` and `uuid` are unique within a session but not across sessions:** 37 `requestId`s, 46 `tool_use.id`s and 220 `uuid`s appear in the files of two sessions (a continued session copies the history of the original). Within one session there are no repeats between agents. Hence the primary key `(session_id, id)` and the panel routes under `/api/sessions/:id/`.
- Copied history is counted in both sessions: each one counts the lines of its own file.

### Model calls

- 45,285 `assistant` lines for 23,579 unique `requestId`s; 13,927 requests are written as several lines.
- **`usage` within one `requestId` differs in 8413 cases:** the input part (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) is the same in all lines, `output_tokens` grows. In all 13,928 multi-line requests the maximum `output_tokens` is in the last line. Rule: the `usage` of a request is taken from its last line.
- 22 lines with `message.model = "<synthetic>"` and `isApiErrorMessage: true`; 14 `assistant` lines have no `requestId`. Every `assistant` line has `usage`.
- **The lines of one request are spread over time.** Of 24,096 requests, 9854 have all lines at the same time, 3597 have a spread under a second, 8686 have 1 to 10 seconds, 1759 have 10 to 60, 200 have more than a minute. The estimate of a call's duration runs to the last line of the response.
- `stop_reason` in the non-last lines of a request is `null`. Values: `tool_use`, `end_turn`, `stop_sequence`, `refusal`.
- Content blocks: `tool_use`, `thinking`, `text`.
- The cache write is broken down into `usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`.

### `user` lines

- `message.content` is a string (2027 lines) or an array of `tool_result`, `text`, `image` blocks.
- Tool result: `tool_use_id`, `is_error`, `content` (a string or an array of blocks).
- `permissionDecision` is an object `{decision, source, reasonType, ruleSource}`. `decision` values: `accept` and `reject`. Pairs across the whole history, including subagent files: `accept`/`config` 1594, `reject`/`config` 13, `reject`/`user_reject` 8, `reject`/`hook` 6, `accept`/`user_temporary` 3.
- A result line always has exactly one `tool_result` block (27,312 lines): results of parallel calls are written as separate lines.
- `toolDenialKind`: `permission-rule`, `user-rejected`, `automode-blocked`, `automode-unavailable`.
- `isMeta: true` on 278 lines.
- **Not every text `user` line is a prompt.** The main files have 1779 lines with text and no tool result: 139 with `isMeta`, 14 with `isCompactSummary` and `isVisibleInTranscriptOnly` (a summary of the compacted context), the remaining 1626 without flags. The `origin` field is present on 623 of them: `origin.kind` = `task-notification` (325, a notification about a finished background task), `human` (288), `peer` (10, a message from another session). Among the lines without flags, the text starts with a service marker in 433 cases: `<task-notification>` 325 (all with `origin`), `<command-message>` 56, `<command-name>` 16, `<local-command-stdout>` 14, `[Request interrupted by user…]` 10, `<system-reminder>` 9, `<bash-input>` 3. The prompt rule (plan §6.2) excludes `isMeta`, `isCompactSummary` and `task-notification`; the other markers (108 lines) are still treated as prompts.
- Attached files are written as `attachment` lines of type `file` (51 lines; keys `filename`, `content`, `displayPath`), not as message blocks. The parser skips them.
- `toolUseResult` is an object, a string (for errors) or an array. Key sets in descending order of frequency:

  | Tool | Keys |
  |---|---|
  | Bash | `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected` and optional ones (`backgroundTaskId`, `returnCodeInterpretation`, `timedOutAfterMs`, …) |
  | Read | `type`, `file` |
  | Edit | `filePath`, `oldString`, `newString`, `originalFile`, `replaceAll`, `structuredPatch`, `userModified` |
  | Write | `type`, `filePath`, `content`, `originalFile`, `structuredPatch`, `userModified` |
  | Agent, background launch (235) | `agentId`, `isAsync`, `status`, `description`, `prompt`, `outputFile`, `canReadOutputFile`, `resolvedModel` |
  | Agent, awaited (7) | `agentId`, `agentType`, `status`, `content`, `prompt`, `totalDurationMs`, `totalTokens`, `totalToolUseCount`, `usage`, `resolvedModel` |
  | Grep | `mode`, `filenames`, `numFiles` and `content`, `numLines` |
  | WebFetch | `url`, `code`, `codeText`, `bytes`, `durationMs`, `result` |
  | WebSearch | `query`, `results`, `durationSeconds`, `searchCount` |

  Subagents are almost always launched in the background: the `Agent` call returns immediately, and the subagent's running time is visible only from its file.

- **Subagent files have no `toolUseResult`.** Of 21,094 result lines in subagent files, the field is absent in 20,439, in 653 it is an error string and in only 2 it is an object. In the main files the field is always present: an object (4203), an array (1204) or a string (258). So for subagent calls there is no structured result data: the file path and URL are taken from the tool input, the duration from the line times, the changed lines are estimated from the input (`old_string` and `new_string` for Edit, `content` for Write).

### Top-level fields

All field names encountered on lines with a message envelope. The decoder treats them as known; the unknown counter gets whatever is not listed here.

| Line type | Fields |
|---|---|
| Common to all | `type`, `uuid`, `parentUuid`, `timestamp`, `sessionId`, `agentId`, `isSidechain`, `cwd`, `gitBranch`, `version`, `entrypoint`, `userType`, `slug` |
| `assistant` | `message`, `requestId`, `isApiErrorMessage`, `apiErrorStatus`, `error`, `errorDetails`, `advisorModel`, `apiBlockIndex`, `attributionAgent`, `attributionMcpServer`, `attributionMcpTool`, `attributionPlugin`, `attributionSkill`, `effort`, `perTurnEffort`, `isAbortedMidStream`, `promptCacheRequested`, `quotaLimits`, `requestRef`, `requestedModel`, `serverClassifierRequest`, `thinkingDisplay`, `thinkingDurationMs`, `toolInputStreamMs`, `wireIngestContext`, `wireToolInputs` |
| `user` | `message`, `toolUseResult`, `permissionDecision`, `toolDenialKind`, `isMeta`, `promptId`, `permissionMode`, `promptSource`, `origin`, `sourceToolAssistantUUID`, `sourceToolUseID`, `isCompactSummary`, `isVisibleInTranscriptOnly`, `interruptedByShutdown`, `imagePasteIds`, `mcpMeta`, `sandboxed`, `toolEndsTurn`, `classifierBoundary`, `classifierMetaLines`, `clientPlatform`, `queueSkipAttachments`, `queueSkipSlashCommands`, `queueTranscriptOnly`, `serverClassifierContext`, `turnAttributionKey`, `turnCompanion`, `turnOrigin`, `turnPosition` |
| `system` | `subtype`, `level`, `content`, `isMeta`, `source`, `error`, `retryAttempt`, `maxRetries`, `retryInMs`, `compactMetadata`, `logicalParentUuid`, `hasOutput`, `hookAdditionalContext`, `hookCount`, `hookErrors`, `hookInfos`, `preventedContinuation`, `stopReason`, `toolUseID` |
| `attachment` | `attachment`, `rendered`, `renderedRole`, `renderedBesideToolResult`, `renderedInHumanTurn` |

The `message` fields of `assistant`: `id`, `type`, `role`, `model`, `content`, `stop_reason`, `stop_sequence`, `stop_details`, `usage`, `container`, `context_management`, `diagnostics`, `input_transformations`.

### Models

Model identifiers in the history, in descending order of call count: `claude-opus-5`, `claude-fable-5`, `claude-fable-5-1`, `claude-opus-5-5`, `claude-opus-4-8`, `claude-fable-5-2`, `claude-haiku-5-5`, `claude-haiku-4-5-20251001` (with a date suffix), and also `<synthetic>`.

### Service lines

- `system/api_error` (14, main files only): `error` is an object `{message, formatted, connection, isNetworkDown, rateLimits}`, sometimes with `noResponse`. There is no HTTP status, neither as a separate field nor in the text: all 14 lines are connection errors. Alongside are `retryAttempt`, `maxRetries`, `retryInMs`.
- A final API refusal is written as an `assistant` line with `isApiErrorMessage: true` and the model `<synthetic>` (16 lines): it has `error` (a string) and, in half of them, `apiErrorStatus` (a number, the HTTP status). These lines are also API errors, with a known status.
- `cost-state` has, besides what is listed below, `startTime`, `totalDuration`, `totalAPIDuration`, `totalAPIDurationWithoutRetries`, `totalToolDuration`, `totalLinesAdded`, `totalLinesRemoved`, `hasUnknownModelCost`.
- `system/compact_boundary` (13): `compactMetadata` with `trigger`, `preTokens`, `postTokens`, `durationMs`, `cumulativeDroppedTokens`.
- `custom-title` (`customTitle`), `ai-title` (`aiTitle`), `cost-state` (34: `totalCostUSD`, `modelUsage.<model>.{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, thinkingTokens, costUSD}`) — without a message envelope and without a time, only `sessionId`.
- The other line types encountered are skipped by torch; their list is `IGNORED_LINE_TYPES` in `src/contracts/lines.ts`.

### Files next to the transcript

- `agent-<id>.meta.json`: always `agentType`, `description`, `toolUseId`, `spawnDepth`; sometimes `model`, `parentAgentId`, worktree fields.
- `custom-title.json` exists for 9 sessions; there are 1325 `custom-title` lines in the transcripts.
- Desktop app metadata: 30 files; `titleSource` takes `auto`, `user`, `tool`.

---

## 3. Check 7: `attachment` lines with instructions

Instructions are written as lines of two types (85 and 63 lines across the whole history, mostly in subagent files):

- `attachment.type = "instructions"`: `attachment.files[]`, each file has `path`, `type` and `content`.
- `attachment.type = "nested_memory"`: `attachment.path`, `attachment.displayPath`, `attachment.content` with `path`, `type`, `content`.

The file content lies in the line in full, so the size and token estimate are computed from the transcript without hooks. Package I2 fills `instructions_loaded` from both line types; hooks add the load reason (`load_reason`), which the transcript lacks.

---

## 4. What changed in the plan because of the findings

| Finding | Change |
|---|---|
| Identifiers are unique only within a session | The primary key of the event tables is `(session_id, id)`; panel routes are under `/api/sessions/:id/` (plan §5, §8) |
| `usage` differs within a request | Taken from the last line of the request (plan §3.1) |
| Estimating a model call's duration needs the time of the previous line of the file | Column `source_files.last_event_ts` (plan §5) |
| Instructions are in the transcript with their content | I2 does not wait for hooks (packages §5) |
| Subagent files have no `toolUseResult` | I1 takes the path, URL and estimate of changed lines from the tool input when there is no structured result (plan §6.2) |
| The API error status exists only on `assistant` lines with `isApiErrorMessage` | They are written to `api_errors` on a par with `system/api_error` lines (plan §3.1) |
| Background task notifications and compacted context summaries are written as `user` lines | The prompt rule in plan §6.2; fields `UserLine.isCompactSummary` and `originKind` |
| `permissionDecision.decision` takes `accept` and `reject` | A refusal is `reject` (constant `PERMISSION_REJECT`) |
| The lines of one response are spread over time | The model call duration estimate runs to the last line of the response (plan §6.2) |

---

## 5. Run of the P1 parser on the real history (2026-11-09)

1237 files, 106,073 lines in 0.6 seconds; no exceptions, no unknown line types. Unknown fields are only the extra `cost-state` fields listed in section 2.

---

## 6. Checkpoint K1 (2026-11-09)

Run on the real history with the owner's consent. The database is `~/.torch/torch.db`, 111 MB, permissions 0600.

### Loading

- `torch doctor`: 1248 files (1002 main, 246 subagent), 109,881 lines; no unknown line types or fields. The file count matches `find … -name '*.jsonl'`.
- `torch index`: initial load 12 seconds, no errors. A repeat pass takes 0.4 seconds, "sessions changed: 0".
- In the database: 1002 sessions (832 in temporary directories), 1248 agents, 24,229 model calls, 27,267 tool calls, 1260 prompts, 9546 messages, 55,050 bodies (94 MB uncompressed, 54 MB in the database).

### Convergence

- The totals of every session equal the number of its call lines; the sum of the context breakdown categories equals the peak for every agent.
- All 1002 sessions open through the API: the list (170 without temporary directories, 4 pages; 1002 with them, 21 pages), the overview and the export; the overview numbers match the database. Sorting by every column responds 200. The overview takes 0.2 ms on average, the export of the largest session 31 ms.
- The built UI on real data: the list, paging and the overview render without errors and without `NaN`.
- All nine models of the history are in the price table; there are no sessions without a cost. Total across the list: 4.66 billion tokens (4.55 billion of them cache reads), $3969 at list price.
- Subagents: 243 at depth 1, 3 at depth 2; none unlinked.
- Tool statuses: ok 26,347, error 701, denied 217, pending 2. An exact duration from the result exists for 28 calls.
- API errors: 30 lines, 8 of them with a status (429 and 529).

### Findings

- **Names of sessions started by a command.** For 54 sessions without an `ai-title`, the first prompt is a command invocation written with the tags `command-message`, `command-name`, `command-args`. The name and text of such a prompt are now "/name arguments". Local command output (`<local-command-stdout>`), shell commands (`<bash-input>`) and the `[Request interrupted by user…]` marker are not prompts.
- **The main agent's running time** ran over the whole file: up to 440 hours. Now it equals the session's active time; for a subagent it is the interval of its file.
- **Active time includes waiting for the user's reply within a turn.** The sum across the history is 124.6 hours; 8 sessions are longer than 2 hours, the longest is 36 hours. For two sessions (12.2 and 11.5 hours) almost all the time is a single tool call whose result arrived 11–12 hours later: a permission request or a question left unanswered. Background task notifications barely affect the total: if they are counted as the start of a segment, the sum drops to 120.6 hours. If pauses between neighboring events longer than 5 minutes are not counted, the sum is 91.9 hours. The rule has not changed: decision 30 is up to the owner.
- **`cost-state` is not suitable for reconciliation.** The line exists for 14 sessions; in 8 of them the cost is zero and `modelUsage` is empty despite tens of millions of tokens in the transcript, in 3 the sum matches the calculation within 2%, in 3 it exceeds the calculation by 1.7–4.5 times (it looks like accumulation per process, not per session). `cost_reported_usd` is stored, the UI does not show it.
- **Model time is greater than Duration** for sessions with parallel subagents: call durations are summed across all agents. In the overview the label "of model time" then reads as a part of Duration.
- **A continued session:** 37 `requestId`s appear in two sessions; 4.3 million tokens out of 4.66 billion are counted twice.
- Sessions without a start: 2, without model calls: 3, without a name: 1; these are sessions from files with no substantive lines.

---

## 7. Checkpoint K2 (2026-11-09)

Stage B is merged: A2, A3, W4, W5, W6. Checked on the owner's real database (1002 sessions), only counters, times and sizes.

### Timeline and panels through the API

- The timeline is served for all 1002 sessions. The largest session (8312 model calls, 9513 tool calls, 110 agents, 2382 file operations): 59 ms, 3.67 MB of JSON.
- Gaps: 141 in 24 sessions; they do not overlap and lie inside the session in every case. For the longest session 440 hours from start to end collapse into 36 hours of axis (43 gaps), for the largest 92 hours collapse into 31 (22 gaps).
- The number of marks of every track matches the session totals for all 1002 sessions.
- Panels: 1014 requests across 65 sessions (agents, tool calls, prompts, files, model calls, API errors, external requests) — all 200, the slowest 10 ms, the largest response 289 KB.
- Bodies: 688 links to tool call input and output — every body is served in full and matches in size; 95 have a truncated start (the "Show all" button is needed).
- There are no calls in the database whose end is earlier than the start (a clock jump).

### Dashboard through the API

- The totals of every range equal the sum over the session list with the same filters, with and without temporary directories.
- Response: 1–6 ms for a day, week and month, 30 ms for a year (168 sessions, 23.8 thousand model calls).
- Calls "by call time" and "by sessions started in the window" match in all ranges on the current data: long sessions lie more than 30 days from today. A discrepancy will appear when a session starts before the window and continues in it.

### UI on real data

Checked by counters through the DOM, without screenshots and without reading text.

- The timeline of the largest session opens: the DOM has 2316 marks out of 20 thousand at Fit, 44 gap bands; in Expanded at 4× with a selection from the address — 532 marks, the selected one is marked, and the dock has a tool call panel with two bodies.
- A nonexistent session: the overview and the timeline show an error message with a Retry button, the application does not crash.
- The dashboard for a year: six tiles, 24 bars, five tops of five links each, 102 rows in the tools table (many MCP tools).

### Not checked

- The tooltip on hovering over a chart bar.
- Smoothness of timeline scrolling on a real session in a browser window: the worker's and reviewer's measurements were made on synthetic data in headless Chrome.
- "Show all" on a truncated body by clicking.

---

## 8. Experimental checks 1–6 (2026-11-10)

Carried out with the owner's consent: a temporary edit of `~/.claude/settings.json` (telemetry, log export, five hooks), copy at `~/.torch/backups/settings.json.2026-11-10-before-spikes`; the edit was made twice, both times the file was restored and matches the copy byte for byte. The OTLP receiver and the hooks handler lived in the session's temporary directory; from what was recorded, only field names, event kinds and identifiers were read.

Versions: desktop sessions — Claude Code 2.1.321 (`entrypoint: claude-desktop`), CLI from Homebrew — 2.1.288. The CLI on the owner's machine is not authenticated (OAuth expired), so there are no model requests through it: on the CLI everything that does not need a model response was checked.

### Hooks (checks 1 and 6)

- Format: `"hooks": { "<Event>": [ { "hooks": [ { "type": "command", "command": "<path>" } ] } ] }`. `matcher` is optional: without it the handler receives all cases of the event.
- In the desktop session 2.1.321, `InstructionsLoaded` and `SessionStart` fired; in CLI 2.1.288 — the same two and `SessionEnd`.
- `SessionEnd` does not arrive in a desktop session after a turn: the session process lives between turns. For desktop sessions the end of a session is visible through hooks only when it is closed.
- `PreCompact` and `PostCompact` do not occur in a short session: their stdin format is not confirmed by experiment.
- stdin fields. Common: `session_id`, `transcript_path`, `cwd`, `hook_event_name`; in the desktop session also `scratchpad_dir`. `SessionStart`: `source` (`startup`); the `model` field was absent in both versions. `SessionEnd`: `reason` (`other`), `prompt_id`. `InstructionsLoaded`: `file_path`, `memory_type` (`Project`), `load_reason` (`session_start`).

### OTel (checks 2, 3, 5)

- **Telemetry is off for the owner:** `CLAUDE_CODE_ENABLE_TELEMETRY` is `"0"`, while `OTEL_METRICS_EXPORTER=otlp` is set without a protocol and an address. plan §7.1 assumed the value was already `"1"`.
- **A metrics exporter without a protocol breaks all of telemetry.** With `CLAUDE_CODE_ENABLE_TELEMETRY=1` and `OTEL_METRICS_EXPORTER=otlp` without `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` (or the common `OTEL_EXPORTER_OTLP_PROTOCOL`), initialization fails with "Unknown protocol" and all log events are dropped ("no event logger initialized"). The error is visible only in the debug log. With a protocol and an address for metrics, logs and metrics are sent.
- **`http://127.0.0.1` and `http/json` are accepted** (CLI 2.1.288). Requests: `POST /otlp/v1/logs` and `POST /otlp/v1/metrics`, `content-type: application/json`, no compression. The path from the variable is used as is.
- **The `env` block reaches the desktop session:** in its environment `CLAUDE_CODE_ENABLE_TELEMETRY=1`. `OTEL_*` variables do not get into the environment of Bash commands. The environment is read when the session process starts: an already open desktop session does not pick up an `env` edit even on subsequent turns.
- **The desktop session exports logs and metrics** (2.1.321) when initialization succeeds: the second test session sent events to the same addresses. The first started with settings on which initialization fails and sent nothing.
- **Unavailable receiver** (CLI 2.1.288, closed port): the command output is the same, the time is the same (3.95 s against 3.97 s), the debug log has two `ECONNREFUSED` error lines. Events are lost, no retries are visible.
- **Unavailable receiver in a desktop session** (2.1.321): the same turn with the receiver stopped took the same time — response after 1.75 s against 1.84 s, end of turn after 3.96 s against 4.44 s. There are no error messages in the session.

### Identifier matching (check 4)

Desktop session 2.1.321: two model calls and one `Read` call.

- The `request_id` of both `api_request` events equals the `requestId` of the transcript's `assistant` lines.
- The `tool_use_id` of the `tool_decision` and `tool_result` events equals the `id` of the `tool_use` block; both events also carry the `request_id` of the model call that requested the tool.
- The `api_request` tokens (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`) equal the transcript's `usage`.
- `api_request`: `model`, tokens by kind, including `cache_creation_5m_tokens` and `cache_creation_1h_tokens`, `cost_usd`, `cost_usd_micros`, `duration_ms`, `ttft_ms`, `request_id`, `client_request_id`, `speed`, `query_source`, `effort`. Time to first token arrives in logs without beta traces.
- `tool_decision`: `decision` (`accept`), `source` (`config`), `tool_name`, `tool_use_id`, `tool_source`, `permission_mode`, `request_id`.
- `tool_result`: `tool_name`, `tool_use_id`, `success`, `duration_ms`, `tool_input_size_bytes`, `tool_result_size_bytes`, `request_id`.
- Events of the main agent have no `agent_id` and `parent_agent_id` attributes.

### What arrives in logs

- The CLI 2.1.288 resource: `service.name=claude-code`, `service.version`, `host.arch`, `os.type`, `os.version`. The desktop session resource: `service.name=claude-code-desktop`, `service.version` is the app version, not the Claude Code version, plus `claude.deployment_mode` and `process.owner`; the same keys are repeated in the attributes of every event together with `anthropic.provider`, `anthropic.custom_base_url`, `anthropic.plan`. Scope: `com.anthropic.claude_code.events`.
- Event name: the `event.name` attribute carries the short name (`api_error`), the record body the full one (`claude_code.api_error`).
- Attributes common to every event: `session.id`, `event.timestamp`, `event.sequence`, `terminal.type`, and also `user.id`, `user.email`, `user.account_uuid`, `user.account_id`, `organization.id`. The torch receiver does not need personal attributes: E1 does not store them.
- Besides the events from plan §3.3, service events arrive: `managed_settings_resolved`, `hook_registered`, `hook_execution_start`, `hook_execution_complete`, `plugin_loaded`, `mcp_server_connection`, `user_prompt`, `assistant_response`. `user_prompt` has the attributes `prompt` and `prompt_text`, `assistant_response` has `response`; by default they contain a placeholder, and the lengths arrive separately (`prompt_length`, `response_length`). The receiver does not store these attributes.
- `api_error` without a server response: `model`, `error`, `duration_ms`, `attempt`, `speed`, `query_source`, `prompt.id`; `request_id` and `status_code` are absent.
- Metrics: `claude_code.session.count`, `claude_code.active_time.total`.

### Consequences for stage C

- **S1.** `torch setup` changes `CLAUDE_CODE_ENABLE_TELEMETRY` from any value to `"1"` and remembers the previous one for rollback. If `OTEL_METRICS_EXPORTER` is set and there is no protocol for metrics, editing the logs alone is not enough: the owner's decision is needed (handoff, "Waiting for the owner's word after K1").
- **E1.** The receiver answers 200 on `/otlp/v1/logs`; it takes the event name from `event.name`; it drops personal attributes and prompt text; it stores unknown events as is, and the merge marks them applied with no action.
- **E2.** Matching by `request_id` and `tool_use_id` is confirmed. `ttft_ms` is in `api_request`: beta traces are not needed for time to first token.

---

## 9. Checkpoint K3 (2026-11-10)

Stage C is merged: S1, E1, E2, L1, W7, T1, D1. Checked on the owner's real database and real `~/.claude/settings.json`, with his consent for every step; only counters, names, types and times. The server is `bun run dev:server`, started by the owner himself on port 4820.

### Indexer and database

- Migration 002 was applied when the database was opened. A copy `~/.torch/backups/torch.db.before-k3` was taken before the check.
- 1272 files, 1009 sessions: the first pass after startup took 438 ms (the external subagent data is applied anew once), passes without changes 43–45 ms.
- Cost recalculation from Settings with the same table: 477 ms for 25,267 model calls and 1009 sessions; the totals by calls and by sessions before and after match.

### Setup and rollback

- `torch setup` on the real file: telemetry `"0"` → `"1"`, three log variables, the protocol and address for metrics (the rule for `OTEL_METRICS_EXPORTER` without a protocol fired), five hooks; `cleanupPeriodDays: 365` untouched. A repeat run reports "already configured".
- `torch uninstall`: the file matched byte for byte both the copy from before `setup` and the copy from before the F6 checks. A repeat run reports "nothing to roll back". The copy of the handler `~/.torch/hooks/record.sh` and the settings copies remain.

### Enrichment on a new desktop session (2.1.321)

A session of two model calls and one `Read` call, started after `setup`.

- Received 37 OTel events and 2 hooks events (`InstructionsLoaded`, `SessionStart`); the spool is empty; the session has no pending events. No event in the database carries attributes from `OTEL_DROPPED_ATTRS`.
- Both model calls: `duration_exact = 1`, `query_source = sdk`, the session has `model_ms_exact = 1`. The `Read` call: `duration_exact = 1`, `permission_decision = accept`, `permission_source = config`.
- The instruction from the transcript received `load_reason = session_start` from the hook; no separate hook record is left.
- The enrichment mark is `full`; for the other 1009 sessions it is `none`.
- The session is visible in the list and opens in the overview and on the timeline through the API of the running server; the channels on the Settings screen are "configured", with the time of the last event.
- Attribute value types: tokens, cost, `ttft_ms` are numbers; `duration_ms` is a number in `api_request` and a string in `tool_result`; `success`, `tool_input_size_bytes`, `tool_result_size_bytes` are strings. Parsing of both kinds works.
- About 27 service events per session arrive (`plugin_loaded`, `hook_registered`, `hook_execution_*` and others): they are stored and marked applied with no action.

### Findings and fixes

- **Model call mark on the timeline.** The exact duration (1564 ms) is shorter than the transcript estimate (1587 ms): a mark from the estimated start ended before the response. Now a call with an exact duration is counted from the end of the response (`api/timeline.ts`).
- **A database copy** via `VACUUM INTO` is created with permissions 0644: tightened by hand to 0600. If database copies appear in the product, the permissions are set at creation.
- The owner's server with `--watch` restarted on every code edit: the receiver windows turn out short, and reception is interrupted for seconds. This does not apply to `torch start` without `--watch`.

### Not checked

- `PreCompact`, `PostCompact` and `SessionEnd` from a real Claude Code: they do not occur in a short session, and a desktop session does not end after a turn.
- Subagent events: whether the `agent_id` of a hooks event matches the agent identifier in the file name.
- API errors from two sources on real data.
- The session appearing in an open UI by eye: checked by an end-to-end run on synthetic data and by API requests to the real server.
- The merge pair windows (5 and 10 minutes) on real data.

---

## 10. Transcripts through a gateway (2026-11-10)

Measured on the owner's machine, where Claude Code talks to the API through an AWS Bedrock / corporate gateway. torch indexed the history without a single error, and the result was empty. Counters only: shapes and numbers, no contents.

### Database after a pass

| Counter | Value |
|---|---|
| Sessions | 176 |
| `model_calls` | 0 |
| Sessions with `primary_model` | 0 |
| Sessions with `tok_total` > 0 | 0 |
| Agents with `ctx_peak` / `ctx_window` | 0 of 397 |
| OTel `api_request` events | 208, none with `request_id` or `client_request_id` |

### Transcripts

| Counter | Value |
|---|---|
| Assistant lines, main files | 14,297 |
| Assistant lines, `subagents/` | 7,793 |
| Lines with `requestId` | 0 |
| Lines with `requestRef` | 3,876 |
| `message.id` | `msg_bdrk_…` |

| Model in `message.model` | Lines |
|---|---|
| `claude-align-aws-opus-5-5` | 14,250 |
| `claude-align-aws-sonnet-5-5` | 1,322 |
| `claude-opus-5-5` | 222 |
| `<synthetic>` | 13 |

OTel names the models without the `claude-` prefix: `align-aws-haiku-4-5`.

### What follows

- A model call was a unique `requestId`: without it there are no calls, so no tokens, no cost, no model and no context. Through the gateway the lines of one response share `message.id`.
- The price table does not know gateway names: even with calls the cost and the window would be NULL. The name has to be reduced to the table's (`claude-align-aws-opus-5-5` → `claude-opus-5-5`).
- `api_request` cannot be joined by `request_id`; only by model, end time and token counts.
- 1,235 green tests did not notice: all synthetic data had the direct-API shape. The transcript builder now writes gateway-shaped lines (`gateway` option).
- Decision 40: provider plugins, `src/providers/`, selected by `config.provider`. `torch doctor` counts the model responses the configured provider gives no call key.
- `requestRef` (3,876 lines) and `client_request_id` are not used: no event on this machine carries `client_request_id`.

// Parsed transcript lines: the result of `parseLine` (src/ingest/parse.ts).
// The transcript format is internal and changes between Claude Code versions. A summary of the structure
// of real data (field names and counts) is in docs/spikes.md.

/** Fields shared by lines with a message envelope. Time is epoch milliseconds, UTC. */
export interface LineEnvelope {
  uuid: string | null;
  parentUuid: string | null;
  timestamp: number | null;
  sessionId: string | null;
  /** Present only in subagent files. */
  agentId: string | null;
  isSidechain: boolean;
  cwd: string | null;
  gitBranch: string | null;
  /** Claude Code version. */
  version: string | null;
  entrypoint: string | null;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** `cache_creation_input_tokens`: the sum of the 5-minute and the 1-hour cache writes. */
  cacheWriteTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** `output_tokens_details.thinking_tokens`; null if the field is absent. Included in outputTokens. */
  thinkingTokens: number | null;
}

export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

/**
 * One `assistant` line carries one content block. An API response of several blocks is written as
 * several lines with the same `requestId`; their input part of `usage` is identical, while
 * `outputTokens` grows, and the total is in the last line of the request.
 */
export interface AssistantLine extends LineEnvelope {
  kind: "assistant";
  requestId: string | null;
  messageId: string | null;
  model: string | null;
  stopReason: string | null;
  usage: Usage | null;
  blocks: AssistantBlock[];
  /** A line-message about a final API failure, appended by Claude Code (model `<synthetic>`). */
  isApiErrorMessage: boolean;
  /** The `error` field of such a line: the kind of error. */
  apiError: string | null;
  /** The `apiErrorStatus` field: HTTP status; not every error line has it. */
  apiErrorStatus: number | null;
}

export interface ToolResultBlock {
  toolUseId: string;
  isError: boolean;
  /** The text the model saw; non-text blocks are replaced with a marker like `[image]`. */
  text: string;
}

/** Fields of `permissionDecision` of a result line. */
export interface PermissionDecision {
  decision: string;
  source: string | null;
  reasonType: string | null;
}

/** The normalized part of `toolUseResult`: what the reducers need, not the whole structure. */
export interface ToolUseResultInfo {
  /** `durationMs` or `totalDurationMs`, if present. */
  durationMs: number | null;
  interrupted: boolean;
  /** `agentId` of an Agent call result: the link to the subagent file. */
  agentId: string | null;
  filePath: string | null;
  /** From `structuredPatch` of Edit and Write. */
  linesAdded: number | null;
  linesRemoved: number | null;
  webFetch: { url: string; code: number | null; bytes: number | null; durationMs: number | null } | null;
  webSearch: { query: string; durationSeconds: number | null } | null;
}

/** A `user` line: the user's prompt or tool results. */
export interface UserLine extends LineEnvelope {
  kind: "user";
  /** Message text (a string or joined text blocks); null if there is no text. */
  text: string | null;
  /** Number of image blocks in the message. */
  images: number;
  toolResults: ToolResultBlock[];
  toolUseResult: ToolUseResultInfo | null;
  permissionDecision: PermissionDecision | null;
  /** `permission-rule`, `user-rejected`, `automode-blocked`, … */
  toolDenialKind: string | null;
  /** A service message not typed by the user. */
  isMeta: boolean;
  /** Summary of the compacted context, inserted by Claude Code after compaction. */
  isCompactSummary: boolean;
  /** `origin.kind`: who sent the message — `human`, `task-notification`, `peer`; null in versions without the field. */
  originKind: string | null;
  promptId: string | null;
}

/** A `system` line with the `api_error` subtype. */
export interface ApiErrorLine extends LineEnvelope {
  kind: "api_error";
  /** `error.message`. */
  error: string;
  /** HTTP status, if it can be extracted from the line; otherwise null. */
  statusCode: number | null;
  retryAttempt: number | null;
  maxRetries: number | null;
  retryInMs: number | null;
}

/** A `system` line with the `compact_boundary` subtype. */
export interface CompactBoundaryLine extends LineEnvelope {
  kind: "compact_boundary";
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
  durationMs: number | null;
}

export interface CustomTitleLine {
  kind: "custom_title";
  sessionId: string | null;
  title: string;
}

export interface AiTitleLine {
  kind: "ai_title";
  sessionId: string | null;
  title: string;
}

export interface CostStateModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

/** A ready-made session cost; rare. */
export interface CostStateLine {
  kind: "cost_state";
  sessionId: string | null;
  totalCostUsd: number;
  modelUsage: Record<string, CostStateModelUsage>;
}

export interface InstructionFile {
  path: string;
  /** The file's `type` from the line: the memory kind (User, Project, …). */
  memoryType: string | null;
  /** Content size in bytes; the content itself is not copied. */
  bytes: number;
}

/** `attachment` lines with the types `instructions` and `nested_memory`: loaded instructions. */
export interface InstructionsLine extends LineEnvelope {
  kind: "instructions";
  files: InstructionFile[];
}

/** A known line type that torch does not use (`IGNORED_LINE_TYPES`). */
export interface IgnoredLine {
  kind: "ignored";
  type: string;
}

/** A line type that is neither among the parsed nor among the skipped ones; also broken JSON. */
export interface UnknownLine {
  kind: "unknown";
  /** Value of the `type` field (for `attachment` and `system`, with the subtype after `/`); `<invalid>` for a broken line. */
  type: string;
}

export type ParsedLine =
  | AssistantLine
  | UserLine
  | ApiErrorLine
  | CompactBoundaryLine
  | CustomTitleLine
  | AiTitleLine
  | CostStateLine
  | InstructionsLine
  | IgnoredLine
  | UnknownLine;

export type ParsedLineKind = ParsedLine["kind"];

/**
 * Line types seen in real history that torch deliberately skips.
 * For `attachment` and `system` it is `type/subtype`. A type outside this list and outside the parsed ones is unknown.
 */
export const IGNORED_LINE_TYPES = [
  "queue-operation",
  "last-prompt",
  "atis-latch",
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "bridge-session",
  "mode",
  "agent-name",
  "relocated",
  "frame-link",
  "artifact-autoreact-ledger",
  "artifact-comment-monitor",
  "file-history-snapshot",
  "file-history-delta",
  "tools-used",
  "system/stop_hook_summary",
  "system/local_command",
  "attachment/total_tokens_reminder",
  "attachment/batching_reminder_sent",
  "attachment/deferred_tools_delta",
  "attachment/deferred_tools_record",
  "attachment/mcp_instructions_delta",
  "attachment/agent_listing_delta",
  "attachment/skill_listing",
  "attachment/edited_text_file",
  "attachment/task_reminder",
  "attachment/environment",
  "attachment/silent_turn_reminder",
  "attachment/queued_command",
  "attachment/command_permissions",
  "attachment/prompt_snapshot",
  "attachment/session_context",
  "attachment/date",
  "attachment/date_change",
  "attachment/auto_mode",
  "attachment/auto_mode_exit",
  "attachment/file",
  "attachment/remote_session_change",
  "attachment/model",
  "attachment/language",
  "attachment/hook_additional_context",
  "attachment/hook_success",
  "attachment/compact_file_reference",
  "attachment/credential_org",
  "attachment/read_truncation_notice",
  "attachment/task_status",
  "attachment/goal_status",
  "attachment/critical_system_reminder",
  "attachment/invoked_skills",
  "attachment/thinking_stripped",
] as const;

/** `agent-<agentId>.meta.json` next to the subagent transcript. */
export interface AgentMeta {
  agentType: string | null;
  description: string | null;
  /** `tool_use.id` of the parent Agent call. */
  toolUseId: string | null;
  spawnDepth: number | null;
  /** Not present in all versions. */
  model: string | null;
  parentAgentId: string | null;
}

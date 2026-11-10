// Tolerant decoders for transcript lines. Package P1.
// The format is internal and changes between Claude Code versions, so the decoder requires nothing:
// a field of the wrong shape is read as absent, an unfamiliar line type and broken JSON yield
// `kind: "unknown"`, an unfamiliar top-level field ends up in `unknownFields`.
import {
  IGNORED_LINE_TYPES,
  type ApiErrorLine,
  type AssistantBlock,
  type AssistantLine,
  type CompactBoundaryLine,
  type CostStateLine,
  type CostStateModelUsage,
  type InstructionFile,
  type InstructionsLine,
  type LineEnvelope,
  type ParsedLine,
  type ParsedLineKind,
  type PermissionDecision,
  type ToolResultBlock,
  type ToolUseResultInfo,
  type Usage,
  type UserLine,
} from "../contracts/lines.ts";
import type { ParseLine, ParseResult, UnknownStats } from "../contracts/pipeline.ts";

type Raw = Record<string, unknown>;

const obj = (value: unknown): Raw | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw) : null);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// ── Known top-level fields (docs/spikes.md §2) ──────────────────────────────────────────────

const COMMON_FIELDS = ["type", "uuid", "parentUuid", "timestamp", "sessionId", "agentId", "isSidechain", "cwd", "gitBranch", "version", "entrypoint", "userType", "slug"];

const known = (...fields: string[]) => new Set([...COMMON_FIELDS, ...fields]);

const ASSISTANT_FIELDS = known(
  "message", "requestId", "isApiErrorMessage", "apiErrorStatus", "error", "errorDetails", "advisorModel", "apiBlockIndex",
  "attributionAgent", "attributionMcpServer", "attributionMcpTool", "attributionPlugin", "attributionSkill", "effort", "perTurnEffort",
  "isAbortedMidStream", "promptCacheRequested", "quotaLimits", "requestRef", "requestedModel", "serverClassifierRequest",
  "thinkingDisplay", "thinkingDurationMs", "toolInputStreamMs", "wireIngestContext", "wireToolInputs",
);

const USER_FIELDS = known(
  "message", "toolUseResult", "permissionDecision", "toolDenialKind", "isMeta", "promptId", "permissionMode", "promptSource", "origin",
  "sourceToolAssistantUUID", "sourceToolUseID", "isCompactSummary", "isVisibleInTranscriptOnly", "interruptedByShutdown", "imagePasteIds",
  "mcpMeta", "sandboxed", "toolEndsTurn", "classifierBoundary", "classifierMetaLines", "clientPlatform", "queueSkipAttachments",
  "queueSkipSlashCommands", "queueTranscriptOnly", "serverClassifierContext", "turnAttributionKey", "turnCompanion", "turnOrigin", "turnPosition",
);

const SYSTEM_FIELDS = known(
  "subtype", "level", "content", "isMeta", "source", "error", "retryAttempt", "maxRetries", "retryInMs", "compactMetadata",
  "logicalParentUuid", "hasOutput", "hookAdditionalContext", "hookCount", "hookErrors", "hookInfos", "preventedContinuation", "stopReason", "toolUseID",
);

const ATTACHMENT_FIELDS = known("attachment", "rendered", "renderedRole", "renderedBesideToolResult", "renderedInHumanTurn");

// ── Shared parts ────────────────────────────────────────────────────────────────────────────

function timestamp(value: unknown): number | null {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

function envelope(row: Raw): LineEnvelope {
  return {
    uuid: str(row.uuid),
    parentUuid: str(row.parentUuid),
    timestamp: timestamp(row.timestamp),
    sessionId: str(row.sessionId),
    agentId: str(row.agentId),
    isSidechain: row.isSidechain === true,
    cwd: str(row.cwd),
    gitBranch: str(row.gitBranch),
    version: str(row.version),
    entrypoint: str(row.entrypoint),
  };
}

// ── assistant ───────────────────────────────────────────────────────────────────────────────

function decodeUsage(value: unknown): Usage | null {
  const usage = obj(value);
  if (!usage) return null;
  const split = obj(usage.cache_creation);
  const write5m = num(split?.ephemeral_5m_input_tokens) ?? 0;
  const write1h = num(split?.ephemeral_1h_input_tokens) ?? 0;
  const write = num(usage.cache_creation_input_tokens) ?? write5m + write1h;
  return {
    inputTokens: num(usage.input_tokens) ?? 0,
    outputTokens: num(usage.output_tokens) ?? 0,
    cacheReadTokens: num(usage.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: write,
    // Anything not named hourly counts as five-minute (the default cache TTL): without a breakdown
    // or with an incomplete one the entry would otherwise drop out of the cost, which is computed by TTL.
    cacheWrite5mTokens: Math.max(0, write - write1h),
    cacheWrite1hTokens: write1h,
    thinkingTokens: num(obj(usage.output_tokens_details)?.thinking_tokens),
  };
}

/** A block of an unfamiliar type is skipped: reducers do not need it. */
function decodeAssistantBlock(value: unknown): AssistantBlock[] {
  const block = obj(value);
  if (block?.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
  if (block?.type === "thinking" && typeof block.thinking === "string") return [{ type: "thinking", thinking: block.thinking }];
  if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
    return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
  }
  return [];
}

function decodeAssistant(row: Raw): AssistantLine {
  const message = obj(row.message);
  return {
    kind: "assistant",
    ...envelope(row),
    requestId: str(row.requestId),
    messageId: str(message?.id),
    model: str(message?.model),
    stopReason: str(message?.stop_reason),
    usage: decodeUsage(message?.usage),
    blocks: arr(message?.content).flatMap(decodeAssistantBlock),
    isApiErrorMessage: row.isApiErrorMessage === true,
    apiError: str(row.error),
    apiErrorStatus: num(row.apiErrorStatus),
  };
}

// ── user ────────────────────────────────────────────────────────────────────────────────────

/** The content of a result is a string or an array of blocks; a non-text block is replaced by a `[type]` marker. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content)
    .map((value) => {
      const block = obj(value);
      return block?.type === "text" && typeof block.text === "string" ? block.text : `[${str(block?.type) ?? "unknown"}]`;
    })
    .join("\n");
}

function decodeToolResult(block: Raw): ToolResultBlock[] {
  if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") return [];
  return [{ toolUseId: block.tool_use_id, isError: block.is_error === true, text: toolResultText(block.content) }];
}

/** The number of lines in a text; a trailing newline does not count as a line. */
export function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function patchLines(result: Raw): { added: number; removed: number } | null {
  if (!Array.isArray(result.structuredPatch)) return null;
  // A new Write file is recorded without a patch: all of its content was added.
  if (result.structuredPatch.length === 0 && result.type === "create") return { added: countLines(str(result.content) ?? ""), removed: 0 };
  const lines = result.structuredPatch.flatMap((hunk) => arr(obj(hunk)?.lines));
  const startsWith = (sign: string) => lines.filter((line) => typeof line === "string" && line.startsWith(sign)).length;
  return { added: startsWith("+"), removed: startsWith("-") };
}

/**
 * A result line does not name the tool, so the kind of result is recognized by keys:
 * WebFetch — `url` together with `code` or `bytes`, WebSearch — `query` together with `results`.
 */
function decodeToolUseResult(value: unknown): ToolUseResultInfo | null {
  const result = obj(value);
  if (!result) return null;
  const patch = patchLines(result);
  const url = str(result.url);
  const query = str(result.query);
  return {
    durationMs: num(result.durationMs) ?? num(result.totalDurationMs),
    interrupted: result.interrupted === true,
    agentId: str(result.agentId),
    // For Edit and Write the path is in `filePath`, for Read it is in `file.filePath`.
    filePath: str(result.filePath) ?? str(obj(result.file)?.filePath),
    linesAdded: patch?.added ?? null,
    linesRemoved: patch?.removed ?? null,
    webFetch:
      url !== null && ("code" in result || "bytes" in result)
        ? { url, code: num(result.code), bytes: num(result.bytes), durationMs: num(result.durationMs) }
        : null,
    webSearch: query !== null && Array.isArray(result.results) ? { query, durationSeconds: num(result.durationSeconds) } : null,
  };
}

function decodePermissionDecision(value: unknown): PermissionDecision | null {
  const decision = obj(value);
  if (typeof decision?.decision !== "string") return null;
  return { decision: decision.decision, source: str(decision.source), reasonType: str(decision.reasonType) };
}

function decodeUser(row: Raw): UserLine {
  const content = obj(row.message)?.content;
  const blocks = arr(content).flatMap<Raw>((value) => obj(value) ?? []);
  const texts = blocks.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []));
  return {
    kind: "user",
    ...envelope(row),
    text: typeof content === "string" ? content : texts.length > 0 ? texts.join("\n") : null,
    images: blocks.filter((block) => block.type === "image").length,
    toolResults: blocks.flatMap(decodeToolResult),
    toolUseResult: decodeToolUseResult(row.toolUseResult),
    permissionDecision: decodePermissionDecision(row.permissionDecision),
    toolDenialKind: str(row.toolDenialKind),
    isMeta: row.isMeta === true,
    isCompactSummary: row.isCompactSummary === true,
    originKind: str(obj(row.origin)?.kind),
    promptId: str(row.promptId),
  };
}

// ── system ──────────────────────────────────────────────────────────────────────────────────

/** The HTTP status is not a separate field in the line: it is at the start of the error text, if the request reached the API. */
const STATUS_CODE_AT_START = /^([1-5]\d{2})(?!\d)/;

function decodeApiError(row: Raw): ApiErrorLine {
  const error = str(obj(row.error)?.message) ?? "";
  const status = STATUS_CODE_AT_START.exec(error);
  return {
    kind: "api_error",
    ...envelope(row),
    error,
    statusCode: status ? Number(status[1]) : null,
    retryAttempt: num(row.retryAttempt),
    maxRetries: num(row.maxRetries),
    retryInMs: num(row.retryInMs),
  };
}

function decodeCompactBoundary(row: Raw): CompactBoundaryLine {
  const meta = obj(row.compactMetadata);
  return {
    kind: "compact_boundary",
    ...envelope(row),
    trigger: str(meta?.trigger),
    preTokens: num(meta?.preTokens),
    postTokens: num(meta?.postTokens),
    durationMs: num(meta?.durationMs),
  };
}

// ── Lines without an envelope ───────────────────────────────────────────────────────────────

function decodeTitle<K extends "custom_title" | "ai_title">(kind: K, field: string) {
  return (row: Raw): { kind: K; sessionId: string | null; title: string } | null => {
    const title = str(row[field]);
    return title === null ? null : { kind, sessionId: str(row.sessionId), title };
  };
}

function decodeCostState(row: Raw): CostStateLine | null {
  const totalCostUsd = num(row.totalCostUSD);
  if (totalCostUsd === null) return null;
  const modelUsage: Record<string, CostStateModelUsage> = {};
  for (const [model, value] of Object.entries(obj(row.modelUsage) ?? {})) {
    const usage = obj(value);
    if (!usage) continue;
    modelUsage[model] = {
      inputTokens: num(usage.inputTokens) ?? 0,
      outputTokens: num(usage.outputTokens) ?? 0,
      cacheReadInputTokens: num(usage.cacheReadInputTokens) ?? 0,
      cacheCreationInputTokens: num(usage.cacheCreationInputTokens) ?? 0,
      costUsd: num(usage.costUSD) ?? 0,
    };
  }
  return { kind: "cost_state", sessionId: str(row.sessionId), totalCostUsd, modelUsage };
}

// ── attachment ──────────────────────────────────────────────────────────────────────────────

function instructionFile(value: unknown, fallbackPath: unknown = null): InstructionFile[] {
  const file = obj(value);
  const path = str(file?.path) ?? str(fallbackPath);
  if (!file || path === null) return [];
  return [{ path, memoryType: str(file.type), bytes: Buffer.byteLength(str(file.content) ?? "", "utf8") }];
}

function decodeInstructions(row: Raw): InstructionsLine {
  const files = arr(obj(row.attachment)?.files).flatMap((file) => instructionFile(file));
  return { kind: "instructions", ...envelope(row), files };
}

function decodeNestedMemory(row: Raw): InstructionsLine {
  const attachment = obj(row.attachment);
  return { kind: "instructions", ...envelope(row), files: instructionFile(attachment?.content, attachment?.path) };
}

// ── Parsing a line ──────────────────────────────────────────────────────────────────────────

interface Decoder {
  /** null — a line of this type without a required part: it counts as unknown. */
  decode: (row: Raw) => ParsedLine | null;
  knownFields: Set<string>;
}

/** The key is the line type; for `system` and `attachment` it includes the subtype after `/`, as in `IGNORED_LINE_TYPES`. */
const DECODERS = new Map<string, Decoder>([
  ["assistant", { decode: decodeAssistant, knownFields: ASSISTANT_FIELDS }],
  ["user", { decode: decodeUser, knownFields: USER_FIELDS }],
  ["system/api_error", { decode: decodeApiError, knownFields: SYSTEM_FIELDS }],
  ["system/compact_boundary", { decode: decodeCompactBoundary, knownFields: SYSTEM_FIELDS }],
  ["attachment/instructions", { decode: decodeInstructions, knownFields: ATTACHMENT_FIELDS }],
  ["attachment/nested_memory", { decode: decodeNestedMemory, knownFields: ATTACHMENT_FIELDS }],
  ["custom-title", { decode: decodeTitle("custom_title", "customTitle"), knownFields: known("customTitle") }],
  ["ai-title", { decode: decodeTitle("ai_title", "aiTitle"), knownFields: known("aiTitle") }],
  ["cost-state", { decode: decodeCostState, knownFields: known("totalCostUSD", "modelUsage", "hasUnknownModelCost", "startTime", "totalDuration", "totalAPIDuration", "totalAPIDurationWithoutRetries", "totalToolDuration", "totalLinesAdded", "totalLinesRemoved") }],
]);

const IGNORED = new Set<string>(IGNORED_LINE_TYPES);

/** The type under which lines with invalid JSON are counted: the name is our own, not from the transcript. */
export const INVALID_TYPE = "<invalid>";

const unknown = (type: string): ParseResult => ({ line: { kind: "unknown", type }, unknownFields: [] });

function typeWithSubtype(row: Raw, type: string): string {
  const subtype = type === "system" ? str(row.subtype) : type === "attachment" ? str(obj(row.attachment)?.type) : null;
  return subtype === null ? type : `${type}/${subtype}`;
}

export const parseLine: ParseLine = (raw) => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return unknown(INVALID_TYPE);
  }
  const row = obj(json);
  const type = str(row?.type);
  if (!row || type === null) return unknown(INVALID_TYPE);

  const fullType = typeWithSubtype(row, type);
  if (IGNORED.has(fullType)) return { line: { kind: "ignored", type: fullType }, unknownFields: [] };
  const decoder = DECODERS.get(fullType);
  const line = decoder?.decode(row);
  if (!decoder || !line) return unknown(fullType);
  return { line, unknownFields: Object.keys(row).filter((field) => !decoder.knownFields.has(field)) };
};

// ── Unknown counter ─────────────────────────────────────────────────────────────────────────

/** The line type under which the fields of a parsed line are counted in `UnknownStats.fields`. */
const LINE_TYPE_BY_KIND: Record<Exclude<ParsedLineKind, "ignored" | "unknown">, string> = {
  assistant: "assistant",
  user: "user",
  api_error: "system",
  compact_boundary: "system",
  custom_title: "custom-title",
  ai_title: "ai-title",
  cost_state: "cost-state",
  instructions: "attachment",
};

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (Object.hasOwn(counts, key) ? counts[key]! : 0) + 1;
}

/** Adds the result of parsing one line to the unknown counter. */
export function countUnknown(stats: UnknownStats, result: ParseResult): void {
  const { line } = result;
  if (line.kind === "unknown") increment(stats.types, line.type);
  if (line.kind === "unknown" || line.kind === "ignored") return;
  for (const field of result.unknownFields) increment(stats.fields, `${LINE_TYPE_BY_KIND[line.kind]}.${field}`);
}

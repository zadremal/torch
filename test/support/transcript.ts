// Assembling synthetic transcripts in the Claude Code format (plan §3.1, docs/spikes.md).
// Field names are as in real files; the content is always made up.
//
//   const t = transcript({ sessionId: "s1" });
//   t.prompt("Fix the bug");
//   const { toolUseIds } = t.assistant({ blocks: [text("Looking"), toolUse("Read", { file_path: "/a.ts" })] });
//   t.toolResult(toolUseIds[0]!, { content: "…" });
//   writeSession(root, { main: t });

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMeta } from "../../src/contracts/lines.ts";

export type RawLine = Record<string, unknown>;

export interface TranscriptOptions {
  sessionId: string;
  /** If set, this is a subagent file: lines get `agentId` and `isSidechain: true`. */
  agentId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  entrypoint?: string;
  /** Time of the first line, epoch milliseconds. */
  startAt?: number;
  /**
   * Assistant lines as a Bedrock gateway writes them: no `requestId` field, `message.id` of the form `msg_bdrk_…`,
   * default model `claude-align-aws-opus-5-5`. The call key is then the message id.
   */
  gateway?: boolean;
}

export interface UsageInput {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  /** If not set, the line has no `output_tokens_details` field. */
  thinking?: number;
}

export type BlockInput =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; name: string; input: unknown; id?: string };

export const text = (value: string): BlockInput => ({ type: "text", text: value });
export const thinking = (value: string): BlockInput => ({ type: "thinking", thinking: value });
export const toolUse = (name: string, input: unknown = {}, id?: string): BlockInput => ({ type: "tool_use", name, input, id });

export interface AssistantInput {
  blocks: BlockInput[];
  /** The call key: `requestId`; with the `gateway` option `message.id`. */
  requestId?: string;
  model?: string;
  usage?: UsageInput;
  /** Stop reason in the last line of the response; by default tool_use for calls, otherwise end_turn. */
  stopReason?: string;
  /** Time of the response lines; by default the builder's clock. */
  at?: number;
  /** false — the whole response in one line. By default one line per block, as Claude Code writes it. */
  split?: boolean;
  /** Explicit uuids of the response lines, one per line; by default issued by the builder. */
  uuids?: string[];
}

export interface ToolResultInput {
  content?: string;
  isError?: boolean;
  /** Value of the `toolUseResult` field as is. */
  toolUseResult?: unknown;
  permissionDecision?: { decision: string; source?: string; reasonType?: string };
  toolDenialKind?: string;
  at?: number;
  uuid?: string;
}

export interface Transcript {
  readonly options: Required<Omit<TranscriptOptions, "agentId">> & { agentId: string | null };
  readonly lines: RawLine[];
  /** Sets the builder's clock to the given time. */
  at(ms: number): Transcript;
  /** Moves the builder's clock forward. */
  tick(ms: number): Transcript;
  /** User message. Returns the line's uuid. */
  prompt(textValue: string, opts?: { at?: number; images?: number; isMeta?: boolean; isCompactSummary?: boolean; origin?: string; uuid?: string }): string;
  /**
   * Model response: one line per block with a shared `requestId`. The returned `requestId` is the call key
   * (`model_calls.id`): with the `gateway` option it is the shared `message.id`, the lines have no `requestId`.
   */
  assistant(input: AssistantInput): { requestId: string; uuids: string[]; toolUseIds: string[] };
  /** A `user` line with a tool result. Returns the line's uuid. */
  toolResult(toolUseId: string, input?: ToolResultInput): string;
  apiError(input: { message: string; retryAttempt?: number; maxRetries?: number; retryInMs?: number; at?: number; uuid?: string }): string;
  compactBoundary(input: { trigger?: string; preTokens: number; postTokens: number; durationMs?: number; at?: number }): string;
  customTitle(title: string): void;
  aiTitle(title: string): void;
  costState(input: { totalCostUSD: number; modelUsage: Record<string, Record<string, number>> }): void;
  /** An `attachment` line of type `instructions`. */
  instructions(files: { path: string; type: string; content: string }[], opts?: { at?: number; uuid?: string }): string;
  /** An `attachment` line of type `nested_memory`. */
  nestedMemory(file: { path: string; type: string; content: string }, opts?: { at?: number }): string;
  /** A line with a message envelope and arbitrary fields: for unknown types and fields. */
  envelope(fields: RawLine, opts?: { at?: number }): string;
  /** A line as is, without an envelope. */
  raw(line: RawLine): void;
  jsonl(): string;
}

export function transcript(options: TranscriptOptions): Transcript {
  const opts = {
    sessionId: options.sessionId,
    agentId: options.agentId ?? null,
    cwd: options.cwd ?? "/Users/dev/code/example",
    version: options.version ?? "2.1.321",
    gitBranch: options.gitBranch ?? "main",
    entrypoint: options.entrypoint ?? "claude-desktop",
    startAt: options.startAt ?? Date.UTC(2026, 9, 1, 10, 0, 0),
    gateway: options.gateway ?? false,
  };
  const lines: RawLine[] = [];
  const prefix = createHash("sha1").update(`${opts.sessionId}/${opts.agentId ?? "main"}`).digest("hex").slice(0, 8);
  let clock = opts.startAt;
  let counter = 0;
  let lastUuid: string | null = null;

  const nextId = () => (++counter).toString(16).padStart(12, "0");
  const time = (at?: number) => {
    if (at !== undefined) clock = at;
    return new Date(clock).toISOString();
  };

  function push(fields: RawLine, at?: number, explicitUuid?: string): string {
    const uuid = explicitUuid ?? `${prefix}-0000-4000-8000-${nextId()}`;
    lines.push({
      parentUuid: lastUuid,
      isSidechain: opts.agentId !== null,
      ...(opts.agentId !== null ? { agentId: opts.agentId } : {}),
      ...fields,
      uuid,
      timestamp: time(at),
      userType: "external",
      entrypoint: opts.entrypoint,
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      version: opts.version,
      gitBranch: opts.gitBranch,
    });
    lastUuid = uuid;
    return uuid;
  }

  function usageFields(usage: UsageInput, outputTokens: number): RawLine {
    const write5m = usage.cacheWrite5m ?? 0;
    const write1h = usage.cacheWrite1h ?? 0;
    return {
      input_tokens: usage.input ?? 0,
      cache_creation_input_tokens: write5m + write1h,
      cache_read_input_tokens: usage.cacheRead ?? 0,
      cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
      output_tokens: outputTokens,
      ...(usage.thinking !== undefined ? { output_tokens_details: { thinking_tokens: usage.thinking } } : {}),
      service_tier: "standard",
    };
  }

  const self: Transcript = {
    options: opts,
    lines,
    at(ms) {
      clock = ms;
      return self;
    },
    tick(ms) {
      clock += ms;
      return self;
    },
    prompt(textValue, o = {}) {
      const images = o.images ?? 0;
      const content =
        images > 0
          ? [
              { type: "text", text: textValue },
              ...Array.from({ length: images }, () => ({ type: "image", source: { type: "base64", media_type: "image/png", data: "" } })),
            ]
          : textValue;
      return push(
        {
          type: "user",
          message: { role: "user", content },
          promptId: `prompt-${nextId()}`,
          ...(o.isMeta ? { isMeta: true } : {}),
          ...(o.isCompactSummary ? { isCompactSummary: true, isVisibleInTranscriptOnly: true } : {}),
          ...(o.origin ? { origin: { kind: o.origin } } : {}),
        },
        o.at,
        o.uuid,
      );
    },
    assistant(input) {
      const requestId = opts.gateway ? null : (input.requestId ?? `req_${prefix}${nextId()}`);
      const messageId = opts.gateway ? (input.requestId ?? `msg_bdrk_${prefix}${nextId()}`) : `msg_${prefix}${nextId()}`;
      const usage = input.usage ?? {};
      const finalOutput = usage.output ?? 0;
      const blocks = input.blocks.map((block) =>
        block.type === "tool_use"
          ? { type: "tool_use", id: block.id ?? `toolu_${prefix}${nextId()}`, name: block.name, input: block.input, caller: { type: "direct" } }
          : block.type === "thinking"
            ? { type: "thinking", thinking: block.thinking, signature: "" }
            : block,
      );
      const toolUseIds = blocks.flatMap((b) => (b.type === "tool_use" ? [(b as { id: string }).id] : []));
      const stopReason = input.stopReason ?? (toolUseIds.length > 0 ? "tool_use" : "end_turn");
      const groups = input.split === false ? [blocks] : blocks.map((b) => [b]);
      const uuids = groups.map((content, index) => {
        const last = index === groups.length - 1;
        return push(
          {
            type: "assistant",
            ...(requestId !== null ? { requestId } : {}),
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              model: input.model ?? (opts.gateway ? "claude-align-aws-opus-5-5" : "claude-opus-5-5"),
              content,
              stop_reason: last ? stopReason : null,
              stop_sequence: null,
              // The input part of usage is the same in all response lines, output_tokens grows toward the last one.
              usage: usageFields(usage, last ? finalOutput : Math.min(finalOutput, index + 1)),
            },
          },
          input.at,
          input.uuids?.[index],
        );
      });
      return { requestId: requestId ?? messageId, uuids, toolUseIds };
    },
    toolResult(toolUseId, input = {}) {
      return push(
        {
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: toolUseId, content: input.content ?? "", ...(input.isError ? { is_error: true } : {}) },
            ],
          },
          promptId: `prompt-${nextId()}`,
          ...(input.toolUseResult !== undefined ? { toolUseResult: input.toolUseResult } : {}),
          ...(input.permissionDecision ? { permissionDecision: input.permissionDecision } : {}),
          ...(input.toolDenialKind ? { toolDenialKind: input.toolDenialKind } : {}),
        },
        input.at,
        input.uuid,
      );
    },
    apiError(input) {
      return push(
        {
          type: "system",
          subtype: "api_error",
          level: "error",
          source: "sdk",
          error: { message: input.message, formatted: input.message, connection: null, isNetworkDown: false, rateLimits: null },
          retryAttempt: input.retryAttempt ?? 1,
          maxRetries: input.maxRetries ?? 10,
          retryInMs: input.retryInMs ?? 1000,
        },
        input.at,
        input.uuid,
      );
    },
    compactBoundary(input) {
      return push(
        {
          type: "system",
          subtype: "compact_boundary",
          level: "info",
          isMeta: false,
          content: "Conversation compacted",
          compactMetadata: {
            trigger: input.trigger ?? "manual",
            preTokens: input.preTokens,
            postTokens: input.postTokens,
            durationMs: input.durationMs ?? 0,
          },
        },
        input.at,
      );
    },
    customTitle(title) {
      lines.push({ type: "custom-title", customTitle: title, sessionId: opts.sessionId });
    },
    aiTitle(title) {
      lines.push({ type: "ai-title", aiTitle: title, sessionId: opts.sessionId });
    },
    costState(input) {
      lines.push({ type: "cost-state", sessionId: opts.sessionId, hasUnknownModelCost: false, ...input });
    },
    instructions(files, o = {}) {
      return push({ type: "attachment", attachment: { type: "instructions", files }, rendered: [] }, o.at, o.uuid);
    },
    nestedMemory(file, o = {}) {
      return push(
        {
          type: "attachment",
          attachment: { type: "nested_memory", path: file.path, displayPath: file.path, content: { ...file, contentDiffersFromDisk: false } },
          rendered: [],
        },
        o.at,
      );
    },
    envelope(fields, o = {}) {
      return push(fields, o.at);
    },
    raw(line) {
      lines.push(line);
    },
    jsonl() {
      return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
    },
  };
  return self;
}

/** Project directory name: the working directory with dashes instead of separators. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export interface SessionFiles {
  main: Transcript;
  subagents?: { transcript: Transcript; meta?: Partial<AgentMeta> }[];
  /** Contents of `custom-title.json`. */
  customTitleFile?: string;
}

export interface WrittenSession {
  mainPath: string;
  subagentPaths: string[];
  sessionDir: string;
}

/** Lays out the session files under the transcripts root the way Claude Code does. */
export function writeSession(transcriptsRoot: string, files: SessionFiles): WrittenSession {
  const { sessionId, cwd } = files.main.options;
  const projectDir = join(transcriptsRoot, projectDirName(cwd));
  const mainPath = join(projectDir, `${sessionId}.jsonl`);
  const sessionDir = join(projectDir, sessionId);
  write(mainPath, files.main.jsonl());
  const subagentPaths = (files.subagents ?? []).map(({ transcript: sub, meta }) => {
    const base = join(sessionDir, "subagents", `agent-${sub.options.agentId}`);
    write(`${base}.jsonl`, sub.jsonl());
    if (meta) write(`${base}.meta.json`, JSON.stringify(meta));
    return `${base}.jsonl`;
  });
  if (files.customTitleFile !== undefined) {
    write(join(sessionDir, "custom-title.json"), JSON.stringify({ customTitle: files.customTitleFile }));
  }
  return { mainPath, subagentPaths, sessionDir };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

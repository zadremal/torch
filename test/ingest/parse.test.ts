// Parsing every line type from plan §3.1 into a type from contracts/lines.ts.
import { expect, test } from "bun:test";
import { SYNTHETIC_MODEL } from "../../src/contracts/constants.ts";
import type { ParsedLine, ParsedLineKind } from "../../src/contracts/lines.ts";
import type { ParseResult } from "../../src/contracts/pipeline.ts";
import { parseLine } from "../../src/ingest/parse.ts";
import { text, thinking, toolUse, transcript, type RawLine, type Transcript } from "../support/transcript.ts";

type Line = Record<string, any>;

const parse = (line: RawLine): ParseResult => parseLine(JSON.stringify(line));
const parseAll = (t: Transcript): ParseResult[] => t.lines.map(parse);

function as<K extends ParsedLineKind>(result: ParseResult, kind: K): Extract<ParsedLine, { kind: K }> {
  expect(result.line.kind).toBe(kind);
  return result.line as Extract<ParsedLine, { kind: K }>;
}

/** A tool result with the given `toolUseResult`, parsed into a user line. */
function resultLine(toolUseResult: unknown) {
  const t = transcript({ sessionId: "s1" });
  t.toolResult("toolu_1", { content: "out", toolUseResult });
  return as(parse(t.lines[0]!), "user");
}

const START = Date.UTC(2026, 9, 1, 10, 0, 0);

// ── assistant ───────────────────────────────────────────────────────────────────────────────

test("assistant: one line per block with a shared requestId, envelope and usage", () => {
  const t = transcript({ sessionId: "s1", cwd: "/Users/dev/code/app", gitBranch: "feature", version: "2.1.300", startAt: START });
  t.prompt("Fix it");
  t.tick(4000);
  const { requestId, uuids, toolUseIds } = t.assistant({
    model: "claude-opus-5-5",
    blocks: [thinking("hm"), text("Reading"), toolUse("Read", { file_path: "/a.ts" })],
    usage: { input: 10, output: 500, cacheRead: 2000, cacheWrite5m: 100, cacheWrite1h: 300, thinking: 40 },
  });
  const results = parseAll(t).slice(1);
  const lines = results.map((r) => as(r, "assistant"));

  expect(results.map((r) => r.unknownFields)).toEqual([[], [], []]);
  expect(lines.map((l) => l.requestId)).toEqual([requestId, requestId, requestId]);
  expect(lines.map((l) => l.stopReason)).toEqual([null, null, "tool_use"]);
  expect(lines.map((l) => l.usage!.outputTokens)).toEqual([1, 2, 500]);
  expect(lines.map((l) => l.blocks)).toEqual([
    [{ type: "thinking", thinking: "hm" }],
    [{ type: "text", text: "Reading" }],
    [{ type: "tool_use", id: toolUseIds[0]!, name: "Read", input: { file_path: "/a.ts" } }],
  ]);
  expect(lines[2]).toEqual({
    kind: "assistant",
    uuid: uuids[2]!,
    parentUuid: uuids[1]!,
    timestamp: START + 4000,
    sessionId: "s1",
    agentId: null,
    isSidechain: false,
    cwd: "/Users/dev/code/app",
    gitBranch: "feature",
    version: "2.1.300",
    entrypoint: "claude-desktop",
    requestId,
    messageId: (t.lines[3] as Line).message.id,
    model: "claude-opus-5-5",
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 400, cacheWrite5mTokens: 100, cacheWrite1hTokens: 300, thinkingTokens: 40 },
    blocks: [{ type: "tool_use", id: toolUseIds[0]!, name: "Read", input: { file_path: "/a.ts" } }],
    isApiErrorMessage: false,
    apiError: null,
    apiErrorStatus: null,
  });
});

test("assistant: a response in a single line carries all the blocks", () => {
  const t = transcript({ sessionId: "s1" });
  t.assistant({ blocks: [text("One"), toolUse("Bash", { command: "ls" }, "toolu_a"), toolUse("Bash", { command: "pwd" }, "toolu_b")], split: false });
  expect(as(parse(t.lines[0]!), "assistant").blocks).toEqual([
    { type: "text", text: "One" },
    { type: "tool_use", id: "toolu_a", name: "Bash", input: { command: "ls" } },
    { type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "pwd" } },
  ]);
});

test("assistant: a subagent file line carries agentId and isSidechain", () => {
  const t = transcript({ sessionId: "s1", agentId: "a1" });
  t.assistant({ blocks: [text("Exploring")] });
  expect(as(parse(t.lines[0]!), "assistant")).toMatchObject({ sessionId: "s1", agentId: "a1", isSidechain: true });
});

test("assistant: usage without thinking, without a cache write breakdown and without usage altogether", () => {
  const t = transcript({ sessionId: "s1" });
  t.assistant({ blocks: [text("ok")], usage: { input: 5, output: 7, cacheRead: 9, cacheWrite5m: 60, cacheWrite1h: 40 } });
  const raw = structuredClone(t.lines[0]) as Line;

  expect(as(parse(raw), "assistant").usage).toEqual({
    inputTokens: 5, outputTokens: 7, cacheReadTokens: 9, cacheWriteTokens: 100, cacheWrite5mTokens: 60, cacheWrite1hTokens: 40, thinkingTokens: null,
  });

  // There is no breakdown by TTL: the whole cache write counts as five-minute.
  delete raw.message.usage.cache_creation;
  expect(as(parse(raw), "assistant").usage).toMatchObject({ cacheWriteTokens: 100, cacheWrite5mTokens: 100, cacheWrite1hTokens: 0 });

  delete raw.message.usage;
  expect(as(parse(raw), "assistant").usage).toBeNull();
});

test("assistant: an API error line with the <synthetic> model and without requestId", () => {
  const t = transcript({ sessionId: "s1" });
  t.envelope({
    type: "assistant",
    isApiErrorMessage: true,
    error: "overloaded",
    apiErrorStatus: 529,
    message: {
      id: "msg_synthetic",
      type: "message",
      role: "assistant",
      model: SYNTHETIC_MODEL,
      content: [{ type: "text", text: "API Error: Overloaded" }],
      stop_reason: "stop_sequence",
      stop_sequence: "",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  const result = parse(t.lines[0]!);
  expect(result.unknownFields).toEqual([]);
  expect(as(result, "assistant")).toMatchObject({
    isApiErrorMessage: true,
    apiError: "overloaded",
    apiErrorStatus: 529,
    requestId: null,
    model: SYNTHETIC_MODEL,
    stopReason: "stop_sequence",
    blocks: [{ type: "text", text: "API Error: Overloaded" }],
  });
});

test("assistant: a block of an unfamiliar type is skipped, a line without message is parsed as empty", () => {
  const t = transcript({ sessionId: "s1" });
  t.assistant({ blocks: [text("kept")], split: false });
  const raw = structuredClone(t.lines[0]) as Line;
  raw.message.content.unshift({ type: "server_tool_use", id: "srv_1" }, { type: "tool_use", name: "NoId" }, "not a block");
  expect(as(parse(raw), "assistant").blocks).toEqual([{ type: "text", text: "kept" }]);

  delete raw.message;
  expect(as(parse(raw), "assistant")).toMatchObject({ messageId: null, model: null, stopReason: null, usage: null, blocks: [] });
});

// ── user ────────────────────────────────────────────────────────────────────────────────────

test("user: prompt as a string", () => {
  const t = transcript({ sessionId: "s1", startAt: START });
  const uuid = t.prompt("Fix the bug");
  const result = parse(t.lines[0]!);
  expect(result.unknownFields).toEqual([]);
  expect(as(result, "user")).toEqual({
    kind: "user",
    uuid,
    parentUuid: null,
    timestamp: START,
    sessionId: "s1",
    agentId: null,
    isSidechain: false,
    cwd: "/Users/dev/code/example",
    gitBranch: "main",
    version: "2.1.321",
    entrypoint: "claude-desktop",
    text: "Fix the bug",
    images: 0,
    toolResults: [],
    toolUseResult: null,
    permissionDecision: null,
    toolDenialKind: null,
    isMeta: false,
    isCompactSummary: false,
    originKind: null,
    promptId: (t.lines[0] as Line).promptId,
  });
});

test("user: prompt as blocks with images, and a service message", () => {
  const t = transcript({ sessionId: "s1" });
  t.prompt("Look at these", { images: 2 });
  t.prompt("<system-reminder>", { isMeta: true });
  const [withImages, meta] = parseAll(t).map((r) => as(r, "user"));
  expect(withImages).toMatchObject({ text: "Look at these", images: 2, toolResults: [], isMeta: false });
  expect(meta).toMatchObject({ text: "<system-reminder>", isMeta: true });

  t.prompt("Summary of the conversation so far", { isCompactSummary: true });
  t.prompt("<task-notification>", { origin: "task-notification" });
  t.prompt("Go on", { origin: "human" });
  const [summary, notification, human] = parseAll(t).slice(2).map((r) => as(r, "user"));
  expect(summary).toMatchObject({ isCompactSummary: true, originKind: null });
  expect(notification).toMatchObject({ isCompactSummary: false, originKind: "task-notification" });
  expect(human).toMatchObject({ originKind: "human" });

  const raw = structuredClone(t.lines[0]) as Line;
  raw.message.content.push({ type: "text", text: "and this" });
  expect(as(parse(raw), "user").text).toBe("Look at these\nand this");
});

test("user: tool result as a string and with an error", () => {
  const t = transcript({ sessionId: "s1" });
  t.toolResult("toolu_ok", { content: "file body" });
  t.toolResult("toolu_bad", { content: "File does not exist.", isError: true, toolUseResult: "Error: File does not exist." });
  const [ok, bad] = parseAll(t).map((r) => as(r, "user"));
  expect(ok).toMatchObject({ text: null, images: 0, toolResults: [{ toolUseId: "toolu_ok", isError: false, text: "file body" }] });
  expect(bad!.toolResults).toEqual([{ toolUseId: "toolu_bad", isError: true, text: "File does not exist." }]);
  // For errors toolUseResult is a string: there is no structure in it.
  expect(bad!.toolUseResult).toBeNull();
});

test("user: result as blocks — text is joined, non-text is replaced by a marker", () => {
  const t = transcript({ sessionId: "s1" });
  t.toolResult("toolu_1");
  t.toolResult("toolu_2");
  const raw = structuredClone(t.lines[0]) as Line;
  raw.message.content[0].content = [
    { type: "text", text: "first" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
    { type: "text", text: "second" },
  ];
  // Two results in one line.
  raw.message.content.push((t.lines[1] as Line).message.content[0]);
  const line = as(parse(raw), "user");
  expect(line.toolResults).toEqual([
    { toolUseId: "toolu_1", isError: false, text: "first\n[image]\nsecond" },
    { toolUseId: "toolu_2", isError: false, text: "" },
  ]);
  // An image inside a result does not count as a prompt attachment.
  expect(line.images).toBe(0);
});

test("user: permission denial", () => {
  const t = transcript({ sessionId: "s1" });
  t.toolResult("toolu_1", {
    content: "Permission denied",
    isError: true,
    permissionDecision: { decision: "reject", source: "rule", reasonType: "rule" },
    toolDenialKind: "permission-rule",
  });
  t.toolResult("toolu_2", { permissionDecision: { decision: "accept" } });
  const [denied, allowed] = parseAll(t).map((r) => as(r, "user"));
  expect(denied).toMatchObject({ permissionDecision: { decision: "reject", source: "rule", reasonType: "rule" }, toolDenialKind: "permission-rule" });
  expect(allowed).toMatchObject({ permissionDecision: { decision: "accept", source: null, reasonType: null }, toolDenialKind: null });
});

// ── user: toolUseResult by tool ─────────────────────────────────────────────────────

const NO_RESULT_INFO = { durationMs: null, interrupted: false, agentId: null, filePath: null, linesAdded: null, linesRemoved: null, webFetch: null, webSearch: null };

test("toolUseResult: Bash, including an interrupted one", () => {
  expect(resultLine({ stdout: "ok", stderr: "", interrupted: false, isImage: false, noOutputExpected: false }).toolUseResult).toEqual(NO_RESULT_INFO);
  expect(resultLine({ stdout: "", stderr: "", interrupted: true, isImage: false, noOutputExpected: false }).toolUseResult).toEqual({ ...NO_RESULT_INFO, interrupted: true });
});

test("toolUseResult: Read gives the file path", () => {
  const info = resultLine({ type: "text", file: { filePath: "/repo/a.ts", content: "", numLines: 3, startLine: 1, totalLines: 3 } }).toolUseResult;
  expect(info).toEqual({ ...NO_RESULT_INFO, filePath: "/repo/a.ts" });
});

test("toolUseResult: Edit counts lines by structuredPatch", () => {
  const info = resultLine({
    filePath: "/repo/a.ts",
    oldString: "a",
    newString: "b",
    originalFile: "",
    replaceAll: false,
    userModified: false,
    structuredPatch: [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [" keep", "-old one", "-old two", "+new one", "+new two", "+new three"] },
      { oldStart: 20, oldLines: 1, newStart: 21, newLines: 1, lines: ["--flag", "+++x"] },
    ],
  }).toolUseResult;
  expect(info).toEqual({ ...NO_RESULT_INFO, filePath: "/repo/a.ts", linesAdded: 4, linesRemoved: 3 });
});

test("toolUseResult: Write of a new file counts the lines of content, an overwrite — by the patch", () => {
  const create = (content: string) =>
    resultLine({ type: "create", filePath: "/repo/new.ts", content, originalFile: null, structuredPatch: [], userModified: false }).toolUseResult;
  expect(create("one\ntwo\nthree\n")).toEqual({ ...NO_RESULT_INFO, filePath: "/repo/new.ts", linesAdded: 3, linesRemoved: 0 });
  expect(create("one\ntwo")).toMatchObject({ linesAdded: 2, linesRemoved: 0 });
  expect(create("")).toMatchObject({ linesAdded: 0, linesRemoved: 0 });

  const update = resultLine({
    type: "update",
    filePath: "/repo/old.ts",
    content: "one\ntwo\n",
    originalFile: "one\n",
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [" one", "+two"] }],
    userModified: false,
  }).toolUseResult;
  expect(update).toMatchObject({ filePath: "/repo/old.ts", linesAdded: 1, linesRemoved: 0 });
});

test("toolUseResult: Agent in the background and with waiting", () => {
  const launched = resultLine({ agentId: "a1", isAsync: true, status: "async_launched", description: "Explore", prompt: "Go", outputFile: "/tmp/a1.output", canReadOutputFile: true });
  expect(launched.toolUseResult).toEqual({ ...NO_RESULT_INFO, agentId: "a1" });

  const awaited = resultLine({ agentId: "a2", agentType: "Explore", status: "completed", content: [{ type: "text", text: "done" }], prompt: "Go", totalDurationMs: 61_000, totalTokens: 9, totalToolUseCount: 2 });
  expect(awaited.toolUseResult).toEqual({ ...NO_RESULT_INFO, agentId: "a2", durationMs: 61_000 });
});

test("toolUseResult: WebFetch and WebSearch", () => {
  const fetched = resultLine({ url: "https://example.com/docs", code: 200, codeText: "OK", bytes: 5120, durationMs: 840, result: "…" });
  expect(fetched.toolUseResult).toEqual({ ...NO_RESULT_INFO, durationMs: 840, webFetch: { url: "https://example.com/docs", code: 200, bytes: 5120, durationMs: 840 } });

  const searched = resultLine({ query: "bun sqlite", results: [], durationSeconds: 2.5, searchCount: 1 });
  expect(searched.toolUseResult).toEqual({ ...NO_RESULT_INFO, webSearch: { query: "bun sqlite", durationSeconds: 2.5 } });
});

test("toolUseResult: other results are not mistaken for external requests, a string and an array yield null", () => {
  expect(resultLine({ mode: "files_with_matches", filenames: [], numFiles: 7 }).toolUseResult).toEqual(NO_RESULT_INFO);
  expect(resultLine({ filenames: [], numFiles: 23, durationMs: 12, truncated: false }).toolUseResult).toEqual({ ...NO_RESULT_INFO, durationMs: 12 });
  // `query` without `results` and `url` without `code` and `bytes` is neither WebSearch nor WebFetch.
  expect(resultLine({ query: "select:Read", matches: [] }).toolUseResult).toEqual(NO_RESULT_INFO);
  expect(resultLine({ url: "https://example.com", title: "Opened" }).toolUseResult).toEqual(NO_RESULT_INFO);
  expect(resultLine("Error: boom").toolUseResult).toBeNull();
  expect(resultLine([{ type: "text", text: "mcp" }]).toolUseResult).toBeNull();
});

// ── system ──────────────────────────────────────────────────────────────────────────────────

test("system/api_error: error text, retries and the code from the start of the message", () => {
  const t = transcript({ sessionId: "s1", startAt: START });
  const uuid = t.apiError({ message: '529 {"type":"error","error":{"type":"overloaded_error"}}', retryAttempt: 2, maxRetries: 10, retryInMs: 1500 });
  const result = parse(t.lines[0]!);
  expect(result.unknownFields).toEqual([]);
  expect(as(result, "api_error")).toEqual({
    kind: "api_error",
    uuid,
    parentUuid: null,
    timestamp: START,
    sessionId: "s1",
    agentId: null,
    isSidechain: false,
    cwd: "/Users/dev/code/example",
    gitBranch: "main",
    version: "2.1.321",
    entrypoint: "claude-desktop",
    error: '529 {"type":"error","error":{"type":"overloaded_error"}}',
    statusCode: 529,
    retryAttempt: 2,
    maxRetries: 10,
    retryInMs: 1500,
  });
});

test("system/api_error: no code if the message does not start with it", () => {
  const statusOf = (message: string) => {
    const t = transcript({ sessionId: "s1" });
    t.apiError({ message });
    return as(parse(t.lines[0]!), "api_error").statusCode;
  };
  expect(statusOf("429 Too Many Requests")).toBe(429);
  expect(statusOf("Connection error.")).toBeNull();
  expect(statusOf("Request failed with status 500")).toBeNull();
  expect(statusOf("5290 tokens over the limit")).toBeNull();
  expect(statusOf("999 not a status")).toBeNull();

  const t = transcript({ sessionId: "s1" });
  t.apiError({ message: "x" });
  const raw = structuredClone(t.lines[0]) as Line;
  delete raw.error;
  delete raw.retryAttempt;
  expect(as(parse(raw), "api_error")).toMatchObject({ error: "", statusCode: null, retryAttempt: null, maxRetries: 10 });
});

test("system/compact_boundary", () => {
  const t = transcript({ sessionId: "s1", startAt: START });
  t.compactBoundary({ trigger: "auto", preTokens: 180_000, postTokens: 24_000, durationMs: 31_000 });
  const result = parse(t.lines[0]!);
  expect(result.unknownFields).toEqual([]);
  expect(as(result, "compact_boundary")).toMatchObject({ timestamp: START, sessionId: "s1", trigger: "auto", preTokens: 180_000, postTokens: 24_000, durationMs: 31_000 });

  const raw = structuredClone(t.lines[0]) as Line;
  delete raw.compactMetadata;
  expect(as(parse(raw), "compact_boundary")).toMatchObject({ trigger: null, preTokens: null, postTokens: null, durationMs: null });
});

// ── Lines without an envelope ─────────────────────────────────────────────────────────────────────

test("custom-title and ai-title", () => {
  const t = transcript({ sessionId: "s1" });
  t.customTitle("Billing refactor");
  t.aiTitle("Refactor billing module");
  const results = parseAll(t);
  expect(results).toEqual([
    { line: { kind: "custom_title", sessionId: "s1", title: "Billing refactor" }, unknownFields: [] },
    { line: { kind: "ai_title", sessionId: "s1", title: "Refactor billing module" }, unknownFields: [] },
  ]);
});

test("cost-state", () => {
  const t = transcript({ sessionId: "s1" });
  t.costState({
    totalCostUSD: 1.25,
    modelUsage: {
      "claude-opus-5-5": { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 3000, cacheCreationInputTokens: 400, thinkingTokens: 50, costUSD: 1.2 },
      "claude-haiku-5-5": { inputTokens: 10, outputTokens: 20, costUSD: 0.05 },
    },
  });
  expect(parse(t.lines[0]!)).toEqual({
    line: {
      kind: "cost_state",
      sessionId: "s1",
      totalCostUsd: 1.25,
      modelUsage: {
        "claude-opus-5-5": { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 3000, cacheCreationInputTokens: 400, costUsd: 1.2 },
        "claude-haiku-5-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0.05 },
      },
    },
    unknownFields: [],
  });
});

// ── attachment ──────────────────────────────────────────────────────────────────────────────

test("attachment/instructions: files with content size in UTF-8 bytes", () => {
  const t = transcript({ sessionId: "s1", agentId: "a1", startAt: START });
  const uuid = t.instructions([
    { path: "/Users/dev/.claude/CLAUDE.md", type: "User", content: "Be brief." },
    { path: "/Users/dev/code/example/CLAUDE.md", type: "Project", content: "Réponds en français" },
  ]);
  const result = parse(t.lines[0]!);
  expect(result.unknownFields).toEqual([]);
  expect(as(result, "instructions")).toEqual({
    kind: "instructions",
    uuid,
    parentUuid: null,
    timestamp: START,
    sessionId: "s1",
    agentId: "a1",
    isSidechain: true,
    cwd: "/Users/dev/code/example",
    gitBranch: "main",
    version: "2.1.321",
    entrypoint: "claude-desktop",
    files: [
      { path: "/Users/dev/.claude/CLAUDE.md", memoryType: "User", bytes: 9 },
      // 17 single-byte characters and two two-byte ones (é, ç).
      { path: "/Users/dev/code/example/CLAUDE.md", memoryType: "Project", bytes: 21 },
    ],
  });
});

test("attachment/nested_memory: one file from attachment.content", () => {
  const t = transcript({ sessionId: "s1", startAt: START });
  const uuid = t.nestedMemory({ path: "/Users/dev/code/example/web/CLAUDE.md", type: "Nested", content: "x".repeat(1200) });
  const result = parse(t.lines[0]!);
  expect(result.unknownFields).toEqual([]);
  expect(as(result, "instructions")).toMatchObject({
    uuid,
    timestamp: START,
    files: [{ path: "/Users/dev/code/example/web/CLAUDE.md", memoryType: "Nested", bytes: 1200 }],
  });

  // Only the attachment has a path: it is the one taken.
  const raw = structuredClone(t.lines[0]) as Line;
  delete raw.attachment.content.path;
  expect(as(parse(raw), "instructions").files).toEqual([{ path: "/Users/dev/code/example/web/CLAUDE.md", memoryType: "Nested", bytes: 1200 }]);
});

test("attachment with instructions: a file without a path or content does not break parsing", () => {
  const t = transcript({ sessionId: "s1" });
  t.instructions([{ path: "/a/CLAUDE.md", type: "Project", content: "abc" }]);
  const raw = structuredClone(t.lines[0]) as Line;
  raw.attachment.files.push({ type: "Project", content: "no path" }, { path: "/b/CLAUDE.md" }, null);
  expect(as(parse(raw), "instructions").files).toEqual([
    { path: "/a/CLAUDE.md", memoryType: "Project", bytes: 3 },
    { path: "/b/CLAUDE.md", memoryType: null, bytes: 0 },
  ]);
  delete raw.attachment.files;
  expect(as(parse(raw), "instructions").files).toEqual([]);
});

test("usage: a cache write is not lost with an incomplete breakdown or with no total", () => {
  const usageOf = (usage: object) => as(parseLine(JSON.stringify({ type: "assistant", message: { usage } })), "assistant").usage!;
  // The breakdown is empty or names only the hourly part: the remainder counts as five-minute.
  expect(usageOf({ cache_creation_input_tokens: 100, cache_creation: {} })).toMatchObject({ cacheWriteTokens: 100, cacheWrite5mTokens: 100, cacheWrite1hTokens: 0 });
  expect(usageOf({ cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 40 } })).toMatchObject({ cacheWriteTokens: 100, cacheWrite5mTokens: 60, cacheWrite1hTokens: 40 });
  // No total: it equals the sum of the breakdown.
  expect(usageOf({ cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 5 } })).toMatchObject({ cacheWriteTokens: 12, cacheWrite5mTokens: 7, cacheWrite1hTokens: 5 });
});

test("a numeric field written as a string is read as absent", () => {
  const usage = as(parseLine(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: "10", output_tokens: 5 } } })), "assistant").usage!;
  expect(usage).toMatchObject({ inputTokens: 0, outputTokens: 5 });
  const error = as(parseLine(JSON.stringify({ type: "system", subtype: "api_error", error: { message: "Connection error." }, retryAttempt: "3", maxRetries: 10 })), "api_error");
  expect(error).toMatchObject({ retryAttempt: null, maxRetries: 10 });
});

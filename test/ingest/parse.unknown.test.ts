// Skipped and unknown line types, unknown fields and their counter.
import { expect, test } from "bun:test";
import { IGNORED_LINE_TYPES } from "../../src/contracts/lines.ts";
import type { ParseResult, UnknownStats } from "../../src/contracts/pipeline.ts";
import { countUnknown, parseLine } from "../../src/ingest/parse.ts";
import { referenceFiles } from "../support/reference-transcript.ts";
import { text, transcript, type RawLine, type Transcript } from "../support/transcript.ts";

type Line = Record<string, any>;

const parse = (line: RawLine): ParseResult => parseLine(JSON.stringify(line));
const parseAll = (t: Transcript): ParseResult[] => t.lines.map(parse);

function count(results: ParseResult[]): UnknownStats {
  const stats: UnknownStats = { types: {}, fields: {} };
  for (const result of results) countUnknown(stats, result);
  return stats;
}

/** A line of the given type; for `system` and `attachment` the subtype comes after `/`. */
function lineOfType(t: Transcript, fullType: string): void {
  const [type, subtype] = fullType.split("/") as [string, string | undefined];
  if (type === "system") t.envelope({ type, subtype, level: "info", content: "…" });
  else if (type === "attachment") t.envelope({ type, attachment: { type: subtype, payload: 1 } });
  else t.raw({ type, sessionId: t.options.sessionId, payload: 1 });
}

test("every type from IGNORED_LINE_TYPES yields ignored and does not reach the counter", () => {
  const t = transcript({ sessionId: "s1" });
  for (const type of IGNORED_LINE_TYPES) lineOfType(t, type);
  const results = parseAll(t);
  expect(results).toEqual(IGNORED_LINE_TYPES.map((type) => ({ line: { kind: "ignored", type }, unknownFields: [] })));
  expect(count(results)).toEqual({ types: {}, fields: {} });
});

test("an unknown line type yields unknown with type and subtype, without an exception", () => {
  const t = transcript({ sessionId: "s1" });
  lineOfType(t, "brand-new-line");
  lineOfType(t, "system/brand_new_subtype");
  lineOfType(t, "attachment/brand_new_attachment");
  t.envelope({ type: "system", level: "info" });
  t.envelope({ type: "attachment" });
  t.raw({ type: "constructor" });
  expect(parseAll(t).map((r) => r.line)).toEqual([
    { kind: "unknown", type: "brand-new-line" },
    { kind: "unknown", type: "system/brand_new_subtype" },
    { kind: "unknown", type: "attachment/brand_new_attachment" },
    { kind: "unknown", type: "system" },
    { kind: "unknown", type: "attachment" },
    { kind: "unknown", type: "constructor" },
  ]);
});

test("a broken line, a non-object and a line without type yield unknown <invalid>", () => {
  const t = transcript({ sessionId: "s1" });
  t.prompt("Fix it");
  const full = JSON.stringify(t.lines[0]);
  const inputs = [full.slice(0, full.length / 2), "", "   ", "not json", "42", "null", '"text"', "[1,2]", "{}", '{"type":7}', '{"sessionId":"s1"}'];
  for (const input of inputs) {
    expect(parseLine(input)).toEqual({ line: { kind: "unknown", type: "<invalid>" }, unknownFields: [] });
  }
});

test("a line of a known type without a required part counts as unknown", () => {
  const t = transcript({ sessionId: "s1" });
  t.raw({ type: "custom-title", sessionId: "s1" });
  t.raw({ type: "ai-title", sessionId: "s1", aiTitle: 7 });
  t.raw({ type: "cost-state", sessionId: "s1", modelUsage: {} });
  expect(parseAll(t).map((r) => r.line)).toEqual([
    { kind: "unknown", type: "custom-title" },
    { kind: "unknown", type: "ai-title" },
    { kind: "unknown", type: "cost-state" },
  ]);
});

test("an unknown top-level field goes into unknownFields, the line is parsed", () => {
  const t = transcript({ sessionId: "s1" });
  t.prompt("Fix it");
  t.assistant({ blocks: [text("ok")] });
  t.apiError({ message: "529 Overloaded" });
  t.instructions([{ path: "/a/CLAUDE.md", type: "Project", content: "abc" }]);
  t.customTitle("Title");
  t.costState({ totalCostUSD: 1, modelUsage: {} });
  const withExtra = (index: number, extra: RawLine) => parse({ ...t.lines[index], ...extra });

  const user = withExtra(0, { brandNewFlag: true, anotherOne: { nested: 1 } });
  expect(user.line).toMatchObject({ kind: "user", text: "Fix it" });
  expect(user.unknownFields).toEqual(["brandNewFlag", "anotherOne"]);

  // A field known to another line type is unknown for this one.
  expect(withExtra(1, { toolUseResult: {} })).toMatchObject({ line: { kind: "assistant" }, unknownFields: ["toolUseResult"] });
  expect(withExtra(2, { requestId: "req_1" })).toMatchObject({ line: { kind: "api_error", statusCode: 529 }, unknownFields: ["requestId"] });
  expect(withExtra(3, { subtype: "x" })).toMatchObject({ line: { kind: "instructions" }, unknownFields: ["subtype"] });
  expect(withExtra(4, { titleSource: "user" })).toMatchObject({ line: { kind: "custom_title" }, unknownFields: ["titleSource"] });
  expect(withExtra(5, { currency: "USD" })).toMatchObject({ line: { kind: "cost_state" }, unknownFields: ["currency"] });
});

test("known top-level fields from spikes §2 do not go into unknownFields", () => {
  const t = transcript({ sessionId: "s1" });
  t.prompt("Fix it");
  t.assistant({ blocks: [text("ok")] });
  t.apiError({ message: "x" });
  t.instructions([]);
  const common = { slug: "calm-river", userType: "external" };
  const known: RawLine[] = [
    { ...common, permissionMode: "default", promptSource: "user", origin: {}, sourceToolAssistantUUID: "u", sourceToolUseID: "t", isCompactSummary: true, isVisibleInTranscriptOnly: true, interruptedByShutdown: false, imagePasteIds: [], mcpMeta: {}, sandboxed: false, toolEndsTurn: false, classifierBoundary: 1, classifierMetaLines: [], clientPlatform: "desktop", queueSkipAttachments: false, queueSkipSlashCommands: false, queueTranscriptOnly: false, serverClassifierContext: {}, turnAttributionKey: "k", turnCompanion: {}, turnOrigin: "user", turnPosition: 1, toolUseResult: {}, permissionDecision: {}, toolDenialKind: "user-rejected", isMeta: false },
    { ...common, isApiErrorMessage: false, apiErrorStatus: 529, error: "e", errorDetails: {}, advisorModel: "m", apiBlockIndex: 0, attributionAgent: "a", attributionMcpServer: "s", attributionMcpTool: "t", attributionPlugin: "p", attributionSkill: "k", effort: "high", perTurnEffort: "high", isAbortedMidStream: false, promptCacheRequested: true, quotaLimits: {}, requestRef: "r", requestedModel: "m", serverClassifierRequest: {}, thinkingDisplay: "full", thinkingDurationMs: 10, toolInputStreamMs: 5, wireIngestContext: {}, wireToolInputs: [] },
    { ...common, content: "c", isMeta: false, compactMetadata: {}, logicalParentUuid: "u", hasOutput: true, hookAdditionalContext: [], hookCount: 1, hookErrors: [], hookInfos: [], preventedContinuation: false, stopReason: "s", toolUseID: "t" },
    { ...common, renderedRole: "user", renderedBesideToolResult: false, renderedInHumanTurn: true },
  ];
  const results = known.map((fields, index) => parse({ ...t.lines[index], ...fields }));
  expect(results.map((r) => r.line.kind)).toEqual(["user", "assistant", "api_error", "instructions"]);
  expect(results.map((r) => r.unknownFields)).toEqual([[], [], [], []]);
});

test("countUnknown sums line types and fields by line type", () => {
  const t = transcript({ sessionId: "s1" });
  lineOfType(t, "brand-new-line");
  lineOfType(t, "brand-new-line");
  lineOfType(t, "system/brand_new_subtype");
  lineOfType(t, "queue-operation");
  t.prompt("One");
  t.prompt("Two");
  t.assistant({ blocks: [text("ok")] });
  t.apiError({ message: "x" });
  t.compactBoundary({ preTokens: 10, postTokens: 5 });
  t.nestedMemory({ path: "/a/CLAUDE.md", type: "Nested", content: "abc" });
  t.aiTitle("Title");
  const extra: Record<number, RawLine> = {
    3: { newField: 1 }, // fields of a skipped line are not counted
    4: { newField: 1, otherField: 2 },
    5: { newField: 1 },
    6: { newField: 1 },
    7: { retryReason: "overloaded" },
    8: { retryReason: "n/a" },
    9: { constructor: "x" },
    10: { newField: 1 },
  };
  const results = t.lines.map((line, index) => parse({ ...line, ...extra[index] }));
  const stats = count([...results, parseLine("{broken")]);
  expect(stats).toEqual({
    types: { "brand-new-line": 2, "system/brand_new_subtype": 1, "<invalid>": 1 },
    fields: { "user.newField": 2, "user.otherField": 1, "assistant.newField": 1, "system.retryReason": 2, "attachment.constructor": 1, "ai-title.newField": 1 },
  });
});

test("the reference session is parsed without unknown types and fields", () => {
  const files = referenceFiles();
  const transcripts = [files.main, ...files.subagents!.map((sub) => sub.transcript)];
  const results = transcripts.flatMap(parseAll);
  expect(count(results)).toEqual({ types: {}, fields: {} });

  const kinds = new Set(results.map((r) => r.line.kind));
  expect([...kinds].sort()).toEqual(["ai_title", "api_error", "assistant", "instructions", "user"]);
  const raw = transcripts.flatMap((tr) => tr.lines as Line[]);
  const assistant = results.flatMap((r) => (r.line.kind === "assistant" ? [r.line] : []));
  expect(assistant).toHaveLength(raw.filter((l) => l.type === "assistant").length);
  expect(new Set(assistant.map((l) => l.requestId)).size).toBe(142);
  expect(assistant.flatMap((l) => l.blocks.filter((b) => b.type === "tool_use"))).toHaveLength(186);
  const toolResults = results.flatMap((r) => (r.line.kind === "user" ? r.line.toolResults : []));
  expect(toolResults).toHaveLength(186);
  expect(toolResults.filter((r) => r.isError)).toHaveLength(7);
});

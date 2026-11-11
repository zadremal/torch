// Tool calls: link between a call and its result, status, target, duration, bodies (plan §6.2).
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ToolCallRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { getContent } from "../../../src/ingest/reduce/contents.ts";
import { bedrock } from "../../../src/providers/bedrock.ts";
import { text, toolUse, transcript, type ToolResultInput } from "../../support/transcript.ts";
import { lastEventTs, parsed, reduce, rows, START } from "./modelCalls.support.ts";

const toolCalls = (db: Database) => rows<ToolCallRow>(db, "tool_calls");
const byId = (db: Database) => Object.fromEntries(toolCalls(db).map((call) => [call.id, call]));

/** One tool call by the main agent; the result arrives after `after` ms if given. */
function single(name: string, input: unknown, result?: ToolResultInput, after = 800): ToolCallRow {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", startAt: START });
  t.prompt("Go");
  const { toolUseIds } = t.assistant({ blocks: [toolUse(name, input)] });
  if (result) t.tick(after).toolResult(toolUseIds[0]!, result);
  reduce(db, t);
  return toolCalls(db)[0]!;
}

const BASH_RESULT = { stdout: "ok", stderr: "", interrupted: false, isImage: false, noOutputExpected: false };

test("a call and a result are linked by tool_use.id: one record with the input and output bodies in contents", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", startAt: START });
  t.prompt("Go");
  const input = { command: "bun test", description: "Run tests" };
  const { requestId, toolUseIds } = t.tick(2000).assistant({ blocks: [text("Running"), toolUse("Bash", input)] });
  t.tick(1200).toolResult(toolUseIds[0]!, { content: "44 pass\n0 fail", toolUseResult: { ...BASH_RESULT, stdout: "44 pass\n0 fail" } });

  reduce(db, t);

  const [call] = toolCalls(db);
  expect(call).toEqual({
    session_id: "s1",
    id: toolUseIds[0]!,
    agent_id: "main",
    model_call_id: requestId,
    turn_index: 1,
    name: "Bash",
    mcp_server: null,
    target: "bun test",
    ts_start: START + 2000,
    ts_end: START + 3200,
    duration_ms: 1200,
    duration_exact: 0,
    status: "ok",
    error_title: null,
    permission_decision: null,
    permission_source: null,
    spawned_agent_id: null,
    input_content_id: expect.any(Number),
    output_content_id: expect.any(Number),
    input_bytes: Buffer.byteLength(JSON.stringify(input, null, 2)),
    output_bytes: 14,
    lines_added: null,
    lines_removed: null,
  });
  expect(JSON.parse(getContent(db, call!.input_content_id!)!.text)).toEqual(input);
  expect(getContent(db, call!.output_content_id!)!.text).toBe("44 pass\n0 fail");
});

test("turn_index and model_call_id are the number and requestId of the model call whose reply holds the tool_use", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.prompt("Go");
  const first = t.assistant({ blocks: [toolUse("Read", { file_path: "/a.ts" })] });
  t.toolResult(first.toolUseIds[0]!, { content: "a" });
  const second = t.assistant({ blocks: [toolUse("Read", { file_path: "/b.ts" }), toolUse("Read", { file_path: "/c.ts" })] });

  reduce(db, t);

  const calls = byId(db);
  expect(calls[first.toolUseIds[0]!]).toMatchObject({ model_call_id: first.requestId, turn_index: 1 });
  expect(calls[second.toolUseIds[0]!]).toMatchObject({ model_call_id: second.requestId, turn_index: 2 });
  expect(calls[second.toolUseIds[1]!]).toMatchObject({ model_call_id: second.requestId, turn_index: 2 });
});

test("bedrock: turn_index and model_call_id come from the call keyed by message.id", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", gateway: true });
  t.prompt("Go");
  const first = t.assistant({ blocks: [toolUse("Read", { file_path: "/a.ts" })] });
  t.toolResult(first.toolUseIds[0]!, { content: "a" });
  const second = t.assistant({ blocks: [text("Two more"), toolUse("Read", { file_path: "/b.ts" }), toolUse("Read", { file_path: "/c.ts" })] });
  expect(second.requestId).toStartWith("msg_bdrk_");

  reduce(db, t, { provider: bedrock });

  const calls = byId(db);
  expect(calls[first.toolUseIds[0]!]).toMatchObject({ model_call_id: first.requestId, turn_index: 1 });
  expect(calls[second.toolUseIds[0]!]).toMatchObject({ model_call_id: second.requestId, turn_index: 2 });
  expect(calls[second.toolUseIds[1]!]).toMatchObject({ model_call_id: second.requestId, turn_index: 2 });
});

test("a call without a result is pending, with no end and no duration", () => {
  const call = single("Bash", { command: "sleep 60" });
  expect(call).toMatchObject({ status: "pending", ts_end: null, duration_ms: null, duration_exact: 0, output_content_id: null, output_bytes: null });
});

test("a result that arrives in the next pass completes the pending call", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", startAt: START });
  t.prompt("Go");
  const { toolUseIds } = t.assistant({ blocks: [toolUse("Bash", { command: "bun test" })] });
  t.tick(5000).toolResult(toolUseIds[0]!, { content: "ok", toolUseResult: BASH_RESULT });
  const lines = parsed(t);

  reduce(db, t, { lines: lines.slice(0, 2) });
  expect(toolCalls(db)[0]).toMatchObject({ status: "pending", ts_end: null });

  reduce(db, t, { lines: lines.slice(2), prevEventTs: lastEventTs(lines.slice(0, 2)) });
  expect(toolCalls(db)[0]).toMatchObject({ status: "ok", ts_start: START, ts_end: START + 5000, duration_ms: 5000 });
});

test("status: is_error is error, with the first line of the output in error_title", () => {
  const call = single("Bash", { command: "bun run build" }, { content: "\nExit code 1\nerror: unknown option '--zod'", isError: true, toolUseResult: "Error: Exit code 1" });
  expect(call).toMatchObject({ status: "error", error_title: "Exit code 1" });
});

test("status: a call the user rejected is denied, although the result is marked is_error", () => {
  const call = single("Bash", { command: "rm -rf build" }, { content: "The user doesn't want to proceed with this tool use.", isError: true, toolDenialKind: "user-rejected" });
  expect(call).toMatchObject({ status: "denied", permission_decision: "reject", permission_source: "user-rejected" });

  const prompt = single(
    "Bash",
    { command: "git push" },
    { content: "The user doesn't want to proceed with this tool use.", isError: true, permissionDecision: { decision: "reject", source: "user_reject" } },
  );
  expect(prompt).toMatchObject({ status: "denied", permission_decision: "reject", permission_source: "user_reject" });
});

test("status: a call blocked by a rule, auto mode or a hook is an error, the decision and source are recorded", () => {
  const rule = single(
    "Bash",
    { command: "git push" },
    { content: "Permission to use Bash has been denied.", isError: true, permissionDecision: { decision: "reject", source: "config", reasonType: "rule" } },
  );
  expect(rule).toMatchObject({ status: "error", error_title: "Permission to use Bash has been denied.", permission_decision: "reject", permission_source: "config" });

  const hook = single("Bash", { command: "curl x" }, { content: "Blocked by hook", isError: true, permissionDecision: { decision: "reject", source: "hook" } });
  expect(hook).toMatchObject({ status: "error", error_title: "Blocked by hook", permission_source: "hook" });

  const auto = single("WebFetch", { url: "https://x.test" }, { content: "Blocked by auto mode.\nReason: …", isError: true, toolDenialKind: "automode-blocked" });
  expect(auto).toMatchObject({ status: "error", error_title: "Blocked by auto mode.", permission_decision: "reject", permission_source: "automode-blocked" });
});

test("status: a blocked call is an error even when the result is not marked is_error", () => {
  const call = single("Bash", { command: "ls" }, { content: "Permission to use Bash has been denied.", toolDenialKind: "permission-rule" });
  expect(call).toMatchObject({ status: "error", error_title: "Permission to use Bash has been denied." });
});

test("status: an allow in permissionDecision does not change the status", () => {
  const call = single("Bash", { command: "ls" }, { content: "a.ts", toolUseResult: BASH_RESULT, permissionDecision: { decision: "accept", source: "config" } });
  expect(call).toMatchObject({ status: "ok", permission_decision: "accept", permission_source: "config" });
});

test("status: interrupted in a Bash result is interrupted", () => {
  const call = single("Bash", { command: "bun test --watch" }, { content: "Command was aborted", isError: true, toolUseResult: { ...BASH_RESULT, interrupted: true } });
  expect(call).toMatchObject({ status: "interrupted" });
});

test("duration: durationMs and totalDurationMs from the result are exact", () => {
  const glob = single("Glob", { pattern: "src/**/*.ts" }, { content: "23 files", toolUseResult: { filenames: [], numFiles: 23, durationMs: 310, truncated: false } }, 800);
  expect(glob).toMatchObject({ ts_end: START + 800, duration_ms: 310, duration_exact: 1 });

  const agent = single(
    "Agent",
    { description: "Map usage", prompt: "Find imports" },
    { content: "Report", toolUseResult: { agentId: "a1", agentType: "Explore", status: "completed", content: [], totalDurationMs: 146_000 } },
    150_000,
  );
  expect(agent).toMatchObject({ duration_ms: 146_000, duration_exact: 1 });
});

test("duration: without it in the result, the difference between result and call row times is an estimate", () => {
  const call = single("Bash", { command: "bun install" }, { content: "done", toolUseResult: BASH_RESULT }, 4200);
  expect(call).toMatchObject({ ts_start: START, ts_end: START + 4200, duration_ms: 4200, duration_exact: 0 });
});

test("call target: file path, first line of a command, URL, search pattern, query, subagent task description", () => {
  const targetOf = (name: string, input: unknown) => single(name, input).target;
  expect(targetOf("Read", { file_path: "/repo/src/a.ts", limit: 50 })).toBe("/repo/src/a.ts");
  expect(targetOf("Edit", { file_path: "/repo/src/b.ts", old_string: "a", new_string: "b" })).toBe("/repo/src/b.ts");
  expect(targetOf("Write", { file_path: "/repo/src/c.ts", content: "x" })).toBe("/repo/src/c.ts");
  expect(targetOf("Bash", { command: "cd /repo && \\\n  bun test\necho done", description: "Run tests" })).toBe("cd /repo && \\");
  expect(targetOf("WebFetch", { url: "https://bun.sh/docs/cli/test", prompt: "How to filter?" })).toBe("https://bun.sh/docs/cli/test");
  expect(targetOf("Grep", { pattern: "billingFetch\\(", path: "src" })).toBe("billingFetch\\(");
  expect(targetOf("Glob", { pattern: "tests/**/*.test.ts" })).toBe("tests/**/*.test.ts");
  expect(targetOf("WebSearch", { query: "openapi-ts zod plugin" })).toBe("openapi-ts zod plugin");
  expect(targetOf("Agent", { subagent_type: "Explore", description: "Map API client usage", prompt: "Find every import" })).toBe("Map API client usage");
  expect(targetOf("TodoWrite", { todos: [] })).toBeNull();
});

test("mcp_server is the server name for tools of the form mcp__<server>__<tool>", () => {
  expect(single("mcp__claude-in-chrome__tabs_create_mcp", {}).mcp_server).toBe("claude-in-chrome");
  expect(single("mcp__Claude_Browser__read_page", {}).mcp_server).toBe("Claude_Browser");
  expect(single("Bash", { command: "ls" }).mcp_server).toBeNull();
});

test("spawned_agent_id is the agentId from the Agent call result", () => {
  const call = single(
    "Agent",
    { description: "Rewrite tests", prompt: "Move tests to bun test", run_in_background: true },
    { content: "Async agent launched", toolUseResult: { agentId: "a7f3", isAsync: true, status: "async_launched", description: "Rewrite tests", prompt: "Move tests to bun test" } },
  );
  expect(call).toMatchObject({ status: "ok", spawned_agent_id: "a7f3", target: "Rewrite tests" });
});

test("changed lines are taken from the result's structuredPatch", () => {
  const edit = single(
    "Edit",
    { file_path: "/repo/a.ts", old_string: "one", new_string: "1\n2\n3" },
    {
      content: "Updated",
      toolUseResult: { filePath: "/repo/a.ts", oldString: "one", newString: "1\n2\n3", structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 4, lines: [" ctx", "-one", "-two", "+1", "+2", "+3", "+4"] }] },
    },
  );
  expect(edit).toMatchObject({ lines_added: 4, lines_removed: 2 });
});

/** A call in a subagent file: result rows there have no `toolUseResult`. */
function inSubagent(name: string, input: unknown, result: ToolResultInput): ToolCallRow {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", agentId: "a1", startAt: START });
  t.prompt("Subtask");
  const { toolUseIds } = t.assistant({ blocks: [toolUse(name, input)] });
  t.tick(300).toolResult(toolUseIds[0]!, result);
  reduce(db, t);
  return toolCalls(db)[0]!;
}

test("without toolUseResult changed lines are an estimate from the input: old_string and new_string for Edit, content for Write", () => {
  const edit = inSubagent("Edit", { file_path: "/repo/a.ts", old_string: "one\ntwo", new_string: "1\n2\n3\n" }, { content: "Updated" });
  expect(edit).toMatchObject({ agent_id: "a1", status: "ok", lines_added: 3, lines_removed: 2, duration_ms: 300, duration_exact: 0 });

  const write = inSubagent("Write", { file_path: "/repo/b.ts", content: "a\nb\nc\nd\n" }, { content: "Created" });
  expect(write).toMatchObject({ lines_added: 4, lines_removed: 0 });

  const read = inSubagent("Read", { file_path: "/repo/a.ts" }, { content: "one\ntwo" });
  expect(read).toMatchObject({ status: "ok", lines_added: null, lines_removed: null });
});

test("a failed edit without a structured result changes no lines", () => {
  const edit = inSubagent("Edit", { file_path: "/repo/a.ts", old_string: "one", new_string: "1\n2" }, { content: "String to replace not found in file.", isError: true });
  expect(edit).toMatchObject({ status: "error", error_title: "String to replace not found in file.", lines_added: null, lines_removed: null });
});

test("one tool_use.id in the files of two sessions — one call in each, a result completes only its own", () => {
  const db = openMemoryDb();
  const first = transcript({ sessionId: "s1" });
  first.assistant({ blocks: [toolUse("Read", { file_path: "/repo/a.ts" }, "toolu_shared")] });
  first.tick(500).toolResult("toolu_shared", { content: "a" });
  // A continued session copies the history of the original: the same identifier, no result yet.
  const second = transcript({ sessionId: "s2" });
  second.assistant({ blocks: [toolUse("Read", { file_path: "/repo/a.ts" }, "toolu_shared")] });
  reduce(db, second);
  reduce(db, first);

  expect(toolCalls(db).map((call) => [call.session_id, call.id, call.status])).toEqual([
    ["s1", "toolu_shared", "ok"],
    ["s2", "toolu_shared", "pending"],
  ]);
});

test("a result without a known call is skipped", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.toolResult("toolu_unknown", { content: "orphan" });
  reduce(db, t);
  expect(toolCalls(db)).toEqual([]);
});

test("reprocessing rows does not overwrite the duration and permission refined by enrichment", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.prompt("Go");
  const { toolUseIds } = t.assistant({ blocks: [toolUse("Bash", { command: "bun test" })] });
  // The result row has its own decision: enrichment refines its source, a repeat does not bring back the previous one.
  t.tick(5000).toolResult(toolUseIds[0]!, { content: "ok", toolUseResult: BASH_RESULT, permissionDecision: { decision: "accept", source: "config" } });
  reduce(db, t);
  // This is how enrich/merge.ts applies the tool_result and tool_decision events.
  db.run("UPDATE tool_calls SET duration_ms = 4870, duration_exact = 1, permission_decision = 'accept', permission_source = 'user_temporary'");
  const enriched = toolCalls(db);

  reduce(db, t);

  expect(toolCalls(db)).toEqual(enriched);
  expect(enriched[0]).toMatchObject({ status: "ok", duration_ms: 4870, duration_exact: 1, permission_decision: "accept", permission_source: "user_temporary" });
});

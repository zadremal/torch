// Idempotence of the call reducers: rows that arrive in two passes give the same database as
// one pass, and reprocessing the same rows does not change the database (plan §6.1).
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { SYNTHETIC_MODEL } from "../../../src/contracts/constants.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { text, thinking, toolUse, transcript, type Transcript } from "../../support/transcript.ts";
import { dump, lastEventTs, parsed, reduce, START } from "./modelCalls.support.ts";

/** Main file: multi-row replies, parallel calls, all statuses, API errors, a compaction. */
function mainFile(): Transcript {
  const t = transcript({ sessionId: "s1", startAt: START });
  t.prompt("Migrate the client");
  const first = t.tick(3000).assistant({
    blocks: [thinking("Plan"), text("Reading"), toolUse("Read", { file_path: "src/a.ts" }), toolUse("Bash", { command: "bun test\necho done" })],
    usage: { input: 12, output: 400, cacheRead: 9000, cacheWrite1h: 2000, thinking: 60 },
  });
  t.tick(200).toolResult(first.toolUseIds[0]!, { content: "one", toolUseResult: { type: "text", file: { filePath: "/repo/src/a.ts", content: "one" } } });
  t.tick(4000).toolResult(first.toolUseIds[1]!, { content: "Exit code 1\n3 fail", isError: true, toolUseResult: "Error: Exit code 1" });
  t.tick(500).apiError({ message: "529 Overloaded", retryAttempt: 1 });
  const second = t.tick(2500).assistant({
    blocks: [
      toolUse("Edit", { file_path: "src/a.ts", old_string: "one", new_string: "1\n2" }),
      toolUse("Write", { file_path: "src/new.ts", content: "a\nb\n" }),
      toolUse("WebFetch", { url: "https://bun.sh/docs", prompt: "Summarise" }),
      toolUse("Agent", { description: "Rewrite tests", prompt: "Move tests", run_in_background: true }),
    ],
    usage: { input: 14, output: 900, cacheRead: 11_000, cacheWrite5m: 500 },
  });
  t.tick(300).toolResult(second.toolUseIds[0]!, {
    content: "Updated",
    toolUseResult: { filePath: "/repo/src/a.ts", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-one", "+1", "+2"] }] },
  });
  t.tick(100).toolResult(second.toolUseIds[1]!, { content: "Denied", isError: true, toolDenialKind: "user-rejected", permissionDecision: { decision: "reject", source: "user" } });
  t.tick(2000).toolResult(second.toolUseIds[2]!, { content: "Summary", toolUseResult: { url: "https://bun.sh/docs", code: 200, bytes: 4096, durationMs: 1800, result: "Summary" } });
  t.tick(100).toolResult(second.toolUseIds[3]!, { content: "Launched", toolUseResult: { agentId: "a1", isAsync: true, status: "async_launched" } });
  t.tick(60_000).compactBoundary({ trigger: "auto", preTokens: 150_000, postTokens: 20_000, durationMs: 30_000 });
  t.tick(1000).envelope({
    type: "assistant",
    requestId: "req_failed",
    isApiErrorMessage: true,
    error: "overloaded",
    apiErrorStatus: 529,
    message: { role: "assistant", model: SYNTHETIC_MODEL, content: [{ type: "text", text: "API Error" }] },
  });
  const third = t.tick(5000).assistant({ blocks: [text("Checking"), toolUse("Bash", { command: "bun test --watch" }), toolUse("WebSearch", { query: "bun watch" })], usage: { input: 9, output: 120, cacheRead: 20_000 } });
  t.tick(9000).toolResult(third.toolUseIds[0]!, { content: "aborted", isError: true, toolUseResult: { stdout: "", stderr: "", interrupted: true } });
  // The WebSearch call stays without a result.
  t.tick(2000).assistant({ blocks: [text("Stopped")], usage: { input: 5, output: 40, cacheRead: 21_000 } });
  return t;
}

/** Subagent file: result rows without `toolUseResult`. */
function subagentFile(): Transcript {
  const t = transcript({ sessionId: "s1", agentId: "a1", startAt: START + 20_000 });
  t.prompt("Move tests");
  const { toolUseIds } = t.tick(2000).assistant({
    blocks: [
      text("Editing"),
      toolUse("Read", { file_path: "/repo/tests/a.test.ts" }),
      toolUse("Edit", { file_path: "/repo/tests/a.test.ts", old_string: "vi.fn()", new_string: "mock()\n// bun" }),
      toolUse("WebFetch", { url: "https://bun.sh/docs/cli/test", prompt: "Mocks" }),
    ],
    usage: { input: 8, output: 300, cacheRead: 5000, cacheWrite5m: 700 },
  });
  for (const id of toolUseIds) t.tick(400).toolResult(id, { content: "ok" });
  t.tick(1500).assistant({ blocks: [text("Done")], usage: { input: 6, output: 80, cacheRead: 6500 } });
  return t;
}

/** Database after processing the files; the `splitFile` file arrives in two passes with the boundary before row `splitAt`. */
function load(db: Database, files: Transcript[], splitFile?: Transcript, splitAt = 0): Database {
  for (const file of files) {
    const lines = parsed(file);
    if (file !== splitFile) {
      reduce(db, file, { lines });
      continue;
    }
    reduce(db, file, { lines: lines.slice(0, splitAt) });
    reduce(db, file, { lines: lines.slice(splitAt), prevEventTs: lastEventTs(lines.slice(0, splitAt)) });
  }
  return db;
}

const files = [mainFile(), subagentFile()];
const onePass = dump(load(openMemoryDb(), files));

test("the scenario covers all package tables and all call statuses", () => {
  const counts = Object.fromEntries(Object.entries(onePass).map(([table, list]) => [table, list.length]));
  expect(counts).toMatchObject({ model_calls: 6, tool_calls: 11, file_ops: 5, external_requests: 3, api_errors: 2, compactions: 1 });
  const statuses = new Set((onePass.tool_calls as { status: string }[]).map((call) => call.status));
  expect([...statuses].sort()).toEqual(["denied", "error", "interrupted", "ok", "pending"]);
});

test("two passes with the boundary at any row give the same database as one", () => {
  for (const file of files) {
    for (let splitAt = 1; splitAt < file.lines.length; splitAt++) {
      expect(dump(load(openMemoryDb(), files, file, splitAt)), `${file.options.agentId ?? "main"}: boundary before row ${splitAt}`).toEqual(onePass);
    }
  }
});

test("reprocessing the same rows does not change the database", () => {
  const db = load(openMemoryDb(), files);
  // The file is re-read from the start in full…
  load(db, files);
  expect(dump(db)).toEqual(onePass);
  // …and once more, in chunks.
  load(db, files, files[0], 7);
  load(db, files, files[1], 3);
  expect(dump(db)).toEqual(onePass);
});

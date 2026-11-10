// External requests: one record per WebFetch or WebSearch call (plan §6.2).
import { expect, test } from "bun:test";
import type { ExternalRequestRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { toolUse, transcript } from "../../support/transcript.ts";
import { reduce, rows, START } from "./modelCalls.support.ts";

const byId = (list: ExternalRequestRow[]) => Object.fromEntries(list.map((row) => [row.id, row]));

test("WebFetch and WebSearch: address, status, size and duration from the structured result", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", startAt: START });
  t.prompt("Go");
  const { toolUseIds } = t.tick(1000).assistant({
    blocks: [toolUse("WebFetch", { url: "https://bun.sh/docs", prompt: "Summarise" }), toolUse("WebSearch", { query: "bun test filter" }), toolUse("Bash", { command: "curl https://bun.sh" })],
  });
  const [fetch, search, bash] = toolUseIds as [string, string, string];
  // The request went to the address after a redirect: it is named in the result.
  t.tick(3000).toolResult(fetch, { content: "Summary", toolUseResult: { url: "https://bun.com/docs", code: 200, codeText: "OK", bytes: 88268, durationMs: 2140, result: "Summary" } });
  t.tick(1000).toolResult(search, { content: "Results", toolUseResult: { query: "bun test filter", results: [], durationSeconds: 1.2345, searchCount: 1 } });
  t.tick(1000).toolResult(bash, { content: "<html>", toolUseResult: { stdout: "<html>", stderr: "", interrupted: false } });

  reduce(db, t);

  type Outcome = Pick<ExternalRequestRow, "kind" | "url" | "status_code" | "bytes" | "duration_ms">;
  const request = (id: string, fields: Outcome): ExternalRequestRow => ({ session_id: "s1", id, agent_id: "main", tool_call_id: id, ts: START + 1000, ...fields });
  expect(byId(rows<ExternalRequestRow>(db, "external_requests"))).toEqual({
    [fetch]: request(fetch, { kind: "web_fetch", url: "https://bun.com/docs", status_code: 200, bytes: 88268, duration_ms: 2140 }),
    [search]: request(search, { kind: "web_search", url: "bun test filter", status_code: null, bytes: null, duration_ms: 1235 }),
  });
});

test("without toolUseResult (subagent file) the address comes from the input, the duration from row times, status and size are unknown", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", agentId: "a1", startAt: START });
  t.prompt("Subtask");
  const { toolUseIds } = t.assistant({ blocks: [toolUse("WebFetch", { url: "https://bun.sh/docs", prompt: "Summarise" }), toolUse("WebSearch", { query: "bun test filter" })] });
  t.tick(2500).toolResult(toolUseIds[0]!, { content: "Summary" });
  t.tick(500).toolResult(toolUseIds[1]!, { content: "Results" });

  reduce(db, t);

  const requests = byId(rows<ExternalRequestRow>(db, "external_requests"));
  expect(requests[toolUseIds[0]!]).toMatchObject({ agent_id: "a1", kind: "web_fetch", url: "https://bun.sh/docs", status_code: null, bytes: null, duration_ms: 2500, ts: START });
  expect(requests[toolUseIds[1]!]).toMatchObject({ agent_id: "a1", kind: "web_search", url: "bun test filter", status_code: null, bytes: null, duration_ms: 3000, ts: START });
});

test("a call without a result is a request with the address from the input and no duration", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.prompt("Go");
  const { toolUseIds } = t.assistant({ blocks: [toolUse("WebFetch", { url: "https://example.com/slow", prompt: "Read" })] });

  reduce(db, t);

  expect(rows<ExternalRequestRow>(db, "external_requests")).toMatchObject([{ id: toolUseIds[0]!, kind: "web_fetch", url: "https://example.com/slow", status_code: null, bytes: null, duration_ms: null }]);
});

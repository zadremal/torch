import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { referenceScenario } from "./reference.ts";
import { referenceFiles, writeReferenceSession } from "./reference-transcript.ts";
import { text, thinking, toolUse, transcript, writeSession } from "./transcript.ts";

type Line = Record<string, any>;

test("a response of several blocks is written as lines with a shared requestId, the output_tokens total is in the last one", () => {
  const t = transcript({ sessionId: "s1" });
  t.prompt("Fix it");
  const { requestId, uuids, toolUseIds } = t.assistant({
    blocks: [thinking("hm"), text("Reading"), toolUse("Read", { file_path: "/a.ts" })],
    usage: { input: 10, output: 500, cacheRead: 2000, cacheWrite1h: 300, thinking: 40 },
  });
  t.toolResult(toolUseIds[0]!, { content: "file body" });
  const assistant = (t.lines as Line[]).filter((l) => l.type === "assistant");
  expect(assistant).toHaveLength(3);
  expect(uuids).toHaveLength(3);
  expect(new Set(assistant.map((l) => l.requestId))).toEqual(new Set([requestId]));
  expect(assistant.map((l) => l.message.usage.output_tokens)).toEqual([1, 2, 500]);
  expect(new Set(assistant.map((l) => l.message.usage.cache_read_input_tokens))).toEqual(new Set([2000]));
  expect(assistant.map((l) => l.message.stop_reason)).toEqual([null, null, "tool_use"]);
  const result = (t.lines as Line[]).at(-1)!;
  expect(result.message.content[0].tool_use_id).toBe(toolUseIds[0]);
  expect(result.parentUuid).toBe(uuids[2]);
});

test("a subagent file marks lines with agentId and isSidechain", () => {
  const t = transcript({ sessionId: "s1", agentId: "a1" });
  t.prompt("Explore");
  expect(t.lines[0]).toMatchObject({ agentId: "a1", isSidechain: true, sessionId: "s1" });
});

test("writeSession lays out files like Claude Code", () => {
  const root = mkdtempSync(join(tmpdir(), "torch-transcripts-"));
  const main = transcript({ sessionId: "s1", cwd: "/Users/dev/code/app" });
  main.prompt("Hello");
  const sub = transcript({ sessionId: "s1", agentId: "a1", cwd: "/Users/dev/code/app" });
  sub.prompt("Explore");
  const written = writeSession(root, { main, subagents: [{ transcript: sub, meta: { agentType: "Explore", toolUseId: "toolu_1", spawnDepth: 1 } }], customTitleFile: "My title" });
  expect(written.mainPath).toBe(join(root, "-Users-dev-code-app", "s1.jsonl"));
  expect(written.subagentPaths).toEqual([join(root, "-Users-dev-code-app", "s1", "subagents", "agent-a1.jsonl")]);
  expect(JSON.parse(readFileSync(join(written.sessionDir, "subagents", "agent-a1.meta.json"), "utf8")).toolUseId).toBe("toolu_1");
  expect(JSON.parse(readFileSync(join(written.sessionDir, "custom-title.json"), "utf8"))).toEqual({ customTitle: "My title" });
  expect(readFileSync(written.mainPath, "utf8").endsWith("\n")).toBe(true);
});

test("the reference session as transcripts follows the scenario", () => {
  const scn = referenceScenario();
  const files = referenceFiles(scn);
  const all = [files.main, ...files.subagents!.map((s) => s.transcript)].flatMap((t) => t.lines as Line[]);
  const requests = new Set(all.filter((l) => l.type === "assistant").map((l) => l.requestId));
  const toolUses = all.filter((l) => l.type === "assistant").flatMap((l) => l.message.content.filter((b: Line) => b.type === "tool_use"));
  const results = all.filter((l) => l.type === "user" && Array.isArray(l.message.content) && l.message.content.some((b: Line) => b.type === "tool_result"));
  expect(files.subagents).toHaveLength(4);
  expect(requests.size).toBe(142);
  expect(toolUses).toHaveLength(186);
  expect(results).toHaveLength(186);
  expect(results.filter((l) => l.message.content[0].is_error)).toHaveLength(7);
  expect(all.filter((l) => l.type === "system" && l.subtype === "api_error")).toHaveLength(3);
  // Three prompts: the first has an image, so it is written as blocks.
  expect((files.main.lines as Line[]).filter((l) => l.type === "user" && !results.includes(l))).toHaveLength(3);
  // The lines of each file go in time order.
  for (const t of [files.main, ...files.subagents!.map((s) => s.transcript)]) {
    const times = (t.lines as Line[]).filter((l) => l.timestamp).map((l) => Date.parse(l.timestamp));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  }
  const root = mkdtempSync(join(tmpdir(), "torch-reference-"));
  const written = writeReferenceSession(root, scn);
  expect(existsSync(written.mainPath)).toBe(true);
  expect(written.subagentPaths).toHaveLength(4);
});

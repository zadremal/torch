// User messages: the session's first prompt is original, the rest are follow_up.
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { PromptRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { reducePrompts } from "../../../src/ingest/reduce/prompts.ts";
import { text, toolUse, transcript } from "../../support/transcript.ts";
import { context, contentText, parsed, rows } from "./session.support.ts";

const START = Date.UTC(2026, 9, 1, 10, 0, 0);

const prompts = (db: Database) =>
  rows<PromptRow>(db, "SELECT * FROM prompts ORDER BY session_id, seq").map(({ content_id, ...row }) => ({ ...row, text: contentText(db, content_id) }));

test("the first prompt is marked original, the rest follow_up; number, time, text and token estimate", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", startAt: START });
  const first = t.prompt("Fix the bug");
  t.tick(2000).assistant({ blocks: [text("Done")] });
  const second = t.tick(60_000).prompt("Also update the docs, 日本語");
  const third = t.tick(60_000).prompt("Thanks");
  reducePrompts(context(db, t), parsed(t));

  expect(prompts(db)).toEqual([
    { session_id: "s1", id: first, ts: START, seq: 0, kind: "original", text: "Fix the bug", tokens_est: 3, attachments_json: null },
    // 22 Latin characters and 3 CJK characters: 31 bytes, 4 bytes per token rounded up.
    { session_id: "s1", id: second, ts: START + 62_000, seq: 1, kind: "follow_up", text: "Also update the docs, 日本語", tokens_est: 8, attachments_json: null },
    { session_id: "s1", id: third, ts: START + 122_000, seq: 2, kind: "follow_up", text: "Thanks", tokens_est: 2, attachments_json: null },
  ]);
});

test("a tool result and an internal row are not counted as prompts", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.prompt("<system-reminder>internal</system-reminder>", { isMeta: true });
  const real = t.prompt("Run the tests");
  const { toolUseIds } = t.assistant({ blocks: [toolUse("Bash", { command: "bun test" })] });
  t.toolResult(toolUseIds[0]!, { content: "12 pass" });
  reducePrompts(context(db, t), parsed(t));

  expect(prompts(db).map((row) => [row.id, row.kind, row.text])).toEqual([[real, "original", "Run the tests"]]);
});

test("a compacted-context summary and a background task notification are not prompts; a message from another session is a prompt", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.prompt("Summary of the conversation so far", { isCompactSummary: true });
  t.prompt("<task-notification>done</task-notification>", { origin: "task-notification" });
  const human = t.prompt("Continue", { origin: "human" });
  const peer = t.prompt("Task from another session", { origin: "peer" });
  reducePrompts(context(db, t), parsed(t));

  expect(prompts(db).map((row) => [row.id, row.kind])).toEqual([
    [human, "original"],
    [peer, "follow_up"],
  ]);
});

test("a row with a tool result and text beside it is not a prompt", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  const { toolUseIds } = t.assistant({ blocks: [toolUse("Bash", { command: "bun test" })] });
  t.envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseIds[0], content: "12 pass" }, { type: "text", text: "note next to the result" }] },
  });
  reducePrompts(context(db, t), parsed(t));

  expect(prompts(db)).toEqual([]);
});

test("a command call is recorded as '/name arguments'; command output and an interruption marker are not prompts", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  const skill = t.prompt("<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>the last commit</command-args>");
  const local = t.prompt("<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>");
  t.prompt("<local-command-stdout>Compacted</local-command-stdout>");
  t.prompt("<bash-input>ls</bash-input><bash-stdout>a.ts</bash-stdout><bash-stderr></bash-stderr>");
  t.prompt("[Request interrupted by user for tool use]");
  reducePrompts(context(db, t), parsed(t));

  expect(prompts(db).map((row) => [row.id, row.kind, row.text])).toEqual([
    [skill, "original", "/review the last commit"],
    [local, "follow_up", "/compact"],
  ]);
});

test("prompt images are recorded as attachments; a prompt of a single image is also a prompt", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.prompt("What is on these screenshots?", { images: 2 });
  t.envelope({ type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }] } });
  reducePrompts(context(db, t), parsed(t));

  expect(prompts(db).map((row) => [row.kind, row.text, row.tokens_est, row.attachments_json])).toEqual([
    ["original", "What is on these screenshots?", 8, '["Image #1","Image #2"]'],
    ["follow_up", "", 0, '["Image #1"]'],
  ]);
});

test("a subagent file gives no prompts: the task from the parent is not a user message", () => {
  const db = openMemoryDb();
  const sub = transcript({ sessionId: "s1", agentId: "a1" });
  sub.prompt("Explore the repo");
  reducePrompts(context(db, sub), parsed(sub));
  expect(prompts(db)).toEqual([]);
});

test("a prompt of a later pass continues the numbering and stays follow_up", () => {
  const db = openMemoryDb();
  const first = transcript({ sessionId: "s1", startAt: START });
  first.prompt("Fix the bug");
  reducePrompts(context(db, first), parsed(first));

  const second = transcript({ sessionId: "s1", startAt: START + 60_000 });
  second.prompt("Also update the docs", { uuid: "later-prompt" });
  reducePrompts(context(db, second), parsed(second));

  expect(prompts(db).map((row) => [row.seq, row.kind, row.text])).toEqual([
    [0, "original", "Fix the bug"],
    [1, "follow_up", "Also update the docs"],
  ]);
});

test("reprocessing the same rows changes neither the number nor the kind", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.prompt("Fix the bug");
  t.prompt("Also update the docs");
  reducePrompts(context(db, t), parsed(t));
  const before = prompts(db);

  // The file is re-read from the start (plan §6.1, step 6): the same rows arrive again.
  reducePrompts(context(db, t), parsed(t));
  expect(prompts(db)).toEqual(before);
});

test("prompt numbering is separate for each session", () => {
  const db = openMemoryDb();
  for (const sessionId of ["s1", "s2"]) {
    const t = transcript({ sessionId });
    t.prompt(`First of ${sessionId}`);
    reducePrompts(context(db, t), parsed(t));
  }
  expect(prompts(db).map((row) => [row.session_id, row.seq, row.kind])).toEqual([
    ["s1", 0, "original"],
    ["s2", 0, "original"],
  ]);
});

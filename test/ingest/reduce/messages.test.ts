// Model text and thinking go into messages; tool calls and Claude Code rows do not.
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { MAIN_AGENT_ID, SYNTHETIC_MODEL } from "../../../src/contracts/constants.ts";
import type { MessageRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { reduceMessages } from "../../../src/ingest/reduce/messages.ts";
import { bedrock } from "../../../src/providers/bedrock.ts";
import { text, thinking, toolUse, transcript } from "../../support/transcript.ts";
import { context, contentText, parsed, rows } from "./session.support.ts";

const START = Date.UTC(2026, 9, 1, 10, 0, 0);

const messages = (db: Database) =>
  rows<MessageRow>(db, "SELECT * FROM messages ORDER BY ts, id").map(({ content_id, ...row }) => ({ ...row, text: contentText(db, content_id) }));

test("reply text and thinking — one record per block, with the model call, agent and row time", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", startAt: START });
  t.prompt("Fix the bug");
  const { requestId, uuids } = t.tick(4000).assistant({
    blocks: [thinking("The bug is in the parser"), text("Reading the parser"), toolUse("Read", { file_path: "/a.ts" })],
  });
  reduceMessages(context(db, t), parsed(t));

  expect(messages(db)).toEqual([
    { session_id: "s1", id: `${uuids[0]}:0`, agent_id: MAIN_AGENT_ID, model_call_id: requestId, ts: START + 4000, kind: "thinking", text: "The bug is in the parser" },
    { session_id: "s1", id: `${uuids[1]}:0`, agent_id: MAIN_AGENT_ID, model_call_id: requestId, ts: START + 4000, kind: "text", text: "Reading the parser" },
  ]);
});

test("a single-row reply: block number in the identifier, the tool call skipped", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  const { uuids } = t.assistant({ blocks: [thinking("hm"), toolUse("Bash", { command: "ls" }), text("Listed")], split: false });
  reduceMessages(context(db, t), parsed(t));

  expect(messages(db).map((row) => [row.id, row.kind, row.text])).toEqual([
    [`${uuids[0]}:0`, "thinking", "hm"],
    [`${uuids[0]}:2`, "text", "Listed"],
  ]);
});

test("a subagent's message is recorded against its agent", () => {
  const db = openMemoryDb();
  const sub = transcript({ sessionId: "s1", agentId: "a1" });
  sub.assistant({ blocks: [text("Exploring")] });
  reduceMessages(context(db, sub), parsed(sub));
  expect(messages(db).map((row) => [row.agent_id, row.kind, row.text])).toEqual([["a1", "text", "Exploring"]]);
});

test("empty blocks are not recorded: thinking without text and a line break before a call", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.assistant({ blocks: [thinking(""), text("\n\n"), text("Answer")] });
  reduceMessages(context(db, t), parsed(t));
  expect(messages(db).map((row) => [row.kind, row.text])).toEqual([["text", "Answer"]]);
});

test("Claude Code rows with the <synthetic> model and API error messages are not a model reply", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.assistant({ model: SYNTHETIC_MODEL, blocks: [text("No response requested.")] });
  t.envelope({
    type: "assistant",
    isApiErrorMessage: true,
    error: "overloaded",
    apiErrorStatus: 529,
    message: { id: "msg_1", type: "message", role: "assistant", model: SYNTHETIC_MODEL, content: [{ type: "text", text: "API Error: Overloaded" }], stop_reason: "stop_sequence" },
  });
  reduceMessages(context(db, t), parsed(t));
  expect(messages(db)).toEqual([]);
});

test("a row without requestId gives a message without a model call", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.assistant({ blocks: [text("Answer")] });
  delete t.lines[0]!.requestId;
  reduceMessages(context(db, t), parsed(t));
  expect(messages(db).map((row) => [row.model_call_id, row.text])).toEqual([[null, "Answer"]]);
});

describe("bedrock provider", () => {
  test("<synthetic> and API error rows are still not a model reply", () => {
    const db = openMemoryDb();
    const t = transcript({ sessionId: "s1", gateway: true });
    t.assistant({ model: SYNTHETIC_MODEL, blocks: [text("No response requested.")] });
    t.envelope({
      type: "assistant",
      isApiErrorMessage: true,
      error: "overloaded",
      apiErrorStatus: 529,
      message: { id: "msg_bdrk_1", type: "message", role: "assistant", model: "claude-align-aws-opus-5-5", content: [{ type: "text", text: "API Error: Overloaded" }], stop_reason: "stop_sequence" },
    });
    reduceMessages(context(db, t, { provider: bedrock }), parsed(t));
    expect(messages(db)).toEqual([]);
  });

  test("a row with message.id and no requestId gives a message of the model call message.id", () => {
    const db = openMemoryDb();
    const t = transcript({ sessionId: "s1", gateway: true });
    const { requestId } = t.assistant({ blocks: [thinking("hm"), text("Answer")] });
    expect(requestId).toStartWith("msg_bdrk_");
    reduceMessages(context(db, t, { provider: bedrock }), parsed(t));
    expect(messages(db).map((row) => [row.model_call_id, row.text])).toEqual([
      [requestId, "hm"],
      [requestId, "Answer"],
    ]);
  });
});

test("reprocessing the same rows does not change the table", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.assistant({ blocks: [thinking("hm"), text("Answer")] });
  reduceMessages(context(db, t), parsed(t));
  const before = messages(db);
  reduceMessages(context(db, t), parsed(t));
  expect(messages(db)).toEqual(before);
  expect(before).toHaveLength(2);
});

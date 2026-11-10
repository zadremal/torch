// File operations: one record per Read, Edit or Write call (plan §6.2).
import { expect, test } from "bun:test";
import type { FileOpRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { toolUse, transcript } from "../../support/transcript.ts";
import { reduce, rows, START } from "./modelCalls.support.ts";

test("Read, Edit and Write each give an operation with the path and changed lines from the structured result", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", startAt: START });
  t.prompt("Go");
  const { toolUseIds } = t.tick(1000).assistant({
    blocks: [
      toolUse("Read", { file_path: "src/a.ts" }),
      toolUse("Edit", { file_path: "src/a.ts", old_string: "one", new_string: "1\n2" }),
      toolUse("Write", { file_path: "src/new.ts", content: "a\nb\nc\n" }),
      toolUse("Bash", { command: "cat src/a.ts" }),
      toolUse("Grep", { pattern: "one", path: "src" }),
    ],
  });
  const [read, edit, write, bash, grep] = toolUseIds as [string, string, string, string, string];
  // The structured result names the full path; in the input it could have been relative.
  t.tick(100).toolResult(read, { content: "one", toolUseResult: { type: "text", file: { filePath: "/repo/src/a.ts", content: "one", numLines: 1, startLine: 1, totalLines: 1 } } });
  t.tick(100).toolResult(edit, {
    content: "Updated",
    toolUseResult: { filePath: "/repo/src/a.ts", oldString: "one", newString: "1\n2", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-one", "+1", "+2"] }] },
  });
  t.tick(100).toolResult(write, { content: "Created", toolUseResult: { type: "create", filePath: "/repo/src/new.ts", content: "a\nb\nc\n", structuredPatch: [], originalFile: null } });
  t.tick(100).toolResult(bash, { content: "one", toolUseResult: { stdout: "one", stderr: "", interrupted: false } });
  t.tick(100).toolResult(grep, { content: "src/a.ts", toolUseResult: { mode: "files_with_matches", filenames: ["src/a.ts"], numFiles: 1 } });

  reduce(db, t);

  type Change = Pick<FileOpRow, "path" | "op" | "lines_added" | "lines_removed">;
  const op = (id: string, fields: Change): FileOpRow => ({ session_id: "s1", id, agent_id: "main", tool_call_id: id, ts: START + 1000, ...fields });
  expect(rows<FileOpRow>(db, "file_ops")).toEqual(
    [
      op(read, { path: "/repo/src/a.ts", op: "read", lines_added: null, lines_removed: null }),
      op(edit, { path: "/repo/src/a.ts", op: "edit", lines_added: 2, lines_removed: 1 }),
      op(write, { path: "/repo/src/new.ts", op: "write", lines_added: 3, lines_removed: 0 }),
    ].sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
});

test("without toolUseResult (subagent file) the path comes from the input, changed lines are an estimate from the input", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", agentId: "a1", startAt: START });
  t.prompt("Subtask");
  const { toolUseIds } = t.assistant({
    blocks: [
      toolUse("Read", { file_path: "/repo/src/a.ts" }),
      toolUse("Edit", { file_path: "/repo/src/a.ts", old_string: "one\ntwo", new_string: "1\n2\n3" }),
      toolUse("Write", { file_path: "/repo/src/new.ts", content: "a\nb\n" }),
    ],
  });
  for (const id of toolUseIds) t.tick(100).toolResult(id, { content: "ok" });

  reduce(db, t);

  const ops = rows<FileOpRow>(db, "file_ops");
  expect(ops.map((op) => op.agent_id)).toEqual(["a1", "a1", "a1"]);
  expect(Object.fromEntries(ops.map((op) => [op.id, [op.path, op.op, op.lines_added, op.lines_removed]]))).toEqual({
    [toolUseIds[0]!]: ["/repo/src/a.ts", "read", null, null],
    [toolUseIds[1]!]: ["/repo/src/a.ts", "edit", 3, 2],
    [toolUseIds[2]!]: ["/repo/src/new.ts", "write", 2, 0],
  });
});

test("a call without a result and a failed edit remain operations with the path from the input and no changed lines", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.prompt("Go");
  const { toolUseIds } = t.assistant({
    blocks: [toolUse("Edit", { file_path: "/repo/a.ts", old_string: "x", new_string: "y" }), toolUse("Write", { file_path: "/repo/b.ts", content: "a\n" })],
  });
  // For errors Claude Code writes a string into toolUseResult.
  t.toolResult(toolUseIds[0]!, { content: "String to replace not found in file.", isError: true, toolUseResult: "Error: String to replace not found in file." });

  reduce(db, t);

  expect(Object.fromEntries(rows<FileOpRow>(db, "file_ops").map((op) => [op.id, [op.path, op.op, op.lines_added, op.lines_removed]]))).toEqual({
    [toolUseIds[0]!]: ["/repo/a.ts", "edit", null, null],
    [toolUseIds[1]!]: ["/repo/b.ts", "write", null, null],
  });
});

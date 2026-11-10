// Incremental reading: only complete lines, offset in bytes, re-reading from the start.
import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileState, ReadResult } from "../../src/contracts/pipeline.ts";
import { parseLine } from "../../src/ingest/parse.ts";
import { readTranscript } from "../../src/ingest/reader.ts";
import { text, toolUse, transcript, writeSession } from "../support/transcript.ts";

function tempFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "torch-reader-")), "session.jsonl");
  writeFileSync(path, content);
  return path;
}

/** What the indexer will remember about a file after a pass. */
const stateAfter = (result: ReadResult): FileState => ({ inode: result.inode, size: result.size, parsedOffset: result.nextOffset });

test("the first pass reads the file from the start and returns information about it", () => {
  const path = tempFile('{"n":1}\n{"n":2}\n');
  const stat = statSync(path);
  expect(readTranscript(path, null)).toEqual({
    lines: ['{"n":1}', '{"n":2}'],
    nextOffset: 16,
    size: 16,
    mtime: Math.trunc(stat.mtimeMs),
    inode: stat.ino,
    restarted: false,
  });
});

test("a truncated last line waits for the next pass", () => {
  const path = tempFile('{"n":1}\n{"n":2}\n{"n":');
  const first = readTranscript(path, null);
  expect(first.lines).toEqual(['{"n":1}', '{"n":2}']);
  expect(first.nextOffset).toBe(16);
  expect(first.size).toBe(21);

  // The line was not finished being written: it is as if the pass never happened.
  appendFileSync(path, "3");
  const second = readTranscript(path, stateAfter(first));
  expect(second).toMatchObject({ lines: [], nextOffset: 16, size: 22, restarted: false });

  appendFileSync(path, "}\n");
  const third = readTranscript(path, stateAfter(second));
  expect(third).toMatchObject({ lines: ['{"n":3}'], nextOffset: 24, size: 24, restarted: false });
});

test("a file without a single newline yields nothing", () => {
  const path = tempFile('{"n":1');
  expect(readTranscript(path, null)).toMatchObject({ lines: [], nextOffset: 0, size: 6, restarted: false });
  expect(readTranscript(tempFile(""), null)).toMatchObject({ lines: [], nextOffset: 0, size: 0, restarted: false });
});

test("an appended file: only the new lines are read", () => {
  const path = tempFile('{"n":1}\n{"n":2}\n');
  const first = readTranscript(path, null);

  appendFileSync(path, '{"n":3}\n{"n":4}\n');
  const second = readTranscript(path, stateAfter(first));
  expect(second).toMatchObject({ lines: ['{"n":3}', '{"n":4}'], nextOffset: 32, size: 32, restarted: false });
  expect(second.inode).toBe(first.inode);

  // Nothing changed: no new lines, the offset stays in place.
  expect(readTranscript(path, stateAfter(second))).toMatchObject({ lines: [], nextOffset: 32, size: 32, restarted: false });
});

test("a shortened file is re-read from the start", () => {
  const path = tempFile('{"n":1}\n{"n":2}\n{"n":3}\n');
  const first = readTranscript(path, null);
  expect(first.nextOffset).toBe(24);

  // Writing to the same path keeps the inode: it is the size that triggers.
  writeFileSync(path, '{"m":1}\n{"m":');
  const second = readTranscript(path, stateAfter(first));
  expect(second.inode).toBe(first.inode);
  expect(second).toMatchObject({ lines: ['{"m":1}'], nextOffset: 8, size: 13, restarted: true });
});

test("a shortened file with an unread tail: the size is smaller than before, though larger than the offset", () => {
  const path = tempFile('{"n":1}\n{"n":2,"tail":"not finished yet');
  const first = readTranscript(path, null);
  expect(first).toMatchObject({ nextOffset: 8, size: 39 });

  writeFileSync(path, '{"m":1}\n{"m":2}\n');
  const second = readTranscript(path, stateAfter(first));
  expect(second).toMatchObject({ lines: ['{"m":1}', '{"m":2}'], nextOffset: 16, size: 16, restarted: true });
});

test("a replaced file (a different inode) is re-read from the start, even if it is longer", () => {
  const path = tempFile('{"n":1}\n{"n":2}\n');
  const first = readTranscript(path, null);

  const replacement = `${path}.new`;
  writeFileSync(replacement, '{"m":1}\n{"m":2}\n{"m":3}\n');
  renameSync(replacement, path);
  const second = readTranscript(path, stateAfter(first));
  expect(second.inode).not.toBe(first.inode);
  expect(second).toMatchObject({ lines: ['{"m":1}', '{"m":2}', '{"m":3}'], nextOffset: 24, size: 24, restarted: true });
});

test("empty lines are skipped, the offset accounts for them", () => {
  const path = tempFile('{"n":1}\n\n  \n{"n":2}\r\n\n');
  const result = readTranscript(path, null);
  expect(result.lines.map((line) => JSON.parse(line))).toEqual([{ n: 1 }, { n: 2 }]);
  expect(result.nextOffset).toBe(result.size);
});

test("the offset is counted in bytes: multi-byte characters do not shift the boundary", () => {
  const first = '{"text":"café, naïve — 你好"}\n';
  const second = '{"text":"second line é"}\n';
  const path = tempFile(first + second + '{"text":"cut off mid-wo');
  const pass = readTranscript(path, null);
  expect(pass.lines).toEqual([first.trimEnd(), second.trimEnd()]);
  expect(pass.nextOffset).toBe(Buffer.byteLength(first + second));

  // Reading from the middle of the file starts exactly at the next line.
  const fromSecond = readTranscript(path, { inode: pass.inode, size: pass.size, parsedOffset: Buffer.byteLength(first) });
  expect(fromSecond.lines).toEqual([second.trimEnd()]);
  expect(fromSecond.nextOffset).toBe(pass.nextOffset);
});

test("a transcript written in chunks yields the same lines as one read whole", () => {
  const t = transcript({ sessionId: "s1" });
  t.prompt("Fix the bug");
  const { toolUseIds } = t.assistant({ blocks: [text("Looking"), toolUse("Read", { file_path: "/a.ts" })] });
  t.toolResult(toolUseIds[0]!, { content: "file body" });
  t.aiTitle("Fix the bug");
  const jsonl = Buffer.from(t.jsonl());
  const { mainPath } = writeSession(mkdtempSync(join(tmpdir(), "torch-reader-")), { main: t });
  const whole = readTranscript(mainPath, null);
  expect(whole.lines).toEqual(t.lines.map((line) => JSON.stringify(line)));
  expect(whole.lines.map((line) => parseLine(line).line.kind)).toEqual(["user", "assistant", "assistant", "user", "ai_title"]);

  // The same file is appended in 100-byte chunks: chunk boundaries cut lines and characters.
  const path = tempFile("");
  const collected: string[] = [];
  let state: FileState | null = null;
  for (let offset = 0; offset < jsonl.length; offset += 100) {
    appendFileSync(path, jsonl.subarray(offset, offset + 100));
    const pass = readTranscript(path, state);
    expect(pass.restarted).toBe(false);
    collected.push(...pass.lines);
    state = stateAfter(pass);
  }
  expect(collected).toEqual(whole.lines);
  expect(state!.parsedOffset).toBe(jsonl.length);
});

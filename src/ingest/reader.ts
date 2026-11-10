// Incremental transcript reading by offset. Package P1.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ReadTranscript } from "../contracts/pipeline.ts";

const NEWLINE = 0x0a;

export const readTranscript: ReadTranscript = (path, prev) => {
  const fd = openSync(path, "r");
  try {
    // Size and inode are taken from the open file: exactly the file and the amount described in the answer are read.
    const stat = fstatSync(fd);
    const restarted = prev !== null && (stat.ino !== prev.inode || stat.size < prev.size);
    const start = prev === null || restarted ? 0 : prev.parsedOffset;

    const buffer = Buffer.allocUnsafe(Math.max(0, stat.size - start));
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
      if (read === 0) break;
      filled += read;
    }

    // A newline byte never occurs inside a multi-byte UTF-8 character, so the boundary
    // is searched for by bytes, and the offset stays a byte offset.
    const complete = buffer.subarray(0, filled).lastIndexOf(NEWLINE) + 1;
    return {
      lines: buffer
        .toString("utf8", 0, complete)
        .split("\n")
        .filter((line) => line.trim() !== ""),
      nextOffset: start + complete,
      size: stat.size,
      mtime: Math.trunc(stat.mtimeMs),
      inode: stat.ino,
      restarted,
    };
  } finally {
    closeSync(fd);
  }
};

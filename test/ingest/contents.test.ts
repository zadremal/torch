import { expect, test } from "bun:test";
import { CONTENT_COMPRESS_MIN_BYTES } from "../../src/contracts/constants.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { getContent, putContent } from "../../src/ingest/reduce/contents.ts";

test("the body comes back as the same text, a repeat does not create a second record", () => {
  const db = openMemoryDb();
  const id = putContent(db, "café, torch");
  expect(putContent(db, "café, torch")).toBe(id);
  expect(putContent(db, "another body")).not.toBe(id);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM contents").get()!.n).toBe(2);
  expect(getContent(db, id)).toEqual({ text: "café, torch", bytes: Buffer.byteLength("café, torch") });
});

test("a body over the threshold is stored compressed and decompressed on read", () => {
  const db = openMemoryDb();
  const small = "a".repeat(CONTENT_COMPRESS_MIN_BYTES);
  const large = "b".repeat(CONTENT_COMPRESS_MIN_BYTES + 1);
  const smallId = putContent(db, small);
  const largeId = putContent(db, large);
  const encoding = (id: number) => db.query<{ encoding: string; stored: number }, [number]>("SELECT encoding, length(body) AS stored FROM contents WHERE id = ?").get(id)!;
  expect(encoding(smallId).encoding).toBe("raw");
  expect(encoding(largeId).encoding).toBe("gzip");
  expect(encoding(largeId).stored).toBeLessThan(large.length);
  expect(getContent(db, largeId)).toEqual({ text: large, bytes: large.length });
});

test("a nonexistent body yields null", () => {
  expect(getContent(openMemoryDb(), 42)).toBeNull();
});

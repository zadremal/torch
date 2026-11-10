// GET /api/contents/:id: a body by id, as unpacked text.
import { expect, test } from "bun:test";
import type { ApiError, ContentResponse } from "../../src/contracts/api.ts";
import { CONTENT_COMPRESS_MIN_BYTES } from "../../src/contracts/constants.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { putContent } from "../../src/ingest/reduce/contents.ts";
import contentsFixture from "../fixtures/dto/contents.json";
import { testApi } from "../support/api.ts";
import { seedReference } from "../support/reference-seed.ts";

test("a short body is returned as is, with its size in bytes", async () => {
  const db = openMemoryDb();
  const text = "Café — 5 €\nnaïve discount";
  const id = putContent(db, text);
  expect(db.query<{ encoding: string }, [number]>("SELECT encoding FROM contents WHERE id = ?").get(id)).toEqual({ encoding: "raw" });

  expect(await testApi(db).get<ContentResponse>(`/api/contents/${id}`)).toEqual({ id, bytes: Buffer.byteLength(text), text });
});

test("a compressed body is returned unpacked and whole", async () => {
  const db = openMemoryDb();
  const text = "command output line\n".repeat(2_000);
  const id = putContent(db, text);
  const stored = db.query<{ encoding: string; size: number }, [number]>("SELECT encoding, LENGTH(body) AS size FROM contents WHERE id = ?").get(id)!;
  expect(Buffer.byteLength(text)).toBeGreaterThan(CONTENT_COMPRESS_MIN_BYTES);
  expect(stored.encoding).toBe("gzip");
  expect(stored.size).toBeLessThan(Buffer.byteLength(text));

  expect(await testApi(db).get<ContentResponse>(`/api/contents/${id}`)).toEqual({ id, bytes: Buffer.byteLength(text), text });
});

test("no body or a non-numeric id — 404", async () => {
  const db = openMemoryDb();
  const id = putContent(db, "body");
  for (const raw of [String(id + 1), "0", "abc", "-1", "1.5", `${id}abc`, "9".repeat(40)]) {
    const response = await testApi(db).request(`/api/contents/${raw}`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as ApiError).error).toContain(raw);
  }
});

test("bodies of the reference session match the dto example", async () => {
  const db = openMemoryDb();
  seedReference(db);
  const api = testApi(db);
  const fixture = contentsFixture as Record<string, ContentResponse>;

  expect(Object.keys(fixture).length).toBeGreaterThan(100);
  for (const [id, content] of Object.entries(fixture)) {
    expect(await api.get<ContentResponse>(`/api/contents/${id}`)).toEqual(content);
  }
});

// Bodies addressed by hash: the only module that writes and reads the contents table.
// Written in the foundation: used by reducers, test supports and the API.
import type { Database } from "bun:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { CONTENT_COMPRESS_MIN_BYTES } from "../../contracts/constants.ts";
import type { ContentRow } from "../../contracts/rows.ts";

/** Puts the body into contents and returns its identifier. Repeating the same body returns the existing one. */
export function putContent(db: Database, text: string): number {
  const raw = Buffer.from(text, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const existing = db.query<{ id: number }, [string]>("SELECT id FROM contents WHERE sha256 = ?").get(sha256);
  if (existing) return existing.id;
  const compress = raw.byteLength > CONTENT_COMPRESS_MIN_BYTES;
  const inserted = db
    .query<{ id: number }, [string, number, string, Uint8Array]>(
      "INSERT INTO contents (sha256, bytes, encoding, body) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .get(sha256, raw.byteLength, compress ? "gzip" : "raw", compress ? gzipSync(raw) : raw);
  return inserted!.id;
}

/** Returns the unpacked body; null if there is no record. */
export function getContent(db: Database, id: number): { text: string; bytes: number } | null {
  const row = db
    .query<Pick<ContentRow, "bytes" | "encoding" | "body">, [number]>("SELECT bytes, encoding, body FROM contents WHERE id = ?")
    .get(id);
  if (!row) return null;
  const raw = row.encoding === "gzip" ? gunzipSync(row.body) : Buffer.from(row.body);
  return { text: raw.toString("utf8"), bytes: row.bytes };
}

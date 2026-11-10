// Bodies in API responses: a link with the start of the text for panels, and the whole body by id.
// Read from the database, so they stay available after the transcript is deleted (decisions 21 and 28). Package A2.
import type { Database } from "bun:sqlite";
import type { BodyRef, ContentResponse } from "../contracts/api.ts";
import { BODY_PREVIEW_CHARS } from "../contracts/constants.ts";
import { getContent } from "../ingest/reduce/contents.ts";
import { type Handler, notFound } from "./context.ts";

/** Start of a body for a panel: no longer than BODY_PREVIEW_CHARS and without half a surrogate pair at the cut. */
function previewOf(text: string): string {
  const cut = text.slice(0, BODY_PREVIEW_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Link to a body for a panel; null if there is no body. */
export function bodyRef(db: Database, contentId: number | null): BodyRef | null {
  if (contentId === null) return null;
  const content = getContent(db, contentId);
  if (!content) return null;
  return {
    contentId,
    bytes: content.bytes,
    preview: previewOf(content.text),
    truncated: content.text.length > BODY_PREVIEW_CHARS,
  };
}

export const getContentBody: Handler = (c) => {
  const raw = c.req.param("id") ?? "";
  // A body id is an integer; nothing else can be a body.
  const content = /^\d{1,15}$/.test(raw) ? getContent(c.get("db"), Number(raw)) : null;
  if (!content) return notFound(c, `body ${raw}`);
  return c.json<ContentResponse>({ id: Number(raw), bytes: content.bytes, text: content.text });
};

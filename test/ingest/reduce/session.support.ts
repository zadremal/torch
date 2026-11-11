// Common parts of the structure reducer tests (package I2): parsing an assembled transcript, the reducer
// context for its file and reading database rows.
import type { Database } from "bun:sqlite";
import { MAIN_AGENT_ID } from "../../../src/contracts/constants.ts";
import type { ParsedLine } from "../../../src/contracts/lines.ts";
import type { ReduceContext } from "../../../src/contracts/pipeline.ts";
import { parseLine } from "../../../src/ingest/parse.ts";
import { getContent } from "../../../src/ingest/reduce/contents.ts";
import { REF_PRICES } from "../../support/reference.ts";
import type { Transcript } from "../../support/transcript.ts";
import { ANTHROPIC_PROVIDER } from "../../support/provider.ts";

/** Transcript rows parsed by the parser, in recording order. */
export const parsed = (t: Transcript): ParsedLine[] => t.lines.map((line) => parseLine(JSON.stringify(line)).line);

/** Reducer context for this transcript's file: without meta.json and external titles unless given. */
export function context(db: Database, t: Transcript, extra: Partial<Pick<ReduceContext, "agentMeta" | "titles">> = {}): ReduceContext {
  return {
    db,
    sessionId: t.options.sessionId,
    agentId: t.options.agentId ?? MAIN_AGENT_ID,
    prices: REF_PRICES,
    provider: ANTHROPIC_PROVIDER,
    prevEventTs: null,
    agentMeta: null,
    titles: { customFile: null, desktop: null },
    ...extra,
  };
}

export function rows<Row>(db: Database, sql: string): Row[] {
  return db.query<Row, []>(sql).all();
}

export const contentText = (db: Database, id: number | null): string | null => (id === null ? null : (getContent(db, id)?.text ?? null));

// Compactions from system/compact_boundary rows (plan §3.1).
import { expect, test } from "bun:test";
import type { CompactionRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { transcript } from "../../support/transcript.ts";
import { reduce, rows, START } from "./modelCalls.support.ts";

test("a compact_boundary row is a compaction with a reason, before and after sizes and a duration", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", startAt: START });
  t.prompt("Go");
  const auto = t.tick(60_000).compactBoundary({ trigger: "auto", preTokens: 168_000, postTokens: 21_500, durationMs: 31_000 });
  const manual = t.tick(60_000).compactBoundary({ trigger: "manual", preTokens: 90_000, postTokens: 12_000, durationMs: 18_000 });

  reduce(db, t);

  expect(rows<CompactionRow>(db, "compactions")).toEqual([
    { session_id: "s1", id: auto, agent_id: "main", ts: START + 60_000, trigger: "auto", pre_tokens: 168_000, post_tokens: 21_500, duration_ms: 31_000 },
    { session_id: "s1", id: manual, agent_id: "main", ts: START + 120_000, trigger: "manual", pre_tokens: 90_000, post_tokens: 12_000, duration_ms: 18_000 },
  ]);
});

test("reprocessing does not duplicate the compaction or overwrite what enrichment refined", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", agentId: "a1" });
  t.compactBoundary({ trigger: "auto", preTokens: 150_000, postTokens: 20_000 });
  reduce(db, t);
  // This is how enrich/merge.ts refines the compaction with the PreCompact and PostCompact events.
  db.run("UPDATE compactions SET trigger = 'manual', duration_ms = 30000");
  const enriched = rows<CompactionRow>(db, "compactions");

  reduce(db, t);

  expect(rows<CompactionRow>(db, "compactions")).toEqual(enriched);
  expect(enriched).toMatchObject([{ agent_id: "a1", trigger: "manual", duration_ms: 30_000 }]);
});

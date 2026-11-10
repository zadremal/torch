// API errors: failed attempts with a retry and final failures (plan §3.1).
import { expect, test } from "bun:test";
import { SYNTHETIC_MODEL } from "../../../src/contracts/constants.ts";
import type { ApiErrorRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { text, transcript } from "../../support/transcript.ts";
import { reduce, rows, START } from "./modelCalls.support.ts";

test("a system/api_error row is a failed attempt with a number, a retry limit and a pause", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", agentId: "a1", startAt: START });
  t.prompt("Go");
  const connection = t.tick(1000).apiError({ message: "Connection error.", retryAttempt: 1, maxRetries: 10, retryInMs: 1200 });
  const overloaded = t.tick(1200).apiError({ message: "529 Overloaded", retryAttempt: 2, maxRetries: 10, retryInMs: 2400 });

  reduce(db, t);

  type Attempt = Pick<ApiErrorRow, "ts" | "status_code" | "error" | "attempt" | "retry_in_ms">;
  const error = (id: string, fields: Attempt): ApiErrorRow => ({ session_id: "s1", id, agent_id: "a1", request_id: null, max_retries: 10, source: "transcript", ...fields });
  expect(rows<ApiErrorRow>(db, "api_errors")).toEqual([
    error(connection, { ts: START + 1000, status_code: null, error: "Connection error.", attempt: 1, retry_in_ms: 1200 }),
    error(overloaded, { ts: START + 2200, status_code: 529, error: "529 Overloaded", attempt: 2, retry_in_ms: 2400 }),
  ]);
});

test("an assistant row with isApiErrorMessage is a final failure with a status, not a model call", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1", startAt: START });
  t.prompt("Go");
  const message = { role: "assistant", model: SYNTHETIC_MODEL, content: [{ type: "text", text: "API Error: Repeated 529 Overloaded errors" }], usage: { input_tokens: 0, output_tokens: 0 } };
  const withStatus = t.tick(9000).envelope({ type: "assistant", requestId: "req_failed", isApiErrorMessage: true, error: "overloaded", apiErrorStatus: 529, message });
  const withoutStatus = t.tick(1000).envelope({ type: "assistant", isApiErrorMessage: true, error: "unknown", message });
  t.assistant({ blocks: [text("Recovered")] });

  reduce(db, t);

  const refusal = { session_id: "s1", agent_id: "main", attempt: null, max_retries: null, retry_in_ms: null, source: "transcript" } as const;
  expect(rows<ApiErrorRow>(db, "api_errors")).toEqual([
    { ...refusal, id: withStatus, ts: START + 9000, request_id: "req_failed", status_code: 529, error: "overloaded" },
    { ...refusal, id: withoutStatus, ts: START + 10_000, request_id: null, status_code: null, error: "unknown" },
  ]);
  expect(rows<{ id: string }>(db, "model_calls").map((call) => call.id)).not.toContain("req_failed");
});

test("reprocessing does not duplicate errors or overwrite what enrichment refined", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.apiError({ message: "Connection error." });
  reduce(db, t);
  // This is how enrich/merge.ts joins a transcript row with the api_error event from OTel.
  db.run("UPDATE api_errors SET request_id = 'req_1', status_code = 503");
  const enriched = rows<ApiErrorRow>(db, "api_errors");

  reduce(db, t);

  expect(rows<ApiErrorRow>(db, "api_errors")).toEqual(enriched);
  expect(enriched).toMatchObject([{ request_id: "req_1", status_code: 503 }]);
});

// GET /api/events event stream: SSE format, broadcast to all connections, heartbeat, client leaving.
import { afterEach, expect, jest, test } from "bun:test";
import { publishIndexed, SSE_HEARTBEAT_MS } from "../../src/api/events.ts";
import { API_ROUTES } from "../../src/contracts/api.ts";
import type { ServerEvent } from "../../src/contracts/events.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { testApi } from "../support/api.ts";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const connection of open.splice(0)) await connection.close();
  jest.useRealTimers();
});

/** An open stream connection: reads SSE records one at a time. */
async function connect() {
  const response = await testApi(openMemoryDb()).request(API_ROUTES.events);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const connection = {
    response,
    /** Next stream record — text up to a blank line. */
    async record(): Promise<string> {
      while (!buffer.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Stream closed");
        buffer += decoder.decode(value, { stream: true });
      }
      const end = buffer.indexOf("\n\n");
      const record = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return record;
    },
    /** Next events: `data:` records with JSON. */
    async events(count: number): Promise<ServerEvent[]> {
      const events: ServerEvent[] = [];
      while (events.length < count) {
        const record = await connection.record();
        if (record.startsWith("data: ")) events.push(JSON.parse(record.slice("data: ".length)) as ServerEvent);
      }
      return events;
    },
    close: () => reader.cancel(),
  };
  open.push(connection);
  return connection;
}

test("the connection opens as an SSE stream and immediately delivers a first record", async () => {
  const connection = await connect();

  expect(connection.response.status).toBe(200);
  expect(connection.response.headers.get("content-type")).toBe("text/event-stream");
  expect(connection.response.headers.get("cache-control")).toBe("no-cache");
  // A comment: the browser gets the headers and opens the connection, but does not count it as an event.
  expect(await connection.record()).toBe(": connected");
});

test("indexer pass: an event for each changed session and one common to the lists", async () => {
  const connection = await connect();

  publishIndexed(["s1", "s2"]);

  expect(await connection.events(3)).toEqual([
    { type: "session_changed", sessionId: "s1" },
    { type: "session_changed", sessionId: "s2" },
    { type: "index_updated", sessions: 2 },
  ]);
});

test("an event record is a single data line with JSON", async () => {
  const connection = await connect();
  await connection.record();

  publishIndexed(["line\nbreak"]);

  expect(await connection.record()).toBe('data: {"type":"session_changed","sessionId":"line\\nbreak"}');
  expect(await connection.record()).toBe('data: {"type":"index_updated","sessions":1}');
});

test("all open connections receive the event; a closed one does not hinder the others", async () => {
  const first = await connect();
  const second = await connect();

  publishIndexed(["s1"]);
  expect(await first.events(2)).toEqual(await second.events(2));

  await first.close();
  publishIndexed(["s2"]);
  expect(await second.events(2)).toEqual([
    { type: "session_changed", sessionId: "s2" },
    { type: "index_updated", sessions: 1 },
  ]);
});

test("a connection opened after the event does not receive it", async () => {
  publishIndexed(["early"]);
  const connection = await connect();

  publishIndexed(["late"]);

  expect((await connection.events(1))[0]).toEqual({ type: "session_changed", sessionId: "late" });
});

test("without events the connection keeps a heartbeat", async () => {
  jest.useFakeTimers();
  const connection = await connect();
  await connection.record();

  jest.advanceTimersByTime(SSE_HEARTBEAT_MS);
  expect(await connection.record()).toBe(": ping");
  jest.advanceTimersByTime(SSE_HEARTBEAT_MS);
  expect(await connection.record()).toBe(": ping");
});

test("after the client leaves the heartbeat stops", async () => {
  jest.useFakeTimers();
  const connection = await connect();
  expect(jest.getTimerCount()).toBe(1);

  await connection.close();

  expect(jest.getTimerCount()).toBe(0);
});

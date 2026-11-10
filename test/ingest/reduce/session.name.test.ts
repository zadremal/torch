// Session name by the priority of decision 7: custom-title → desktop app title → ai-title →
// start of the first prompt.
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ExternalTitles } from "../../../src/contracts/pipeline.ts";
import type { SessionRow } from "../../../src/contracts/rows.ts";
import { openMemoryDb } from "../../../src/db/db.ts";
import { reduceSession } from "../../../src/ingest/reduce/session.ts";
import { text, transcript, type Transcript } from "../../support/transcript.ts";
import { context, parsed, rows } from "./session.support.ts";

type Name = Pick<SessionRow, "name" | "name_lower" | "name_source">;

const nameOf = (db: Database): Name => rows<Name>(db, "SELECT name, name_lower, name_source FROM sessions WHERE id = 's1'")[0]!;

/** One pass over the main file with the given external titles. */
function pass(db: Database, t: Transcript, titles: Partial<ExternalTitles> = {}): Name {
  reduceSession(context(db, t, { titles: { customFile: null, desktop: null, ...titles } }), parsed(t));
  return nameOf(db);
}

/** Main file with all name sources in its rows: prompt, ai-title and custom-title. */
function fullTranscript(): Transcript {
  const t = transcript({ sessionId: "s1" });
  t.prompt("Fix the flaky billing test");
  t.assistant({ blocks: [text("On it")] });
  t.aiTitle("Stabilise billing tests");
  t.customTitle("Billing: Flaky Test");
  return t;
}

// ── Priority levels ─────────────────────────────────────────────────────────────────────────

test("level 1: a custom-title row outranks the desktop app title, ai-title and the prompt", () => {
  expect(pass(openMemoryDb(), fullTranscript(), { desktop: "Desktop title" })).toEqual({
    name: "Billing: Flaky Test",
    name_lower: "billing: flaky test",
    name_source: "custom",
  });
});

test("level 1: custom-title.json gives a name with source custom and outranks a custom-title row", () => {
  const onlyFile = transcript({ sessionId: "s1" });
  onlyFile.prompt("Fix the flaky billing test");
  expect(pass(openMemoryDb(), onlyFile, { customFile: "Renamed In File", desktop: "Desktop title" })).toEqual({
    name: "Renamed In File",
    name_lower: "renamed in file",
    name_source: "custom",
  });
  expect(pass(openMemoryDb(), fullTranscript(), { customFile: "Renamed In File" })).toMatchObject({ name: "Renamed In File", name_source: "custom" });
});

test("level 2: the desktop app title outranks ai-title and the prompt", () => {
  const t = transcript({ sessionId: "s1" });
  t.prompt("Fix the flaky billing test");
  t.aiTitle("Stabilise billing tests");
  expect(pass(openMemoryDb(), t, { desktop: "Desktop Title" })).toEqual({ name: "Desktop Title", name_lower: "desktop title", name_source: "desktop" });
});

test("level 3: ai-title outranks the prompt", () => {
  const t = transcript({ sessionId: "s1" });
  t.prompt("Fix the flaky billing test");
  t.aiTitle("Stabilise billing tests");
  expect(pass(openMemoryDb(), t)).toEqual({ name: "Stabilise billing tests", name_lower: "stabilise billing tests", name_source: "ai" });
});

test("level 4: without titles the name is the start of the first prompt", () => {
  const t = transcript({ sessionId: "s1" });
  t.prompt("Fix the flaky billing test");
  t.assistant({ blocks: [text("On it")] });
  t.prompt("Also update the docs");
  expect(pass(openMemoryDb(), t)).toEqual({ name: "Fix the flaky billing test", name_lower: "fix the flaky billing test", name_source: "prompt" });
});

test("level 4: a session started by a command — the name is '/name arguments', without the record tags", () => {
  const t = transcript({ sessionId: "s1" });
  t.prompt("<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>the last commit</command-args>");
  expect(pass(openMemoryDb(), t)).toEqual({ name: "/review the last commit", name_lower: "/review the last commit", name_source: "prompt" });
});

test("a session without a single name source stays without a name", () => {
  const t = transcript({ sessionId: "s1" });
  t.assistant({ blocks: [text("Hello")] });
  expect(pass(openMemoryDb(), t)).toEqual({ name: null, name_lower: null, name_source: null });
});

// ── Name from the prompt ────────────────────────────────────────────────────────────────────

test("name from the prompt: one line, at most 80 characters, with an ellipsis when truncated", () => {
  const short = transcript({ sessionId: "s1" });
  short.prompt("  Fix the bug\n\nin   src/api/billing.ts\n");
  expect(pass(openMemoryDb(), short).name).toBe("Fix the bug in src/api/billing.ts");

  const long = transcript({ sessionId: "s1" });
  long.prompt(`${"word ".repeat(30)}end`);
  const { name } = pass(openMemoryDb(), long);
  expect(name).toBe(`${"word ".repeat(16).trimEnd()}…`);
  expect([...name!].length).toBeLessThanOrEqual(81);
});

test("name from the prompt: internal rows and tool results are not counted as a prompt", () => {
  const t = transcript({ sessionId: "s1" });
  t.prompt("<local-command-caveat>internal</local-command-caveat>", { isMeta: true });
  t.toolResult("toolu_1", { content: "tool output" });
  t.prompt("", { images: 1 });
  t.prompt("Real question");
  expect(pass(openMemoryDb(), t)).toMatchObject({ name: "Real question", name_source: "prompt" });
});

test("name_lower — the name in lowercase for any alphabet", () => {
  const t = transcript({ sessionId: "s1" });
  t.customTitle("Écran API Façade");
  expect(pass(openMemoryDb(), t)).toEqual({ name: "Écran API Façade", name_lower: "écran api façade", name_source: "custom" });
});

test("an empty title is not counted as a source", () => {
  const t = transcript({ sessionId: "s1" });
  t.prompt("Fix the flaky billing test");
  t.aiTitle("   ");
  expect(pass(openMemoryDb(), t, { customFile: "", desktop: "  " })).toMatchObject({ name: "Fix the flaky billing test", name_source: "prompt" });
});

// ── Name between passes ─────────────────────────────────────────────────────────────────────

test("a higher-priority source that arrives later replaces the name — at every level", () => {
  const db = openMemoryDb();
  const first = transcript({ sessionId: "s1" });
  first.prompt("Fix the flaky billing test");
  expect(pass(db, first)).toMatchObject({ name_source: "prompt" });

  const second = transcript({ sessionId: "s1" });
  second.aiTitle("Stabilise billing tests");
  expect(pass(db, second)).toEqual({ name: "Stabilise billing tests", name_lower: "stabilise billing tests", name_source: "ai" });

  expect(pass(db, transcript({ sessionId: "s1" }), { desktop: "Desktop Title" })).toEqual({ name: "Desktop Title", name_lower: "desktop title", name_source: "desktop" });

  const fourth = transcript({ sessionId: "s1" });
  fourth.customTitle("Billing: Flaky Test");
  expect(pass(db, fourth, { desktop: "Desktop Title" })).toEqual({ name: "Billing: Flaky Test", name_lower: "billing: flaky test", name_source: "custom" });
});

test("a lower-priority source that arrives later does not change the name", () => {
  const db = openMemoryDb();
  const first = transcript({ sessionId: "s1" });
  first.customTitle("Billing: Flaky Test");
  pass(db, first);

  const later = transcript({ sessionId: "s1" });
  later.prompt("Fix the flaky billing test");
  later.aiTitle("Stabilise billing tests");
  expect(pass(db, later, { desktop: "Desktop Title" })).toEqual({ name: "Billing: Flaky Test", name_lower: "billing: flaky test", name_source: "custom" });
});

test("the next prompt does not change the name from the first prompt", () => {
  const db = openMemoryDb();
  const first = transcript({ sessionId: "s1" });
  first.prompt("Fix the flaky billing test");
  pass(db, first);

  const later = transcript({ sessionId: "s1" });
  later.prompt("Also update the docs");
  expect(pass(db, later)).toMatchObject({ name: "Fix the flaky billing test", name_source: "prompt" });
});

test("a new value of the same source replaces the previous one: a rename and a new ai-title", () => {
  const db = openMemoryDb();
  const first = transcript({ sessionId: "s1" });
  first.aiTitle("First guess");
  first.aiTitle("Second guess");
  expect(pass(db, first)).toMatchObject({ name: "Second guess", name_source: "ai" });

  const second = transcript({ sessionId: "s1" });
  second.aiTitle("Third guess");
  expect(pass(db, second)).toEqual({ name: "Third guess", name_lower: "third guess", name_source: "ai" });

  const third = transcript({ sessionId: "s1" });
  third.customTitle("Old Name");
  pass(db, third);
  const fourth = transcript({ sessionId: "s1" });
  fourth.customTitle("New Name");
  expect(pass(db, fourth)).toEqual({ name: "New Name", name_lower: "new name", name_source: "custom" });
});

test("an external title is applied even in a pass without new rows", () => {
  const db = openMemoryDb();
  const t = transcript({ sessionId: "s1" });
  t.prompt("Fix the flaky billing test");
  pass(db, t);
  reduceSession(context(db, t, { titles: { customFile: null, desktop: "Desktop Title" } }), []);
  expect(nameOf(db)).toMatchObject({ name: "Desktop Title", name_source: "desktop" });
});

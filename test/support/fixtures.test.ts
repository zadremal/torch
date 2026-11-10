import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DTO_DIR, serialize } from "./build-dto.ts";
import { buildDtoFixtures, fixtureFiles } from "./reference-dto.ts";

const fixtures = await buildDtoFixtures();

test("files in test/fixtures/dto match the generator (otherwise: bun run fixtures)", () => {
  const files = fixtureFiles(fixtures);
  expect(readdirSync(DTO_DIR).filter((name) => name.endsWith(".json")).sort()).toEqual(Object.keys(files).sort());
  for (const [name, value] of Object.entries(files)) {
    expect(readFileSync(join(DTO_DIR, name), "utf8") === serialize(value)).toBe(true);
  }
});

test("the reference session's responses are consistent with each other", () => {
  const { session, timeline, agents, toolCalls, network, files, sessions, contents } = fixtures;
  expect(session.agents).toHaveLength(5);
  expect(session.modelCalls).toBe(142);
  expect(session.toolCalls).toBe(186);
  expect(session.toolErrors).toBe(7);
  expect(session.prompts.map((p) => p.kind)).toEqual(["original", "follow_up", "follow_up"]);
  expect(timeline.tools).toHaveLength(186);
  expect(timeline.modelCalls).toHaveLength(142);
  expect(timeline.apiErrors).toHaveLength(3);
  // Every timeline mark has its panel available.
  for (const tool of timeline.tools) expect(toolCalls[tool.id]).toBeDefined();
  for (const call of timeline.modelCalls) expect(network[`model:${call.id}`]).toBeDefined();
  for (const error of timeline.apiErrors) expect(network[`error:${error.id}`]).toBeDefined();
  for (const request of timeline.external) expect(network[`external:${request.id}`]).toBeDefined();
  for (const op of timeline.files) expect(files[op.path]).toBeDefined();
  for (const agent of timeline.agents) expect(agents[agent.agentId]).toBeDefined();
  // Every content reference has the content itself.
  for (const panel of Object.values(toolCalls)) {
    expect(contents[panel.input!.contentId]).toBeDefined();
    expect(contents[panel.output!.contentId]).toBeDefined();
  }
  for (const panel of Object.values(agents)) {
    expect(panel.ctxBreakdown.reduce((n, b) => n + b.tokens, 0)).toBe(panel.ctxPeak!);
  }
  expect(sessions.items).toHaveLength(16);
  expect(sessions.items[0]!.id).toBe(session.id);
});

test("dashboard: bar counts by range and week totals equal the sum over the list", () => {
  const { dashboard, sessions } = fixtures;
  expect(Object.fromEntries(Object.entries(dashboard).map(([range, d]) => [range, d.series.modelCalls.length]))).toEqual({ day: 12, week: 7, month: 30, year: 12, custom: 31 });
  const week = sessions.items.filter((s) => s.startedAt! >= dashboard.week.from && s.startedAt! < dashboard.week.to);
  expect(dashboard.week.totals.sessions.value).toBe(week.length);
  expect(dashboard.week.totals.toolCalls.value).toBe(week.reduce((n, s) => n + s.toolCalls, 0));
  expect(dashboard.week.series.toolCalls.reduce((n, p) => n + p.value, 0)).toBe(dashboard.week.totals.toolCalls.value);
});

// Session overview logic (W3) on the test/fixtures/dto responses: tiles, Token usage, agents, prompts, header.
import { describe, expect, test } from "bun:test";
import type { AgentSummary, SessionOverview } from "../../src/contracts/api.ts";
import {
  agentRows,
  enrichmentNote,
  exportFileName,
  formatWindow,
  promptsModel,
  statusTag,
  summaryTiles,
  timeRange,
  tokenCards,
} from "../../web/src/pages/session-overview/model.ts";
import running from "../fixtures/dto/sessionRunning.json";
import reference from "../fixtures/dto/session.json";

const done = reference as unknown as SessionOverview;
const live = running as unknown as SessionOverview;

describe("summaryTiles", () => {
  test("six tiles in artboard order", () => {
    expect(summaryTiles(done).map((t) => t.label)).toEqual([
      "Duration",
      "Total tokens",
      "Errors",
      "Agents",
      "Model calls",
      "Cost",
    ]);
  });

  test("baseline session values", () => {
    const t = Object.fromEntries(summaryTiles(done).map((x) => [x.label, x]));
    expect(t.Errors).toMatchObject({ value: "7", error: true, helper: "3.8% of 186 tool calls" });
    expect(t.Agents).toMatchObject({ value: "5", helper: "1 main, 4 subagents" });
    expect(t["Model calls"]).toMatchObject({ value: "142", helper: "186 tool calls" });
    expect(t["Total tokens"]?.value).toBe("9.54M");
    expect(t["Total tokens"]?.helper).toBe("94% served from cache");
    expect(t.Duration?.value).toBe("18m 36s");
    expect(t.Duration?.helper).toBe("~21m 32s of model time");
    expect(t.Cost?.helper).toBe("Estimated at list prices");
  });

  test("a running session without a cost: a dash with a note", () => {
    const cost = summaryTiles(live).find((x) => x.label === "Cost");
    expect(cost).toEqual({ label: "Cost", value: "—", helper: "Unknown model price" });
  });

  test("no errors: a tile without an icon", () => {
    const tiles = summaryTiles({ ...done, toolErrors: 0 });
    expect(tiles.find((x) => x.label === "Errors")?.error).toBe(false);
  });
});

describe("tokenCards", () => {
  test("four series in bar order, thinking in the Output explanation", () => {
    const cards = tokenCards(done.tokens);
    expect(cards.map((c) => c.label)).toEqual(["Input", "Output", "Cache read", "Cache write"]);
    expect(cards[1]?.note).toContain(`incl. 6.8K thinking`);
    expect(cards[2]?.note).toBe("94% · input served from cache");
  });

  test("shares are computed from the total; a zero total does not give NaN", () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, total: 0 };
    expect(tokenCards(zero).every((c) => c.note.startsWith("0%"))).toBe(true);
  });
});

describe("agents", () => {
  const agent = (agentId: string, parentAgentId: string | null, depth: number): AgentSummary => ({
    ...done.agents[1]!,
    agentId,
    parentAgentId,
    depth,
    type: parentAgentId ? "Explore" : null,
  });

  test("baseline session: the main one first, nested ones with indent 1", () => {
    const rows = agentRows(done.agents);
    expect(rows.map((r) => [r.agentId, r.depth])).toEqual([
      ["main", 0],
      ["explore-1", 1],
      ["plan-1", 1],
      ["gp-1", 1],
      ["gp-2", 1],
    ]);
    expect(rows[0]).toMatchObject({ name: "Main agent", caption: "main · orchestrator", peak: "148.2K · 74%" });
    expect(rows[1]).toMatchObject({ name: "Explore", caption: "explore-1 · Map existing API client usage" });
    expect(rows[0]?.usage).toBe("Read 18 · Edit 14 · Bash 11 · Grep 6");
  });

  test("order and indent come from the server: rows are not reordered", () => {
    const rows = agentRows([agent("a", null, 0), agent("b", "a", 1), agent("b1", "b", 2), agent("c", "a", 1)]);
    expect(rows.map((r) => [r.agentId, r.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["b1", 2],
      ["c", 1],
    ]);
  });

  test("an unknown context peak is a dash without a bar", () => {
    const row = agentRows([{ ...agent("a", null, 0), ctxPeak: null }])[0];
    expect(row).toMatchObject({ peak: "—", peakRatio: null });
  });

  test("context window: whole thousands and millions", () => {
    expect(formatWindow(200_000)).toBe("200K");
    expect(formatWindow(1_000_000)).toBe("1M");
    expect(formatWindow(null)).toBe("—");
  });
});

describe("prompts", () => {
  test("the initial prompt and follow-ups in time order", () => {
    const model = promptsModel(done.prompts)!;
    expect(model.original.kind).toBe("original");
    expect(model.followUps.length).toBe(done.prompts.length - 1);
    expect(model.followUpsLabel).toBe("2 follow-up prompts");
    expect(model.caption).toContain("1 attachment: Image #1");
    expect(model.caption).toContain("~86 tokens");
  });

  test("without prompts there is no block; a single follow-up is in the singular", () => {
    expect(promptsModel([])).toBeNull();
    const [first, second] = done.prompts;
    expect(promptsModel([first!, second!])?.followUpsLabel).toBe("1 follow-up prompt");
  });
});

describe("header and export", () => {
  test("Running and Completed status", () => {
    expect(statusTag(live)).toEqual({ label: "Running", tone: "blue" });
    expect(statusTag(done)).toEqual({ label: "Completed", tone: "green" });
  });

  test("enrichment mark: none, partial, full", () => {
    expect(enrichmentNote(done)).toBe("No enrichment");
    expect(enrichmentNote(live)).toBe("Partial enrichment");
    expect(enrichmentNote({ ...done, enrichment: "full" })).toBeNull();
  });

  test("interval: a running session has no end", () => {
    expect(timeRange(live).endsWith("– now")).toBe(true);
    expect(timeRange(done)).toMatch(/^[A-Z][a-z]{2} \d+, \d\d:\d\d – \d\d:\d\d:\d\d$/);
    expect(timeRange({ ...done, startedAt: null })).toBe("—");
  });

  test("name of the downloaded file", () => {
    expect(exportFileName(done.id)).toBe(`torch-session-${done.id}.json`);
  });
});

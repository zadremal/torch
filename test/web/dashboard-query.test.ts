// Dashboard page: translation between "address ↔ state ↔ API query parameters" (plan §8, §9.3).
import { describe, expect, test } from "bun:test";
import {
  CUSTOM_ISSUE_TEXT,
  DEFAULT_STATE,
  type DashboardState,
  customIssue,
  isDateString,
  parseState,
  stateToQuery,
  stateToSearch,
} from "../../web/src/pages/dashboard/query.ts";

const state = (change: Partial<DashboardState>): DashboardState => ({ ...DEFAULT_STATE, ...change });

describe("defaults", () => {
  test("an empty address is the week, the query and the address are empty", () => {
    expect(parseState("")).toEqual(DEFAULT_STATE);
    expect(stateToSearch(DEFAULT_STATE)).toBe("");
    expect(stateToQuery(DEFAULT_STATE)).toEqual({});
  });

  test("explicitly written defaults do not return to the address", () => {
    expect(stateToSearch(parseState("range=week&temp=false"))).toBe("");
  });

  test("an unrecognized range is replaced with the week", () => {
    expect(parseState("range=decade").range).toBe("week");
  });
});

describe("range and temp directories", () => {
  test.each(["day", "month", "year"] as const)("%s: in the address and in the query", (range) => {
    expect(stateToSearch(state({ range }))).toBe(`range=${range}`);
    expect(stateToQuery(state({ range }))).toEqual({ range });
    expect(parseState(`range=${range}`).range).toBe(range);
  });

  test("temp gets into the address and the query only when enabled", () => {
    expect(stateToSearch(state({ temp: true }))).toBe("temp=true");
    expect(stateToQuery(state({ temp: true }))).toEqual({ temp: true });
    expect(stateToQuery(state({ range: "day", temp: true }))).toEqual({ range: "day", temp: true });
    expect(parseState("temp=true").temp).toBe(true);
    expect(parseState("temp=1").temp).toBe(false);
  });

  test("dates outside Custom are dropped from the address", () => {
    const parsed = parseState("range=month&from=2026-10-01&to=2026-10-31");
    expect(parsed).toEqual(state({ range: "month" }));
    expect(stateToSearch(state({ range: "month", from: "2026-10-01", to: "2026-10-31" }))).toBe("range=month");
  });
});

describe("Custom", () => {
  const custom = state({ range: "custom", from: "2026-10-01", to: "2026-10-31" });

  test("consistent dates: the address and the query with both dates", () => {
    expect(stateToSearch(custom)).toBe("range=custom&from=2026-10-01&to=2026-10-31");
    expect(stateToQuery(custom)).toEqual({ range: "custom", from: "2026-10-01", to: "2026-10-31" });
    expect(parseState(stateToSearch(custom))).toEqual(custom);
  });

  test("one day: from equals to", () => {
    const day = state({ range: "custom", from: "2026-10-05", to: "2026-10-05" });
    expect(customIssue(day)).toBeNull();
    expect(stateToQuery(day)).toEqual({ range: "custom", from: "2026-10-05", to: "2026-10-05" });
  });

  test("dates not set: no query, the reason is missing", () => {
    for (const change of [{}, { from: "2026-10-01" }, { to: "2026-10-31" }]) {
      const s = state({ range: "custom", ...change });
      expect(customIssue(s)).toBe("missing");
      expect(stateToQuery(s)).toBeNull();
    }
  });

  test("end before start: no query, the reason is reversed", () => {
    const s = state({ range: "custom", from: "2026-10-31", to: "2026-10-01" });
    expect(customIssue(s)).toBe("reversed");
    expect(stateToQuery(s)).toBeNull();
    expect(CUSTOM_ISSUE_TEXT.reversed).toContain("earlier");
  });

  test("a nonexistent or misspelled date from the address is dropped", () => {
    expect(parseState("range=custom&from=2026-02-30&to=2026-10-31")).toEqual(
      state({ range: "custom", to: "2026-10-31" }),
    );
    expect(parseState("range=custom&from=10/01/2026&to=2026-10-31").from).toBe("");
    expect(isDateString("2026-02-28")).toBe(true);
    expect(isDateString("2026-2-8")).toBe(false);
  });

  test("empty fields get into the address one at a time so that input is not lost", () => {
    expect(stateToSearch(state({ range: "custom", from: "2026-10-01" }))).toBe("range=custom&from=2026-10-01");
    expect(stateToSearch(state({ range: "custom" }))).toBe("range=custom");
  });
});

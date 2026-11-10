// Sessions page: translation between "address ↔ state ↔ API query parameters" (plan §8, §9.3).
import { describe, expect, test } from "bun:test";
import type { SessionSortKey } from "@contracts/api.ts";
import {
  DEFAULT_STATE,
  SORT_KEYS,
  type SessionsState,
  firstDir,
  hasFilters,
  pageCount,
  parseState,
  resetFilters,
  stateToQuery,
  stateToSearch,
  withFilter,
  withSort,
} from "../../web/src/pages/sessions/query.ts";

const state = (change: Partial<SessionsState>): SessionsState => ({ ...DEFAULT_STATE, ...change });

describe("defaults", () => {
  test("an empty address is the default state, the query and the address are empty", () => {
    expect(parseState("")).toEqual(DEFAULT_STATE);
    expect(stateToSearch(DEFAULT_STATE)).toBe("");
    expect(stateToQuery(DEFAULT_STATE)).toEqual({});
  });

  test("explicitly written defaults do not return to the address", () => {
    const parsed = parseState("agents=any&sort=started&dir=desc&page=1&temp=false");
    expect(stateToSearch(parsed)).toBe("");
    expect(stateToQuery(parsed)).toEqual({});
  });
});

describe("each query parameter", () => {
  test("search", () => {
    const s = state({ q: "billing" });
    expect(stateToSearch(s)).toBe("q=billing");
    expect(stateToQuery(s)).toEqual({ q: "billing" });
    expect(parseState("q=billing")).toEqual(s);
  });

  test("spaces around the search do not go into the query, an empty search neither", () => {
    expect(stateToQuery(state({ q: "  fix  " }))).toEqual({ q: "fix" });
    expect(stateToQuery(state({ q: "   " }))).toEqual({});
  });

  test.each(["one", "few", "many"] as const)("agent bucket %s", (agents) => {
    const s = state({ agents });
    expect(stateToSearch(s)).toBe(`agents=${agents}`);
    expect(stateToQuery(s)).toEqual({ agents });
    expect(parseState(`agents=${agents}`)).toEqual(s);
  });

  test.each(["tcMin", "tcMax", "erMin", "erMax", "tkMin", "tkMax"] as const)("bound %s is a number", (key) => {
    const s = state({ [key]: "12" });
    expect(stateToSearch(s)).toBe(`${key}=12`);
    expect(stateToQuery(s)).toEqual({ [key]: 12 });
    expect(parseState(`${key}=12`)).toEqual(s);
  });

  test("zero is a set bound, an empty string is not", () => {
    expect(stateToQuery(state({ erMin: "0" }))).toEqual({ erMin: 0 });
    expect(stateToQuery(state({ erMin: "" }))).toEqual({});
  });

  test("both bounds of a range together", () => {
    const s = state({ tkMin: "100", tkMax: "5000" });
    expect(stateToQuery(s)).toEqual({ tkMin: 100, tkMax: 5000 });
    expect(stateToSearch(s)).toBe("tkMin=100&tkMax=5000");
  });

  test("project", () => {
    const s = state({ project: "billing-web" });
    expect(stateToSearch(s)).toBe("project=billing-web");
    expect(stateToQuery(s)).toEqual({ project: "billing-web" });
    expect(parseState("project=billing-web")).toEqual(s);
  });

  test("temp directories", () => {
    const s = state({ temp: true });
    expect(stateToSearch(s)).toBe("temp=true");
    expect(stateToQuery(s)).toEqual({ temp: true });
    expect(parseState("temp=true")).toEqual(s);
  });

  test("page", () => {
    const s = state({ page: 3 });
    expect(stateToSearch(s)).toBe("page=3");
    expect(stateToQuery(s)).toEqual({ page: 3 });
    expect(parseState("page=3")).toEqual(s);
  });

  test("everything together round-trips", () => {
    const s = state({
      q: "next js",
      agents: "many",
      tcMin: "10",
      erMax: "5",
      tkMin: "100",
      project: "store front",
      temp: true,
      sort: "cost",
      dir: "asc",
      page: 2,
    });
    expect(parseState(stateToSearch(s))).toEqual(s);
  });
});

describe("sorting by each column", () => {
  test.each(SORT_KEYS.filter((key) => key !== "started"))("%s: the key goes into the address and the query", (sort) => {
    const s = state({ sort });
    expect(stateToSearch(s)).toBe(`sort=${sort}`);
    expect(stateToQuery(s)).toEqual({ sort });
    expect(parseState(`sort=${sort}`)).toEqual(s);
  });

  test("started is the default, but with dir=asc the direction is written", () => {
    expect(stateToSearch(state({ dir: "asc" }))).toBe("dir=asc");
    expect(stateToQuery(state({ dir: "asc" }))).toEqual({ dir: "asc" });
  });

  test("first click: name ascending, the other columns descending", () => {
    for (const key of SORT_KEYS) {
      expect(firstDir(key)).toBe(key === "name" ? "asc" : "desc");
      if (key === "started") continue;
      const next = withSort(DEFAULT_STATE, key as SessionSortKey);
      expect(next.sort).toBe(key);
      expect(next.dir).toBe(firstDir(key));
    }
  });

  test("a repeated click on the same column changes the direction", () => {
    const once = withSort(DEFAULT_STATE, "tokens");
    expect(stateToSearch(once)).toBe("sort=tokens");
    const twice = withSort(once, "tokens");
    expect(twice).toMatchObject({ sort: "tokens", dir: "asc" });
    expect(stateToSearch(twice)).toBe("sort=tokens&dir=asc");
    expect(withSort(twice, "tokens").dir).toBe("desc");
  });

  test("a click on started in the default gives dir=asc, and on another column the direction is reset", () => {
    expect(withSort(DEFAULT_STATE, "started")).toMatchObject({ sort: "started", dir: "asc" });
    expect(withSort(state({ sort: "name", dir: "desc" }), "errors")).toMatchObject({ sort: "errors", dir: "desc" });
  });

  test("changing the sort returns to the first page", () => {
    expect(withSort(state({ page: 4 }), "agents").page).toBe(1);
  });
});

describe("pages and filters", () => {
  test("changing any filter returns to the first page", () => {
    const s = state({ page: 5 });
    expect(withFilter(s, { q: "x" }).page).toBe(1);
    expect(withFilter(s, { agents: "few" }).page).toBe(1);
    expect(withFilter(s, { tcMin: "3" }).page).toBe(1);
    expect(withFilter(s, { project: "a" }).page).toBe(1);
    expect(withFilter(s, { temp: true }).page).toBe(1);
  });

  test("pageCount: a whole number of pages, at least one", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(1001, 50)).toBe(21);
  });
});

describe("reset", () => {
  test("clears the search, agents, ranges, project and page", () => {
    const s = state({ q: "a", agents: "one", tcMin: "1", erMax: "2", tkMin: "3", project: "p", page: 3 });
    expect(resetFilters(s)).toEqual(DEFAULT_STATE);
  });

  test("sorting and temp directories stay", () => {
    const s = state({ q: "a", temp: true, sort: "cost", dir: "asc" });
    expect(resetFilters(s)).toEqual(state({ temp: true, sort: "cost", dir: "asc" }));
  });

  test("hasFilters: without filters there is nothing to reset, sorting and page do not count as filters", () => {
    expect(hasFilters(DEFAULT_STATE)).toBe(false);
    expect(hasFilters(state({ sort: "name", dir: "asc", temp: true, page: 2 }))).toBe(false);
    expect(hasFilters(state({ q: "a" }))).toBe(true);
    expect(hasFilters(state({ project: "p" }))).toBe(true);
    expect(hasFilters(state({ tkMax: "0" }))).toBe(true);
  });
});

describe("parsing a corrupted address", () => {
  test("unknown values are replaced with the default", () => {
    expect(parseState("agents=lots&sort=nope&dir=up&page=0&temp=1")).toEqual(DEFAULT_STATE);
    expect(parseState("page=-2").page).toBe(1);
    expect(parseState("page=1.5").page).toBe(1);
    expect(parseState("page=abc").page).toBe(1);
  });

  test("bounds: a non-number and negatives are dropped", () => {
    expect(parseState("tcMin=abc&erMax=-1&tkMin=Infinity")).toEqual(DEFAULT_STATE);
  });

  test("also accepts a ready URLSearchParams", () => {
    expect(parseState(new URLSearchParams({ q: "a", page: "2" }))).toEqual(state({ q: "a", page: 2 }));
  });
});

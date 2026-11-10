// GET /api/sessions: every plan §8 query parameter on a seed database.
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createApi } from "../../src/api/routes.ts";
import type { ApiError, SessionSortKey, SessionsResponse } from "../../src/contracts/api.ts";
import { SESSIONS_PAGE_SIZE } from "../../src/contracts/constants.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import sessionsFixture from "../fixtures/dto/sessions.json";
import { testConfig } from "../support/api.ts";
import { seedListSessions, seedReference } from "../support/reference-seed.ts";
import { seed } from "../support/seed.ts";

const DAY = 86_400_000;
const OCT_1 = Date.UTC(2026, 9, 1);

function api(db: Database) {
  const app = createApi({ db, config: testConfig(), now: () => 0 });
  return {
    async list(query = ""): Promise<SessionsResponse> {
      const response = await app.request(`/api/sessions${query}`);
      expect(response.status).toBe(200);
      return (await response.json()) as SessionsResponse;
    },
    async ids(query = ""): Promise<string[]> {
      return (await this.list(query)).items.map((item) => item.id);
    },
    request: (query: string) => app.request(`/api/sessions${query}`),
  };
}

/**
 * Four ordinary sessions and one from a temporary directory. Values are chosen so that the order by
 * each column is its own: a mixed-up sort column gives a different list.
 */
function seeded(): Database {
  const db = openMemoryDb();
  seed.session(db, { id: "a", name: "Fix login bug", project: "web", started_at: OCT_1, active_ms: 300_000, agents_count: 3, tok_total: 9_000_000, tool_calls: 10, tool_errors: 3, cost_usd: 4 });
  seed.session(db, { id: "b", name: "billing export", project: "billing", started_at: OCT_1 + DAY, active_ms: 900_000, agents_count: 5, tok_total: 1_500_000, tool_calls: 120, tool_errors: 0, cost_usd: 12 });
  seed.session(db, { id: "c", name: "Refactor Login form", project: "web", started_at: OCT_1 + 2 * DAY, active_ms: 100_000, agents_count: 1, tok_total: 400_000, tool_calls: 40, tool_errors: 20, cost_usd: null });
  seed.session(db, { id: "d", name: "Migrate database", project: "billing", started_at: OCT_1 + 3 * DAY, active_ms: 600_000, agents_count: 2, tok_total: 50_000, tool_calls: 300, tool_errors: 1, cost_usd: 0.5 });
  seed.session(db, { id: "t", name: "Scratch login", project: "T", cwd: "/private/var/folders/zz/T/scratch", is_temp_dir: 1, started_at: OCT_1 + 4 * DAY, tool_calls: 5 });
  return db;
}

describe("response shape and defaults", () => {
  test("without parameters: sort by start from newest to oldest, first page, temporary directories hidden", async () => {
    const body = await api(seeded()).list();
    expect(body.items.map((item) => item.id)).toEqual(["d", "c", "b", "a"]);
    expect(body).toMatchObject({ total: 4, totalAll: 4, page: 1, pageSize: SESSIONS_PAGE_SIZE });
  });

  test("a list row fills every SessionListItem field", async () => {
    const db = openMemoryDb();
    seed.session(db, { id: "s1", name: "Fix the bug", project: "web", is_temp_dir: 1, status: "running", started_at: OCT_1, active_ms: 123_000, agents_count: 4, tok_total: 987_654, tool_calls: 31, tool_errors: 2, cost_usd: 3.21 });
    expect((await api(db).list("?temp=true")).items).toEqual([
      { id: "s1", name: "Fix the bug", project: "web", isTempDir: true, status: "running", startedAt: OCT_1, activeMs: 123_000, agents: 4, tokens: 987_654, toolCalls: 31, errors: 2, costUsd: 3.21 },
    ]);
  });

  test("a session without a name, project, start time and cost: the name is the id, the rest null", async () => {
    const db = openMemoryDb();
    seed.session(db, { id: "bare", name: null, project: null, started_at: null, cost_usd: null });
    expect((await api(db).list()).items[0]).toMatchObject({ id: "bare", name: "bare", project: null, startedAt: null, costUsd: null });
  });

  test("empty parameter values equal their absence", async () => {
    const client = api(seeded());
    expect(await client.list("?q=&agents=&tcMin=&tcMax=&erMin=&erMax=&tkMin=&tkMax=&project=&temp=&sort=&dir=&page=")).toEqual(await client.list());
  });

  test("the response on the reference database matches the dto/sessions.json example", async () => {
    const db = openMemoryDb();
    seedReference(db);
    seedListSessions(db);
    expect(await api(db).list()).toEqual(sessionsFixture as SessionsResponse);
  });
});

describe("filters", () => {
  test("q — substring of the name, case-insensitive", async () => {
    const client = api(seeded());
    expect(await client.ids("?q=login")).toEqual(["c", "a"]);
    expect(await client.ids("?q=BILLING")).toEqual(["b"]);
    expect(await client.ids("?q=nothing-like-this")).toEqual([]);
    expect(await client.ids(`?q=${encodeURIComponent("' OR 1=1 --")}`)).toEqual([]);
  });

  test("agents — buckets any, one, few, many", async () => {
    const client = api(seeded());
    expect(await client.ids("?agents=any")).toEqual(["d", "c", "b", "a"]);
    expect(await client.ids("?agents=one")).toEqual(["c"]);
    expect(await client.ids("?agents=few")).toEqual(["d", "a"]);
    expect(await client.ids("?agents=many")).toEqual(["b"]);
  });

  test("tcMin and tcMax — tool call count, inclusive", async () => {
    const client = api(seeded());
    expect(await client.ids("?tcMin=120")).toEqual(["d", "b"]);
    expect(await client.ids("?tcMax=40")).toEqual(["c", "a"]);
    expect(await client.ids("?tcMin=40&tcMax=120")).toEqual(["c", "b"]);
  });

  test("erMin and erMax — tool error count, inclusive", async () => {
    const client = api(seeded());
    expect(await client.ids("?erMin=3")).toEqual(["c", "a"]);
    expect(await client.ids("?erMax=1")).toEqual(["d", "b"]);
    expect(await client.ids("?erMin=1&erMax=3")).toEqual(["d", "a"]);
  });

  test("tkMin and tkMax — total tokens in thousands, inclusive", async () => {
    const client = api(seeded());
    expect(await client.ids("?tkMin=1500")).toEqual(["b", "a"]);
    expect(await client.ids("?tkMax=400")).toEqual(["d", "c"]);
    expect(await client.ids("?tkMin=50.5&tkMax=1500")).toEqual(["c", "b"]);
  });

  test("project — exact project name", async () => {
    const client = api(seeded());
    expect(await client.ids("?project=web")).toEqual(["c", "a"]);
    expect(await client.ids("?project=billing")).toEqual(["d", "b"]);
    expect(await client.ids("?project=nope")).toEqual([]);
  });

  test("temp — temporary directories are hidden by default and shown with temp=true", async () => {
    const client = api(seeded());
    expect(await client.ids()).not.toContain("t");
    expect(await client.ids("?temp=false")).not.toContain("t");
    expect(await client.ids("?temp=true")).toEqual(["t", "d", "c", "b", "a"]);
    expect((await client.list("?temp=true")).items[0]).toMatchObject({ id: "t", isTempDir: true });
    // A project filter does not open temporary directories by itself.
    expect(await client.ids("?project=T")).toEqual([]);
    expect(await client.ids("?project=T&temp=true")).toEqual(["t"]);
  });

  test("total counts those matching the filters, totalAll — all with the same temp", async () => {
    const client = api(seeded());
    expect(await client.list("?q=login")).toMatchObject({ total: 2, totalAll: 4 });
    expect(await client.list("?q=login&temp=true")).toMatchObject({ total: 3, totalAll: 5 });
    expect(await client.list("?project=web&erMin=10&agents=one")).toMatchObject({ total: 1, totalAll: 4 });
    expect(await client.list("?tcMin=1000")).toMatchObject({ items: [], total: 0, totalAll: 4 });
  });
});

describe("sorting", () => {
  /** Ascending order for each column on the seeded() database. */
  const ASCENDING: Record<SessionSortKey, string[]> = {
    name: ["b", "a", "d", "c"],
    started: ["a", "b", "c", "d"],
    duration: ["c", "a", "d", "b"],
    agents: ["c", "d", "a", "b"],
    tokens: ["d", "c", "b", "a"],
    toolCalls: ["a", "c", "b", "d"],
    errors: ["b", "d", "a", "c"],
    // "c" has an unknown cost: such a row goes last in either direction.
    cost: ["d", "a", "b", "c"],
  };

  for (const [sort, ascending] of Object.entries(ASCENDING)) {
    test(`sort=${sort}: dir=asc, dir=desc and the default direction`, async () => {
      const client = api(seeded());
      const descending = sort === "cost" ? ["b", "a", "d", "c"] : [...ascending].reverse();
      expect(await client.ids(`?sort=${sort}&dir=asc`)).toEqual(ascending);
      expect(await client.ids(`?sort=${sort}&dir=desc`)).toEqual(descending);
      expect(await client.ids(`?sort=${sort}`)).toEqual(descending);
    });
  }

  test("dir without sort reverses the sort by start", async () => {
    expect(await api(seeded()).ids("?dir=asc")).toEqual(["a", "b", "c", "d"]);
  });

  test("a session without a start time goes last in either direction", async () => {
    const db = seeded();
    seed.session(db, { id: "n", started_at: null });
    const client = api(db);
    expect(await client.ids("?sort=started&dir=asc")).toEqual(["a", "b", "c", "d", "n"]);
    expect(await client.ids("?sort=started&dir=desc")).toEqual(["d", "c", "b", "a", "n"]);
  });

  test("sorting works together with a filter", async () => {
    expect(await api(seeded()).ids("?project=web&sort=tokens&dir=desc&temp=true")).toEqual(["a", "c"]);
  });
});

describe("pages", () => {
  function seededPages(): Database {
    const db = openMemoryDb();
    // 120 sessions with the same call count: the order among equals is set by start and id.
    for (let n = 0; n < 120; n++) seed.session(db, { id: `s${String(n).padStart(3, "0")}`, started_at: OCT_1 + n * 60_000, tool_calls: 7 });
    return db;
  }

  test("page cuts the list by SESSIONS_PAGE_SIZE, total does not depend on the page", async () => {
    const client = api(seededPages());
    const pages = await Promise.all([1, 2, 3, 4].map((page) => client.list(`?page=${page}`)));
    expect(pages.map((body) => body.items.length)).toEqual([SESSIONS_PAGE_SIZE, SESSIONS_PAGE_SIZE, 20, 0]);
    expect(pages.map((body) => body.page)).toEqual([1, 2, 3, 4]);
    for (const body of pages) expect(body).toMatchObject({ total: 120, totalAll: 120, pageSize: SESSIONS_PAGE_SIZE });
    expect(pages[0]!.items[0]!.id).toBe("s119");
    expect(pages[1]!.items[0]!.id).toBe("s069");
    expect(pages[2]!.items.at(-1)!.id).toBe("s000");
  });

  test("pages do not overlap and cover the whole list when sorting by a column with equal values", async () => {
    const client = api(seededPages());
    const seen = (await Promise.all([1, 2, 3].map((page) => client.ids(`?sort=toolCalls&dir=asc&page=${page}`)))).flat();
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });

  test("page works together with a filter", async () => {
    const db = seededPages();
    for (let n = 0; n < 60; n++) seed.session(db, { id: `w${String(n).padStart(2, "0")}`, project: "web", started_at: OCT_1 - n * 60_000 });
    const body = await api(db).list("?project=web&page=2");
    expect(body.items.map((item) => item.id)).toEqual(Array.from({ length: 10 }, (_, n) => `w${50 + n}`));
    expect(body).toMatchObject({ total: 60, totalAll: 180, page: 2 });
  });
});

describe("invalid parameters", () => {
  const BAD = [
    "?agents=lots",
    "?tcMin=-1",
    "?tcMax=abc",
    "?erMin=1e3",
    "?erMax=NaN",
    "?tkMin=ten",
    "?tkMax=-0.5",
    "?temp=maybe",
    "?sort=id",
    "?sort=started_at",
    "?dir=up",
    "?page=0",
    "?page=-2",
    "?page=1.5",
    "?page=abc",
  ];

  for (const query of BAD) {
    test(`${query} — 400 response with an ApiError naming the parameter`, async () => {
      const response = await api(seeded()).request(query);
      expect(response.status).toBe(400);
      const body = (await response.json()) as ApiError;
      expect(body.error).toContain(query.slice(1, query.indexOf("=")));
    });
  }

  test("one bad parameter among good ones — also 400", async () => {
    expect((await api(seeded()).request("?q=login&sort=name&page=x")).status).toBe(400);
  });
});

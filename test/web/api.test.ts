// API client: addresses by API_ROUTES and the fixture mode for every plan §8 route.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ApiRequestError, api, apiPath, isFixtureMode } from "../../web/src/lib/api.ts";
import { FIXTURE_RUNNING_SESSION_ID } from "../../web/src/lib/fixtures.ts";

const REFERENCE_ID = "8f3c1a2e-61b0-4c7e-9d2a-000000000142";

describe("apiPath", () => {
  test("route without parameters", () => {
    expect(apiPath("sessions")).toBe("/api/sessions");
    expect(apiPath("settings")).toBe("/api/settings");
    expect(apiPath("events")).toBe("/api/events");
  });

  test("path parameters are substituted and encoded", () => {
    expect(apiPath("session", { id: "abc" })).toBe("/api/sessions/abc");
    expect(apiPath("timeline", { id: "abc" })).toBe("/api/sessions/abc/timeline");
    expect(apiPath("agent", { id: "abc", agentId: "gp-1" })).toBe("/api/sessions/abc/agents/gp-1");
    expect(apiPath("network", { id: "abc", kind: "model", netId: "req 1/2" })).toBe(
      "/api/sessions/abc/network/model/req%201%2F2",
    );
    expect(apiPath("content", { id: 17 })).toBe("/api/contents/17");
  });

  test("query string: empty values and false are skipped", () => {
    expect(apiPath("sessions", {}, { q: "billing", agents: "few", tcMin: 10, tcMax: undefined, page: 2 })).toBe(
      "/api/sessions?q=billing&agents=few&tcMin=10&page=2",
    );
    expect(apiPath("sessions", {}, { q: "", temp: false })).toBe("/api/sessions");
    expect(apiPath("dashboard", {}, { range: "custom", from: "2026-10-01", to: "2026-10-31", temp: true })).toBe(
      "/api/dashboard?range=custom&from=2026-10-01&to=2026-10-31&temp=true",
    );
  });

  test("the file path goes into the query string", () => {
    expect(apiPath("file", { id: "abc" }, { path: "/Users/dev/a b.ts" })).toBe(
      "/api/sessions/abc/files?path=%2FUsers%2Fdev%2Fa+b.ts",
    );
  });

  test("an unset path parameter is an error", () => {
    expect(() => apiPath("session")).toThrow();
  });
});

describe("fixture mode", () => {
  const before = process.env.VITE_TORCH_FIXTURES;

  beforeAll(() => {
    process.env.VITE_TORCH_FIXTURES = "1";
  });

  afterAll(() => {
    if (before === undefined) delete process.env.VITE_TORCH_FIXTURES;
    else process.env.VITE_TORCH_FIXTURES = before;
  });

  test("is switched on by an environment variable", () => {
    expect(isFixtureMode()).toBe(true);
  });

  test("GET /api/dashboard: one file per range, week by default", async () => {
    for (const range of ["day", "week", "month", "year", "custom"] as const) {
      expect((await api.dashboard({ range })).range).toBe(range);
    }
    expect((await api.dashboard()).range).toBe("week");
  });

  test("GET /api/sessions and /api/projects", async () => {
    const sessions = await api.sessions({ q: "anything" });
    expect(sessions.items).toHaveLength(16);
    expect(sessions.items[0]?.id).toBe(REFERENCE_ID);
    expect((await api.projects()).projects.length).toBeGreaterThan(0);
  });

  test("GET /api/sessions/:id: any id returns the baseline session", async () => {
    const overview = await api.session("any-id");
    expect(overview.id).toBe(REFERENCE_ID);
    expect(overview.status).toBe("completed");
    expect(overview.agents).toHaveLength(5);
  });

  test("GET /api/sessions/:id: the running session by a special id", async () => {
    const running = await api.session(FIXTURE_RUNNING_SESSION_ID);
    expect(running.status).toBe("running");
    expect(running.enrichment).toBe("partial");
    expect(running.costUsd).toBeNull();
  });

  test("GET /api/sessions/:id/export and /timeline", async () => {
    const exported = await api.sessionExport(REFERENCE_ID);
    expect(exported.session.id).toBe(REFERENCE_ID);
    expect(exported.toolCalls).toHaveLength(186);
    const timeline = await api.timeline(REFERENCE_ID);
    expect(timeline.session.id).toBe(REFERENCE_ID);
    expect(timeline.agents).toHaveLength(5);
  });

  test("GET /api/sessions/:id/agents/:agentId: by agentId", async () => {
    expect((await api.agent(REFERENCE_ID, "gp-1")).agentId).toBe("gp-1");
    expect((await api.agent(REFERENCE_ID, "main")).agentId).toBe("main");
  });

  test("GET /api/sessions/:id/tool-calls/:callId and /prompts/:promptId: by id", async () => {
    expect((await api.toolCall(REFERENCE_ID, "toolu_main_001")).id).toBe("toolu_main_001");
    expect((await api.prompt(REFERENCE_ID, "ref-prompt-2")).id).toBe("ref-prompt-2");
  });

  test("GET /api/sessions/:id/files?path=: by file path", async () => {
    const path = "/Users/dev/code/billing-web/src/billing/checkout.ts";
    expect((await api.file(REFERENCE_ID, path)).path).toBe(path);
  });

  test("GET /api/sessions/:id/network/:kind/:netId: by the key <kind>:<netId>", async () => {
    const model = await api.network(REFERENCE_ID, "model", "req_main_001");
    expect(model.net).toBe("model");
    expect(model.id).toBe("req_main_001");
    const external = await api.network(REFERENCE_ID, "external", "toolu_plan-1_008");
    expect(external.net).toBe("external");
  });

  test("GET /api/contents/:id: by body id", async () => {
    const content = await api.content(1);
    expect(content.id).toBe(1);
    expect(typeof content.text).toBe("string");
  });

  test("GET and PUT /api/settings", async () => {
    const settings = await api.settings();
    expect(Object.keys(settings.prices.models).length).toBeGreaterThan(0);
    const prices = { ...settings.prices, updated: "2026-11-09" };
    const saved = await api.saveSettings({ prices });
    expect(saved.prices.updated).toBe("2026-11-09");
    expect(saved.paths).toEqual(settings.paths);
  });

  test("an unknown key is a 404 error, like the server", async () => {
    const error = await api.agent(REFERENCE_ID, "no-such-agent").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(404);
  });
});

describe("regular mode", () => {
  test("the request goes to the address from API_ROUTES, a server error becomes ApiRequestError", async () => {
    expect(isFixtureMode()).toBe(false);
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      return url.includes("missing")
        ? Response.json({ error: "Not found: session" }, { status: 404 })
        : Response.json({ projects: [] });
    }) as typeof fetch;
    try {
      expect(await api.projects({ temp: true })).toEqual({ projects: [] });
      const error = await api.session("missing").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiRequestError);
      expect((error as ApiRequestError).status).toBe(404);
      expect((error as ApiRequestError).message).toBe("Not found: session");
      expect(seen).toEqual(["/api/projects?temp=true", "/api/sessions/missing"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// GET and PUT /api/settings on a seed database. Prices, the database and settings.json live in a temporary directory.
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../../src/api/routes.ts";
import { loadConfig } from "../../src/config.ts";
import type { ApiError, PriceTable, SessionsResponse, SettingsResponse } from "../../src/contracts/api.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { loadPrices } from "../../src/ingest/reduce/cost.ts";
import { seed } from "../support/seed.ts";

let dir: string;
let db: Database;
let app: ReturnType<typeof createApi>;
const config = () => loadConfig({ dataDir: dir, claudeSettingsPath: join(dir, "claude-settings.json") });

const get = async () => (await app.request("/api/settings")).json() as Promise<SettingsResponse>;
const put = (body: unknown) =>
  app.request("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "torch-settings-"));
  db = openMemoryDb();
  app = createApi({ db, config: config(), now: () => 0 });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("GET /api/settings", () => {
  test("without prices.json takes the table from the repository, paths from the configuration", async () => {
    const settings = await get();
    expect(Object.keys(settings.prices.models).length).toBeGreaterThan(0);
    expect(settings.paths.dataDir).toBe(dir);
    expect(settings.paths.db).toBe(join(dir, "torch.db"));
    expect(settings.paths.spool).toBe(join(dir, "spool"));
    expect(settings.paths.claudeSettings).toBe(join(dir, "claude-settings.json"));
  });

  test("without settings.json channels are not configured, retention is not set", async () => {
    const { channels, cleanupPeriodDays } = await get();
    expect(channels.otel).toEqual({ configured: false, lastEventAt: null });
    expect(channels.hooks).toEqual({ configured: false, lastEventAt: null });
    expect(cleanupPeriodDays).toBeNull();
  });

  test("settings.json with torch channels: configured, retention read, event time by tables", async () => {
    writeFileSync(
      join(dir, "claude-settings.json"),
      JSON.stringify({
        cleanupPeriodDays: 365,
        env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4820/otlp/v1/logs" },
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "/home/u/.torch/hooks/record.sh" }] }] },
      }),
    );
    seed.otelEvent(db, { session_id: "s", ts: 100, name: "a" });
    seed.otelEvent(db, { session_id: "s", ts: 300, name: "b" });
    seed.hookEvent(db, { session_id: "s", ts: 200, name: "c" });
    const { channels, cleanupPeriodDays } = await get();
    expect(channels.otel).toEqual({ configured: true, lastEventAt: 300 });
    expect(channels.hooks).toEqual({ configured: true, lastEventAt: 200 });
    expect(cleanupPeriodDays).toBe(365);
  });

  test("foreign hooks and a foreign logs address are not counted as a torch channel; a broken file does not break the response", async () => {
    writeFileSync(
      join(dir, "claude-settings.json"),
      JSON.stringify({ env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://collector:4318/v1/logs" }, hooks: { Stop: [{ command: "other.sh" }] } }),
    );
    const { channels } = await get();
    expect(channels.otel.configured).toBe(false);
    expect(channels.hooks.configured).toBe(false);
    writeFileSync(join(dir, "claude-settings.json"), "{not json");
    expect((await get()).cleanupPeriodDays).toBeNull();
  });
});

describe("PUT /api/settings", () => {
  const edited = (settings: SettingsResponse, input: number): PriceTable => {
    const prices = structuredClone(settings.prices);
    prices.models["claude-opus-5-5"] = { ...prices.models["claude-opus-5-5"]!, input };
    return prices;
  };

  test("saves the table to prices.json and returns the updated settings", async () => {
    const prices = edited(await get(), 7);
    const response = await put({ prices });
    expect(response.status).toBe(200);
    expect(((await response.json()) as SettingsResponse).prices.models["claude-opus-5-5"]!.input).toBe(7);
    expect(loadPrices(join(dir, "prices.json"))).toEqual(prices);
    expect((await get()).prices).toEqual(prices);
  });

  test("a price edit changes the cost of the call, agent, session and session list", async () => {
    seed.session(db, { id: "s1" });
    seed.agent(db, { session_id: "s1" });
    seed.modelCall(db, { session_id: "s1", id: "c1", model: "claude-opus-5-5", tok_input: 1_000_000, cost_usd: 5 });
    seed.modelCall(db, { session_id: "s1", id: "c2", model: "claude-opus-5-5", tok_output: 1_000_000, turn_index: 2, cost_usd: 0 });
    const settings = await get();
    await put({ prices: edited(settings, 10) });
    const total = 10 + settings.prices.models["claude-opus-5-5"]!.output;

    const cost = (sql: string) => db.query<{ cost_usd: number | null }, []>(sql).get()!.cost_usd;
    expect(cost("SELECT cost_usd FROM model_calls WHERE id = 'c1'")).toBe(10);
    expect(cost("SELECT cost_usd FROM agents WHERE session_id = 's1'")).toBe(total);
    expect(cost("SELECT cost_usd FROM sessions WHERE id = 's1'")).toBe(total);
    const list = (await (await app.request("/api/sessions")).json()) as SessionsResponse;
    expect(list.items[0]!.costUsd).toBe(total);
  });

  test("a model not in the table gives an unknown cost; one added to the table gives a known one", async () => {
    seed.session(db, { id: "s1" });
    seed.agent(db, { session_id: "s1", model: "new-model" });
    seed.modelCall(db, { session_id: "s1", id: "c1", model: "new-model", tok_input: 1_000_000, cost_usd: null });
    const settings = await get();
    const prices = structuredClone(settings.prices);
    prices.models["new-model"] = { input: 2, output: 4, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, contextWindow: 200_000 };
    await put({ prices });
    expect(db.query<{ cost_usd: number | null }, []>("SELECT cost_usd FROM sessions WHERE id = 's1'").get()!.cost_usd).toBe(2);

    delete prices.models["new-model"];
    await put({ prices });
    expect(db.query<{ cost_usd: number | null }, []>("SELECT cost_usd FROM sessions WHERE id = 's1'").get()!.cost_usd).toBeNull();
  });

  test("an invalid table — 400, prices.json and cost do not change", async () => {
    const settings = await get();
    await put({ prices: settings.prices });
    const before = readFileSync(join(dir, "prices.json"), "utf8");
    const bad = structuredClone(settings.prices);
    bad.models["claude-opus-5-5"]!.input = -1;
    const response = await put({ prices: bad });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error).toContain("claude-opus-5-5");
    expect(readFileSync(join(dir, "prices.json"), "utf8")).toBe(before);
  });

  test("a body without prices — 400", async () => {
    expect((await put({})).status).toBe(400);
    expect((await put("text")).status).toBe(400);
  });
});

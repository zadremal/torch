// Prices, paths, channel state. Package W7.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TorchConfig } from "../config.ts";
import { API_ROUTES, type ApiError, type ChannelState, type PriceTable, type SettingsResponse } from "../contracts/api.ts";
import type { Provider } from "../contracts/provider.ts";
import { deriveContext } from "../ingest/reduce/context.ts";
import { DEFAULT_PRICES_PATH, callCost, loadPrices } from "../ingest/reduce/cost.ts";
import { deriveTotals } from "../ingest/reduce/totals.ts";
import { providerFor } from "../providers/index.ts";
import type { Handler } from "./context.ts";

/** Marker of torch hooks in settings.json: the handler installed by `torch setup` (plan §7.2). */
const HOOK_MARKER = "record.sh";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Claude Code settings.json; a missing or unparseable file gives an empty object: the screen still opens. */
function readClaudeSettings(path: string): Json {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function lastEventAt(db: Database, table: "otel_events" | "hook_events"): number | null {
  return db.query<{ ts: number | null }, []>(`SELECT MAX(ts) AS ts FROM ${table}`).get()?.ts ?? null;
}

/** Price table of the data directory; before the first run it is not there — the repository table is used. */
function currentPrices(config: TorchConfig): PriceTable {
  return loadPrices(existsSync(config.pricesPath) ? config.pricesPath : DEFAULT_PRICES_PATH);
}

function buildSettings(db: Database, config: TorchConfig): SettingsResponse {
  const claude = readClaudeSettings(config.claudeSettingsPath);
  const env = isObject(claude.env) ? claude.env : {};
  const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  const otel: ChannelState = {
    configured: typeof logsEndpoint === "string" && logsEndpoint.includes(API_ROUTES.otlpLogs),
    lastEventAt: lastEventAt(db, "otel_events"),
  };
  const hooks: ChannelState = {
    configured: claude.hooks !== undefined && JSON.stringify(claude.hooks).includes(HOOK_MARKER),
    lastEventAt: lastEventAt(db, "hook_events"),
  };
  const days = claude.cleanupPeriodDays;
  return {
    prices: currentPrices(config),
    paths: {
      dataDir: config.dataDir,
      db: config.dbPath,
      transcripts: config.transcriptsDir,
      desktopSessions: config.desktopSessionsDir,
      spool: config.spoolDir,
      claudeSettings: config.claudeSettingsPath,
    },
    channels: { otel, hooks },
    cleanupPeriodDays: typeof days === "number" ? days : null,
  };
}

interface CallRow {
  session_id: string;
  id: string;
  model: string;
  tok_input: number;
  tok_output: number;
  tok_cache_read: number;
  tok_cache_write_5m: number;
  tok_cache_write_1h: number;
}

/**
 * Recalculates model call costs by the new table and the totals of all sessions. The context window also
 * depends on the table, so the context is recalculated too.
 */
function reprice(db: Database, prices: PriceTable, provider: Provider, now: number): void {
  const calls = db
    .query<CallRow, []>("SELECT session_id, id, model, tok_input, tok_output, tok_cache_read, tok_cache_write_5m, tok_cache_write_1h FROM model_calls")
    .all();
  const update = db.query("UPDATE model_calls SET cost_usd = ?3 WHERE session_id = ?1 AND id = ?2");
  const sessions = db.query<{ id: string }, []>("SELECT id FROM sessions").all();
  db.transaction(() => {
    for (const c of calls) {
      // The stored model is the reported name (a gateway's own); the table knows the canonical one.
      const cost = callCost(prices, provider.canonicalModel(c.model), {
        input: c.tok_input,
        output: c.tok_output,
        cacheRead: c.tok_cache_read,
        cacheWrite5m: c.tok_cache_write_5m,
        cacheWrite1h: c.tok_cache_write_1h,
      });
      update.run(c.session_id, c.id, cost);
    }
    for (const { id } of sessions) {
      deriveContext({ db, sessionId: id, prices, provider, now });
      deriveTotals({ db, sessionId: id, prices, provider, now });
    }
  })();
}

export const getSettings: Handler = (c) => {
  const { db, config } = c.var;
  try {
    return c.json<SettingsResponse>(buildSettings(db, config));
  } catch (e) {
    return c.json<ApiError>({ error: (e as Error).message }, 500);
  }
};

export const putSettings: Handler = async (c) => {
  const { db, config, now } = c.var;
  const body: unknown = await c.req.json().catch(() => null);
  if (!isObject(body) || !isObject(body.prices)) return c.json<ApiError>({ error: "A { prices } body is expected" }, 400);

  // Validation uses the same parser torch reads the table with: write to a temporary file next to it, then rename.
  const temp = `${config.pricesPath}.tmp`;
  mkdirSync(dirname(config.pricesPath), { recursive: true });
  writeFileSync(temp, `${JSON.stringify(body.prices, null, 2)}\n`);
  let prices: PriceTable;
  try {
    prices = loadPrices(temp);
  } catch (e) {
    rmSync(temp, { force: true });
    return c.json<ApiError>({ error: (e as Error).message }, 400);
  }
  renameSync(temp, config.pricesPath);

  reprice(db, prices, providerFor(config.provider), now());
  return c.json<SettingsResponse>(buildSettings(db, config));
};

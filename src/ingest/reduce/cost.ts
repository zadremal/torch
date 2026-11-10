// Cost and context window calculation from the price table. Package P2.
import { readFileSync } from "node:fs";
import type { ModelPrice, PriceTable } from "../../contracts/api.ts";
import type { CallCost, ContextWindow } from "../../contracts/pipeline.ts";

/** Price table from the repository: `prices.json` of the data directory is created from it on first run. */
export const DEFAULT_PRICES_PATH = new URL("../../../prices.default.json", import.meta.url).pathname;
const PER_MILLION = 1_000_000;

/** Model entry: the exact key, otherwise the identifier without the date suffix (`-YYYYMMDD`). */
function findModel(prices: PriceTable, model: string): ModelPrice | null {
  const { models } = prices;
  if (Object.hasOwn(models, model)) return models[model]!;
  const base = model.replace(/-\d{8}$/, "");
  return Object.hasOwn(models, base) ? models[base]! : null;
}

/** Thinking tokens are already included in output and are not billed separately. */
export const callCost: CallCost = (prices, model, tokens) => {
  const price = findModel(prices, model);
  if (!price) return null;
  const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
  const long = price.longContext;
  const p = long && promptTokens > long.overTokens ? long : price;
  return (
    (tokens.input * p.input +
      tokens.output * p.output +
      tokens.cacheRead * p.cacheRead +
      tokens.cacheWrite5m * p.cacheWrite5m +
      tokens.cacheWrite1h * p.cacheWrite1h) /
    PER_MILLION
  );
};

export const contextWindow: ContextWindow = (prices, model, observedCtxTokens) => {
  const p = findModel(prices, model);
  if (!p) return null;
  if (observedCtxTokens === undefined || observedCtxTokens <= p.contextWindow) return p.contextWindow;
  // The next known size that fits the observed one; if there is none, the observed one itself.
  return prices.contextWindows.find((w) => w >= observedCtxTokens) ?? observedCtxTokens;
};

const TOKEN_PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;

function fail(path: string, why: string): never {
  throw new Error(`Invalid price table format ${path}: ${why}`);
}

/** Reads the price table from a file; without a path, prices.default.json from the repository root. */
export function loadPrices(path: string = DEFAULT_PRICES_PATH): PriceTable {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`Could not read the price table ${path}: ${(e as Error).message}`);
  }
  if (typeof data !== "object" || data === null) return fail(path, "an object is expected");
  const t = data as Record<string, unknown>;
  if (typeof t.source !== "string") fail(path, "source must be a string");
  if (typeof t.updated !== "string") fail(path, "updated must be a string");
  if (!Array.isArray(t.contextWindows) || t.contextWindows.some((w) => typeof w !== "number"))
    fail(path, "contextWindows must be an array of numbers");
  if (typeof t.models !== "object" || t.models === null || Array.isArray(t.models)) fail(path, "models must be an object");
  for (const [id, m] of Object.entries(t.models)) {
    const model = (m ?? {}) as Record<string, unknown>;
    const check = (fields: readonly string[], record: Record<string, unknown>, where: string) => {
      for (const f of fields) {
        const v = record[f];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(path, `${where}.${f} must be a non-negative number`);
      }
    };
    check([...TOKEN_PRICE_FIELDS, "contextWindow"], model, `models.${id}`);
    if (model.longContext !== undefined) {
      if (typeof model.longContext !== "object" || model.longContext === null) fail(path, `models.${id}.longContext must be an object`);
      check([...TOKEN_PRICE_FIELDS, "overTokens"], model.longContext as Record<string, unknown>, `models.${id}.longContext`);
    }
  }
  return data as PriceTable;
}

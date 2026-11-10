// Prices table editing: a draft with string cells (while a person types, the number is incomplete),
// parsing the draft back into PriceTable, and channel state captions.
import type { ChannelState, ModelPrice, PriceTable } from "@contracts/api.ts";
import { DASH, formatDateTime } from "../../lib/format.ts";

/** Prices table columns in artboard order; `contextWindow` is the window size, the rest are dollars per million tokens. */
export const PRICE_COLUMNS = [
  { field: "input", label: "Input" },
  { field: "output", label: "Output" },
  { field: "cacheRead", label: "Cache read" },
  { field: "cacheWrite5m", label: "Cache write 5m" },
  { field: "cacheWrite1h", label: "Cache write 1h" },
  { field: "contextWindow", label: "Context window" },
] as const;

export type PriceField = (typeof PRICE_COLUMNS)[number]["field"];

export interface DraftRow {
  /** Stable row key: the model name is editable, the key is not. */
  key: number;
  model: string;
  cells: Record<PriceField, string>;
  /** The model's previous entry: `longContext`, which is not in the table, is preserved from it. */
  base: ModelPrice | null;
}

export interface Draft {
  rows: DraftRow[];
  nextKey: number;
}

export function toDraft(prices: PriceTable): Draft {
  const rows = Object.entries(prices.models).map(([model, price], key): DraftRow => {
    const cells = Object.fromEntries(PRICE_COLUMNS.map(({ field }) => [field, String(price[field])])) as Record<PriceField, string>;
    return { key, model, cells, base: price };
  });
  return { rows, nextKey: rows.length };
}

export function addRow(draft: Draft): Draft {
  const cells = Object.fromEntries(PRICE_COLUMNS.map(({ field }) => [field, ""])) as Record<PriceField, string>;
  return { rows: [...draft.rows, { key: draft.nextKey, model: "", cells, base: null }], nextKey: draft.nextKey + 1 };
}

export function removeRow(draft: Draft, key: number): Draft {
  return { ...draft, rows: draft.rows.filter((row) => row.key !== key) };
}

export function editRow(draft: Draft, key: number, change: (row: DraftRow) => DraftRow): Draft {
  return { ...draft, rows: draft.rows.map((row) => (row.key === key ? change(row) : row)) };
}

/** A number from a cell; null — empty or not a number. Input like `1e3` and `0x10` is not accepted: decimal notation only. */
function parseCell(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  return Number(trimmed);
}

export type ParsedDraft = { ok: true; prices: PriceTable } | { ok: false; errors: Map<number, string> };

/** Draft → table for PUT; the other fields (`source`, `updated`, `contextWindows`) are taken from `base`. */
export function parseDraft(draft: Draft, base: PriceTable): ParsedDraft {
  const errors = new Map<number, string>();
  const models: Record<string, ModelPrice> = {};
  const seen = new Set<string>();
  for (const row of draft.rows) {
    const id = row.model.trim();
    if (id === "") {
      errors.set(row.key, "Model name is empty");
      continue;
    }
    if (seen.has(id)) {
      errors.set(row.key, `Model ${id} is listed twice`);
      continue;
    }
    seen.add(id);
    const values = {} as Record<PriceField, number>;
    const bad = PRICE_COLUMNS.find(({ field, label }) => {
      const value = parseCell(row.cells[field]);
      if (value === null || (field === "contextWindow" && (value === 0 || !Number.isInteger(value)))) {
        errors.set(row.key, `${label} must be ${field === "contextWindow" ? "a positive whole number" : "a number, 0 or more"}`);
        return true;
      }
      values[field] = value;
      return false;
    });
    if (bad) continue;
    models[id] = { ...(row.base?.longContext ? { longContext: row.base.longContext } : {}), ...values };
  }
  return errors.size > 0 ? { ok: false, errors } : { ok: true, prices: { ...base, models } };
}

/** Whether there are edits relative to the saved table. */
export function isChanged(draft: Draft, saved: PriceTable): boolean {
  const parsed = parseDraft(draft, saved);
  return !parsed.ok || JSON.stringify(parsed.prices.models) !== JSON.stringify(withNumericOrder(saved.models));
}

/** Models in key order with fields in parse order: the comparison does not depend on the field order in the file. */
function withNumericOrder(models: PriceTable["models"]): PriceTable["models"] {
  return Object.fromEntries(
    Object.entries(models).map(([id, price]) => {
      const values = Object.fromEntries(PRICE_COLUMNS.map(({ field }) => [field, price[field]])) as Record<PriceField, number>;
      return [id, { ...(price.longContext ? { longContext: price.longContext } : {}), ...values }];
    }),
  );
}

/** Channel state in one line: "Not configured" or "Configured · last event …". */
export function channelStatus(channel: ChannelState): { label: string; detail: string } {
  if (!channel.configured) return { label: "Not configured", detail: channel.lastEventAt === null ? "No events received" : `Last event ${formatDateTime(channel.lastEventAt)}` };
  return { label: "Configured", detail: channel.lastEventAt === null ? "No events received yet" : `Last event ${formatDateTime(channel.lastEventAt)}` };
}

/** Retention of Claude Code transcripts. */
export function retentionLabel(days: number | null): string {
  return days === null ? `${DASH} (Claude Code default: 30 days)` : `${days} days`;
}

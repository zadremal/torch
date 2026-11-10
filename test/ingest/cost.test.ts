import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callCost, contextWindow, loadPrices } from "../../src/ingest/reduce/cost.ts";

const prices = loadPrices();
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

test("default table: source, date, windows ascending, all models from the history", () => {
  expect(prices.source).toStartWith("https://");
  expect(prices.updated).toBe("2026-11-09");
  expect([...prices.contextWindows].sort((a, b) => a - b)).toEqual(prices.contextWindows);
  for (const id of ["claude-opus-5", "claude-fable-5", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-4-8", "claude-fable-5-2", "claude-haiku-5-5", "claude-haiku-4-5"]) {
    expect(prices.models[id]).toBeDefined();
    expect(prices.contextWindows).toContain(prices.models[id]!.contextWindow);
  }
});

test("the cost of a call with a 5-minute and a 1-hour cache matches the manual calculation", () => {
  // claude-opus-5-5: input 4, output 20, cacheRead 0.2, write5m 5, write1h 8 ($/MTok)
  const cost = callCost(prices, "claude-opus-5-5", { input: 1000, output: 2000, cacheRead: 100_000, cacheWrite5m: 10_000, cacheWrite1h: 20_000 });
  // 0.004 + 0.04 + 0.02 + 0.05 + 0.16
  expect(cost).toBeCloseTo(0.274, 10);
});

test("a 5-minute and a 1-hour cache write are billed at their own prices", () => {
  expect(callCost(prices, "claude-sonnet-5-5", { ...zero, cacheWrite5m: 1_000_000 })).toBeCloseTo(2.5, 10);
  expect(callCost(prices, "claude-sonnet-5-5", { ...zero, cacheWrite1h: 1_000_000 })).toBeCloseTo(4, 10);
});

test("an unknown model and <synthetic> yield null", () => {
  expect(callCost(prices, "claude-unknown-9", { ...zero, input: 1 })).toBeNull();
  expect(callCost(prices, "<synthetic>", { ...zero, input: 1 })).toBeNull();
  expect(contextWindow(prices, "claude-unknown-9")).toBeNull();
});

test("a date suffix finds the entry without the suffix", () => {
  const t = { ...zero, input: 1_000_000, output: 1_000_000 };
  expect(callCost(prices, "claude-haiku-4-5-20251001", t)).toBe(callCost(prices, "claude-haiku-4-5", t)!);
  expect(callCost(prices, "claude-haiku-4-5-20251001", t)).toBeCloseTo(6, 10);
  expect(contextWindow(prices, "claude-haiku-4-5-20251001")).toBe(200_000);
});

test("the context window is raised to the next known size", () => {
  expect(contextWindow(prices, "claude-haiku-4-5")).toBe(200_000);
  expect(contextWindow(prices, "claude-haiku-4-5", 150_000)).toBe(200_000);
  expect(contextWindow(prices, "claude-haiku-4-5", 200_001)).toBe(1_000_000);
  expect(contextWindow(prices, "claude-opus-5-5", 500_000)).toBe(1_000_000);
});

test("loadPrices: a format error contains the file path", () => {
  const dir = mkdtempSync(join(tmpdir(), "torch-prices-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ source: "x", updated: "2026-11-09", contextWindows: [1], models: { m: { input: "1" } } }));
  expect(() => loadPrices(bad)).toThrow(bad);
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{");
  expect(() => loadPrices(broken)).toThrow(broken);
  expect(() => loadPrices(join(dir, "missing.json"))).toThrow("missing.json");
});

test("loadPrices reads the table by path", () => {
  const dir = mkdtempSync(join(tmpdir(), "torch-prices-"));
  const p = join(dir, "prices.json");
  writeFileSync(p, JSON.stringify(prices));
  expect(loadPrices(p)).toEqual(prices);
});

test("a prompt longer than the longContext threshold is billed at long-context prices", () => {
  const prices = loadPrices();
  const haiku = prices.models["claude-haiku-5-5"]!;
  expect(haiku.longContext?.overTokens).toBe(100_000);
  // The prompt is input + cache read and write: exactly 100,000 is still at the regular price.
  const atLimit = { input: 1_000, output: 1_000_000, cacheRead: 99_000, cacheWrite5m: 0, cacheWrite1h: 0 };
  expect(callCost(prices, "claude-haiku-5-5", atLimit)).toBeCloseTo((1_000 * 0.1 + 1_000_000 * 0.5 + 99_000 * 0.01) / 1e6, 10);
  const over = { ...atLimit, cacheRead: 99_001 };
  expect(callCost(prices, "claude-haiku-5-5", over)).toBeCloseTo((1_000 * 0.5 + 1_000_000 * 2.5 + 99_001 * 0.05) / 1e6, 10);
});

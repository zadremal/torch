// Settings screen: editing the price table (model.ts) and rendering the blocks on a response from test/fixtures/dto.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SettingsResponse } from "../../../src/contracts/api.ts";
import fixture from "../../fixtures/dto/settings.json";
import { addRow, channelStatus, editRow, isChanged, parseDraft, removeRow, retentionLabel, toDraft } from "../../../web/src/pages/settings/model.ts";

const settings = fixture as SettingsResponse;
const WEB_DIR = join(import.meta.dir, "../../../web");

describe("price draft", () => {
  test("a round trip without edits gives the same table and does not count as a change", () => {
    const draft = toDraft(settings.prices);
    const parsed = parseDraft(draft, settings.prices);
    expect(parsed.ok && parsed.prices).toEqual(settings.prices);
    expect(isChanged(draft, settings.prices)).toBe(false);
  });

  test("a cell edit gets into the table, the other fields and longContext are kept", () => {
    const withLong = structuredClone(settings.prices);
    withLong.models["claude-opus-5-5"]!.longContext = { input: 10, output: 40, cacheRead: 1, cacheWrite5m: 12, cacheWrite1h: 20, overTokens: 200_000 };
    const draft = editRow(toDraft(withLong), 0, (row) => ({ ...row, cells: { ...row.cells, input: "5.5" } }));
    expect(isChanged(draft, withLong)).toBe(true);
    const parsed = parseDraft(draft, withLong);
    if (!parsed.ok) throw new Error("success was expected");
    expect(parsed.prices.models["claude-opus-5-5"]!.input).toBe(5.5);
    expect(parsed.prices.models["claude-opus-5-5"]!.longContext?.overTokens).toBe(200_000);
    expect(parsed.prices.source).toBe(withLong.source);
  });

  test("adding and removing a model", () => {
    let draft = addRow(toDraft(settings.prices));
    const key = draft.rows.at(-1)!.key;
    expect(parseDraft(draft, settings.prices).ok).toBe(false);
    draft = editRow(draft, key, (row) => ({
      ...row,
      model: "new-model",
      cells: { input: "1", output: "2", cacheRead: "0", cacheWrite5m: "0", cacheWrite1h: "0", contextWindow: "200000" },
    }));
    const added = parseDraft(draft, settings.prices);
    expect(added.ok && Object.keys(added.prices.models)).toContain("new-model");
    draft = removeRow(draft, key);
    expect(isChanged(draft, settings.prices)).toBe(false);
  });

  test("per-row errors: an empty number, a negative, a fractional window, an empty and a repeated name", () => {
    const base = toDraft(settings.prices);
    const bad = (cell: string, value: string) => {
      const parsed = parseDraft(editRow(base, 0, (row) => ({ ...row, cells: { ...row.cells, [cell]: value } })), settings.prices);
      return parsed.ok ? null : parsed.errors.get(0);
    };
    expect(bad("input", "")).toBe("Input must be a number, 0 or more");
    expect(bad("output", "-1")).toContain("Output must be");
    expect(bad("cacheRead", "1e3")).toContain("Cache read must be");
    expect(bad("contextWindow", "1000.5")).toContain("Context window must be a positive whole number");
    expect(bad("contextWindow", "0")).toContain("Context window must be");
    const unnamed = parseDraft(editRow(base, 1, (row) => ({ ...row, model: " " })), settings.prices);
    expect(!unnamed.ok && unnamed.errors.get(1)).toBe("Model name is empty");
    const twice = parseDraft(editRow(base, 1, (row) => ({ ...row, model: base.rows[0]!.model })), settings.prices);
    expect(!twice.ok && twice.errors.get(1)).toContain("listed twice");
  });
});

describe("labels", () => {
  test("channel state and retention period", () => {
    expect(channelStatus({ configured: false, lastEventAt: null })).toEqual({ label: "Not configured", detail: "No events received" });
    expect(channelStatus({ configured: true, lastEventAt: null }).detail).toBe("No events received yet");
    expect(channelStatus({ configured: true, lastEventAt: 1793456453000 })).toMatchObject({ label: "Configured" });
    expect(channelStatus({ configured: true, lastEventAt: 1793456453000 }).detail).toMatch(/^Last event \w{3} \d+, \d\d:\d\d$/);
    expect(retentionLabel(365)).toBe("365 days");
    expect(retentionLabel(null)).toContain("30 days");
  });
});

describe("rendering", () => {
  interface ViteServer {
    ssrLoadModule(id: string): Promise<Record<string, any>>;
    close(): Promise<void>;
  }
  let server: ViteServer;
  let h: (type: unknown, props?: object | null) => unknown;
  let renderToString: (element: unknown) => string;
  const consoleInfo = console.info;

  beforeAll(async () => {
    console.info = () => {};
    const vitePath = createRequire(join(WEB_DIR, "package.json")).resolve("vite");
    const vite = await import(pathToFileURL(vitePath).href);
    server = await vite.createServer({
      root: WEB_DIR,
      configFile: join(WEB_DIR, "vite.config.ts"),
      server: { middlewareMode: true, ws: false, hmr: false },
      appType: "custom",
      logLevel: "silent",
      plugins: [
        {
          name: "torch-test-harness",
          resolveId: (id: string) => (id === "virtual:harness" ? "\0virtual:harness" : null),
          load: (id: string) => (id === "\0virtual:harness" ? `export { createElement } from "react"; export { renderToString } from "react-dom/server";` : null),
        },
      ],
    });
    const harness = await server.ssrLoadModule("virtual:harness");
    h = harness.createElement;
    renderToString = harness.renderToString;
  }, 60_000);

  afterAll(async () => {
    console.info = consoleInfo;
    await server?.close();
  });

  const noop = () => {};

  test("price table: a row per model, cells with values, a row error", async () => {
    const { PricesTable } = await server.ssrLoadModule("/src/pages/settings/components/PricesTable.tsx");
    const draft = toDraft(settings.prices);
    const html = renderToString(
      h(PricesTable, {
        rows: draft.rows,
        errors: new Map([[0, "Input must be a number, 0 or more"]]),
        onModelChange: noop,
        onCellChange: noop,
        onRemove: noop,
        onAdd: noop,
      }),
    );
    for (const model of Object.keys(settings.prices.models)) expect(html).toContain(`value="${model}"`);
    expect(html).toContain("Cache write 5m");
    expect(html).toContain("Add model");
    expect(html).toContain("Input must be a number, 0 or more");
    expect(html.match(/<tr/g)).toHaveLength(1 + draft.rows.length);
  });

  test("paths, channels and retention period from the response", async () => {
    const { DataPaths, Channels, Retention } = await server.ssrLoadModule("/src/pages/settings/components/Overview.tsx");
    const paths = renderToString(h(DataPaths, { paths: settings.paths }));
    for (const path of Object.values(settings.paths)) expect(paths).toContain(path);
    const channels = renderToString(h(Channels, { channels: settings.channels }));
    expect(channels).toContain("Configured");
    expect(channels).toContain("Not configured");
    expect(renderToString(h(Retention, { days: 365 }))).toContain("365 days");
  });

  test("the page before the response shows loading", async () => {
    const { SettingsPage } = await server.ssrLoadModule("/src/pages/settings/SettingsPage.tsx");
    const html = renderToString(h(SettingsPage));
    expect(html).toContain("Settings");
    expect(html).toContain("Loading…");
  });
});

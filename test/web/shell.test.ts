// UI shell: the six plan §9.1 routes on templates, the header, shared atoms and molecules.
// Components are rendered on the server through Vite (it parses TSX and style imports),
// without a browser or network; the appearance is checked against the artboards separately.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const WEB_DIR = join(import.meta.dir, "../../web");

interface ViteServer {
  ssrLoadModule(id: string): Promise<Record<string, any>>;
  close(): Promise<void>;
}

let server: ViteServer;
let h: (type: unknown, props?: object | null, ...children: unknown[]) => unknown;
let renderToString: (element: unknown) => string;
let renderRoute: (location: string) => string;

const load = (id: string) => server.ssrLoadModule(id);
const render = async (file: string, name: string, props: object, ...children: unknown[]) =>
  renderToString(h((await load(file))[name], props, ...children));

// On first render Carbon prints reminders about v12 flags: they are not needed in the test output.
const consoleInfo = console.info;

beforeAll(async () => {
  console.info = () => {};
  // Vite is installed in the web package, not in the root.
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
        // React for the test is taken by the same path as for the components: a single instance.
        name: "torch-test-harness",
        resolveId: (id: string) => (id === "virtual:harness" ? "\0virtual:harness" : null),
        load: (id: string) =>
          id === "\0virtual:harness"
            ? `export { createElement } from "react";
               export { renderToString } from "react-dom/server";
               export { StaticRouter } from "react-router";
               export { App } from "/src/App.tsx";`
            : null,
      },
    ],
  });
  const harness = await load("virtual:harness");
  h = harness.createElement;
  renderToString = harness.renderToString;
  renderRoute = (location) => renderToString(h(harness.StaticRouter, { location }, h(harness.App)));
}, 60_000);

afterAll(async () => {
  console.info = consoleInfo;
  await server?.close();
});

describe("plan §9.1 routes", () => {
  const activeLink = (html: string) => html.match(/<a[^>]*aria-current="page"[^>]*>([^<]*)</)?.[1] ?? null;

  test.each([
    ["/", "Dashboard"],
    ["/sessions", "Sessions"],
    ["/settings", null],
  ])("%s: the AppShell template without the session shell", (location, active) => {
    const html = renderRoute(location);
    expect(html).toContain('class="torch-shell"');
    expect(html).toContain("<main");
    expect(html).not.toContain("torch-session");
    expect(activeLink(html)).toBe(active);
  });

  test.each(["/sessions/abc", "/sessions/abc/timeline"])("%s: the AppShell and SessionLayout templates", (location) => {
    const html = renderRoute(location);
    expect(html).toContain('class="torch-shell"');
    expect(html).toContain('class="torch-session"');
    // The page stub passed nothing: the template shows the heading placeholder and both tabs.
    expect(html).toContain("cds--skeleton__heading");
    expect(html).toMatch(/Session views.*Overview.*Timeline/s);
    // Session pages belong to the Sessions section, as in the mockup.
    expect(activeLink(html)).toBe("Sessions");
  });

  test("/sessions/abc/panel: a separate tab without the app header", () => {
    const html = renderRoute("/sessions/abc/panel");
    expect(html).not.toContain("torch-shell");
    expect(html).not.toContain("torch-header");
  });
});

describe("header", () => {
  test("the torch name, the Dashboard and Sessions links, the gear leads to /settings", () => {
    const html = renderRoute("/");
    expect(html).toMatch(/<header class="torch-header[^"]*cds--g100/);
    expect(html).toContain('<span class="torch-header__name">torch</span>');
    expect(html).not.toContain("Session debugger");
    expect(html).toMatch(/<nav aria-label="Main"[^>]*>.*href="\/"[^>]*>Dashboard<.*href="\/sessions"[^>]*>Sessions</s);
    expect(html).toMatch(/<a[^>]*class="cds--btn cds--btn--ghost cds--btn--icon-only[^"]*"[^>]*href="\/settings"/);
    expect(html).toContain(">Settings<");
  });
});

describe("atoms", () => {
  test("Meter: share in percent, clamped to 0…100, color and a variant without a track", async () => {
    const file = "/src/components/atoms/Meter.tsx";
    expect(await render(file, "Meter", { ratio: 0.74 })).toContain("inline-size:74%");
    expect(await render(file, "Meter", { ratio: 3 })).toContain("inline-size:100%");
    expect(await render(file, "Meter", { ratio: Number.NaN })).toContain("inline-size:0%");
    const bare = await render(file, "Meter", { ratio: 0.5, color: "#009d9a", track: false });
    expect(bare).toContain("torch-meter--bare");
    expect(bare).toContain("background:#009d9a");
  });

  test("Swatch and Mono", async () => {
    expect(await render("/src/components/atoms/Swatch.tsx", "Swatch", { color: "#8a3ffc" })).toContain(
      "background:#8a3ffc",
    );
    const mono = await render("/src/components/atoms/Mono.tsx", "Mono", { size: "md", tone: "helper" }, "claude-opus-5-5");
    expect(mono).toBe('<span class="torch-mono torch-mono--md torch-mono--helper">claude-opus-5-5</span>');
  });

  test("TimelineMark: with onSelect a button with a label and a state, without it a legend sample", async () => {
    const file = "/src/components/atoms/TimelineMark.tsx";
    const mark = await render(file, "TimelineMark", {
      kind: "tool",
      label: "Bash bun test, failed",
      left: "33%",
      width: "max(3px, 4%)",
      error: true,
      dimmed: true,
      selected: true,
      onSelect() {},
    });
    expect(mark).toStartWith('<button type="button"');
    expect(mark).toContain("torch-mark--tool torch-mark--error torch-mark--dimmed");
    expect(mark).toContain('aria-label="Bash bun test, failed"');
    expect(mark).toContain('aria-pressed="true"');
    expect(mark).toContain("left:33%");

    const sample = await render(file, "TimelineMark", { kind: "prompt", label: "Prompt" });
    expect(sample).toBe('<span class="torch-mark torch-mark--prompt torch-mark--sample" aria-hidden="true"></span>');
  });
});

describe("molecules", () => {
  test("StatTile: session overview tiles with the values from the mockup", async () => {
    const file = "/src/components/molecules/StatTile.tsx";
    const { StatTile } = await load(file);
    const html = await render(
      file,
      "StatTileGrid",
      { label: "Session summary" },
      h(StatTile, { label: "Total tokens", value: "2.18M", helper: "79% served from cache" }),
      h(StatTile, { label: "Errors", value: "7", helper: "3.8% of 186 tool calls", error: true }),
    );
    expect(html).toStartWith('<section class="torch-stat-tiles" aria-label="Session summary">');
    expect(html).toContain('<span class="torch-stat-tile__value">2.18M</span>');
    expect(html).toContain("79% served from cache");
    // The error icon appears only in a tile with the error flag.
    expect(html.match(/torch-stat-tile__icon/g)).toHaveLength(1);
  });

  test("SegmentedControl: the selected value is marked with aria-pressed", async () => {
    const html = await render("/src/components/molecules/SegmentedControl.tsx", "SegmentedControl", {
      label: "Agents",
      showLabel: true,
      value: "few",
      onChange() {},
      options: [
        { value: "any", label: "Any" },
        { value: "one", label: "1" },
        { value: "few", label: "2–3" },
        { value: "many", label: "4+" },
      ],
    });
    expect(html).toMatch(/aria-pressed="false">Any<.*aria-pressed="true">2–3<.*aria-pressed="false">4\+</s);
    expect(html).toContain(">Agents</span>");
    expect(html).toContain('role="group"');
  });

  test("RangeFilter: Min and Max fields under a common title", async () => {
    const html = await render("/src/components/molecules/RangeFilter.tsx", "RangeFilter", {
      legend: "Tool calls",
      value: { min: "10", max: "" },
      onChange() {},
    });
    expect(html).toContain("<legend");
    expect(html).toContain("Tool calls</legend>");
    expect(html).toMatch(/>Min<\/label>.*type="number".*value="10".*>Max<\/label>.*placeholder="Any"/s);
  });

  test("RangeFilter: From and To dates for the Custom range", async () => {
    const html = await render("/src/components/molecules/RangeFilter.tsx", "RangeFilter", {
      legend: "Date range",
      hideLegend: true,
      type: "date",
      minLabel: "From",
      maxLabel: "To",
      value: { min: "2026-10-01", max: "2026-10-31" },
      onChange() {},
    });
    expect(html).toContain("cds--visually-hidden");
    expect(html).toMatch(/>From<\/label>.*type="date".*value="2026-10-01".*>To<\/label>.*value="2026-10-31"/s);
  });

  test("KeyValue: pairs as a definition list, an error is highlighted", async () => {
    const file = "/src/components/molecules/KeyValue.tsx";
    const { KeyValue } = await load(file);
    const html = await render(
      file,
      "KeyValueList",
      {},
      h(KeyValue, { label: "Duration" }, "18m 42s"),
      h(KeyValue, { label: "Errors", error: true }, "10 (7 tool, 3 network)"),
    );
    expect(html).toStartWith("<dl");
    expect(html).toMatch(/<dt[^>]*>Duration<\/dt><dd[^>]*>18m 42s<\/dd>/);
    expect(html).toMatch(/torch-key-value__value--error">10 \(7 tool, 3 network\)</);
  });

  test("CallRow: a button row of a call with an error", async () => {
    const html = await render("/src/components/molecules/CallRow.tsx", "CallRow", {
      time: "+6:12",
      name: "Bash",
      detail: "bun run generate:client",
      duration: "4.2 s",
      error: true,
      current: true,
      onSelect() {},
    });
    expect(html).toStartWith('<button type="button" class="torch-call-row torch-call-row--error torch-call-row--current"');
    expect(html).toContain('aria-label="Bash bun run generate:client, failed"');
    for (const text of ["+6:12", "Bash", "bun run generate:client", "4.2 s"]) expect(html).toContain(`>${text}<`);
    expect(html).toContain("torch-call-row__icon");
  });
});

describe("chart organisms", () => {
  test("BarChart: total and series peak from dto, a place for a Carbon Charts chart", async () => {
    const { fixtureResponse } = await load("/src/lib/fixtures.ts");
    const dashboard = await fixtureResponse("dashboard", {}, { range: "week" });
    const html = await render("/src/components/organisms/BarChart/BarChart.tsx", "BarChart", {
      metric: "modelCalls",
      points: dashboard.series.modelCalls,
      bucket: dashboard.bucket,
    });
    expect(html).toContain('aria-label="Model calls"');
    expect(html.replaceAll("<!-- -->", "")).toContain("1,347 total · peak 395");
    expect(html).toContain("chart-holder");
  });

  test("ProportionChart: tokens and context from dto; empty data gives no chart", async () => {
    const file = "/src/components/organisms/ProportionChart/ProportionChart.tsx";
    const { fixtureResponse } = await load("/src/lib/fixtures.ts");
    const session = await fixtureResponse("session", { id: "any" });
    const agent = await fixtureResponse("agent", { agentId: "main" });
    expect(await render(file, "ProportionChart", { kind: "tokens", label: "Token usage", tokens: session.tokens })).toContain(
      "chart-holder",
    );
    expect(
      await render(file, "ProportionChart", { kind: "context", label: "Context at peak", breakdown: agent.ctxBreakdown }),
    ).toContain("chart-holder");
    expect(await render(file, "ProportionChart", { kind: "context", label: "Context at peak", breakdown: [] })).toContain(
      "No data",
    );
  });

  test("Carbon Charts is imported only in two organisms, its styles at the entry point", () => {
    const importers = [...new Bun.Glob("**/*.{ts,tsx,scss}").scanSync({ cwd: join(WEB_DIR, "src"), absolute: true })]
      .filter((file) => /from\s+["']@carbon\/charts|import\s+["']@carbon\/charts|@use\s+["']@carbon\/charts/.test(readFileSync(file, "utf8")))
      .map((file) => relative(join(WEB_DIR, "src"), file))
      .sort();
    expect(importers).toEqual([
      "components/organisms/BarChart/BarChart.tsx",
      "components/organisms/ProportionChart/ProportionChart.tsx",
      "main.tsx",
    ]);
    expect(readFileSync(join(WEB_DIR, "src/main.tsx"), "utf8")).toContain('import "@carbon/charts/styles.css";');
  });
});

// Rendering of the detail panel (W4) on the test/fixtures/dto responses: six views, the frame in the dock and in
// a separate tab, the "Back to …" button, the /sessions/:id/panel page.
// Components are rendered on the server through Vite, as in shell.test.ts: without a browser or network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DetailPanelData } from "../../web/src/components/organisms/DetailPanel/model.ts";
import agents from "../fixtures/dto/agents.json";
import files from "../fixtures/dto/files.json";
import network from "../fixtures/dto/network.json";
import prompts from "../fixtures/dto/prompts.json";
import session from "../fixtures/dto/session.json";
import toolCalls from "../fixtures/dto/toolCalls.json";

const WEB_DIR = join(import.meta.dir, "../../web");
const SCHEMAS = "/Users/dev/code/billing-web/src/api/billing/schemas.ts";

interface ViteServer {
  ssrLoadModule(id: string): Promise<Record<string, any>>;
  close(): Promise<void>;
}

let server: ViteServer;
let h: (type: unknown, props?: object | null, ...children: unknown[]) => unknown;
let renderToString: (element: unknown) => string;
let StaticRouter: unknown;
let App: unknown;
let DetailPanel: unknown;
let DetailPanelShell: unknown;

const consoleInfo = console.info;

beforeAll(async () => {
  // On first render Carbon prints reminders about v12 flags: they are not needed in the test output.
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
        // React for the test is taken by the same path as for the components: a single instance.
        name: "torch-test-harness",
        resolveId: (id: string) => (id === "virtual:panel-harness" ? "\0virtual:panel-harness" : null),
        load: (id: string) =>
          id === "\0virtual:panel-harness"
            ? `export { createElement } from "react";
               export { renderToString } from "react-dom/server";
               export { StaticRouter } from "react-router";
               export { App } from "/src/App.tsx";
               export { DetailPanel, DetailPanelShell } from "/src/components/organisms/DetailPanel/DetailPanel.tsx";`
            : null,
      },
    ],
  });
  const harness = await server.ssrLoadModule("virtual:panel-harness");
  h = harness.createElement;
  renderToString = harness.renderToString;
  ({ StaticRouter, App, DetailPanel, DetailPanelShell } = harness);
}, 60_000);

afterAll(async () => {
  console.info = consoleInfo;
  await server?.close();
});

/** Markup without React service comments between adjacent texts. */
const html = (element: unknown) =>
  renderToString(h(StaticRouter, { location: "/sessions/abc/timeline" }, element)).replaceAll("<!-- -->", "");

const item = (kind: DetailPanelData["kind"], data: unknown) => ({ kind, data }) as DetailPanelData;

const ITEMS = {
  session: item("session", session),
  agent: item("agent", agents["gp-1"]),
  tool: item("tool", toolCalls.toolu_main_009),
  prompt: item("prompt", prompts["ref-prompt-1"]),
  file: item("file", (files as Record<string, unknown>)[SCHEMAS]),
  net: item("net", (network as Record<string, unknown>)["model:req_main_001"]),
};

const START = session.startedAt;
const panel = (props: object) => html(h(DetailPanel, { onOpen() {}, sessionStart: START, ...props }));

/** Headings of the view blocks in markup order. */
const headings = (markup: string) => [...markup.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));

describe("six views on the dto responses", () => {
  test("Agent: artboard blocks in order, peak context is a ProportionChart chart", () => {
    const markup = panel({ item: ITEMS.agent });
    expect(headings(markup)).toEqual([
      "general-purpose",
      "Basic information",
      "Input prompt",
      "Context",
      "What was in the context at peak",
      "Instructions loaded",
      "Tool usage",
      "Tool calls (49)",
    ]);
    expect(markup).toContain(">Agent</span>");
    expect(markup).toContain("Rewrite tests with bun test");
    expect(markup).toContain("Move tests/ from vitest to bun test.");
    expect(markup).toContain("of 200K window");
    expect(markup).toContain("112.7K · 56%");
    // The composite bar is drawn by the ProportionChart organism with an estimate mark.
    expect(markup).toMatch(/aria-label="Context at peak"[^>]*>.*chart-holder/s);
    expect(markup).toContain(">Estimated<");
    expect(markup).toContain("Open the peak model call");
    expect(markup).toContain("~2.4K tokens");
    // The First / Last / Peak bars and Tool usage are the Meter atom: three with a track, four without.
    expect(markup.match(/class="Meter__root"/g)).toHaveLength(3);
    expect(markup.match(/Meter__bare/g)).toHaveLength(4);
    expect(markup).toContain("Errors only (4)");
    expect(markup.match(/<button type="button" class="CallRow__root/g)).toHaveLength(49);
    expect(markup.match(/CallRow__error/g)).toHaveLength(4);
  });

  test("Tool call with an error: the Error label, message, input and error output", () => {
    const markup = panel({ item: ITEMS.tool });
    expect(headings(markup)).toEqual(["Bash", "Basic information", "Input", "Error output"]);
    expect(markup).toContain(">Tool call</span>");
    expect(markup).toContain("DetailPanel__titleMono");
    expect(markup).toContain("cds--tag--red");
    expect(markup).toContain("bun run generate:client");
    expect(markup).toContain("(+6:12)");
    expect(markup).toContain("~4.2 s");
    expect(markup).toContain("cds--inline-notification--error");
    expect(markup).toContain("$ openapi-ts -i openapi.yaml -o src/api/billing/gen --zod");
    expect(markup).toContain("DetailPanel__preError");
    expect(markup).toContain("error: unknown option &#x27;--zod&#x27;");
  });

  test("Tool call without an error: the Success label, the Output block and a file link", () => {
    const markup = panel({ item: item("tool", toolCalls.toolu_main_003) });
    expect(headings(markup)).toEqual(["Edit", "Basic information", "Input", "Output", "File"]);
    expect(markup).toContain("cds--tag--green");
    expect(markup).not.toContain("cds--inline-notification");
    expect(markup).not.toContain("DetailPanel__preError");
    expect(markup).toContain("+6 −3");
  });

  test("User prompt: heading, fields and text", () => {
    const markup = panel({ item: ITEMS.prompt });
    expect(headings(markup)).toEqual(["Original prompt", "Prompt"]);
    expect(markup).toContain(">User prompt</span>");
    expect(markup).toContain("Image #1");
    expect(markup).toContain("DetailPanel__preLarge");
    expect(markup).toContain("Replace the hand-written fetch wrapper");
  });

  test("File: the path as the heading, counters and a list of operations with agents", () => {
    const markup = panel({ item: ITEMS.file });
    expect(headings(markup)).toEqual([SCHEMAS, "Operations"]);
    expect(markup).toContain("DetailPanel__titlePath");
    expect(markup).toContain("+290 −21");
    expect(markup.match(/<button type="button" class="CallRow__root/g)).toHaveLength(15);
    expect(markup).toContain(">general-purpose · gp-1<");
  });

  test("Network call: a model call with tokens, response and requested calls", () => {
    const markup = panel({ item: ITEMS.net });
    expect(headings(markup)).toEqual(["Thinking", "Response", "Tool calls requested (1)"]);
    expect(markup).toContain(">Network call</span>");
    expect(markup).toContain("Model API");
    expect(markup).toContain("18.4K (11.0K cached)");
    expect(markup).toContain("tool_use");
    expect(markup).toContain("Next: Bash.");
    expect(markup).not.toContain("cds--inline-notification");
  });

  test("Network call: a failed attempt and an external request", () => {
    const failed = panel({ item: item("net", network["error:ref-apierr-main"]) });
    expect(headings(failed)).toEqual(["Error response"]);
    expect(failed).toContain("cds--inline-notification--error");
    expect(failed).toContain("Attempt 1 of 10 · retried after 1.2 s");
    expect(failed).toMatch(/DetailPanel__preError[^>]*>529 Overloaded</);

    const external = panel({ item: item("net", network["external:toolu_plan-1_008"]) });
    expect(headings(external)).toEqual([]);
    expect(external).toContain("WebFetch");
    expect(external).toContain("https://heyapi.dev/openapi-ts/get-started");
    expect(external).toContain("86.2 KB");
    expect(external).toContain("WebFetch call");
  });

  test("Session: name, status, totals and links to five agents", () => {
    const markup = panel({ item: ITEMS.session });
    expect(headings(markup)).toEqual(["Migrate billing API client to openapi-ts", "Agents"]);
    expect(markup).toContain(">Session</span>");
    expect(markup).toContain("Completed");
    expect(markup).toContain("No enrichment");
    expect(markup).toContain("7 tool, 3 API");
    expect(markup).toContain('title="Active time; 18m 42s from start to end"');
    for (const label of ["Main agent", "Explore · explore-1", "Plan · plan-1", "general-purpose · gp-1"]) {
      expect(markup).toContain(`>${label}</button>`);
    }
  });

  test("the panel heading names the session; links to other views are buttons", () => {
    for (const data of Object.values(ITEMS)) {
      const markup = panel({ item: data });
      expect(markup).toStartWith('<section class="DetailPanel__root" aria-label="Details">');
      expect(markup).toContain("Details · 8f3c1a2e");
      // The session scaffold substring does not occur in the panel markup (shell.test.ts).
      expect(markup).not.toContain("SessionLayout__");
    }
    expect(panel({ item: ITEMS.tool })).toMatch(/<button type="button" class="DetailPanel__link">Main agent<\/button>/);
  });

  test("without a session start the time is shown as time of day, not as an offset", () => {
    const markup = html(h(DetailPanel, { item: ITEMS.tool, onOpen() {} }));
    expect(markup).not.toContain("(+6:12)");
  });

  test("a long body: the beginning and a Show all button are shown if the page gave a loader", () => {
    const call = toolCalls.toolu_main_009;
    const truncated = item("tool", { ...call, output: { ...call.output, bytes: 88268, truncated: true } });
    const withLoader = panel({ item: truncated, onLoadContent: async () => ({ id: 1, bytes: 1, text: "" }) });
    expect(withLoader).toContain("First 4,000 characters of 86.2 KB");
    expect(withLoader).toContain(">Show all</button>");
    const withoutLoader = panel({ item: truncated });
    expect(withoutLoader).toContain("First 4,000 characters of 86.2 KB");
    expect(withoutLoader).not.toContain("Show all");
    expect(panel({ item: ITEMS.tool })).not.toContain("Show all");
  });
});

describe("panel frame", () => {
  const docked = (props: object) => panel({ item: ITEMS.agent, dock: "right", onDock() {}, onClose() {}, ...props });

  test("in the dock: three dock buttons with the current one marked, a new tab and close", () => {
    const markup = docked({ detachedHref: "/sessions/abc/panel?sel=agent%3Agp-1" });
    expect(markup).toContain('role="group" aria-label="Dock panel"');
    const pressed = [...markup.matchAll(/aria-pressed="(true|false)"/g)].map((m) => m[1]);
    // Artboard order: left, bottom, right.
    expect(pressed).toEqual(["false", "false", "true"]);
    expect(markup).toMatch(/Dock left.*Dock bottom.*Dock right.*Open in new tab.*Close panel/s);
    expect(markup).toMatch(/<a target="_blank"[^>]*href="\/sessions\/abc\/panel\?sel=agent%3Agp-1"/);
    expect(markup).not.toContain("Back to timeline");
  });

  test.each([
    ["left", ["true", "false", "false"]],
    ["bottom", ["false", "true", "false"]],
  ])("dock %s is marked by its own button", (dock, expected) => {
    const pressed = [...docked({ dock }).matchAll(/aria-pressed="(true|false)"/g)].map((m) => m[1]);
    expect(pressed).toEqual(expected);
  });

  test("in a separate tab: a Back to timeline link instead of the dock and close", () => {
    const markup = panel({ item: ITEMS.agent, timelineHref: "/sessions/abc/timeline?sel=agent%3Agp-1" });
    expect(markup).toMatch(/<a[^>]*href="\/sessions\/abc\/timeline\?sel=agent%3Agp-1"[^>]*>Back to timeline<\/a>/);
    expect(markup).not.toContain("Dock panel");
    expect(markup).not.toContain("Open in new tab");
    expect(markup).not.toContain("Close panel");
  });

  test("the \"Back to …\" button exists only when there is somewhere to go back to", () => {
    const withBack = panel({ item: ITEMS.tool, onBack() {}, backLabel: "general-purpose (gp-1)" });
    expect(withBack).toContain("Back to general-purpose (gp-1)</button>");
    expect(panel({ item: ITEMS.tool })).not.toContain("DetailPanel__back");
  });

  test("the same frame without data: shown by the loader while the request is in flight", () => {
    const markup = html(
      h(DetailPanelShell, { sessionId: "8f3c1a2e-61b0", dock: "bottom", onDock() {}, onClose() {} }, "loading"),
    );
    expect(markup).toContain("Details · 8f3c1a2e");
    expect(markup).toContain("Close panel");
    expect(markup).toContain(">loading</div>");
  });
});

describe("page /sessions/:id/panel", () => {
  const route = (location: string | object) =>
    renderToString(h(StaticRouter, { location }, h(App))).replaceAll("<!-- -->", "");

  test("separate tab: the panel frame without the app header, a placeholder while the data loads", () => {
    const markup = route("/sessions/abc/panel?sel=tool%3Atoolu_main_009");
    expect(markup).toStartWith('<main class="PanelPage__root">');
    expect(markup).toContain("Details · abc");
    expect(markup).toContain("cds--skeleton__text");
    expect(markup).toMatch(/href="\/sessions\/abc\/timeline\?sel=tool%3Atoolu_main_009"[^>]*>Back to timeline</);
    expect(markup).not.toContain("Dock panel");
  });

  test("a history entry with the label of the element we came from gives the \"Back to …\" button", () => {
    const location = { pathname: "/sessions/abc/panel", search: "?sel=tool%3Atoolu_gp-1_031" };
    const withState = route({ ...location, state: { panelBack: "general-purpose (gp-1)" } });
    expect(withState).toContain("Back to general-purpose (gp-1)</button>");
    // A tab opened by address has no panel history.
    expect(route(location)).not.toContain("DetailPanel__back");
  });

  test("without a selection in the address the back link leads to the timeline with the session view", () => {
    expect(route("/sessions/abc/panel")).toMatch(/href="\/sessions\/abc\/timeline\?sel=session"[^>]*>Back to timeline</);
  });
});

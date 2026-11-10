// End-to-end run steps: all five screens and Settings the way a user walks through them —
// Dashboard → Sessions → session overview → timeline → panel → panel in a separate tab → Settings.
// What is visible is checked: element roles and names, UI texts, the page address.

import { readFileSync } from "node:fs";
import type { PriceTable } from "../../src/contracts/api.ts";
import { type Browser, type Page, type Scope, waitFor } from "./browser.ts";
import { LIVE_SESSION, type World } from "./world.ts";

export interface Stage {
  world: World;
  /** torch server address. */
  baseUrl: string;
  browser: Browser;
  page: Page;
}

/** A failed step: the screen, the step's expectation and what exactly did not match. */
export class StepError extends Error {
  constructor(screen: string, expectation: string, cause: unknown) {
    super(`${screen} — ${expectation}\n  ${(cause instanceof Error ? cause.message : String(cause)).replaceAll("\n", "\n  ")}`);
  }
}

// ── Checks ──────────────────────────────────────────────────────────────────────────────────

/** Waits until the value read from the page matches the expected one. */
async function shows(what: string, expected: string, read: () => Promise<string | undefined>): Promise<void> {
  let seen: string | undefined;
  try {
    await waitFor(what, async () => ((seen = await read()) === expected ? true : undefined));
  } catch {
    throw new Error(`${what}: expected “${expected}”, the page has “${seen ?? "nothing"}”`);
  }
}

/** Labels of the scope in reading order: what is written as text on the screen. */
async function texts(scope: Scope): Promise<string[]> {
  return (await scope.names("StaticText")).map((value) => value.trim()).filter((value) => value !== "");
}

/** Waits until a label appears in the scope — as a whole, not as part of another text. */
async function showsText(scope: Scope, where: string, text: string): Promise<void> {
  await waitFor(`${where}: there must be a label “${text}”`, async () => ((await texts(scope)).includes(text) ? true : undefined));
}

/** Waits until the toggle button becomes pressed. */
async function pressed(scope: Scope, name: string | RegExp): Promise<void> {
  await waitFor(`button “${name instanceof RegExp ? name.source : name}” must become pressed`, async () => (String(await (await scope.all("button", name))[0]?.state("pressed")) === "true" ? true : undefined));
}

/** Value of a totals tile: the text following its caption. */
async function tile(tiles: Scope, label: string): Promise<string | undefined> {
  const all = await texts(tiles);
  const at = all.indexOf(label);
  return at < 0 ? undefined : all[at + 1];
}

/** A table row cell by column header; the row is the one that contains a link with this name. */
async function cell(table: Scope, rowLink: string, column: string): Promise<string | undefined> {
  const columns = await table.names("columnheader");
  for (const row of await table.all("row")) {
    if ((await row.all("link", rowLink)).length === 0) continue;
    return (await row.names("cell"))[columns.indexOf(column)];
  }
  return undefined;
}

/** A script exception on the page, a console error or an API error is a failure, even if the screen looks intact. */
function failOnProblems(page: Page): void {
  const problems = page.takeProblems();
  if (problems.length > 0) throw new Error(`the page reported a failure:\n${problems.map((problem) => `${problem.kind}: ${problem.text}`).join("\n")}`);
}

// ── Scenario ────────────────────────────────────────────────────────────────────────────────

/** Runs all steps; returns the number of known defects that reproduced. A failed step is a `StepError`. */
export async function runScenario({ world, baseUrl, browser, page }: Stage): Promise<number> {
  const ref = world.reference;
  const refErrors = ref.toolCalls.filter((call) => call.status === "error").length;
  const sessionPath = `/sessions/${ref.sessionId}`;
  /** A long call with an error: a wide mark on the track and the "Tool call" view with the error message. */
  const call = ref.toolCalls.find((tool) => tool.target === "bun test --watch")!;
  const callSelection = `tool:${call.id}`;
  const callAgent = ref.agents.find((agent) => agent.id === call.agentId)!;
  /** The name of a call mark on the track starts with the tool and its target. */
  const callMark = new RegExp(`^${call.name} ${call.target}`);
  /** An edit in Settings: the output-token price of the main agent's model is a noticeable part of the session cost. */
  const model = ref.agents[0]!.model;
  const outputPrice = ref.prices.models[model]!.output;
  const newOutputPrice = outputPrice * 2;
  /** Cost of the reference session at this output-token price of this model, as the list writes it: "$8.48". */
  const costAt = (price: number): string => {
    const usd = ref.modelCalls.reduce((sum, c) => sum + c.costUsd + (c.model === model ? (c.tokOutput * (price - outputPrice)) / 1_000_000 : 0), 0);
    return `$${usd.toFixed(2)}`;
  };

  /** A run step: on failure it names the screen and the expectation; a page failure not visible on the screen is a failure too. */
  async function step(screen: string, expectation: string, body: () => Promise<void>): Promise<void> {
    const startedAt = Date.now();
    try {
      await body();
      failOnProblems(page);
    } catch (error) {
      throw new StepError(screen, expectation, error);
    }
    console.log(`✓ ${screen} — ${expectation} (${Date.now() - startedAt} ms)`);
  }

  let defects = 0;
  /**
   * A step for a known screen defect: while the defect exists, the step fails but the run goes on.
   * When the defect is fixed, the report line will ask to remove the mark.
   */
  async function knownDefect(screen: string, expectation: string, body: () => Promise<void>): Promise<void> {
    try {
      await step(screen, expectation, body);
      console.log("  defect no longer reproduces: it is time to remove the known-defect mark from this step");
    } catch (error) {
      defects++;
      console.log(`! known defect: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const atPath = (path: string) => page.waitForUrl(`path ${path}`, (url) => url.pathname === path);
  const withParam = (name: string, value: string | null, on: Page = page) =>
    on.waitForUrl(value === null ? `without parameter ${name}` : `${name}=${value}`, (url) => url.searchParams.get(name) === value);

  await step("Dashboard", "opens: week totals, charts, tops and tables", async () => {
    await page.goto(baseUrl);
    await page.find("heading", "Dashboard");
    await pressed(await page.find("group", "Time range"), "Last week");
    // For the week there is only the running session: the reference one started earlier.
    const totals = await page.find("region", "Totals");
    await shows("tile Sessions", "1", () => tile(totals, "Sessions"));
    const activity = await page.find("region", "Activity");
    for (const chart of ["Model calls", "Tool calls"]) await activity.find("region", chart);
    for (const block of ["Token mix", "Insights", "Tool calls by tool", "Model calls by model"]) await page.find("region", block);
  });

  // With one call per week the axis ticks are integers: fractional ones would give repeated rounded labels.
  await step("Dashboard", "the Calls axis tick labels on the Model calls chart do not repeat", async () => {
    const ticks = await (await (await page.find("region", "Activity")).find("region", "Model calls")).find("graphics-object", "left ticks");
    const labels = await waitFor("the Calls axis must have tick labels", async () => {
      const found = await texts(ticks);
      return found.length > 0 ? found : undefined;
    });
    if (new Set(labels).size !== labels.length) throw new Error(`axis tick labels: ${labels.join(", ")}`);
  });

  await step("Dashboard", "the Last month range adds the reference session", async () => {
    await (await page.find("button", "Last month")).click();
    await withParam("range", "month");
    await pressed(page, "Last month");
    const totals = await page.find("region", "Totals");
    await shows("tile Sessions", "2", () => tile(totals, "Sessions"));
    await shows("tile Tool calls", String(ref.toolCalls.length + 1), () => tile(totals, "Tool calls"));
    await (await page.find("region", "Insights")).find("link", ref.name);
    await (await page.find("table", "Tool calls by tool")).find("cell", "Bash");
  });

  await step("Sessions", "opens from the header: both sessions in the table", async () => {
    await (await (await page.find("navigation", "Main")).find("link", "Sessions")).click();
    await atPath("/sessions");
    await page.find("heading", "Sessions");
    await showsText(await page.find("region", "Session list"), "list", "Showing 2 of 2 sessions");
    const table = await page.find("table", "Sessions");
    await table.find("link", LIVE_SESSION.name);
    await shows("reference session, Agents column", String(ref.agents.length), () => cell(table, ref.name, "Agents"));
    await shows("reference session, Tool calls column", String(ref.toolCalls.length), () => cell(table, ref.name, "Tool calls"));
    await shows("reference session, Errors column", String(refErrors), () => cell(table, ref.name, "Errors"));
    await shows("reference session, Cost column", costAt(outputPrice), () => cell(table, ref.name, "Cost"));
  });

  await step("Sessions", "search by name leaves one session, reset brings both back", async () => {
    const list = await page.find("region", "Session list");
    await (await page.find("searchbox", "Search sessions by name")).fill("billing");
    await withParam("q", "billing");
    await showsText(list, "list", "Showing 1 of 2 sessions");
    await page.find("link", ref.name);
    await page.gone("link", LIVE_SESSION.name);
    await (await page.find("button", "Reset filters")).click();
    await withParam("q", null);
    await showsText(list, "list", "Showing 2 of 2 sessions");
    await page.find("link", LIVE_SESSION.name);
  });

  await step("Sessions", "live update: a line appended to the transcript changes the list row without a reload", async () => {
    const table = await page.find("table", "Sessions");
    const loadedAt = await page.evaluate<number>("performance.timeOrigin");
    await shows("running session, Tool calls column before the write", "1", () => cell(table, LIVE_SESSION.name, "Tool calls"));
    world.appendToLive();
    await shows("running session, Tool calls column after the write", "2", () => cell(table, LIVE_SESSION.name, "Tool calls"));
    if ((await page.evaluate<number>("performance.timeOrigin")) !== loadedAt) throw new Error("the page reloaded, but it should have updated in place");
  });

  await step("Session overview", "opens from the list: header, tiles and agents of the reference session", async () => {
    await (await page.find("link", ref.name)).click();
    await atPath(sessionPath);
    await page.find("heading", ref.name);
    await showsText(page, "session header", "Completed");
    const summary = await page.find("region", "Session summary");
    await shows("tile Agents", String(ref.agents.length), () => tile(summary, "Agents"));
    await shows("tile Model calls", String(ref.modelCalls.length), () => tile(summary, "Model calls"));
    await shows("tile Errors", String(refErrors), () => tile(summary, "Errors"));
    await page.find("region", "Token usage");
    const prompt = await page.find("region", "Original prompt");
    await showsText(prompt, "block Original prompt", ref.prompts[0]!.text);
    const agents = await page.find("region", "Agents");
    await shows("Agents table, number of agent rows", String(ref.agents.length), async () => String((await (await agents.find("table")).all("link")).length));
  });

  await step("Session timeline", "opens from the overview: tracks with marks", async () => {
    await (await page.find("link", "Open timeline")).click();
    await atPath(`${sessionPath}/timeline`);
    await page.find("heading", ref.name);
    const timeline = await page.find("region", "Timeline");
    await pressed(await page.find("group", "Density"), "Compact");
    await timeline.find("group", `Prompts, ${ref.prompts.length} user messages`);
    await timeline.find("group", `Agents, ${ref.agents.length} · 1 main, ${ref.agents.length - 1} subagents`);
    await timeline.find("group", `Tools, ${ref.toolCalls.length} calls · ${refErrors} failed`);
    await timeline.find("button", /^Original prompt/);
  });

  await step("Session timeline", "Expanded mode lays out calls by agent and gets into the address", async () => {
    await (await (await page.find("group", "Density")).find("button", "Expanded")).click();
    await withParam("view", "expanded");
    await pressed(await page.find("group", "Density"), "Expanded");
    const timeline = await page.find("region", "Timeline");
    await timeline.find("group", /^Main agent, main /);
    await timeline.find("group", new RegExp(`^${callAgent.type}, ${callAgent.id} `));
  });

  await step("Detail panel", "a call mark on the timeline opens the panel in the dock", async () => {
    await (await (await page.find("region", "Timeline")).find("button", callMark)).click();
    await withParam("sel", callSelection);
    await pressed(page, callMark);
    const details = await page.find("region", "Details");
    await details.find("heading", call.name);
    for (const text of ["Tool call", "Error", call.id]) await showsText(details, "panel", text);
    await details.find("region", "Error output");
  });

  await step("Detail panel", "going to an agent inside the panel and returning with the Back to button", async () => {
    const details = await page.find("region", "Details");
    await (await details.find("button", `${callAgent.type} · ${callAgent.id}`)).click();
    await withParam("sel", `agent:${callAgent.id}`);
    await details.find("heading", callAgent.type!);
    await showsText(details, "panel", callAgent.description!);
    await (await details.find("button", /^Back to /)).click();
    await withParam("sel", callSelection);
    await details.find("heading", call.name);
  });

  await step("Detail panel", "the left dock gets into the address", async () => {
    await (await (await page.find("group", "Dock panel")).find("button", "Dock left")).click();
    await withParam("dock", "left");
    await pressed(await page.find("group", "Dock panel"), "Dock left");
  });

  await step("Detail panel (separate tab)", "Open in new tab opens the same call with a link to the timeline", async () => {
    const tab = await browser.newPage(async () => (await (await page.find("region", "Details")).find("link", "Open in new tab")).click());
    await tab.waitForUrl(`path ${sessionPath}/panel`, (url) => url.pathname === `${sessionPath}/panel`);
    await withParam("sel", callSelection, tab);
    const details = await tab.find("region", "Details");
    await details.find("heading", call.name);
    for (const text of ["Tool call", "Error", call.id]) await showsText(details, "panel", text);
    await details.find("link", "Back to timeline");
    // Dock controls exist only on the panel in the timeline.
    await tab.gone("group", "Dock panel");
    failOnProblems(tab);
    await browser.closePage(tab);
    await page.activate();
  });

  await step("Settings", "opens from the header: prices, data locations, channels, retention", async () => {
    await (await (await page.find("banner")).find("link", "Settings")).click();
    await atPath("/settings");
    await page.find("heading", "Settings");
    await (await page.find("table", "Prices per million tokens")).find("textbox", `Output, ${model}`);
    // The run server works on a temporary data directory: the page shows exactly it.
    await showsText(await page.find("region", "Data locations"), "data locations", world.dataDir);
    for (const block of ["Enrichment channels", "Retention"]) await page.find("region", block);
  });

  await step("Settings", "a price edit is saved to the temporary data directory and changes the session cost", async () => {
    await (await page.find("textbox", `Output, ${model}`)).fill(String(newOutputPrice));
    await (await page.find("button", "Save prices")).click();
    await showsText(page, "block Prices", "Prices saved");
    const saved = (JSON.parse(readFileSync(world.pricesPath, "utf8")) as PriceTable).models[model]?.output;
    if (saved !== newOutputPrice) throw new Error(`${world.pricesPath}: output price of ${model} is ${saved}, expected ${newOutputPrice}`);

    await (await (await page.find("navigation", "Main")).find("link", "Sessions")).click();
    await atPath("/sessions");
    const table = await page.find("table", "Sessions");
    await shows("reference session, Cost column after recalculation", costAt(newOutputPrice), () => cell(table, ref.name, "Cost"));
  });
  return defects;
}

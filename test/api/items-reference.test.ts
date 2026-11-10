// Panels of the reference session loaded by the pipeline match the dto examples the screens
// work from. Known differences from the example generator are named at each comparison.
import { expect, test } from "bun:test";
import type { AgentPanel, CallRow, FilePanel, NetworkPanel, PromptPanel, ToolCallPanel } from "../../src/contracts/api.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import agentsFixture from "../fixtures/dto/agents.json";
import filesFixture from "../fixtures/dto/files.json";
import networkFixture from "../fixtures/dto/network.json";
import promptsFixture from "../fixtures/dto/prompts.json";
import toolCallsFixture from "../fixtures/dto/toolCalls.json";
import { testApi } from "../support/api.ts";
import { REF_SESSION_ID } from "../support/reference.ts";
import { seedReference } from "../support/reference-seed.ts";

const db = openMemoryDb();
seedReference(db);
const api = testApi(db);
const get = <T>(path: string) => api.get<T>(`/api/sessions/${REF_SESSION_ID}/${path}`);

const agents = agentsFixture as unknown as Record<string, AgentPanel>;
const toolCalls = toolCallsFixture as unknown as Record<string, ToolCallPanel>;
const prompts = promptsFixture as unknown as Record<string, PromptPanel>;
const files = filesFixture as unknown as Record<string, FilePanel>;
const network = networkFixture as unknown as Record<string, NetworkPanel>;

const byTime = <Row extends CallRow>(rows: Row[]): Row[] => [...rows].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));

test("panels of the five agents match the dto example", async () => {
  expect(Object.keys(agents)).toHaveLength(5);
  for (const [agentId, panel] of Object.entries(agents)) {
    expect(await get<AgentPanel>(`agents/${encodeURIComponent(agentId)}`)).toEqual(panel);
  }
});

test("panels of the 186 tool calls match the dto example", async () => {
  expect(Object.keys(toolCalls)).toHaveLength(186);
  let exact = 0;
  for (const [callId, panel] of Object.entries(toolCalls)) {
    // The example generator always writes `durationExact: false` in a call panel; the API takes the flag from
    // the database — the same one this call has in the agent's call list from the example.
    const durationExact = agents[panel.agentId]!.calls.find((call) => call.id === callId)!.durationExact;
    if (durationExact) exact++;
    expect(await get<ToolCallPanel>(`tool-calls/${encodeURIComponent(callId)}`)).toEqual({ ...panel, durationExact });
  }
  expect(exact).toBe(13);
});

test("panels of the three prompts match the dto example", async () => {
  expect(Object.keys(prompts)).toHaveLength(3);
  for (const [promptId, panel] of Object.entries(prompts)) {
    expect(await get<PromptPanel>(`prompts/${encodeURIComponent(promptId)}`)).toEqual(panel);
  }
});

test("panels of the 13 files match the dto example", async () => {
  expect(Object.keys(files)).toHaveLength(13);
  for (const [path, panel] of Object.entries(files)) {
    // The example generator returns operations in scenario order (by agent), the API — by time: the composition
    // is compared as a whole, the example's order is brought to the API order.
    const ops = byTime(panel.ops);
    expect(await get<FilePanel>(`files?path=${encodeURIComponent(path)}`)).toEqual({ ...panel, ops, agents: [...new Set(ops.map((op) => op.agentId))] });
  }
});

test("network panels match the dto example: 142 model calls, 3 API errors, 2 external requests", async () => {
  const count = (net: NetworkPanel["net"]) => Object.values(network).filter((panel) => panel.net === net).length;
  expect([count("model"), count("error"), count("external")]).toEqual([142, 3, 2]);
  for (const [key, panel] of Object.entries(network)) {
    // The example key is `<kind>:<id>`, as in the selection record.
    const kind = key.slice(0, key.indexOf(":"));
    const netId = key.slice(key.indexOf(":") + 1);
    expect(await get<NetworkPanel>(`network/${kind}/${encodeURIComponent(netId)}`)).toEqual(panel);
  }
});

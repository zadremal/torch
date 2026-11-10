// Detail panel logic (W4) on the test/fixtures/dto responses: labels of the six views, fields, lists
// of calls, the "Errors only" filter, "Back to …", the plan §9.3 deviations.
import { describe, expect, test } from "bun:test";
import type {
  AgentPanel,
  ApiErrorPanel,
  ExternalRequestPanel,
  FilePanel,
  ModelCallPanel,
  NetworkPanel,
  PromptPanel,
  SessionOverview,
  ToolCallPanel,
} from "../../src/contracts/api.ts";
import { BODY_PREVIEW_CHARS, PANEL_DOCKS } from "../../src/contracts/constants.ts";
import { formatSelection, parseSelection } from "../../src/contracts/selection.ts";
import {
  agentDescription,
  agentFields,
  agentLabel,
  agentName,
  agentTags,
  backLabel,
  bodyNote,
  breakdownAside,
  callRows,
  contextStages,
  contextWindowAside,
  type DetailPanelData,
  DOCK_OPTIONS,
  durationLabel,
  emptyCallsText,
  failedCount,
  type FieldModel,
  fileFields,
  fileOpRows,
  formatBytes,
  instructionRows,
  messageTitle,
  networkFields,
  networkNotice,
  networkSubject,
  networkTags,
  permissionLabel,
  promptFields,
  promptTitle,
  rowDetail,
  rowTime,
  selectionOf,
  sessionAgentLinks,
  sessionFields,
  sessionIdOf,
  sessionTags,
  shortSessionId,
  toolFields,
  toolNotice,
  toolOutputTitle,
  toolStatusTag,
  toolUsageAside,
  toolUsageRows,
  visibleCalls,
} from "../../web/src/components/organisms/DetailPanel/model.ts";
import { formatClock, formatDateTime } from "../../web/src/lib/format.ts";
import agentsJson from "../fixtures/dto/agents.json";
import filesJson from "../fixtures/dto/files.json";
import networkJson from "../fixtures/dto/network.json";
import promptsJson from "../fixtures/dto/prompts.json";
import runningJson from "../fixtures/dto/sessionRunning.json";
import sessionJson from "../fixtures/dto/session.json";
import toolCallsJson from "../fixtures/dto/toolCalls.json";

const agents = agentsJson as unknown as Record<string, AgentPanel>;
const tools = toolCallsJson as unknown as Record<string, ToolCallPanel>;
const prompts = promptsJson as unknown as Record<string, PromptPanel>;
const files = filesJson as unknown as Record<string, FilePanel>;
const network = networkJson as unknown as Record<string, NetworkPanel>;
const session = sessionJson as unknown as SessionOverview;
const running = runningJson as unknown as SessionOverview;

const REFERENCE_ID = "8f3c1a2e-61b0-4c7e-9d2a-000000000142";
const SCHEMAS = "/Users/dev/code/billing-web/src/api/billing/schemas.ts";
/** Start of the baseline session: the "+6:12" time is counted from it. */
const START = session.startedAt!;

const main = agents.main!;
const gp1 = agents["gp-1"]!;
const explore = agents["explore-1"]!;
const failedBash = tools.toolu_main_009!;
const edit = tools.toolu_main_003!;
const spawn = tools.toolu_main_005!;
const original = prompts["ref-prompt-1"]!;
const followUp = prompts["ref-prompt-2"]!;
const schemas = files[SCHEMAS]!;
const modelCall = network["model:req_main_001"] as ModelCallPanel;
const overloaded = network["error:ref-apierr-main"] as ApiErrorPanel;
const connection = network["error:ref-apierr-explore-1"] as ApiErrorPanel;
const webFetch = network["external:toolu_plan-1_008"] as ExternalRequestPanel;

/** One element for each of the six panel views. */
const ITEMS: DetailPanelData[] = [
  { kind: "session", data: session },
  { kind: "agent", data: gp1 },
  { kind: "tool", data: failedBash },
  { kind: "prompt", data: original },
  { kind: "file", data: schemas },
  { kind: "net", data: modelCall },
];

const byLabel = (fields: FieldModel[]) => Object.fromEntries(fields.map((field) => [field.label, field]));

describe("six panel views", () => {
  test("each view has its own selection, and its address entry reads back", () => {
    expect(ITEMS.map((item) => formatSelection(selectionOf(item)))).toEqual([
      "session",
      "agent:gp-1",
      "tool:toolu_main_009",
      "prompt:ref-prompt-1",
      `file:${SCHEMAS}`,
      "net:model:req_main_001",
    ]);
    for (const item of ITEMS) {
      expect(parseSelection(formatSelection(selectionOf(item)))).toEqual(selectionOf(item));
    }
  });

  test("the session id in the heading comes from the data of any view, the first eight characters", () => {
    for (const item of ITEMS) expect(sessionIdOf(item)).toBe(REFERENCE_ID);
    expect(shortSessionId(REFERENCE_ID)).toBe("8f3c1a2e");
    expect(shortSessionId("s-0142")).toBe("s-0142");
  });

  test("the \"Back to …\" label for the element being left", () => {
    expect(ITEMS.map(backLabel)).toEqual([
      "session",
      "general-purpose (gp-1)",
      "Bash call",
      "prompt",
      "file",
      "network call",
    ]);
    expect(backLabel({ kind: "agent", data: main })).toBe("Main agent");
  });

  test("dock buttons: left, bottom, right, all the PANEL_DOCKS values", () => {
    expect(DOCK_OPTIONS.map((option) => option.dock)).toEqual(["left", "bottom", "right"]);
    expect(DOCK_OPTIONS.map((option) => option.dock).sort()).toEqual([...PANEL_DOCKS].sort());
    expect(DOCK_OPTIONS.map((option) => option.label)).toEqual(["Dock left", "Dock bottom", "Dock right"]);
  });
});

describe("common labels", () => {
  test("agent name: the main one by name, a subagent by type and id", () => {
    expect(agentName("main", null)).toBe("Main agent");
    expect(agentName("gp-1", "general-purpose")).toBe("general-purpose");
    expect(agentName("a1b2", null)).toBe("a1b2");
    expect(agentLabel("main", null)).toBe("Main agent");
    expect(agentLabel("gp-1", "general-purpose")).toBe("general-purpose · gp-1");
    expect(agentLabel("a1b2", null)).toBe("a1b2");
  });

  test("duration: an estimate is marked with \"~\", an unknown one is a dash", () => {
    expect(durationLabel(4200, true)).toBe("4.2 s");
    expect(durationLabel(4200, false)).toBe("~4.2 s");
    expect(durationLabel(null, false)).toBe("—");
  });

  test("row time: from the session start, without it the time of day", () => {
    expect(rowTime(failedBash.start, START)).toBe("+6:12");
    expect(rowTime(failedBash.start, undefined)).toBe(formatClock(failedBash.start));
  });

  test("size in bytes", () => {
    expect(formatBytes(88268)).toBe("86.2 KB");
    expect(formatBytes(341)).toBe("341 B");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatBytes(null)).toBe("—");
  });

  test("a body shown in part is labeled; a full one has no label", () => {
    expect(bodyNote(original.body)).toBeNull();
    expect(bodyNote({ contentId: 9, bytes: 88268, preview: "x".repeat(BODY_PREVIEW_CHARS), truncated: true })).toBe(
      "First 4,000 characters of 86.2 KB",
    );
  });
});

describe("Agent view", () => {
  test("header: name, model and the number of tool errors", () => {
    expect(agentName(gp1.agentId, gp1.type)).toBe("general-purpose");
    expect(agentTags(gp1)).toEqual([
      { label: "claude-sonnet-4-5", tone: "blue" },
      { label: "4 errors", tone: "red" },
    ]);
    // Without errors there is no error label.
    expect(agentTags(explore)).toEqual([{ label: "claude-haiku-4-5", tone: "blue" }]);
    expect(agentTags({ ...gp1, toolErrors: 1 })[1]?.label).toBe("1 error");
    expect(agentDescription(gp1)).toBe("Rewrite tests with bun test");
    expect(agentDescription(main)).toBe("Top-level agent that received the user prompt.");
  });

  test("Basic information: nine artboard fields, a subagent has a link to its parent", () => {
    const fields = agentFields(gp1);
    expect(fields.map((field) => field.label)).toEqual([
      "ID",
      "Type",
      "Model",
      "Start",
      "End",
      "Duration",
      "API calls",
      "Tokens",
      "Cost",
      "Parent",
    ]);
    const f = byLabel(fields);
    expect(f.ID).toMatchObject({ value: "gp-1", mono: true });
    expect(f.Type?.value).toBe("Subagent · general-purpose");
    expect(f.Start?.value).toBe(formatClock(gp1.startedAt));
    expect(f.End?.value).toBe(formatClock(gp1.endedAt));
    expect(f.Duration?.value).toBe("4m 55s");
    // Failed API attempts are counted separately from tool errors (decision 12).
    expect(f["API calls"]?.value).toBe("34 (1 failed)");
    expect(f.Tokens?.value).toBe("2.26M");
    expect(f.Cost?.value).toBe("$1.52");
    expect(f.Parent).toMatchObject({ value: "Main agent", to: { kind: "agent", id: "main" } });
  });

  test("main agent: type Main, no parent; an unknown cost is a dash", () => {
    const f = byLabel(agentFields(main));
    expect(f.Type?.value).toBe("Main");
    expect(f.Parent).toBeUndefined();
    expect(byLabel(agentFields({ ...main, costUsd: null })).Cost?.value).toBe("—");
    expect(byLabel(agentFields({ ...main, apiErrors: 0 }))["API calls"]?.value).toBe("58");
  });

  test("Context: first call, last and peak as window shares", () => {
    expect(contextWindowAside(gp1)).toBe("of 200K window");
    const stages = contextStages(gp1);
    expect(stages.map((stage) => [stage.label, stage.value])).toEqual([
      ["First call", "16.2K"],
      ["Last call", "104.5K"],
      ["Peak", "112.7K · 56%"],
    ]);
    expect(stages.map((stage) => stage.ratio)).toEqual([0.081, 0.5225, 0.5635]);
    expect(new Set(stages.map((stage) => stage.color)).size).toBe(3);
  });

  test("Context without a known window: values without shares, empty bars", () => {
    const unknown = { ...gp1, ctxWindow: null };
    expect(contextWindowAside(unknown)).toBeUndefined();
    expect(contextStages(unknown).map((stage) => [stage.value, stage.ratio])).toEqual([
      ["16.2K", 0],
      ["104.5K", 0],
      ["112.7K", 0],
    ]);
    expect(contextStages({ ...gp1, ctxPeak: null })[2]).toMatchObject({ value: "—", ratio: 0 });
  });

  test("peak context: four categories, the sum equals the peak, the estimate is marked (plan §9.3)", () => {
    expect(gp1.ctxBreakdown.map((entry) => entry.category)).toEqual([
      "system_tools",
      "instructions",
      "messages",
      "tool_results",
    ]);
    expect(gp1.ctxBreakdown.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(gp1.ctxPeak!);
    expect(breakdownAside(gp1)).toBe("Estimated");
    expect(breakdownAside({ ...gp1, ctxBreakdownExact: true })).toBeUndefined();
  });

  test("Instructions loaded: path, type and a token estimate by file size (plan §9.3)", () => {
    expect(instructionRows(main.instructions)).toEqual([
      { path: "/Users/dev/.claude/CLAUDE.md", kind: "User memory", tokens: "~1.2K tokens" },
      { path: "/Users/dev/code/billing-web/CLAUDE.md", kind: "Project memory", tokens: "~2.4K tokens" },
      {
        path: "/Users/dev/code/billing-web/.claude/skills/openapi-client/SKILL.md",
        kind: "Skill",
        tokens: "~2.1K tokens",
      },
    ]);
  });

  test("Instructions loaded: the load reason from hooks; without size and type, dashes", () => {
    expect(
      instructionRows([
        { path: "/a/CLAUDE.md", memoryType: "Project", loadReason: "nested_traversal", tokensEst: 300, source: "hook" },
        { path: "/b/CLAUDE.md", memoryType: null, loadReason: null, tokensEst: null, source: "hook" },
      ]),
    ).toEqual([
      { path: "/a/CLAUDE.md", kind: "Project memory · nested_traversal", tokens: "~300 tokens" },
      { path: "/b/CLAUDE.md", kind: "—", tokens: "—" },
    ]);
  });

  test("Tool usage: the bar is the share of the most frequent tool, errors next to the number", () => {
    expect(toolUsageAside(gp1)).toBe("49 calls");
    expect(toolUsageAside({ ...gp1, toolCalls: 1 })).toBe("1 call");
    const rows = toolUsageRows(gp1.toolUsage);
    expect(rows.map((row) => [row.name, row.count, row.errors])).toEqual([
      ["Bash", "18", 3],
      ["Edit", "15", 1],
      ["Read", "11", 0],
      ["Write", "5", 0],
    ]);
    expect(rows[0]?.ratio).toBe(1);
    expect(rows[3]?.ratio).toBeCloseTo(5 / 18);
    expect(toolUsageRows([])).toEqual([]);
  });
});

describe("Tool calls list and the \"Errors only\" filter", () => {
  test("without the filter, all calls of the agent by time", () => {
    expect(visibleCalls(gp1.calls, false)).toHaveLength(49);
    expect(visibleCalls(gp1.calls, false)).toEqual(gp1.calls);
  });

  test("with the filter, only calls with an error; their number is in the checkbox label", () => {
    expect(failedCount(gp1.calls)).toBe(4);
    const shown = visibleCalls(gp1.calls, true);
    expect(shown.map((call) => call.id)).toEqual([
      "toolu_gp-1_031",
      "toolu_gp-1_038",
      "toolu_gp-1_043",
      "toolu_gp-1_046",
    ]);
    expect(shown.every((call) => call.status === "error")).toBe(true);
  });

  test("an agent without errors has an empty and explained list under the filter", () => {
    expect(failedCount(explore.calls)).toBe(0);
    expect(visibleCalls(explore.calls, true)).toEqual([]);
    expect(emptyCallsText(true)).toBe("No tool calls failed for this agent.");
    expect(emptyCallsText(false)).toBe("This agent made no tool calls.");
  });

  test("a denial, an interruption and a call without a result do not count as errors (decision 12)", () => {
    const call = gp1.calls[0]!;
    const mixed = (["ok", "error", "denied", "interrupted", "pending"] as const).map((status, index) => ({
      ...call,
      id: `c${index}`,
      status,
    }));
    expect(failedCount(mixed)).toBe(1);
    expect(visibleCalls(mixed, true).map((item) => item.id)).toEqual(["c1"]);
    expect(callRows(mixed, START).map((row) => row.error)).toEqual([false, true, false, false, false]);
  });

  test("rows: time since the session start, target, duration with an estimate mark, error", () => {
    expect(callRows(visibleCalls(gp1.calls, true), START)).toEqual([
      {
        id: "toolu_gp-1_031",
        time: "+11:40",
        name: "Bash",
        detail: "bun test",
        detailMono: true,
        duration: "~18.4 s",
        error: true,
      },
      {
        id: "toolu_gp-1_038",
        time: "+12:22",
        name: "Bash",
        detail: "bun test tests/invoices.test.ts",
        detailMono: true,
        duration: "~6.1 s",
        error: true,
      },
      {
        id: "toolu_gp-1_043",
        time: "+12:48",
        name: "Edit",
        detail: "…/billing-web/tests/setup.ts",
        detailMono: true,
        duration: "~200 ms",
        error: true,
      },
      {
        id: "toolu_gp-1_046",
        time: "+12:55",
        name: "Bash",
        detail: "bun test --watch",
        detailMono: true,
        duration: "~2m 00s",
        error: true,
      },
    ]);
  });

  test("an exact duration has no mark; a call without a result is a dash", () => {
    const exact = main.calls.find((call) => call.durationExact)!;
    expect(callRows([exact], START)[0]?.duration).not.toStartWith("~");
    expect(callRows([{ ...exact, durationMs: null, status: "pending" }], START)[0]?.duration).toBe("—");
  });

  test("call target: a long absolute path is shortened to the last segments", () => {
    expect(rowDetail(SCHEMAS)).toBe("…/api/billing/schemas.ts");
    expect(rowDetail("/tmp/a.ts")).toBe("/tmp/a.ts");
    expect(rowDetail("bun run generate:client")).toBe("bun run generate:client");
    expect(rowDetail("/usr/local/bin/tool --flag /a/b/c/d")).toBe("/usr/local/bin/tool --flag /a/b/c/d");
    expect(rowDetail("https://heyapi.dev/openapi-ts/get-started")).toBe("https://heyapi.dev/openapi-ts/get-started");
    expect(rowDetail(null)).toBe("");
  });
});

describe("Tool call view", () => {
  test("status label: success, error and neutral statuses", () => {
    expect(toolStatusTag("ok")).toEqual({ label: "Success", tone: "green", icon: "success" });
    expect(toolStatusTag("error")).toEqual({ label: "Error", tone: "red", icon: "error" });
    expect(toolStatusTag("denied")).toEqual({ label: "Denied", tone: "gray" });
    expect(toolStatusTag("interrupted")).toEqual({ label: "Interrupted", tone: "gray" });
    expect(toolStatusTag("pending")).toEqual({ label: "Pending", tone: "gray" });
  });

  test("Basic information: six artboard fields with links to the agent and the model call", () => {
    const fields = toolFields(failedBash, START);
    expect(fields.map((field) => field.label)).toEqual([
      "Call ID",
      "Agent",
      "Started",
      "Duration",
      "Model turn",
      "Permission",
    ]);
    const f = byLabel(fields);
    expect(f["Call ID"]).toMatchObject({ value: "toolu_main_009", mono: true });
    expect(f.Agent).toMatchObject({ value: "Main agent", to: { kind: "agent", id: "main" } });
    expect(f.Started?.value).toBe(`${formatClock(failedBash.start)} (+6:12)`);
    expect(f.Duration?.value).toBe("~4.2 s");
    expect(f["Model turn"]).toMatchObject({ value: "#9", to: { kind: "net", net: "model", id: "req_main_009" } });
    expect(f.Permission?.value).toBe("—");
  });

  test("a subagent call names the agent by type and id", () => {
    expect(byLabel(toolFields(tools["toolu_plan-1_008"]!, START)).Agent).toMatchObject({
      value: "Plan · plan-1",
      to: { kind: "agent", id: "plan-1" },
    });
  });

  test("additional fields: changed lines for an edit, the launched agent for an Agent call", () => {
    expect(byLabel(toolFields(edit, START))["Lines changed"]?.value).toBe("+6 −3");
    expect(byLabel(toolFields(spawn, START))["Spawned agent"]).toMatchObject({
      value: "explore-1",
      to: { kind: "agent", id: "explore-1" },
    });
    expect(byLabel(toolFields({ ...edit, mcpServer: "github" }, START))["MCP server"]?.value).toBe("github");
    const bare = byLabel(toolFields({ ...failedBash, turnIndex: null, modelCallId: null }, START));
    expect(bare["Model turn"]?.value).toBe("—");
    expect(bare["Model turn"]?.to).toBeUndefined();
  });

  test("Permission: the decision and its source, without enrichment only a denial (plan §9.3)", () => {
    expect(permissionLabel({ status: "ok", permissionDecision: "accept", permissionSource: "config" })).toBe(
      "Allowed · config",
    );
    expect(permissionLabel({ status: "denied", permissionDecision: "reject", permissionSource: "user_reject" })).toBe(
      "Denied · user_reject",
    );
    expect(permissionLabel({ status: "denied", permissionDecision: null, permissionSource: null })).toBe("Denied");
    expect(permissionLabel({ status: "ok", permissionDecision: null, permissionSource: null })).toBe("—");
    expect(permissionLabel({ status: "ok", permissionDecision: "accept", permissionSource: null })).toBe("Allowed");
  });

  test("error: the heading is the first line of the output, the output block is named Error output", () => {
    expect(toolNotice(failedBash)).toEqual({ title: "$ openapi-ts -i openapi.yaml -o src/api/billing/gen --zod" });
    expect(failedBash.output?.preview.startsWith(toolNotice(failedBash)!.title)).toBe(true);
    expect(toolOutputTitle(failedBash)).toBe("Error output");
    expect(toolNotice({ ...failedBash, errorTitle: null })).toEqual({ title: "Tool call failed" });
  });

  test("a successful call: no message, the output block is named Output, an edit has a file path", () => {
    expect(toolNotice(edit)).toBeNull();
    expect(toolOutputTitle(edit)).toBe("Output");
    expect(edit.filePath).toBe(SCHEMAS);
    expect(failedBash.filePath).toBeNull();
  });
});

describe("User prompt view", () => {
  test("heading by prompt kind", () => {
    expect(promptTitle(original.kind)).toBe("Original prompt");
    expect(promptTitle(followUp.kind)).toBe("Follow-up prompt");
  });

  test("fields: time, token estimate, receiver and attachments", () => {
    const fields = promptFields(original, START);
    expect(fields.map((field) => field.label)).toEqual(["Sent", "Tokens", "Received by", "Attachments"]);
    const f = byLabel(fields);
    expect(f.Sent?.value).toBe(`${formatClock(original.ts)} (+0:00)`);
    expect(f.Tokens?.value).toBe("~86");
    expect(f["Received by"]).toMatchObject({ value: "Main agent", to: { kind: "agent", id: "main" } });
    expect(f.Attachments?.value).toBe("Image #1");
    expect(byLabel(promptFields(followUp, START)).Attachments?.value).toBe("None");
    expect(byLabel(promptFields(followUp, START)).Sent?.value).toBe(`${formatClock(followUp.ts)} (+8:32)`);
  });
});

describe("File view", () => {
  test("operation counters, changed lines and agents", () => {
    expect(fileFields(schemas).map((field) => [field.label, field.value])).toEqual([
      ["Reads", "6"],
      ["Edits", "7"],
      ["Writes", "2"],
      ["Lines changed", "+290 −21"],
      ["Agents", "main, explore-1, plan-1, gp-1, gp-2"],
    ]);
    expect(byLabel(fileFields({ ...schemas, linesAdded: 0, linesRemoved: 0 }))["Lines changed"]?.value).toBe("None");
  });

  test("Operations: the third column is the agent, not the path; a row leads to the tool call", () => {
    const rows = fileOpRows(schemas.ops, START);
    expect(rows).toHaveLength(schemas.ops.length);
    expect(rows[0]).toEqual({
      id: "toolu_main_003",
      time: "+0:43",
      name: "Edit",
      detail: "Main agent",
      detailMono: false,
      duration: "~245 ms",
      error: false,
    });
    expect(new Set(rows.map((row) => row.detail))).toEqual(
      new Set([
        "Main agent",
        "Explore · explore-1",
        "Plan · plan-1",
        "general-purpose · gp-1",
        "general-purpose · gp-2",
      ]),
    );
    for (const row of rows) expect(tools[row.id]).toBeDefined();
  });
});

describe("Network call view (plan §9.3: tokens, latency, stop reason; status only for errors)", () => {
  test("model call: a label without status, the model as a string, fields with tokens", () => {
    expect(networkTags(modelCall)).toEqual([{ label: "Model API", tone: "gray" }]);
    expect(networkSubject(modelCall)).toBe("claude-opus-5-5");
    expect(networkNotice(modelCall)).toBeNull();
    const fields = networkFields(modelCall, START);
    expect(fields.map((field) => field.label)).toEqual([
      "Agent",
      "Started",
      "Latency",
      "Model turn",
      "Input tokens",
      "Output tokens",
      "Cache write",
      "Stop reason",
      "Cost",
      "Request ID",
    ]);
    const f = byLabel(fields);
    expect(f.Agent).toMatchObject({ value: "Main agent", to: { kind: "agent", id: "main" } });
    expect(f.Started?.value).toBe(`${formatClock(modelCall.start)} (+0:00)`);
    // Latency without enrichment is an estimate from the transcript.
    expect(f.Latency?.value).toBe("~7.3 s");
    expect(f["Model turn"]?.value).toBe("#1");
    expect(f["Input tokens"]?.value).toBe("18.4K (11.0K cached)");
    expect(f["Output tokens"]?.value).toBe("306 (92 thinking)");
    expect(f["Cache write"]?.value).toBe("7.3K");
    expect(f["Stop reason"]?.value).toBe("tool_use");
    expect(f.Cost?.value).toBe("$0.09");
    expect(f["Request ID"]).toMatchObject({ value: "req_main_001", mono: true });
    // There are no request and response sizes in bytes.
    expect(f.Request).toBeUndefined();
    expect(f.Response).toBeUndefined();
  });

  test("a model call with exact latency, without thinking and cache writes", () => {
    const f = byLabel(
      networkFields(
        { ...modelCall, durationExact: true, tokThinking: 0, tokCacheWrite1h: 0, costUsd: null, querySource: "sdk" },
        START,
      ),
    );
    expect(f.Latency?.value).toBe("7.3 s");
    expect(f["Output tokens"]?.value).toBe("306");
    expect(f["Cache write"]).toBeUndefined();
    expect(f.Cost?.value).toBe("—");
    expect(f["Query source"]?.value).toBe("sdk");
  });

  test("model response: Thinking and Response blocks, requested calls lead to tools", () => {
    expect(modelCall.messages.map((message) => messageTitle(message.kind))).toEqual(["Thinking", "Response"]);
    const rows = callRows(modelCall.toolCalls, START);
    expect(rows.map((row) => [row.id, row.name, row.detail])).toEqual([["toolu_main_001", "Bash", "bun install"]]);
    expect(tools[rows[0]!.id]).toBeDefined();
  });

  test("a failed attempt with a status: a red label and a retry message", () => {
    expect(networkTags(overloaded)).toEqual([
      { label: "Model API", tone: "gray" },
      { label: "529", tone: "red", icon: "error" },
    ]);
    expect(networkSubject(overloaded)).toBeNull();
    expect(networkNotice(overloaded)).toEqual({
      title: "529 Overloaded",
      subtitle: "Attempt 1 of 10 · retried after 1.2 s",
    });
    expect(networkFields(overloaded, START).map((field) => [field.label, field.value])).toEqual([
      ["Agent", "Main agent"],
      ["Time", `${formatClock(overloaded.ts)} (+9:35)`],
      ["Status", "529"],
      ["Attempt", "1 of 10"],
      ["Retry in", "1.2 s"],
      ["Source", "Transcript"],
    ]);
  });

  test("a failed attempt without a status: the Failed label, a dash in the status field", () => {
    expect(networkTags(connection)[1]).toEqual({ label: "Failed", tone: "red", icon: "error" });
    expect(networkNotice(connection)?.title).toBe("Connection error.");
    const f = byLabel(networkFields(connection, START));
    expect(f.Status).toMatchObject({ value: "—", error: false });
    expect(f.Agent?.value).toBe("Explore · explore-1");
  });

  test("an OTel error: the request id and source; a long text, the first line in the heading", () => {
    const otel: ApiErrorPanel = {
      ...overloaded,
      source: "otel",
      requestId: "req_x",
      attempt: null,
      maxRetries: null,
      retryInMs: null,
      error: '{"type":"error"}\n{"more":true}',
    };
    const f = byLabel(networkFields(otel, START));
    expect(f["Request ID"]).toMatchObject({ value: "req_x", mono: true });
    expect(f.Source?.value).toBe("OpenTelemetry");
    expect(f.Attempt?.value).toBe("—");
    expect(f["Retry in"]?.value).toBe("—");
    expect(networkNotice(otel)).toEqual({ title: '{"type":"error"}', subtitle: undefined });
  });

  test("an external request: kind, response status, address and a link to the tool call", () => {
    expect(networkTags(webFetch)).toEqual([
      { label: "WebFetch", tone: "gray" },
      { label: "200", tone: "green", icon: "success" },
    ]);
    expect(networkSubject(webFetch)).toBe("https://heyapi.dev/openapi-ts/get-started");
    expect(networkNotice(webFetch)).toBeNull();
    const fields = networkFields(webFetch, START);
    expect(fields.map((field) => [field.label, field.value])).toEqual([
      ["Agent", "Plan · plan-1"],
      ["Started", `${formatClock(webFetch.ts)} (+4:47)`],
      ["Latency", "3.5 s"],
      ["Response size", "86.2 KB"],
      ["Triggered by", "WebFetch call"],
    ]);
    expect(byLabel(fields)["Triggered by"]?.to).toEqual({ kind: "tool", id: "toolu_plan-1_008" });
  });

  test("an external request without a structured result and with a response error", () => {
    const unknown: ExternalRequestPanel = { ...webFetch, kind: "web_search", statusCode: null, bytes: null, durationMs: null };
    expect(networkTags(unknown)).toEqual([{ label: "WebSearch", tone: "gray" }]);
    expect(byLabel(networkFields(unknown, START))["Response size"]?.value).toBe("—");
    expect(byLabel(networkFields(unknown, START)).Latency?.value).toBe("—");
    const notFound: ExternalRequestPanel = { ...webFetch, statusCode: 404 };
    expect(networkTags(notFound)[1]).toEqual({ label: "404", tone: "red", icon: "error" });
    expect(networkNotice(notFound)).toEqual({ title: "Request failed with status 404" });
  });
});

describe("Session view", () => {
  test("labels: status and a mark of incomplete enrichment (plan §9.3)", () => {
    expect(sessionTags(session)).toEqual([
      { label: "Completed", tone: "green" },
      { label: "No enrichment", tone: "gray" },
    ]);
    expect(sessionTags(running)).toEqual([
      { label: "Running", tone: "blue" },
      { label: "Partial enrichment", tone: "gray" },
    ]);
    expect(sessionTags({ ...session, enrichment: "full" })).toEqual([{ label: "Completed", tone: "green" }]);
  });

  test("ten artboard fields; Duration is active time, the full interval in the tooltip", () => {
    const fields = sessionFields(session);
    expect(fields.map((field) => field.label)).toEqual([
      "ID",
      "Start",
      "End",
      "Duration",
      "Agents",
      "Model calls",
      "Tool calls",
      "Errors",
      "Tokens",
      "Cost",
    ]);
    const f = byLabel(fields);
    expect(f.ID).toMatchObject({ value: REFERENCE_ID, mono: true });
    expect(f.Start?.value).toBe(formatDateTime(session.startedAt));
    expect(f.End?.value).toBe(formatDateTime(session.endedAt));
    expect(f.Duration).toMatchObject({ value: "18m 36s", title: "Active time; 18m 42s from start to end" });
    expect(f.Agents?.value).toBe("5");
    expect(f["Model calls"]?.value).toBe("142");
    expect(f["Tool calls"]?.value).toBe("186");
    // Tool errors and API errors are not added together (decision 12).
    expect(f.Errors).toMatchObject({ value: "7 tool, 3 API", error: true });
    expect(f.Tokens?.value).toBe("9.54M");
    expect(f.Cost?.value).toBe("$8.48");
  });

  test("a running session: no end, an unknown cost is a dash; without errors the field is not highlighted", () => {
    const f = byLabel(sessionFields(running));
    expect(f.End?.value).toBe("Running");
    expect(f.Cost?.value).toBe("—");
    expect(f.Duration?.title).toEndWith("from start to last event");
    expect(byLabel(sessionFields({ ...session, toolErrors: 0, apiErrors: 0 })).Errors).toMatchObject({
      value: "0",
      error: false,
    });
    expect(byLabel(sessionFields({ ...session, apiErrors: 0 })).Errors?.value).toBe("7");
  });

  test("agent links: the main one first, subagents indented by depth", () => {
    expect(sessionAgentLinks(session).map((link) => [link.agentId, link.label, link.depth])).toEqual([
      ["main", "Main agent", 0],
      ["explore-1", "Explore · explore-1", 1],
      ["plan-1", "Plan · plan-1", 1],
      ["gp-1", "general-purpose · gp-1", 1],
      ["gp-2", "general-purpose · gp-2", 1],
    ]);
    expect(sessionAgentLinks(session)[1]?.description).toBe("Map existing API client usage");
  });
});

describe("transitions between views on the dto fixtures do not lead into emptiness", () => {
  const exists = (field: FieldModel): boolean => {
    const { to } = field;
    if (!to) return true;
    switch (to.kind) {
      case "session":
        return true;
      case "agent":
        return to.id in agents;
      case "tool":
        return to.id in tools;
      case "prompt":
        return to.id in prompts;
      case "file":
        return to.id in files;
      case "net":
        return `${to.net}:${to.id}` in network;
    }
  };

  test("agent: call rows, the peak model call and the parent", () => {
    for (const agent of Object.values(agents)) {
      for (const row of callRows(agent.calls, START)) expect(tools[row.id]).toBeDefined();
      expect(network[`model:${agent.ctxPeakCallId}`]).toBeDefined();
      for (const field of agentFields(agent)) expect(exists(field)).toBe(true);
    }
  });

  test("tool call: the agent, the model call, a file and the launched subagent", () => {
    for (const call of Object.values(tools)) {
      for (const field of toolFields(call, START)) expect(exists(field)).toBe(true);
      if (call.filePath) expect(files[call.filePath]).toBeDefined();
    }
    expect(Object.values(tools).filter((call) => call.spawnedAgentId).map((call) => call.spawnedAgentId)).toEqual([
      "explore-1",
      "plan-1",
      "gp-1",
      "gp-2",
    ]);
  });

  test("prompt, file, network call, and a session", () => {
    for (const prompt of Object.values(prompts)) {
      for (const field of promptFields(prompt, START)) expect(exists(field)).toBe(true);
    }
    for (const file of Object.values(files)) {
      for (const row of fileOpRows(file.ops, START)) expect(tools[row.id]).toBeDefined();
    }
    for (const call of Object.values(network)) {
      for (const field of networkFields(call, START)) expect(exists(field)).toBe(true);
      if (call.net === "model") for (const row of callRows(call.toolCalls, START)) expect(tools[row.id]).toBeDefined();
    }
    for (const link of sessionAgentLinks(session)) expect(agents[link.agentId]).toBeDefined();
  });
});

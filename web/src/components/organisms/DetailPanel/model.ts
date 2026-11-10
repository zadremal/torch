// Detail panel logic without rendering: labels, "label — value" fields, list rows,
// the "Errors only" filter, the "Back to …" button label. Everything the panel shows as text
// is computed here; the components only lay out the ready values.
import type {
  AgentPanel,
  ApiErrorPanel,
  BodyRef,
  CallRow,
  ExternalRequestPanel,
  FileOpEntry,
  FilePanel,
  InstructionEntry,
  ModelCallPanel,
  NetworkPanel,
  PromptPanel,
  SessionOverview,
  ToolCallPanel,
  ToolUsageEntry,
} from "@contracts/api.ts";
import { BODY_PREVIEW_CHARS, MAIN_AGENT_ID, PERMISSION_REJECT } from "@contracts/constants.ts";
import type { ExternalKind, MessageKind, PromptKind, ToolStatus } from "@contracts/rows.ts";
import type { PanelDock, Selection } from "@contracts/selection.ts";
import {
  DASH,
  formatClock,
  formatCount,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatOffset,
  formatPercent,
  formatTokens,
} from "../../../lib/format.ts";
import { CONTEXT_STAGE_COLORS } from "../../../styles/palette.ts";

/** Data of the selected item: the panel view is set by the `kind` field. */
export type DetailPanelData =
  | { kind: "session"; data: SessionOverview }
  | { kind: "agent"; data: AgentPanel }
  | { kind: "tool"; data: ToolCallPanel }
  | { kind: "prompt"; data: PromptPanel }
  | { kind: "file"; data: FilePanel }
  | { kind: "net"; data: NetworkPanel };

/** A "label — value" pair of the Basic information block. */
export interface FieldModel {
  label: string;
  value: string;
  mono?: boolean;
  error?: boolean;
  /** Hover hint. */
  title?: string;
  /** The value is a link to another panel view. */
  to?: Selection;
}

export interface TagModel {
  label: string;
  tone: "red" | "green" | "blue" | "gray";
  icon?: "error" | "success";
}

/** Error message above the body: a tool call or a network call. */
export interface NoticeModel {
  title: string;
  subtitle?: string;
}

/** Call list row: values of the CallRow molecule. */
export interface CallRowModel {
  id: string;
  time: string;
  name: string;
  detail: string;
  detailMono: boolean;
  duration: string;
  error: boolean;
}

// ── Common ──────────────────────────────────────────────────────────────────────────────────

const plural = (count: number, one: string) => `${formatCount(count)} ${count === 1 ? one : `${one}s`}`;

const firstLine = (text: string) => text.split("\n", 1)[0]!.trim();

const agentSelection = (id: string): Selection => ({ kind: "agent", id });

/** Session identifier in the panel header: the first eight characters. */
export function shortSessionId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Identifier of the session the panel data belongs to. */
export function sessionIdOf(item: DetailPanelData): string {
  return item.kind === "session" ? item.data.id : item.data.sessionId;
}

/** The selection the panel data corresponds to. */
export function selectionOf(item: DetailPanelData): Selection {
  switch (item.kind) {
    case "session":
      return { kind: "session" };
    case "agent":
      return { kind: "agent", id: item.data.agentId };
    case "tool":
    case "prompt":
      return { kind: item.kind, id: item.data.id };
    case "file":
      return { kind: "file", id: item.data.path };
    case "net":
      return { kind: "net", net: item.data.net, id: item.data.id };
  }
}

/** Agent name in its panel header. */
export function agentName(agentId: string, type: string | null): string {
  return agentId === MAIN_AGENT_ID ? "Main agent" : (type ?? agentId);
}

/** Agent name in links and list rows: type and identifier. */
export function agentLabel(agentId: string, type: string | null): string {
  if (agentId === MAIN_AGENT_ID) return "Main agent";
  return type ? `${type} · ${agentId}` : agentId;
}

/** Label of the "Back to …" button for the item being left. */
export function backLabel(item: DetailPanelData): string {
  switch (item.kind) {
    case "session":
      return "session";
    case "agent": {
      const { agentId, type } = item.data;
      return agentId === MAIN_AGENT_ID ? "Main agent" : `${agentName(agentId, type)} (${agentId})`;
    }
    case "tool":
      return `${item.data.name} call`;
    case "prompt":
      return "prompt";
    case "file":
      return "file";
    case "net":
      return "network call";
  }
}

/** Dock buttons in artboard order: left, bottom, right. */
export const DOCK_OPTIONS: readonly { dock: PanelDock; label: string }[] = [
  { dock: "left", label: "Dock left" },
  { dock: "bottom", label: "Dock bottom" },
  { dock: "right", label: "Dock right" },
];

/** Duration; a transcript-based estimate is marked with "~" (plan §9.3). */
export function durationLabel(ms: number | null, exact: boolean): string {
  if (ms === null) return DASH;
  return exact ? formatDuration(ms) : `~${formatDuration(ms)}`;
}

/** Time in a list row: since the session start; without a session start — time of day. */
export function rowTime(ts: number, sessionStart: number | undefined): string {
  return sessionStart === undefined ? formatClock(ts) : formatOffset(ts - sessionStart);
}

/** Event time in a field: "14:08:23 (+6:12)". */
function startedLabel(ts: number, sessionStart: number | undefined): string {
  return sessionStart === undefined ? formatClock(ts) : `${formatClock(ts)} (${formatOffset(ts - sessionStart)})`;
}

/** Size in bytes: 88268 → "86.2 KB". */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return DASH;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Context window in whole thousands: 200000 → "200K". */
function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens % 1000 === 0) return `${tokens / 1000}K`;
  return formatTokens(tokens);
}

/** Note under a body that is not shown in full; null if the body arrived in full. */
export function bodyNote(body: BodyRef): string | null {
  return body.truncated ? `First ${formatCount(BODY_PREVIEW_CHARS)} characters of ${formatBytes(body.bytes)}` : null;
}

const linesChanged = (added: number | null, removed: number | null): string | null =>
  added === null && removed === null ? null : `+${added ?? 0} −${removed ?? 0}`;

// ── Call lists ──────────────────────────────────────────────────────────────────────────────

const PATH_SEGMENTS_SHOWN = 3;

/**
 * Third column of a call row. An absolute path is shortened to its last segments: the row
 * is truncated at the end, and with a long path only the root common to all files would otherwise remain.
 */
export function rowDetail(target: string | null): string {
  if (!target) return "";
  if (!/^\/\S+$/.test(target)) return target;
  const segments = target.split("/").filter(Boolean);
  return segments.length > PATH_SEGMENTS_SHOWN ? `…/${segments.slice(-PATH_SEGMENTS_SHOWN).join("/")}` : target;
}

/** An error is only the error status: refused and interrupted are neutral statuses (decision 12). */
const isFailed = (call: Pick<CallRow, "status">): boolean => call.status === "error";

/** Number for the "Errors only (N)" label. */
export function failedCount(calls: readonly CallRow[]): number {
  return calls.filter(isFailed).length;
}

/** The "Errors only" filter. */
export function visibleCalls<T extends CallRow>(calls: readonly T[], errorsOnly: boolean): T[] {
  return errorsOnly ? calls.filter(isFailed) : [...calls];
}

function callRow(call: CallRow, sessionStart: number | undefined, detail: string, detailMono: boolean): CallRowModel {
  return {
    id: call.id,
    time: rowTime(call.start, sessionStart),
    name: call.name,
    detail,
    detailMono,
    duration: durationLabel(call.durationMs, call.durationExact),
    error: isFailed(call),
  };
}

/** Tool calls rows: the third column is the call target. */
export function callRows(calls: readonly CallRow[], sessionStart?: number): CallRowModel[] {
  return calls.map((call) => callRow(call, sessionStart, rowDetail(call.target), true));
}

/** Operations rows of the file panel: the third column is the agent. */
export function fileOpRows(ops: readonly FileOpEntry[], sessionStart?: number): CallRowModel[] {
  return ops.map((op) => callRow(op, sessionStart, agentLabel(op.agentId, op.agentType), false));
}

/** Text of an empty Tool calls list. */
export function emptyCallsText(errorsOnly: boolean): string {
  return errorsOnly ? "No tool calls failed for this agent." : "This agent made no tool calls.";
}

// ── Agent ───────────────────────────────────────────────────────────────────────────────────

export function agentTags(a: AgentPanel): TagModel[] {
  const tags: TagModel[] = [];
  if (a.model) tags.push({ label: a.model, tone: "blue" });
  if (a.toolErrors > 0) tags.push({ label: plural(a.toolErrors, "error"), tone: "red" });
  return tags;
}

export function agentDescription(a: AgentPanel): string | null {
  return a.agentId === MAIN_AGENT_ID ? "Top-level agent that received the user prompt." : a.description;
}

export function agentFields(a: AgentPanel): FieldModel[] {
  const main = a.agentId === MAIN_AGENT_ID;
  const fields: FieldModel[] = [
    { label: "ID", value: a.agentId, mono: true },
    { label: "Type", value: main ? "Main" : `Subagent · ${a.type ?? "unknown"}` },
    { label: "Model", value: a.model ?? DASH, mono: true },
    { label: "Start", value: formatClock(a.startedAt) },
    { label: "End", value: formatClock(a.endedAt) },
    { label: "Duration", value: formatDuration(a.runMs) },
    // API errors are counted separately from tool errors (decision 12).
    { label: "API calls", value: `${formatCount(a.modelCalls)}${a.apiErrors > 0 ? ` (${a.apiErrors} failed)` : ""}` },
    { label: "Tokens", value: formatTokens(a.tokens.total) },
    { label: "Cost", value: formatMoney(a.costUsd) },
  ];
  if (a.parentAgentId !== null) {
    // The panel of an agent does not know the parent's type: the main one is named by name, a nested one by identifier.
    fields.push({ label: "Parent", value: agentLabel(a.parentAgentId, null), to: agentSelection(a.parentAgentId) });
  }
  return fields;
}

export interface ContextStageModel {
  label: string;
  value: string;
  /** Share of the context window, 0…1. */
  ratio: number;
  color: string;
}

/** Agent context: first call, last, peak — shares of the window. */
export function contextStages(a: AgentPanel): ContextStageModel[] {
  const stage = (label: string, tokens: number | null, color: string, withShare: boolean): ContextStageModel => {
    const ratio = tokens !== null && a.ctxWindow ? tokens / a.ctxWindow : null;
    const value = withShare && ratio !== null ? `${formatTokens(tokens)} · ${formatPercent(ratio)}` : formatTokens(tokens);
    return { label, value, ratio: ratio ?? 0, color };
  };
  return [
    stage("First call", a.ctxFirst, CONTEXT_STAGE_COLORS.first, false),
    stage("Last call", a.ctxLast, CONTEXT_STAGE_COLORS.last, false),
    stage("Peak", a.ctxPeak, CONTEXT_STAGE_COLORS.peak, true),
  ];
}

export function contextWindowAside(a: AgentPanel): string | undefined {
  return a.ctxWindow === null ? undefined : `of ${formatWindow(a.ctxWindow)} window`;
}

/** Context breakdown at the peak — an estimate until there is an exact source (decision 16). */
export function breakdownAside(a: AgentPanel): string | undefined {
  return a.ctxBreakdownExact ? undefined : "Estimated";
}

const MEMORY_LABELS: Record<string, string> = {
  User: "User memory",
  Project: "Project memory",
  Local: "Local memory",
};

export interface InstructionRowModel {
  path: string;
  kind: string;
  tokens: string;
}

/** Instructions loaded: path, type and a token estimate from the file size (plan §9.3). */
export function instructionRows(instructions: readonly InstructionEntry[]): InstructionRowModel[] {
  return instructions.map((entry) => {
    const type = entry.memoryType ? (MEMORY_LABELS[entry.memoryType] ?? entry.memoryType) : null;
    return {
      path: entry.path,
      kind: [type, entry.loadReason].filter(Boolean).join(" · ") || DASH,
      tokens: entry.tokensEst === null ? DASH : `~${formatTokens(entry.tokensEst)} tokens`,
    };
  });
}

export interface ToolUsageRowModel {
  name: string;
  count: string;
  errors: number;
  /** Share of the most frequent tool, 0…1. */
  ratio: number;
}

export function toolUsageRows(usage: readonly ToolUsageEntry[]): ToolUsageRowModel[] {
  const max = Math.max(1, ...usage.map((entry) => entry.count));
  return usage.map((entry) => ({
    name: entry.name,
    count: formatCount(entry.count),
    errors: entry.errors,
    ratio: entry.count / max,
  }));
}

export const toolUsageAside = (a: AgentPanel): string => plural(a.toolCalls, "call");

// ── Tool call ───────────────────────────────────────────────────────────────────────────────

export function toolStatusTag(status: ToolStatus): TagModel {
  switch (status) {
    case "ok":
      return { label: "Success", tone: "green", icon: "success" };
    case "error":
      return { label: "Error", tone: "red", icon: "error" };
    case "denied":
      return { label: "Denied", tone: "gray" };
    case "interrupted":
      return { label: "Interrupted", tone: "gray" };
    case "pending":
      return { label: "Pending", tone: "gray" };
  }
}

const PERMISSION_LABELS: Record<string, string> = { accept: "Allowed", [PERMISSION_REJECT]: "Denied" };

/**
 * Permission decision and its source: "Allowed · config". The rule name is in none of the
 * sources; without enrichment only a denial is known (plan §9.3).
 */
export function permissionLabel(t: Pick<ToolCallPanel, "status" | "permissionDecision" | "permissionSource">): string {
  const decision = t.permissionDecision
    ? (PERMISSION_LABELS[t.permissionDecision] ?? t.permissionDecision)
    : t.status === "denied"
      ? "Denied"
      : null;
  if (decision === null) return DASH;
  return t.permissionSource ? `${decision} · ${t.permissionSource}` : decision;
}

export function toolFields(t: ToolCallPanel, sessionStart?: number): FieldModel[] {
  const fields: FieldModel[] = [
    { label: "Call ID", value: t.id, mono: true },
    { label: "Agent", value: agentLabel(t.agentId, t.agentType), to: agentSelection(t.agentId) },
    { label: "Started", value: startedLabel(t.start, sessionStart) },
    { label: "Duration", value: durationLabel(t.durationMs, t.durationExact) },
    {
      label: "Model turn",
      value: t.turnIndex === null ? DASH : `#${t.turnIndex}`,
      to: t.modelCallId === null ? undefined : { kind: "net", net: "model", id: t.modelCallId },
    },
    { label: "Permission", value: permissionLabel(t) },
  ];
  if (t.mcpServer) fields.push({ label: "MCP server", value: t.mcpServer, mono: true });
  const lines = linesChanged(t.linesAdded, t.linesRemoved);
  if (lines) fields.push({ label: "Lines changed", value: lines });
  if (t.spawnedAgentId) {
    fields.push({ label: "Spawned agent", value: t.spawnedAgentId, to: agentSelection(t.spawnedAgentId) });
  }
  return fields;
}

/** Call error title — the first line of the output; a call without an error has no message. */
export function toolNotice(t: ToolCallPanel): NoticeModel | null {
  return t.status === "error" ? { title: t.errorTitle || "Tool call failed" } : null;
}

export const toolOutputTitle = (t: ToolCallPanel): string => (t.status === "error" ? "Error output" : "Output");

// ── Prompt ──────────────────────────────────────────────────────────────────────────────────

export const promptTitle = (kind: PromptKind): string => (kind === "original" ? "Original prompt" : "Follow-up prompt");

export function promptFields(p: PromptPanel, sessionStart?: number): FieldModel[] {
  return [
    { label: "Sent", value: startedLabel(p.ts, sessionStart) },
    { label: "Tokens", value: `~${formatTokens(p.tokensEst)}` },
    // Only prompts of the main file get into `prompts`: the main agent receives them.
    { label: "Received by", value: agentLabel(MAIN_AGENT_ID, null), to: agentSelection(MAIN_AGENT_ID) },
    { label: "Attachments", value: p.attachments.length > 0 ? p.attachments.join(", ") : "None" },
  ];
}

// ── File ────────────────────────────────────────────────────────────────────────────────────

export function fileFields(f: FilePanel): FieldModel[] {
  return [
    { label: "Reads", value: formatCount(f.reads) },
    { label: "Edits", value: formatCount(f.edits) },
    { label: "Writes", value: formatCount(f.writes) },
    { label: "Lines changed", value: f.linesAdded + f.linesRemoved > 0 ? `+${f.linesAdded} −${f.linesRemoved}` : "None" },
    { label: "Agents", value: f.agents.join(", ") },
  ];
}

// ── Network call ────────────────────────────────────────────────────────────────────────────

const EXTERNAL_LABELS: Record<ExternalKind, string> = { web_fetch: "WebFetch", web_search: "WebSearch" };

const HTTP_ERROR_FROM = 400;

/** Header labels: call kind and status. Status exists only for errors and external requests (plan §9.3). */
export function networkTags(n: NetworkPanel): TagModel[] {
  switch (n.net) {
    case "model":
      return [{ label: "Model API", tone: "gray" }];
    case "error":
      return [
        { label: "Model API", tone: "gray" },
        { label: n.statusCode === null ? "Failed" : String(n.statusCode), tone: "red", icon: "error" },
      ];
    case "external": {
      const tags: TagModel[] = [{ label: EXTERNAL_LABELS[n.kind], tone: "gray" }];
      if (n.statusCode !== null) {
        tags.push(
          n.statusCode >= HTTP_ERROR_FROM
            ? { label: String(n.statusCode), tone: "red", icon: "error" }
            : { label: String(n.statusCode), tone: "green", icon: "success" },
        );
      }
      return tags;
    }
  }
}

/** Line under the labels: call model, address or search query text. */
export function networkSubject(n: NetworkPanel): string | null {
  switch (n.net) {
    case "model":
      return n.model;
    case "error":
      return null;
    case "external":
      return n.url;
  }
}

function modelCallFields(n: ModelCallPanel, sessionStart: number | undefined): FieldModel[] {
  const cacheWrite = n.tokCacheWrite5m + n.tokCacheWrite1h;
  const fields: FieldModel[] = [
    { label: "Agent", value: agentLabel(n.agentId, n.agentType), to: agentSelection(n.agentId) },
    { label: "Started", value: startedLabel(n.start, sessionStart) },
    { label: "Latency", value: durationLabel(n.durationMs, n.durationExact) },
    { label: "Model turn", value: `#${n.turnIndex}` },
    { label: "Input tokens", value: `${formatTokens(n.ctxTokens)} (${formatTokens(n.tokCacheRead)} cached)` },
    {
      label: "Output tokens",
      value: `${formatTokens(n.tokOutput)}${n.tokThinking > 0 ? ` (${formatTokens(n.tokThinking)} thinking)` : ""}`,
    },
  ];
  if (cacheWrite > 0) fields.push({ label: "Cache write", value: formatTokens(cacheWrite) });
  fields.push(
    { label: "Stop reason", value: n.stopReason ?? DASH },
    { label: "Cost", value: formatMoney(n.costUsd) },
    { label: "Request ID", value: n.id, mono: true },
  );
  if (n.querySource) fields.push({ label: "Query source", value: n.querySource });
  return fields;
}

const EVENT_SOURCE_LABELS: Record<ApiErrorPanel["source"], string> = { transcript: "Transcript", otel: "OpenTelemetry" };

const attemptLabel = (n: ApiErrorPanel): string | null =>
  n.attempt === null ? null : n.maxRetries === null ? String(n.attempt) : `${n.attempt} of ${n.maxRetries}`;

function apiErrorFields(n: ApiErrorPanel, sessionStart: number | undefined): FieldModel[] {
  const fields: FieldModel[] = [
    { label: "Agent", value: agentLabel(n.agentId, n.agentType), to: agentSelection(n.agentId) },
    { label: "Time", value: startedLabel(n.ts, sessionStart) },
    { label: "Status", value: n.statusCode === null ? DASH : String(n.statusCode), error: n.statusCode !== null },
    { label: "Attempt", value: attemptLabel(n) ?? DASH },
    { label: "Retry in", value: formatDuration(n.retryInMs) },
  ];
  if (n.requestId) fields.push({ label: "Request ID", value: n.requestId, mono: true });
  fields.push({ label: "Source", value: EVENT_SOURCE_LABELS[n.source] });
  return fields;
}

function externalFields(n: ExternalRequestPanel, sessionStart: number | undefined): FieldModel[] {
  return [
    { label: "Agent", value: agentLabel(n.agentId, n.agentType), to: agentSelection(n.agentId) },
    { label: "Started", value: startedLabel(n.ts, sessionStart) },
    { label: "Latency", value: formatDuration(n.durationMs) },
    { label: "Response size", value: formatBytes(n.bytes) },
    { label: "Triggered by", value: `${EXTERNAL_LABELS[n.kind]} call`, to: { kind: "tool", id: n.toolCallId } },
  ];
}

/** Network call fields: tokens, latency, stop reason; there are no sizes in bytes (plan §9.3). */
export function networkFields(n: NetworkPanel, sessionStart?: number): FieldModel[] {
  switch (n.net) {
    case "model":
      return modelCallFields(n, sessionStart);
    case "error":
      return apiErrorFields(n, sessionStart);
    case "external":
      return externalFields(n, sessionStart);
  }
}

export function networkNotice(n: NetworkPanel): NoticeModel | null {
  if (n.net === "error") {
    const attempt = attemptLabel(n);
    const parts = [
      attempt && `Attempt ${attempt}`,
      n.retryInMs !== null && `retried after ${formatDuration(n.retryInMs)}`,
    ].filter(Boolean);
    return { title: firstLine(n.error) || "Request failed", subtitle: parts.join(" · ") || undefined };
  }
  if (n.net === "external" && n.statusCode !== null && n.statusCode >= HTTP_ERROR_FROM) {
    return { title: `Request failed with status ${n.statusCode}` };
  }
  return null;
}

/** Title of the block with the model response text. */
export const messageTitle = (kind: MessageKind): string => (kind === "thinking" ? "Thinking" : "Response");

// ── Session ─────────────────────────────────────────────────────────────────────────────────

/** Status (Running or Completed) and the enrichment note if it is incomplete (plan §9.3). */
export function sessionTags(s: SessionOverview): TagModel[] {
  const tags: TagModel[] = [
    s.status === "running" ? { label: "Running", tone: "blue" } : { label: "Completed", tone: "green" },
  ];
  if (s.enrichment === "none") tags.push({ label: "No enrichment", tone: "gray" });
  if (s.enrichment === "partial") tags.push({ label: "Partial enrichment", tone: "gray" });
  return tags;
}

export function sessionFields(s: SessionOverview): FieldModel[] {
  const running = s.status === "running";
  const span = s.startedAt !== null && s.endedAt !== null ? formatDuration(s.endedAt - s.startedAt) : null;
  const errors = s.apiErrors > 0 ? `${s.toolErrors} tool, ${s.apiErrors} API` : formatCount(s.toolErrors);
  return [
    { label: "ID", value: s.id, mono: true },
    { label: "Start", value: formatDateTime(s.startedAt) },
    { label: "End", value: running ? "Running" : formatDateTime(s.endedAt) },
    {
      label: "Duration",
      value: formatDuration(s.activeMs),
      // Active time; the full interval is in the hint (plan §9.3).
      title: span ? `Active time; ${span} from start to ${running ? "last event" : "end"}` : "Active time",
    },
    { label: "Agents", value: formatCount(s.agentsCount) },
    { label: "Model calls", value: formatCount(s.modelCalls) },
    { label: "Tool calls", value: formatCount(s.toolCalls) },
    { label: "Errors", value: errors, error: s.toolErrors + s.apiErrors > 0 },
    { label: "Tokens", value: formatTokens(s.tokens.total) },
    { label: "Cost", value: formatMoney(s.costUsd) },
  ];
}

export interface AgentLinkModel {
  agentId: string;
  label: string;
  /** Nesting depth: link indent. */
  depth: number;
  description: string | null;
}

/** Links to the session's agents in server order: the main one first, nested ones after their parent. */
export function sessionAgentLinks(s: SessionOverview): AgentLinkModel[] {
  return s.agents.map((a) => ({
    agentId: a.agentId,
    label: agentLabel(a.agentId, a.type),
    depth: a.depth,
    description: a.description,
  }));
}

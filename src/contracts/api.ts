// DTO of each API route (plan §8). The server and the UI import these types rather than describing
// them again. Fields are camelCase; time is epoch milliseconds, UTC; null means "unknown", not zero.
// Route paths are the API_ROUTES constant at the end of the file.

import type {
  AgentRow,
  ApiErrorRow,
  CompactionRow,
  Enrichment,
  EventSource,
  ExternalKind,
  ExternalRequestRow,
  FileOp,
  FileOpRow,
  InstructionLoadedRow,
  InstructionSource,
  MessageKind,
  MessageRow,
  ModelCallRow,
  NameSource,
  PromptKind,
  PromptRow,
  SessionRow,
  SessionStatus,
  ToolCallRow,
  ToolStatus,
} from "./rows.ts";

// ── Common ──────────────────────────────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Included in output. */
  thinking: number;
  /** input + output + cacheRead + cacheWrite. */
  total: number;
}

/** A reference to a body in `contents`: the start of the text right away, the whole body via GET /api/contents/:id. */
export interface BodyRef {
  contentId: number;
  bytes: number;
  /** The first BODY_PREVIEW_CHARS characters. */
  preview: string;
  truncated: boolean;
}

/** A row of the tool call list in the agent panel and the file panel. */
export interface CallRow {
  id: string;
  agentId: string;
  name: string;
  target: string | null;
  start: number;
  durationMs: number | null;
  durationExact: boolean;
  status: ToolStatus;
}

// ── Prices ──────────────────────────────────────────────────────────────────────────────────

/** Prices in dollars per million tokens, by token kind. */
export interface TokenPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** A model's prices and the size of its context window. */
export interface ModelPrice extends TokenPrices {
  contextWindow: number;
  /** Prices for a call whose prompt (input + cache read and write) is larger than `overTokens`. */
  longContext?: TokenPrices & { overTokens: number };
}

/** Format of `prices.default.json` and `~/.torch/prices.json`. */
export interface PriceTable {
  /** Address of the documentation page the prices were taken from. */
  source: string;
  /** Date the prices were captured, YYYY-MM-DD. */
  updated: string;
  /** Known window sizes in ascending order: an agent's window is raised to the next of them. */
  contextWindows: number[];
  /** The key is the model identifier without the date suffix. */
  models: Record<string, ModelPrice>;
}

// ── GET /api/sessions ───────────────────────────────────────────────────────────────────────

export type AgentsBucket = "any" | "one" | "few" | "many";
export type SessionSortKey = "name" | "started" | "duration" | "agents" | "tokens" | "toolCalls" | "errors" | "cost";
export type SortDir = "asc" | "desc";

/** List request parameters. All are optional; in the address they are strings with the same names. */
export interface SessionsQuery {
  /** Substring of the session name, case-insensitive. */
  q?: string;
  agents?: AgentsBucket;
  tcMin?: number;
  tcMax?: number;
  erMin?: number;
  erMax?: number;
  /** Total tokens, in thousands. */
  tkMin?: number;
  tkMax?: number;
  project?: string;
  /** true — also show sessions from temporary directories. Default false. */
  temp?: boolean;
  /** Default is started. */
  sort?: SessionSortKey;
  /** Default is desc. */
  dir?: SortDir;
  /** From 1. */
  page?: number;
}

export interface SessionListItem {
  id: string;
  name: string;
  project: string | null;
  isTempDir: boolean;
  status: SessionStatus;
  startedAt: number | null;
  /** Active time (decision 30). */
  activeMs: number;
  agents: number;
  tokens: number;
  toolCalls: number;
  /** Tool calls that ended with an error (decision 12). */
  errors: number;
  costUsd: number | null;
}

export interface SessionsResponse {
  items: SessionListItem[];
  /** How many sessions match the filters. */
  total: number;
  /** How many sessions in total with the same `temp` value, without the other filters. */
  totalAll: number;
  page: number;
  pageSize: number;
}

// ── GET /api/projects ───────────────────────────────────────────────────────────────────────

/** Request parameter: `temp`, as in the session list. */
export interface ProjectsResponse {
  projects: { name: string; sessions: number }[];
}

// ── GET /api/sessions/:id ───────────────────────────────────────────────────────────────────

export interface PromptSummary {
  id: string;
  ts: number;
  kind: PromptKind;
  text: string;
  tokensEst: number;
  attachments: string[];
}

export interface ToolUsageEntry {
  name: string;
  count: number;
  errors: number;
}

export interface AgentSummary {
  agentId: string;
  parentAgentId: string | null;
  depth: number;
  /** null for the main agent. */
  type: string | null;
  description: string | null;
  model: string | null;
  ctxPeak: number | null;
  ctxWindow: number | null;
  runMs: number;
  toolCalls: number;
  toolErrors: number;
  apiErrors: number;
  filesRead: number;
  /** In descending order of call count. */
  toolUsage: ToolUsageEntry[];
}

/** A tool call that ended with an error: a row of the overview's Errors list. */
export interface ToolErrorEntry {
  /** Tool call identifier: the selection `tool:<id>` opens it in the details panel. */
  id: string;
  agentId: string;
  name: string;
  target: string | null;
  ts: number;
  /** First line of the error output; null if the call recorded none. */
  errorTitle: string | null;
}

/** Session overview; also the data of the "Session" view of the details panel. */
export interface SessionOverview {
  id: string;
  name: string;
  nameSource: NameSource | null;
  project: string | null;
  cwd: string | null;
  isTempDir: boolean;
  status: SessionStatus;
  enrichment: Enrichment;
  transcriptPresent: boolean;
  primaryModel: string | null;
  ccVersion: string | null;
  gitBranch: string | null;
  startedAt: number | null;
  endedAt: number | null;
  activeMs: number;
  modelMs: number;
  modelMsExact: boolean;
  tokens: TokenTotals;
  agentsCount: number;
  modelCalls: number;
  toolCalls: number;
  toolErrors: number;
  apiErrors: number;
  costUsd: number | null;
  /** The ready-made total from the transcript, if there is one (decision 8). */
  costReportedUsd: number | null;
  /** Context window of the main agent. */
  contextWindow: number | null;
  /** By time; the first is original. */
  prompts: PromptSummary[];
  /** The main agent first, nested ones right after their parent. */
  agents: AgentSummary[];
  /** Tool calls with the error status by time: as many as `toolErrors`. */
  toolErrorList: ToolErrorEntry[];
}

// ── GET /api/sessions/:id/export ────────────────────────────────────────────────────────────

/** A normalized session: database rows as is. Bodies are not embedded, except the text of prompts. */
export interface SessionExport {
  exportedAt: number;
  session: SessionRow;
  agents: AgentRow[];
  prompts: (PromptRow & { text: string })[];
  modelCalls: ModelCallRow[];
  toolCalls: ToolCallRow[];
  fileOps: FileOpRow[];
  externalRequests: ExternalRequestRow[];
  apiErrors: ApiErrorRow[];
  messages: MessageRow[];
  compactions: CompactionRow[];
  instructions: InstructionLoadedRow[];
}

// ── GET /api/sessions/:id/timeline ──────────────────────────────────────────────────────────

/** A collapsed idle stretch: longer than IDLE_GAP_MS and with no running calls. */
export interface TimelineGap {
  start: number;
  end: number;
}

export interface TimelinePrompt {
  id: string;
  ts: number;
  kind: PromptKind;
}

export interface TimelineAgent {
  agentId: string;
  parentAgentId: string | null;
  depth: number;
  type: string | null;
  description: string | null;
  model: string | null;
  start: number;
  end: number;
  toolCalls: number;
  toolErrors: number;
}

export interface TimelineTool {
  id: string;
  agentId: string;
  name: string;
  target: string | null;
  start: number;
  /** null for a call without a result. */
  durationMs: number | null;
  status: ToolStatus;
}

export interface TimelineFileOp {
  toolCallId: string;
  agentId: string;
  path: string;
  op: FileOp;
  ts: number;
  /** The tool call ended with an error. */
  error: boolean;
}

export interface TimelineModelCall {
  id: string;
  agentId: string;
  start: number;
  durationMs: number;
}

export interface TimelineApiError {
  id: string;
  agentId: string;
  ts: number;
}

export interface TimelineExternal {
  /** Equals the tool call identifier. */
  id: string;
  agentId: string;
  kind: ExternalKind;
  ts: number;
  durationMs: number | null;
  /** Response status 400 and above, or a tool call error. */
  error: boolean;
}

/** Six tracks (Session, Prompts, Agents, Tools, Files, Network) and the map of gaps. */
export interface TimelineResponse {
  session: {
    id: string;
    name: string;
    status: SessionStatus;
    startedAt: number;
    endedAt: number;
    activeMs: number;
    modelCalls: number;
    toolCalls: number;
    toolErrors: number;
    apiErrors: number;
  };
  gaps: TimelineGap[];
  prompts: TimelinePrompt[];
  agents: TimelineAgent[];
  tools: TimelineTool[];
  files: TimelineFileOp[];
  /** Network: Model API calls, their failed attempts and external requests. */
  modelCalls: TimelineModelCall[];
  apiErrors: TimelineApiError[];
  external: TimelineExternal[];
}

// ── Details panel ───────────────────────────────────────────────────────────────────────────

export type ContextCategory = "system_tools" | "instructions" | "messages" | "tool_results";

export interface ContextBreakdownEntry {
  category: ContextCategory;
  tokens: number;
}

export interface InstructionEntry {
  path: string;
  memoryType: string | null;
  loadReason: string | null;
  tokensEst: number | null;
  source: InstructionSource;
}

/** GET /api/sessions/:id/agents/:agentId */
export interface AgentPanel {
  sessionId: string;
  agentId: string;
  parentAgentId: string | null;
  depth: number;
  type: string | null;
  description: string | null;
  model: string | null;
  startedAt: number | null;
  endedAt: number | null;
  runMs: number;
  modelCalls: number;
  apiErrors: number;
  toolCalls: number;
  toolErrors: number;
  tokens: TokenTotals;
  costUsd: number | null;
  prompt: BodyRef | null;
  ctxWindow: number | null;
  ctxFirst: number | null;
  ctxLast: number | null;
  ctxPeak: number | null;
  ctxPeakCallId: string | null;
  /** The sum of the categories equals ctxPeak. */
  ctxBreakdown: ContextBreakdownEntry[];
  /** false — an estimate, shown with the "Estimated" label (decision 16). */
  ctxBreakdownExact: boolean;
  instructions: InstructionEntry[];
  toolUsage: ToolUsageEntry[];
  /** All tool calls of the agent by time. */
  calls: CallRow[];
}

/** GET /api/sessions/:id/tool-calls/:callId */
export interface ToolCallPanel {
  sessionId: string;
  id: string;
  agentId: string;
  agentType: string | null;
  name: string;
  mcpServer: string | null;
  target: string | null;
  status: ToolStatus;
  errorTitle: string | null;
  start: number;
  durationMs: number | null;
  durationExact: boolean;
  /** Sequence number of the model call within the agent. */
  turnIndex: number | null;
  modelCallId: string | null;
  /** The decision and its source; both null without enrichment and without a denial. */
  permissionDecision: string | null;
  permissionSource: string | null;
  spawnedAgentId: string | null;
  input: BodyRef | null;
  output: BodyRef | null;
  /** File path of Read, Edit and Write: a link to the file panel. */
  filePath: string | null;
  linesAdded: number | null;
  linesRemoved: number | null;
}

/** GET /api/sessions/:id/prompts/:promptId */
export interface PromptPanel {
  sessionId: string;
  id: string;
  kind: PromptKind;
  ts: number;
  tokensEst: number;
  attachments: string[];
  body: BodyRef;
}

export interface FileOpEntry extends CallRow {
  op: FileOp;
  agentType: string | null;
  linesAdded: number | null;
  linesRemoved: number | null;
}

/** GET /api/sessions/:id/files?path= */
export interface FilePanel {
  sessionId: string;
  path: string;
  reads: number;
  edits: number;
  writes: number;
  linesAdded: number;
  linesRemoved: number;
  /** Identifiers of the agents that worked with the file. */
  agents: string[];
  ops: FileOpEntry[];
}

export type NetworkKind = "model" | "error" | "external";

export interface ModelCallPanel {
  net: "model";
  sessionId: string;
  id: string;
  agentId: string;
  agentType: string | null;
  model: string;
  start: number;
  durationMs: number;
  /** false — the latency is estimated from the transcript. */
  durationExact: boolean;
  stopReason: string | null;
  turnIndex: number;
  querySource: string | null;
  tokInput: number;
  tokOutput: number;
  tokCacheRead: number;
  tokCacheWrite5m: number;
  tokCacheWrite1h: number;
  tokThinking: number;
  ctxTokens: number;
  costUsd: number | null;
  /** The response text and thinking. */
  messages: { kind: MessageKind; body: BodyRef }[];
  /** Tool calls requested by this response. */
  toolCalls: CallRow[];
}

export interface ApiErrorPanel {
  net: "error";
  sessionId: string;
  id: string;
  agentId: string;
  agentType: string | null;
  ts: number;
  requestId: string | null;
  statusCode: number | null;
  error: string;
  attempt: number | null;
  maxRetries: number | null;
  retryInMs: number | null;
  source: EventSource;
}

export interface ExternalRequestPanel {
  net: "external";
  sessionId: string;
  /** Equals the tool call identifier. */
  id: string;
  agentId: string;
  agentType: string | null;
  toolCallId: string;
  kind: ExternalKind;
  url: string | null;
  statusCode: number | null;
  bytes: number | null;
  durationMs: number | null;
  ts: number;
}

/** GET /api/sessions/:id/network/:kind/:netId */
export type NetworkPanel = ModelCallPanel | ApiErrorPanel | ExternalRequestPanel;

/** GET /api/contents/:id — the body as unpacked text. */
export interface ContentResponse {
  id: number;
  bytes: number;
  text: string;
}

// ── GET /api/dashboard ──────────────────────────────────────────────────────────────────────

export type DashboardRange = "day" | "week" | "month" | "year" | "custom";
export type DashboardBucket = "hours" | "day" | "month";

export interface DashboardQuery {
  /** Default is week. */
  range?: DashboardRange;
  /** For custom: dates in local time, YYYY-MM-DD, inclusive. */
  from?: string;
  to?: string;
  temp?: boolean;
}

/** The value for the window and for the previous window of the same length. */
export interface Metric {
  value: number;
  prev: number;
}

export interface SeriesPoint {
  /** Start of the column. */
  start: number;
  value: number;
}

export interface LeaderboardItem {
  sessionId: string;
  name: string;
  project: string | null;
  value: number;
}

export interface DashboardResponse {
  range: DashboardRange;
  /** The window [from, to) in the machine's local time and the previous window of the same length. */
  from: number;
  to: number;
  prevFrom: number;
  prevTo: number;
  bucket: DashboardBucket;
  totals: {
    sessions: Metric;
    modelCalls: Metric;
    toolCalls: Metric;
    tokens: Metric;
    /** Cost of sessions with a known cost. */
    costUsd: Metric;
    /** Tool calls that ended with an error. */
    errors: Metric;
  };
  series: {
    modelCalls: SeriesPoint[];
    toolCalls: SeriesPoint[];
  };
  tokenMix: TokenTotals;
  /** Five top lists, each no longer than LEADERBOARD_SIZE. */
  top: {
    cost: LeaderboardItem[];
    duration: LeaderboardItem[];
    tokens: LeaderboardItem[];
    toolCalls: LeaderboardItem[];
    errors: LeaderboardItem[];
  };
  /** In descending order of call count. */
  tools: { name: string; calls: number; errors: number }[];
  models: { model: string; calls: number; tokens: number; costUsd: number | null }[];
}

// ── GET, PUT /api/settings ──────────────────────────────────────────────────────────────────

export interface ChannelState {
  /** The channel is configured in Claude Code's settings.json. */
  configured: boolean;
  lastEventAt: number | null;
}

export interface SettingsResponse {
  prices: PriceTable;
  paths: {
    dataDir: string;
    db: string;
    transcripts: string;
    desktopSessions: string;
    spool: string;
    claudeSettings: string;
  };
  channels: {
    otel: ChannelState;
    hooks: ChannelState;
  };
  /** `cleanupPeriodDays` from settings.json; null if not set. */
  cleanupPeriodDays: number | null;
}

/** Body of PUT /api/settings. After saving, the cost is recalculated; the response is the updated SettingsResponse. */
export interface SettingsUpdate {
  prices: PriceTable;
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────

/** Route paths in Hono notation. The server registers them in src/api/routes.ts, the client builds addresses from them. */
export const API_ROUTES = {
  dashboard: "/api/dashboard",
  sessions: "/api/sessions",
  projects: "/api/projects",
  session: "/api/sessions/:id",
  sessionExport: "/api/sessions/:id/export",
  timeline: "/api/sessions/:id/timeline",
  agent: "/api/sessions/:id/agents/:agentId",
  toolCall: "/api/sessions/:id/tool-calls/:callId",
  prompt: "/api/sessions/:id/prompts/:promptId",
  file: "/api/sessions/:id/files",
  network: "/api/sessions/:id/network/:kind/:netId",
  content: "/api/contents/:id",
  events: "/api/events",
  settings: "/api/settings",
  otlpLogs: "/otlp/v1/logs",
  otlpMetrics: "/otlp/v1/metrics",
} as const;

export type ApiRouteName = keyof typeof API_ROUTES;

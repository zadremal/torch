// Session overview logic without rendering: tile values, Token usage series, agent order,
// header captions and the downloaded file name. Everything the screen shows as text is computed here.
import type { AgentSummary, PromptSummary, SessionOverview, TokenTotals } from "@contracts/api.ts";
import {
  DASH,
  formatClock,
  formatCount,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatPercent,
  formatTokens,
} from "../../lib/format.ts";
import { TOKEN_COLORS } from "../../styles/palette.ts";

export interface TileModel {
  label: string;
  value: string;
  helper?: string;
  error?: boolean;
}

/** Six totals tiles, in artboard order. */
export function summaryTiles(s: SessionOverview): TileModel[] {
  const subagents = s.agentsCount - 1;
  return [
    {
      label: "Duration",
      value: formatDuration(s.activeMs),
      // Without exact marks the model time is an estimate (plan §9.3).
      helper: `${s.modelMsExact ? "" : "~"}${formatDuration(s.modelMs)} of model time`,
    },
    {
      label: "Total tokens",
      value: formatTokens(s.tokens.total),
      helper: s.tokens.total > 0 ? `${formatPercent(s.tokens.cacheRead / s.tokens.total)} served from cache` : undefined,
    },
    {
      label: "Errors",
      value: formatCount(s.toolErrors),
      error: s.toolErrors > 0,
      helper:
        s.toolCalls > 0
          ? `${formatPercent(s.toolErrors / s.toolCalls, 1)} of ${formatCount(s.toolCalls)} tool calls`
          : undefined,
    },
    {
      label: "Agents",
      value: formatCount(s.agentsCount),
      helper: `1 main, ${subagents} ${subagents === 1 ? "subagent" : "subagents"}`,
    },
    { label: "Model calls", value: formatCount(s.modelCalls), helper: `${formatCount(s.toolCalls)} tool calls` },
    {
      label: "Cost",
      value: formatMoney(s.costUsd),
      // An unknown model is a dash with a note (plan §9.3).
      helper: s.costUsd === null ? "Unknown model price" : "Estimated at list prices",
    },
  ];
}

export interface TokenCardModel {
  label: string;
  value: string;
  note: string;
  color: string;
}

/** Four cards under the Token usage bar; shares are of the total number of tokens. */
export function tokenCards(t: TokenTotals): TokenCardModel[] {
  const share = (n: number) => formatPercent(t.total > 0 ? n / t.total : 0);
  return [
    {
      label: "Input",
      value: formatTokens(t.input),
      note: `${share(t.input)} · uncached prompt tokens`,
      color: TOKEN_COLORS.input,
    },
    {
      label: "Output",
      value: formatTokens(t.output),
      note: `${share(t.output)} · incl. ${formatTokens(t.thinking)} thinking`,
      color: TOKEN_COLORS.output,
    },
    {
      label: "Cache read",
      value: formatTokens(t.cacheRead),
      note: `${share(t.cacheRead)} · input served from cache`,
      color: TOKEN_COLORS.cacheRead,
    },
    {
      label: "Cache write",
      value: formatTokens(t.cacheWrite),
      note: `${share(t.cacheWrite)} · input written to cache`,
      color: TOKEN_COLORS.cacheWrite,
    },
  ];
}

export interface AgentRowModel {
  agentId: string;
  depth: number;
  name: string;
  caption: string;
  model: string | null;
  peak: string;
  /** Share of the context window, 0…1; null — unknown. */
  peakRatio: number | null;
  runDuration: string;
  calls: string;
  usage: string;
  filesRead: number;
  errors: number;
}

const USAGE_SHOWN = 4;

export function agentRows(agents: AgentSummary[]): AgentRowModel[] {
  // The tree traversal order and depth are set by the server (`agentsInTreeOrder`): only captions here.
  return agents.map((a) => {
    const main = a.parentAgentId === null && a.type === null;
    const ratio = a.ctxPeak !== null && a.ctxWindow ? a.ctxPeak / a.ctxWindow : null;
    const caption = [a.agentId, a.description ?? (main ? "orchestrator" : null)].filter(Boolean).join(" · ");
    return {
      agentId: a.agentId,
      depth: a.depth,
      name: main ? "Main agent" : (a.type ?? a.agentId),
      caption,
      model: a.model,
      peak: ratio === null ? DASH : `${formatTokens(a.ctxPeak)} · ${formatPercent(ratio)}`,
      peakRatio: ratio,
      runDuration: formatDuration(a.runMs),
      calls: `${a.toolCalls} ${a.toolCalls === 1 ? "call" : "calls"}`,
      usage: a.toolUsage
        .slice(0, USAGE_SHOWN)
        .map((u) => `${u.name} ${u.count}`)
        .join(" · "),
      filesRead: a.filesRead,
      errors: a.toolErrors,
    };
  });
}

/** Context window in whole thousands, as in the artboard: 200000 → "200K". */
export function formatWindow(tokens: number | null): string {
  if (tokens === null) return DASH;
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens % 1000 === 0) return `${tokens / 1000}K`;
  return formatTokens(tokens);
}

export interface PromptsModel {
  original: PromptSummary;
  /** «Sent 14:02:11 · ~86 tokens · 1 attachment: openapi.yaml». */
  caption: string;
  followUps: PromptSummary[];
  followUpsLabel: string;
}

/** The original prompt and follow-ups; null if there are no prompts. The first by time is the original. */
export function promptsModel(prompts: PromptSummary[]): PromptsModel | null {
  const original = prompts.find((p) => p.kind === "original") ?? prompts[0];
  if (!original) return null;
  const followUps = prompts.filter((p) => p !== original);
  const n = original.attachments.length;
  const parts = [`Sent ${formatClock(original.ts)}`, `~${formatTokens(original.tokensEst)} tokens`];
  if (n > 0) parts.push(`${n} ${n === 1 ? "attachment" : "attachments"}: ${original.attachments.join(", ")}`);
  return {
    original,
    caption: parts.join(" · "),
    followUps,
    followUpsLabel: `${followUps.length} follow-up ${followUps.length === 1 ? "prompt" : "prompts"}`,
  };
}

export type StatusTone = "green" | "blue";

export function statusTag(s: SessionOverview): { label: string; tone: StatusTone } {
  return s.status === "running" ? { label: "Running", tone: "blue" } : { label: "Completed", tone: "green" };
}

/** Enrichment note in the header (plan §9.3); a fully enriched session has none. */
export function enrichmentNote(s: SessionOverview): string | null {
  if (s.enrichment === "none") return "No enrichment";
  if (s.enrichment === "partial") return "Partial enrichment";
  return null;
}

/** Session interval: "Oct 31, 14:02 – 14:20:53"; a running session has no end. */
export function timeRange(s: SessionOverview): string {
  if (s.startedAt === null) return DASH;
  const start = formatDateTime(s.startedAt);
  return s.status === "running" || s.endedAt === null ? `${start} – now` : `${start} – ${formatClock(s.endedAt)}`;
}

/** Name of the downloaded Export JSON file. */
export function exportFileName(sessionId: string): string {
  return `torch-session-${sessionId}.json`;
}

// Session row: project, temp directory, name by the priority of decision 7, time bounds. Package I2.
import { basename } from "node:path";
import { MAIN_AGENT_ID, PROMPT_NAME_MAX_CHARS, TEMP_DIR_PREFIXES } from "../../contracts/constants.ts";
import type { LineEnvelope, ParsedLine } from "../../contracts/lines.ts";
import type { ExternalTitles, LineReducer } from "../../contracts/pipeline.ts";
import type { NameSource, SessionRow } from "../../contracts/rows.ts";
import { isPrompt, promptText } from "./prompts.ts";

/** Name sources in ascending order of priority (decision 7). */
const NAME_PRIORITY: NameSource[] = ["prompt", "ai", "desktop", "custom"];

type EnvelopeLine = Extract<ParsedLine, LineEnvelope>;

const hasEnvelope = (line: ParsedLine): line is EnvelopeLine => "timestamp" in line;

/** Time of the earliest and latest row; null if no rows have a time. */
export function timeBounds(lines: ParsedLine[]): [number | null, number | null] {
  let min: number | null = null;
  let max: number | null = null;
  for (const line of lines) {
    if (!hasEnvelope(line) || line.timestamp === null) continue;
    min = min === null ? line.timestamp : Math.min(min, line.timestamp);
    max = max === null ? line.timestamp : Math.max(max, line.timestamp);
  }
  return [min, max];
}

/** Value of an envelope field from the first row where it is present. */
function firstOf(lines: ParsedLine[], field: "cwd" | "entrypoint" | "version" | "gitBranch"): string | null {
  for (const line of lines) {
    if (hasEnvelope(line) && line[field] !== null) return line[field];
  }
  return null;
}

const clean = (value: string | null | undefined): string | null => value?.trim() || null;

function lastTitle(lines: ParsedLine[], kind: "custom_title" | "ai_title"): string | null {
  const line = lines.findLast((l) => l.kind === kind && l.title.trim() !== "");
  return line?.kind === kind ? line.title.trim() : null;
}

/** Start of the prompt as a single line. */
function promptName(text: string): string {
  const chars = [...text.trim().replace(/\s+/g, " ")];
  if (chars.length <= PROMPT_NAME_MAX_CHARS) return chars.join("");
  return `${chars.slice(0, PROMPT_NAME_MAX_CHARS).join("").trimEnd()}…`;
}

/** Name from the highest-priority source present in this pass. */
function nameCandidate(titles: ExternalTitles, lines: ParsedLine[]): { name: string; source: NameSource } | null {
  const bySource: Record<NameSource, string | null | undefined> = {
    // The custom-title.json file holds the current name, the rows hold the rename history: the file wins.
    custom: clean(titles.customFile) ?? lastTitle(lines, "custom_title"),
    desktop: clean(titles.desktop),
    ai: lastTitle(lines, "ai_title"),
    prompt: lines.filter(isPrompt).map((line) => promptName(promptText(line))).find((name) => name !== ""),
  };
  for (const source of NAME_PRIORITY.toReversed()) {
    const name = bySource[source];
    if (name) return { name, source };
  }
  return null;
}

function replacesName(current: NameSource | null, next: NameSource): boolean {
  if (current === null) return true;
  // The name from the prompt is taken once, from the first one: later prompts do not change it.
  if (next === "prompt") return false;
  // Equal priority replaces: the name was renamed, a new ai-title arrived.
  return NAME_PRIORITY.indexOf(next) >= NAME_PRIORITY.indexOf(current);
}

type OwnColumns = Pick<
  SessionRow,
  "cwd" | "project" | "is_temp_dir" | "name" | "name_lower" | "name_source" | "entrypoint" | "cc_version" | "git_branch" | "cost_reported_usd"
>;

export const reduceSession: LineReducer = (ctx, lines) => {
  const { db, sessionId } = ctx;

  // Time bounds are over all the session's files, including subagents.
  const [startedAt, endedAt] = timeBounds(lines);
  db.query(
    `INSERT INTO sessions (id, started_at, ended_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (id) DO UPDATE SET
       started_at = MIN(COALESCE(started_at, excluded.started_at), COALESCE(excluded.started_at, started_at)),
       ended_at = MAX(COALESCE(ended_at, excluded.ended_at), COALESCE(excluded.ended_at, ended_at))`,
  ).run(sessionId, startedAt, endedAt);

  const row = db
    .query<OwnColumns, [string]>(
      `SELECT cwd, project, is_temp_dir, name, name_lower, name_source, entrypoint, cc_version, git_branch, cost_reported_usd
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId)!;

  // The session is described only by rows of the main file: a subagent has its own directory (worktree) and its own prompt.
  const main = ctx.agentId === MAIN_AGENT_ID ? lines : [];

  const cwd = row.cwd ?? firstOf(main, "cwd");
  const candidate = nameCandidate(ctx.titles, main);
  const named = candidate !== null && replacesName(row.name_source, candidate.source);
  const costState = main.findLast((line) => line.kind === "cost_state");

  db.query(
    `UPDATE sessions SET cwd = ?, project = ?, is_temp_dir = ?, name = ?, name_lower = ?, name_source = ?,
       entrypoint = ?, cc_version = ?, git_branch = ?, cost_reported_usd = ?
     WHERE id = ?`,
  ).run(
    cwd,
    cwd === null ? null : basename(cwd) || null,
    cwd !== null && TEMP_DIR_PREFIXES.some((prefix) => cwd.startsWith(prefix)) ? 1 : 0,
    named ? candidate.name : row.name,
    named ? candidate.name.toLowerCase() : row.name_lower,
    named ? candidate.source : row.name_source,
    row.entrypoint ?? firstOf(main, "entrypoint"),
    row.cc_version ?? firstOf(main, "version"),
    row.git_branch ?? firstOf(main, "gitBranch"),
    costState?.kind === "cost_state" ? costState.totalCostUsd : row.cost_reported_usd,
    sessionId,
  );
};

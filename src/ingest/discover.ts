// Walking the transcript root, files next to a transcript and the read-back of source_files
// bookkeeping (plan §6.1, step 1). Nothing is written to the database here: the indexer pass does that. Package I4.
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { MAIN_AGENT_ID } from "../contracts/constants.ts";
import type { AgentMeta } from "../contracts/lines.ts";
import type { SourceFileKind, SourceFileRow } from "../contracts/rows.ts";

export interface DiscoveredFile {
  path: string;
  kind: SourceFileKind;
  sessionId: string;
  agentId: string;
  /** Session directory `<project>/<sessionId>`: holds `custom-title.json` and the subagent files. */
  sessionDir: string;
}

const TRANSCRIPT_EXT = ".jsonl";
const SUBAGENTS_DIR = "subagents";
const SUBAGENT_FILE = /^agent-(.+)\.jsonl$/;

/** A file or directory vanished: between the walk and the read this is a normal situation. */
export function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A directory that exists but cannot be read (permissions): its files were not found, but they did not disappear either. */
export type OnUnreadable = (dir: string, error: unknown) => void;

function entries(dir: string, onUnreadable: OnUnreadable): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (!isMissing(error)) onUnreadable(dir, error);
    return [];
  }
}

/**
 * Transcript files under the root (plan §3.1): `<project>/<sessionId>.jsonl` and
 * `<project>/<sessionId>/subagents/agent-<agentId>.jsonl`. Identifiers are taken from the file names.
 * Order is by path: the indexer pass does not depend on the order the file system returns entries in.
 * An unreadable directory does not abort the walk: `onUnreadable` reports it.
 */
export function discoverFiles(transcriptsDir: string, onUnreadable: OnUnreadable): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];
  for (const project of entries(transcriptsDir, onUnreadable)) {
    if (!project.isDirectory()) continue;
    const projectDir = join(transcriptsDir, project.name);
    for (const entry of entries(projectDir, onUnreadable)) {
      if (entry.isDirectory()) {
        // A session directory is read even without the main file: subagents remain when it has vanished.
        const sessionDir = join(projectDir, entry.name);
        for (const sub of entries(join(sessionDir, SUBAGENTS_DIR), onUnreadable)) {
          const agentId = SUBAGENT_FILE.exec(sub.name)?.[1];
          if (!agentId || sub.isDirectory()) continue;
          files.push({ path: join(sessionDir, SUBAGENTS_DIR, sub.name), kind: "subagent", sessionId: entry.name, agentId, sessionDir });
        }
      } else if (entry.name.endsWith(TRANSCRIPT_EXT)) {
        const sessionId = entry.name.slice(0, -TRANSCRIPT_EXT.length);
        files.push({ path: join(projectDir, entry.name), kind: "main", sessionId, agentId: MAIN_AGENT_ID, sessionDir: join(projectDir, sessionId) });
      }
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ── Files next to a transcript ──────────────────────────────────────────────────────────────

/**
 * A JSON object from a file; null if the file is missing or Claude Code has not finished writing it. A file that
 * exists but is unreadable is an exception: it is a failure of the transcript file it sits next to.
 */
function readJsonObject(path: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** `agent-<agentId>.meta.json` next to a subagent file; null if the file is missing. */
export function readAgentMeta(subagentPath: string): AgentMeta | null {
  const meta = readJsonObject(`${subagentPath.slice(0, -TRANSCRIPT_EXT.length)}.meta.json`);
  if (!meta) return null;
  return {
    agentType: str(meta.agentType),
    description: str(meta.description),
    toolUseId: str(meta.toolUseId),
    spawnDepth: num(meta.spawnDepth),
    model: str(meta.model),
    parentAgentId: str(meta.parentAgentId),
  };
}

/** `customTitle` from `<sessionId>/custom-title.json`; null if the file is missing. */
export function readCustomTitle(sessionDir: string): string | null {
  return str(readJsonObject(join(sessionDir, "custom-title.json"))?.customTitle);
}

// ── Bookkeeping in source_files ─────────────────────────────────────────────────────────────

/** Everything known about files from earlier passes, by path. */
export function knownFiles(db: Database): Map<string, SourceFileRow> {
  const rows = db.query<SourceFileRow, []>("SELECT * FROM source_files").all();
  return new Map(rows.map((row) => [row.path, row]));
}

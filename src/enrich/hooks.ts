// Ingestion of hooks event files from the spool into hook_events. Package E1.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HookEventExtras, HookEventName, HookPayload } from "../contracts/enrich.ts";

/** A finished event: `hooks/record.sh` writes under a temporary name and renames to `*.json`. */
const SPOOL_FILE = /^[^.].*\.json$/;

const INSTRUCTIONS_LOADED: HookEventName = "InstructionsLoaded";

interface SpoolFile {
  path: string;
  mtime: number;
}

/** Finished spool files in write order: by event time, ties broken by name. */
function spoolFiles(spoolDir: string): SpoolFile[] {
  if (!existsSync(spoolDir)) return [];
  const files: SpoolFile[] = [];
  for (const name of readdirSync(spoolDir)) {
    if (!SPOOL_FILE.test(name)) continue;
    const path = join(spoolDir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat?.isFile()) files.push({ path, mtime: Math.floor(stat.mtimeMs) });
  }
  return files.sort((a, b) => a.mtime - b.mtime || (a.path < b.path ? -1 : 1));
}

/** File text as an event; null if it is not a JSON object with an event name and a session. */
function parsePayload(text: string): HookPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const payload = parsed as Partial<HookPayload>;
  return typeof payload.hook_event_name === "string" && typeof payload.session_id === "string" ? (parsed as HookPayload) : null;
}

/** Current size of the instructions file: the event does not carry it (plan §3.4), and the file may change later. */
function fileBytes(path: string | undefined): number | null {
  if (typeof path !== "string") return null;
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    // The file does not exist or is not accessible.
    return null;
  }
}

/**
 * Ingests and deletes files from the spool; returns the number of accepted events.
 *
 * The event has no time: the file write time serves as one. A file is deleted right after its row
 * is inserted. Writes to the spool are atomic, so a file that does not parse will not change any
 * more: it is deleted without an event.
 */
export function ingestSpool(db: Database, spoolDir: string): number {
  const insert = db.query("INSERT INTO hook_events (session_id, ts, name, attrs_json) VALUES (?, ?, ?, ?)");
  let accepted = 0;
  for (const file of spoolFiles(spoolDir)) {
    const payload = parsePayload(readFileSync(file.path, "utf8"));
    if (payload) {
      const extras: Partial<HookEventExtras> = payload.hook_event_name === INSTRUCTIONS_LOADED ? { file_bytes: fileBytes(payload.file_path) } : {};
      insert.run(payload.session_id, file.mtime, payload.hook_event_name, JSON.stringify({ ...payload, ...extras }));
      accepted += 1;
    }
    rmSync(file.path, { force: true });
  }
  return accepted;
}

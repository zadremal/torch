#!/usr/bin/env bun
// torch start | index | doctor | setup | uninstall | status (plan §7.3). Package I4.
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { publishIndexed } from "./api/events.ts";
import { startReceiverWindow } from "./enrich/coverage.ts";
import { loadConfig, type TorchConfig } from "./config.ts";
import type { PriceTable } from "./contracts/api.ts";
import type { IndexResult } from "./contracts/pipeline.ts";
import type { ReceiverWindowRow } from "./contracts/rows.ts";
import { openDb, openReadonlyDb, schemaVersion } from "./db/db.ts";
import { IndexError, indexedProvider, planRebuild, rebuildBlocker, runIndex, scanTranscripts, type IndexDeps } from "./ingest/index.ts";
import { INVALID_TYPE } from "./ingest/parse.ts";
import { DEFAULT_PRICES_PATH, loadPrices } from "./ingest/reduce/cost.ts";
import { startWatcher } from "./ingest/watch.ts";
import { providerFor } from "./providers/index.ts";
import { accessToken, createServer, WEB_DIST } from "./server.ts";
import { runSetup, runUninstall } from "./setup/index.ts";

const COMMANDS = ["start", "index", "doctor", "setup", "uninstall", "status"] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `Usage: torch <command>
  start [--port N] [--host H] [--no-open]  catch up the index, start the server, open the browser
  index [--rebuild [--yes]]                run the indexer; --rebuild rebuilds the database from scratch
  doctor                                   unknown line types and transcript fields, state of the channels
  status                                   schema version, session count, database size, receiver windows
  setup [--port N] | uninstall             edit and roll back settings.json; --port is the receiver port, as for start`;

/** How many of the latest receiver windows `torch status` prints. */
const STATUS_WINDOWS = 5;

export interface ServeOptions {
  port: number;
  hostname: string;
  fetch: (request: Request) => Response | Promise<Response>;
}

/** A listening server: the address with the actual port, and a stop function. */
export interface Listening {
  url: URL;
  stop: () => void;
}

export interface CliDeps {
  config: TorchConfig;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => number;
  /** A yes/no question before an irreversible action. */
  confirm: (question: string) => boolean;
  openBrowser: (url: string) => void;
  /** Starts listening on the address; in production it is `Bun.serve`. */
  serve: (options: ServeOptions) => Listening;
  /** Directory of the built UI. */
  webDir: string;
}

/** A running server: `torch start` returns it instead of an exit code. */
export interface RunningTorch {
  url: string;
  stop: () => void;
}

const count = (db: Database, sql: string): number => db.query<{ n: number }, []>(sql).get()!.n;
const isoTime = (ms: number): string => new Date(ms).toISOString();
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The price table from the data directory; on first run it is created as a copy of prices.default.json. */
function ensurePrices(config: TorchConfig): PriceTable {
  if (!existsSync(config.pricesPath)) {
    mkdirSync(dirname(config.pricesPath), { recursive: true });
    copyFileSync(DEFAULT_PRICES_PATH, config.pricesPath);
  }
  return loadPrices(config.pricesPath);
}

/**
 * Dependencies of the watch passes. The price table is re-read when its file changes: an edit made
 * in Settings reaches new model calls without a restart.
 */
function watchDeps(db: Database, deps: CliDeps): IndexDeps {
  const { config } = deps;
  let prices = ensurePrices(config);
  let mtime = statSync(config.pricesPath).mtimeMs;
  return {
    db,
    config,
    now: deps.now,
    get prices() {
      const current = statSync(config.pricesPath).mtimeMs;
      if (current !== mtime) {
        prices = loadPrices(config.pricesPath);
        mtime = current;
      }
      return prices;
    },
  };
}

/**
 * The database was indexed with another provider than config.json sets: unchanged files are not read again, so
 * their sessions keep the old result. null — they agree.
 */
function providerMismatch(db: Database, config: TorchConfig): string | null {
  const indexed = indexedProvider(db);
  if (indexed === config.provider) return null;
  return `The database was indexed with provider ${indexed}, config.json sets ${config.provider}: sessions indexed before keep the ${indexed} result. To reindex: torch index --rebuild`;
}

/** An indexer pass with a report. false if some files could not be processed. */
function catchUp(deps: CliDeps, db: Database, options: { rebuild?: boolean } = {}): boolean {
  const { config, out, err } = deps;
  // Without the directory the pass would mark every file as gone: the path is most likely wrong.
  if (!existsSync(config.transcriptsDir)) err(`Transcripts directory not found: ${config.transcriptsDir}`);
  let result: IndexResult;
  let ok = true;
  try {
    result = runIndex({ db, config, prices: ensurePrices(config), now: deps.now }, options);
  } catch (error) {
    if (!(error instanceof IndexError)) throw error;
    err(`${error.message}:`);
    for (const failure of error.failures) err(`  ${failure.path}: ${message(failure.error)}`);
    result = error.result;
    ok = false;
  }
  out(`Files: ${result.filesSeen}, with new lines: ${result.filesRead}, lines parsed: ${result.linesParsed}, sessions changed: ${result.sessionsChanged.length}`);
  const mismatch = providerMismatch(db, config);
  if (mismatch) err(mismatch);
  const unknownTypes = Object.keys(result.unknown.types).length;
  const unknownFields = Object.keys(result.unknown.fields).length;
  if (unknownTypes + unknownFields > 0) out(`Unknown line types: ${unknownTypes}, fields: ${unknownFields} — details: torch doctor`);
  return ok;
}

function index(deps: CliDeps, rebuild: boolean, yes: boolean): number {
  const { config, out, err } = deps;
  const db = openDb(config.dbPath);
  try {
    if (rebuild) {
      // The disk is checked against the database before the question and before the wipe: the count of what is lost reflects what is there now.
      const plan = planRebuild(db, config.transcriptsDir);
      const blocker = rebuildBlocker(plan);
      if (blocker) {
        err(blocker);
        err(`Transcripts directory: ${config.transcriptsDir}`);
        return 1;
      }
      out(`The rebuild wipes the database and reloads only what is on disk (transcript files: ${plan.transcripts}): everything older than the Claude Code retention period will be lost.`);
      out(`Will be lost: sessions without a main file on disk: ${plan.sessionsLost} of ${plan.sessions}; subagent files of the remaining sessions that are no longer on disk: ${plan.subagentFilesLost}.`);
      if (!yes && !deps.confirm("Continue?")) {
        out("Rebuild cancelled.");
        return 1;
      }
    }
    return catchUp(deps, db, { rebuild }) ? 0 : 1;
  } finally {
    db.close();
  }
}

/**
 * A line type or field name that is safe to print: an identifier. Anything else may turn out to be
 * transcript text and does not reach the output.
 */
const PRINTABLE_NAME = /^[A-Za-z0-9_./-]{1,80}$/;
function printCounts(out: CliDeps["out"], title: string, counts: Record<string, number>): void {
  const all = Object.entries(counts);
  const printable = ([name]: [string, number]): boolean => PRINTABLE_NAME.test(name) || name === INVALID_TYPE;
  const named = all.filter(printable).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  // How many times names that must not be printed occurred: one line, without the names themselves.
  const odd = all.filter((entry) => !printable(entry)).reduce((sum, [, n]) => sum + n, 0);
  out(`${title}: ${all.length === 0 ? "none" : all.length}`);
  for (const [name, n] of named) out(`  ${String(n).padStart(7)}  ${name}`);
  if (odd > 0) out(`  nonstandard name: ${odd}`);
}

function doctor({ config, out }: CliDeps): number {
  // Only line types, field names and counters are printed: line contents never go out.
  const scan = scanTranscripts(config.transcriptsDir, providerFor(config.provider));
  out(`Transcripts: ${config.transcriptsDir}`);
  out(`Files: ${scan.mainFiles + scan.subagentFiles} (main ${scan.mainFiles}, subagent ${scan.subagentFiles}), lines: ${scan.lines}`);
  if (scan.unreadable > 0) out(`Files and directories that could not be read: ${scan.unreadable}`);
  out(`Provider: ${config.provider}`);
  const db = openReadonlyDb(config.dbPath);
  const mismatch = db && providerMismatch(db, config);
  if (mismatch) out(`  ${mismatch}`);
  out(`  Model response lines without a call key: ${scan.keyless}`);
  if (scan.keyless > 0) {
    // With bedrock already set the advice to set it would mislead: such lines have neither requestId nor message.id.
    const advice = config.provider === "bedrock" ? "" : ' Transcripts written through a gateway need "provider": "bedrock" in config.json, then torch index --rebuild';
    out(`  They give no model calls, tokens or cost.${advice}`);
  }
  printCounts(out, "Unknown line types", scan.unknown.types);
  printCounts(out, "Unknown fields", scan.unknown.fields);

  if (!db) {
    out(`Enrichment channels: no database yet (${config.dbPath})`);
    return 0;
  }
  try {
    out("Enrichment channels:");
    for (const [label, table] of [["OTel", "otel_events"], ["Hooks", "hook_events"]] as const) {
      const events = db.query<{ n: number; pending: number; last: number | null }, []>(`SELECT COUNT(*) AS n, COALESCE(SUM(applied = 0), 0) AS pending, MAX(ts) AS last FROM ${table}`).get()!;
      out(`  ${label}: ${events.last === null ? "no events" : `events ${events.n}, not applied ${events.pending}, last ${isoTime(events.last)}`}`);
    }
    const last = db.query<ReceiverWindowRow, []>("SELECT * FROM receiver_windows ORDER BY stopped_at DESC LIMIT 1").get();
    out(`  OTel receiver: ${last ? `ran until ${isoTime(last.stopped_at)}` : "has not run yet"}`);
  } finally {
    db.close();
  }
  return 0;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function status({ config, out }: CliDeps): number {
  const db = openReadonlyDb(config.dbPath);
  if (!db) {
    out(`No database yet: ${config.dbPath}. torch index or torch start will create it.`);
    return 0;
  }
  try {
    const wal = `${config.dbPath}-wal`;
    out(`Database: ${config.dbPath}`);
    out(`Schema version: ${schemaVersion(db)}`);
    out(
      `Sessions: ${count(db, "SELECT COUNT(*) AS n FROM sessions")} (running ${count(db, "SELECT COUNT(*) AS n FROM sessions WHERE status = 'running'")}, without transcript ${count(db, "SELECT COUNT(*) AS n FROM sessions WHERE transcript_present = 0")})`,
    );
    out(`Database size: ${formatBytes(statSync(config.dbPath).size + (existsSync(wal) ? statSync(wal).size : 0))}`);
    const windows = db.query<ReceiverWindowRow, [number]>("SELECT * FROM receiver_windows ORDER BY started_at DESC LIMIT ?").all(STATUS_WINDOWS);
    out(`Receiver windows: ${windows.length === 0 ? "none" : `latest ${windows.length}`}`);
    for (const window of windows) out(`  ${isoTime(window.started_at)} — ${isoTime(window.stopped_at)}`);
  } finally {
    db.close();
  }
  return 0;
}

/**
 * Catches up the index, starts the server with the API and the UI, and watches the transcripts
 * directory: changes reach open screens as SSE events. While the server runs, an OTel receiver
 * window is open: sessions get their enrichment mark from it.
 */
function start(deps: CliDeps, open: boolean): RunningTorch {
  const { config, out } = deps;
  const db = openDb(config.dbPath);
  let listening: Listening | null = null;
  let stopWatching = (): void => {};
  let closeWindow = (): void => {};
  const stop = (): void => {
    stopWatching();
    listening?.stop();
    closeWindow();
    db.close();
  };
  try {
    // The window is opened before the catch-up pass: the enrichment mark recalculation already sees it.
    closeWindow = startReceiverWindow(db, deps.now);
    // Bad files are already named in the pass report: the rest of the history is loaded, the server starts.
    catchUp(deps, db);
    const token = accessToken(config.host);
    const app = createServer({ db, config, now: deps.now }, { token, webDir: deps.webDir });
    listening = deps.serve({ port: config.port, hostname: config.host, fetch: (request) => app.fetch(request) });
    stopWatching = startWatcher(watchDeps(db, deps), publishIndexed, (error) => deps.err(`torch start: transcript watching: ${message(error)}`));
    const url = new URL(listening.url);
    if (token) url.searchParams.set("token", token);
    out(`torch: ${url.href}`);
    if (open) deps.openBrowser(url.href);
    return { url: url.href, stop };
  } catch (error) {
    // A failure after listening has begun does not leave the server hanging on the port.
    stop();
    throw error;
  }
}

/** Editing Claude Code's settings.json and rolling it back: the difference is shown before the question (decision 27). */
async function settings(deps: CliDeps, command: "setup" | "uninstall"): Promise<number> {
  const { config, out } = deps;
  const path = config.claudeSettingsPath;
  try {
    const result = await (command === "setup" ? runSetup : runUninstall)({
      settingsPath: path,
      backupsDir: config.backupsDir,
      hookPath: join(config.dataDir, "hooks", "record.sh"),
      port: config.port,
      now: deps.now,
      confirm: async (diff) => {
        out(`Changes in ${path}:`);
        out(diff);
        return deps.confirm("Write?");
      },
    });
    if (result.status === "declined") {
      out("Changes not written.");
      return 1;
    }
    if (result.status === "unchanged") {
      out(command === "setup" ? `${path} is already configured: no changes.` : `${path} has no torch setup edits: nothing to roll back.`);
      return 0;
    }
    out(command === "setup" ? `Written: ${path}. The edit applies to Claude Code sessions started after it.` : `torch edits removed from ${path}.`);
    if (result.backupPath) out(`Copy of the previous file: ${result.backupPath}`);
    return 0;
  } catch (error) {
    deps.err(`torch ${command}: ${message(error)}`);
    return 1;
  }
}

function parsePort(value: string): number | null {
  const port = Number(value);
  return /^\d+$/.test(value) && port <= 65535 ? port : null;
}

/** Runs a command. Returns the exit code; for `start`, the running server; for `setup` and `uninstall`, a promise of the code. */
export function runCli(argv: string[], deps: CliDeps): number | RunningTorch | Promise<number> {
  const usage = (problem?: string): number => {
    if (problem) deps.err(problem);
    deps.err(USAGE);
    return 2;
  };

  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (error) {
    return usage(message(error));
  }
  const [command, ...rest] = args.positionals;
  if (rest.length > 0 || !(COMMANDS as readonly (string | undefined)[]).includes(command)) return usage();
  const { values } = args;

  try {
    switch (command as Command) {
      case "start": {
        const port = values.port === undefined ? deps.config.port : parsePort(values.port);
        if (port === null) return usage(`Invalid port: ${values.port}`);
        return start({ ...deps, config: { ...deps.config, port, host: values.host ?? deps.config.host } }, !values["no-open"]);
      }
      case "index":
        return index(deps, values.rebuild ?? false, values.yes ?? false);
      case "doctor":
        return doctor(deps);
      case "status":
        return status(deps);
      case "setup":
      case "uninstall": {
        // The receiver port in the settings is the same as for `start`: the flag is parsed the same way.
        const port = values.port === undefined ? deps.config.port : parsePort(values.port);
        if (port === null) return usage(`Invalid port: ${values.port}`);
        return settings({ ...deps, config: { ...deps.config, port } }, command as "setup" | "uninstall");
      }
    }
  } catch (error) {
    deps.err(`torch ${command}: ${message(error)}`);
    return 1;
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      "no-open": { type: "boolean" },
      rebuild: { type: "boolean" },
      yes: { type: "boolean" },
    },
  });
}

if (import.meta.main) {
  let config: TorchConfig;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`torch: ${message(error)}`);
    process.exit(1);
  }
  const result = await runCli(process.argv.slice(2), {
    config,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    now: Date.now,
    confirm: (question) => confirm(question),
    openBrowser: (url) => {
      Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] });
    },
    serve: (options) => {
      const server = Bun.serve(options);
      return { url: server.url, stop: () => void server.stop(true) };
    },
    webDir: WEB_DIST,
  });
  if (typeof result === "number") process.exit(result);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      result.stop();
      process.exit(0);
    });
  }
}

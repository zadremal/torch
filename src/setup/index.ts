// Editing Claude Code's settings.json, the backup and the rollback (plan §7.1). Package S1.
// Order: read the file, show the difference, ask, save a copy, write.

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { lineDiff } from "./diff.ts";
import { applySetup, isSetupState, revertSetup, torchEdits, type SetupState } from "./settings.ts";

export interface SetupOptions {
  /** Path to settings.json: a parameter so that tests work on a copy. */
  settingsPath: string;
  /** Directory of settings.json copies; the record of setup edits lives here too. */
  backupsDir: string;
  /** Where the hooks handler is installed; this path is written into settings.json. */
  hookPath: string;
  port: number;
  now: () => number;
  /** User confirmation after the difference is shown. */
  confirm: (diff: string) => Promise<boolean>;
}

export interface SetupResult {
  /** written: the file was changed; unchanged: nothing to change; declined: the user refused. */
  status: "written" | "unchanged" | "declined";
  /** Copy of the file before the edit; null if the file was not changed or did not exist. */
  backupPath: string | null;
}

/** The hooks handler in the repository: `torch setup` copies it into the data directory. */
const HOOK_SOURCE = join(import.meta.dir, "..", "..", "hooks", "record.sh");
/** Record of setup edits in the backups directory: the rollback works from it. */
const STATE_FILE = "setup-state.json";
/** Start of a settings.json copy name; the time follows. */
const BACKUP_PREFIX = "settings.json.";

const UNCHANGED: SetupResult = { status: "unchanged", backupPath: null };
const DECLINED: SetupResult = { status: "declined", backupPath: null };

const statePath = (options: SetupOptions): string => join(options.backupsDir, STATE_FILE);

/** Text of the file; null if there is no file. */
function readSettings(path: string): string | null {
  if (!existsSync(path)) {
    // Writing to the path of a dangling link would replace the link with a regular file.
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${path}: symbolic link points to a nonexistent file`);
    return null;
  }
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  // Text that does not convert back to the same bytes would be corrupted by writing.
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`${path}: file is not UTF-8`);
  try {
    JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: file does not parse as JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return text;
}

/** Writes a file through a temporary name and a rename. */
function writeAtomic(path: string, text: string, mode: number): void {
  const temp = `${path}.torch-tmp`;
  // A temporary file left by an earlier failure would keep its own permissions: it is created anew, at once with the right ones.
  rmSync(temp, { force: true });
  writeFileSync(temp, text, { mode, flag: "wx" });
  // umask may have removed bits that the original has.
  chmodSync(temp, mode);
  renameSync(temp, path);
}

/** Writes settings.json; `text` null means the file is deleted. */
function writeSettings(path: string, text: string | null): void {
  if (text === null) {
    rmSync(path);
    return;
  }
  // A symbolic link stays a link: the file it points to is replaced.
  const target = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  mkdirSync(dirname(target), { recursive: true });
  writeAtomic(target, text, mode);
}

/** The edit record; null means there is no record file. A file of another shape is an error, not a missing record. */
function readState(options: SetupOptions): SetupState | null {
  const path = statePath(options);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    parsed = undefined;
  }
  if (!isSetupState(parsed)) throw new Error(`${path}: the setup edit record is corrupted`);
  return parsed;
}

/** Saves the edit record; null means there is no record any more. */
function writeState(options: SetupOptions, state: SetupState | null): void {
  if (state === null) {
    rmSync(statePath(options), { force: true });
    return;
  }
  mkdirSync(options.backupsDir, { recursive: true, mode: 0o700 });
  writeAtomic(statePath(options), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

/** Copy of the file before the edit. settings.json may hold access keys: the copy is closed to others. */
function backup(options: SetupOptions): string {
  mkdirSync(options.backupsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date(options.now()).toISOString().replace(/[:.]/g, "-");
  for (let n = 0; ; n++) {
    const path = join(options.backupsDir, `${BACKUP_PREFIX}${stamp}${n === 0 ? "" : `-${n}`}`);
    if (existsSync(path)) continue;
    copyFileSync(options.settingsPath, path);
    chmodSync(path, 0o600);
    return path;
  }
}

/** The settings.json copy most recently written; null if there are no copies. */
function latestBackup(backupsDir: string): string | null {
  if (!existsSync(backupsDir)) return null;
  const copies = readdirSync(backupsDir)
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .map((name) => ({ path: join(backupsDir, name), mtime: statSync(join(backupsDir, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime || (a.path < b.path ? -1 : 1));
  return copies.at(-1)?.path ?? null;
}

/**
 * torch edits in a file without a record of them are an error: the previous values are unknown,
 * so they can be neither rolled back nor remembered as "previous" when the value is torch's own.
 */
function rejectOrphans(options: SetupOptions, current: string): void {
  const edits = torchEdits(current, shellWord(options.hookPath));
  if (!edits.own) return;
  const latest = latestBackup(options.backupsDir);
  throw new Error(
    `${options.settingsPath} contains torch setup edits, but there is no record of them (${statePath(options)}): the previous values are unknown. ` +
      `Keys set by torch: ${edits.keys.join(", ")}. Restore them manually. ` +
      `File copies are in ${options.backupsDir}; ${latest ? `the latest: ${latest}` : "there are no copies there"}.`,
  );
}

/** The file is missing but a record of edits to it exists: the record stays until the rollback. */
const missingSettings = (options: SetupOptions): Error =>
  new Error(`${options.settingsPath} not found, but a record of torch setup edits exists (${statePath(options)}): it is kept, and the rollback will work when the file returns. If the file is deleted for good, delete the record.`);

/** Shows the difference, asks and saves a copy. null means the user refused. */
async function approve(options: SetupOptions, current: string | null, next: string | null): Promise<SetupResult | null> {
  if (!(await options.confirm(lineDiff(current ?? "", next ?? "")))) return null;
  // Claude Code writes to settings.json itself too: the edit was computed from text that may already be stale.
  if (readSettings(options.settingsPath) !== current) throw new Error(`${options.settingsPath} changed while the confirmation was pending: run the command again`);
  return { status: "written", backupPath: current === null ? null : backup(options) };
}

/** Installs the hooks handler through a temporary name: a running hook will not see a half-written file. */
function installHook(hookPath: string): void {
  mkdirSync(dirname(hookPath), { recursive: true });
  const temp = `${hookPath}.tmp`;
  copyFileSync(HOOK_SOURCE, temp);
  chmodSync(temp, 0o755);
  renameSync(temp, hookPath);
}

/** A path as a shell command word: Claude Code runs the handler through a shell. */
const shellWord = (path: string): string => (/^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`);

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const current = readSettings(options.settingsPath);
  const previous = readState(options);
  // A new file in place of the vanished one would wipe the record of edits to the old one.
  if (current === null && previous && !previous.fileCreated) throw missingSettings(options);
  // Edits of the previous setup are removed first: a run with another port or data directory
  // leaves no old values, and the "previous" values stay the user's, not torch's.
  const base = previous && current !== null ? revertSetup(current, previous) : current;
  const { text, state } = applySetup(base, { port: options.port, hookCommand: shellWord(options.hookPath) });
  if (current !== null && isDeepStrictEqual(JSON.parse(current), JSON.parse(text))) {
    // The handler is installed here too: the settings already reference it, and the file may have vanished or gone stale.
    installHook(options.hookPath);
    return UNCHANGED;
  }
  if (current !== null && !previous) rejectOrphans(options, current);
  const approved = await approve(options, current, text);
  if (!approved) return DECLINED;
  installHook(options.hookPath);
  // The edit record is written before the edits themselves: a failure in between leaves a record
  // without edits, and rolling back from it touches nothing. Edits without a record could not be rolled back.
  writeState(options, state);
  try {
    writeSettings(options.settingsPath, text);
  } catch (error) {
    // The file stayed as it was: so does the edit record.
    writeState(options, previous);
    throw error;
  }
  return approved;
}

export async function runUninstall(options: SetupOptions): Promise<SetupResult> {
  const current = readSettings(options.settingsPath);
  const state = readState(options);
  if (!state) {
    if (current !== null) rejectOrphans(options, current);
    return UNCHANGED;
  }
  if (current === null) {
    if (!state.fileCreated) throw missingSettings(options);
    // The file was created by setup and is already gone: the rollback happened without torch.
    writeState(options, null);
    return UNCHANGED;
  }
  const next = revertSetup(current, state);
  if (next === current) {
    writeState(options, null);
    return UNCHANGED;
  }
  const approved = await approve(options, current, next);
  if (!approved) return DECLINED;
  writeSettings(options.settingsPath, next);
  // The edit record is removed only after the rollback.
  writeState(options, null);
  return approved;
}

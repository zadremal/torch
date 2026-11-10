// torch paths and port: defaults, with ~/.torch/config.json on top (plan §4.3).
// The data directory is moved with the TORCH_HOME variable: this is how tests work in a temporary directory.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HOST, DEFAULT_PORT } from "./contracts/constants.ts";

export interface TorchConfig {
  /** ~/.torch */
  dataDir: string;
  dbPath: string;
  /** Copy of prices.default.json, edited from Settings. */
  pricesPath: string;
  spoolDir: string;
  backupsDir: string;
  /** ~/.claude/projects */
  transcriptsDir: string;
  /** Metadata of the desktop app sessions. */
  desktopSessionsDir: string;
  /** ~/.claude/settings.json */
  claudeSettingsPath: string;
  port: number;
  host: string;
}

/** Keys read from config.json. */
type ConfigFile = Partial<Pick<TorchConfig, "port" | "host" | "transcriptsDir" | "desktopSessionsDir" | "claudeSettingsPath">>;

export function defaultDataDir(): string {
  return process.env.TORCH_HOME ?? join(homedir(), ".torch");
}

export function loadConfig(overrides: Partial<TorchConfig> = {}): TorchConfig {
  const dataDir = overrides.dataDir ?? defaultDataDir();
  const home = homedir();
  const file = readConfigFile(join(dataDir, "config.json"));
  return {
    dataDir,
    dbPath: join(dataDir, "torch.db"),
    pricesPath: join(dataDir, "prices.json"),
    spoolDir: join(dataDir, "spool"),
    backupsDir: join(dataDir, "backups"),
    transcriptsDir: join(home, ".claude", "projects"),
    desktopSessionsDir: join(home, "Library", "Application Support", "Claude", "claude-code-sessions"),
    claudeSettingsPath: join(home, ".claude", "settings.json"),
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    ...file,
    ...overrides,
  };
}

function readConfigFile(path: string): ConfigFile {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: a JSON object is expected`);
  }
  return parsed as ConfigFile;
}

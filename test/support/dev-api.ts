// An API on the reference in-memory database: a development server for screens while there is no indexer.
// Launch: `bun run dev:seed`; UI — `bun run dev:web` (Vite proxies /api to this port).
// Unlike the examples mode, filters, sorting and session list pages work here.
import { mkdirSync, writeFileSync } from "node:fs";
import { createApi } from "../../src/api/routes.ts";
import { loadConfig } from "../../src/config.ts";
import { openMemoryDb } from "../../src/db/db.ts";
import { REF_PRICES, REF_START } from "./reference.ts";
import { seedListSessions, seedReference } from "./reference-seed.ts";

const db = openMemoryDb();
seedReference(db);
seedListSessions(db);

// All paths are inside the development server's data directory: it does not read the real Claude Code directories.
const DATA_DIR = "/tmp/torch-dev-seed";
const config = loadConfig({
  dataDir: DATA_DIR,
  transcriptsDir: `${DATA_DIR}/projects`,
  desktopSessionsDir: `${DATA_DIR}/desktop`,
  claudeSettingsPath: `${DATA_DIR}/settings.json`,
});
// The reference database is calculated with the reference price table: the Settings screen shows and recalculates with the same one.
mkdirSync(config.dataDir, { recursive: true });
writeFileSync(config.pricesPath, `${JSON.stringify(REF_PRICES, null, 2)}\n`);
const app = createApi({ db, config, now: () => REF_START + 3_600_000 });

Bun.serve({ port: config.port, hostname: config.host, fetch: app.fetch });
console.log(`API on the reference database: http://${config.host}:${config.port}/api/sessions`);

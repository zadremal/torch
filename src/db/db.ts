// Opening the database: mode 0600, WAL, forward-only migrations, a copy of the file before migrating (plan §12).

import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

interface Migration {
  version: number;
  sql: string;
}

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort()
    .map((name) => ({ version: Number.parseInt(name, 10), sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));
}

export function schemaVersion(db: Database): number {
  const hasMeta = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) return 0;
  const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row ? Number(row.value) : 0;
}

/** Applies the missing migrations, each in its own transaction. Returns the numbers of those applied. */
export function migrate(db: Database, onBeforeMigration?: (version: number) => void): number[] {
  const applied: number[] = [];
  for (const migration of loadMigrations()) {
    if (migration.version <= schemaVersion(db)) continue;
    onBeforeMigration?.(migration.version);
    db.transaction(() => {
      db.exec(migration.sql);
      db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1").run(
        String(migration.version),
      );
    })();
    applied.push(migration.version);
  }
  return applied;
}

/** Opens the database file, creating the directory and the file if needed. */
export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  const db = new Database(path, { create: true });
  chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db, (version) => {
    // The database is the only copy of old sessions: save the file before changing the schema.
    if (!existed || schemaVersion(db) === 0) return;
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const backup = `${path}.before-v${version}`;
    copyFileSync(path, backup);
    chmodSync(backup, 0o600);
  });
  return db;
}

/**
 * An existing database, read-only: the file is not created, migrations are not applied.
 * null if there is no database yet.
 */
export function openReadonlyDb(path: string): Database | null {
  return existsSync(path) ? new Database(path, { readonly: true }) : null;
}

/** An in-memory database with the current schema: for tests. */
export function openMemoryDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

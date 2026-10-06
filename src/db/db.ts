import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKUPS_DIR, DB_PATH, MIGRATIONS_DIR } from "../config/paths.js";

export type Db = DatabaseSync;

let shared: Db | undefined;

export function openDb(file = DB_PATH): Db {
  if (file === DB_PATH && shared) return shared;
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  if (file === DB_PATH) shared = db;
  return db;
}

// Migrations are numbered .sql files; PRAGMA user_version records the last one applied.
export function migrate(db: Db): void {
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    const version = Number.parseInt(f, 10);
    if (version <= current) continue;
    tx(db, () => {
      db.exec(readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
      db.exec(`PRAGMA user_version = ${version}`);
    });
  }
}

// Re-entrant: the outermost call opens the transaction, nested calls use
// savepoints, so helpers like transition() can be called from inside tx().
const depth = new WeakMap<Db, number>();

export function tx<T>(db: Db, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const sp = `sp_${level}`;
  db.exec(level === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    db.exec(level === 0 ? "COMMIT" : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    db.exec(level === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  } finally {
    depth.set(db, level);
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function getKv<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? parseJson(row.value, fallback) : fallback;
}

export function setKv(db: Db, key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, JSON.stringify(value), now());
}

// Daily snapshot of the database; keeps the newest 14 copies.
export function backup(db: Db): string {
  mkdirSync(BACKUPS_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const target = path.join(BACKUPS_DIR, `nuportal-${day}.db`);
  rmSync(target, { force: true }); // VACUUM INTO refuses to overwrite
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  const old = readdirSync(BACKUPS_DIR)
    .filter((f) => /^nuportal-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .slice(0, -14);
  for (const f of old) rmSync(path.join(BACKUPS_DIR, f), { force: true });
  return target;
}

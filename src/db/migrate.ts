import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

export function getUserVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

function migrationNumber(filename: string): number {
  const match = /^(\d+)_.*\.sql$/.exec(filename);
  if (!match) throw new Error(`bad migration filename: ${filename}`);
  return Number(match[1]);
}

/**
 * Apply pending migrations in filename order, bumping PRAGMA user_version.
 * Each file is expected to set user_version itself (see 0001_init.sql), and
 * the runner enforces it afterwards as a safety net. Returns applied filenames.
 */
export function applyMigrations(
  db: Database.Database,
  dir: string = MIGRATIONS_DIR,
): string[] {
  const current = getUserVersion(db);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];

  for (const file of files) {
    const version = migrationNumber(file);
    if (version <= current) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.exec(sql);
    // Safety net: the migration file should set user_version itself.
    if (getUserVersion(db) < version) {
      db.pragma(`user_version = ${version}`);
    }
    applied.push(file);
  }
  return applied;
}

/**
 * Open (creating parent dirs as needed) and configure a DB connection.
 * Every connection in this project must set WAL + foreign_keys + busy_timeout.
 */
export function openDb(filePath: string): Database.Database {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'whatsapp-channel.db');

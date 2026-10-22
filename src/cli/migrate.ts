#!/usr/bin/env tsx
/** `npm run migrate` — apply pending migrations in src/db/migrations/. */
import { config } from 'dotenv';
import { applyMigrations, openDb, resolveDbPath } from '../db/migrate.js';

config();

const DB_PATH = resolveDbPath();

const db = openDb(DB_PATH);
try {
  const applied = applyMigrations(db);
  console.log(applied.length === 0 ? 'Database is up to date.' : `Applied: ${applied.join(', ')}`);
} finally {
  db.close();
}

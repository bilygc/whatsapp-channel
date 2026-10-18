#!/usr/bin/env tsx
/** `npm run migrate` — apply pending migrations in src/db/migrations/. */
import { DEFAULT_DB_PATH, applyMigrations, openDb } from '../db/migrate.js';

const DB_PATH = process.env.DB_PATH ?? DEFAULT_DB_PATH;

const db = openDb(DB_PATH);
try {
  const applied = applyMigrations(db);
  console.log(applied.length === 0 ? 'Database is up to date.' : `Applied: ${applied.join(', ')}`);
} finally {
  db.close();
}

#!/usr/bin/env tsx
/**
 * `npm run fetch` — M1 fetch CLI: pulls all sources into SQLite with
 * per-source graceful degradation, then prints a per-source summary.
 * Exit code is 1 only if ALL sources failed.
 */
import Parser from 'rss-parser';
import { config } from 'dotenv';
import { DEFAULT_DB_PATH, applyMigrations, openDb } from '../db/migrate.js';
import { defaultDeps, runFetch } from '../fetcher/run.js';

config();

const DB_PATH = process.env.DB_PATH ?? DEFAULT_DB_PATH;

async function main(): Promise<void> {
  const db = openDb(DB_PATH);
  try {
    const applied = applyMigrations(db);
    if (applied.length > 0) {
      console.log(`Applied migrations: ${applied.join(', ')}`);
    }

    const parser = new Parser({ timeout: 15000 });
    const apiKey = process.env.NEWSDATA_API_KEY;
    if (!apiKey) {
      console.warn('Warning: NEWSDATA_API_KEY not set — NewsData source will be skipped.');
    }

    const summary = await runFetch(
      db,
      defaultDeps(
        (url: string) => parser.parseURL(url),
        fetch,
        apiKey,
      ),
    );

    console.log('source\tfetched\tinserted\tskipped\tstatus');
    for (const s of summary.sources) {
      const status = s.failed ? `FAILED: ${s.error}` : (s.error ?? 'ok');
      console.log(`${s.source}\t${s.fetched}\t${s.inserted}\t${s.skipped}\t${status}`);
    }
    console.log(
      `Total: fetched=${summary.fetched} inserted=${summary.inserted} ` +
        `skipped=${summary.skipped} failed_sources=${summary.failed}`,
    );
    process.exitCode = summary.exitCode;
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error('fetch failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

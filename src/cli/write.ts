#!/usr/bin/env tsx
/**
 * `npm run write` — M2 writer CLI: one LLM call per `selected` article →
 * Spanish caption draft (`pending`) in SQLite. Per-article isolation: a
 * failed LLM call leaves that article `selected` for a retry and the rest
 * still write. Exit code is 1 only if ALL attempted articles failed.
 */
import { config } from 'dotenv';
import { applyMigrations, openDb, resolveDbPath } from '../db/migrate.js';
import { generateCaption, resolveLlmConfig } from '../writer/openrouter.js';
import { runWriter } from '../writer/run.js';
import { formatArticleLine } from './format.js';

config();

async function main(): Promise<void> {
  const { apiKey, model } = resolveLlmConfig();
  if (!apiKey) {
    console.error('write failed: OPENROUTER_API_KEY is not set (see .env.example).');
    process.exitCode = 1;
    return;
  }

  const db = openDb(resolveDbPath());
  try {
    applyMigrations(db);
    console.log(`Using model: ${model}`);
    const summary = await runWriter(db, {
      now: () => new Date(),
      generate: (article) => generateCaption(article, { fetchFn: fetch, apiKey, model }),
    });
    for (const r of summary.results) {
      console.log(formatArticleLine(r));
    }
    console.log(
      `Total: selected=${summary.total} written=${summary.written} failed=${summary.failed}`,
    );
    process.exitCode = summary.exitCode;
  } catch (err) {
    console.error(`write failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error('write failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

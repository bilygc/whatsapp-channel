#!/usr/bin/env tsx
/**
 * `npm run select` — M2 selector CLI: scores `new` articles and marks the top
 * N (default 4, per the plan's 3–4 posts/day cap) as `selected` for the writer.
 * Usage: npm run select [-- <limit>]
 */
import { config } from 'dotenv';
import { applyMigrations, openDb, resolveDbPath } from '../db/migrate.js';
import { SELECT_DEFAULT_LIMIT, selectTopArticles } from '../selector/select.js';
import { scrub } from '../writer/validate.js';

config();

async function main(): Promise<void> {
  const rawLimit = process.argv[2];
  const limit = rawLimit !== undefined ? Number(rawLimit) : SELECT_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) {
    console.error(`select failed: limit must be a non-negative integer (got "${rawLimit}")`);
    process.exitCode = 1;
    return;
  }

  const db = openDb(resolveDbPath());
  try {
    applyMigrations(db);
    const { selected, scored } = selectTopArticles(db, { limit });
    console.log(`Scored ${scored} new article(s); selected ${selected.length} (limit ${limit}).`);
    for (const a of selected) {
      // Feed fields are remote-controlled: scrub terminal-escape/control
      // sequences so a hostile title cannot spoof terminal output.
      console.log(`- [${a.id}] ${scrub(a.source)}: ${scrub(a.title)} (${scrub(a.url)})`);
    }
  } catch (err) {
    console.error(`select failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error('select failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

#!/usr/bin/env tsx
/**
 * `npm run previewDrafts` — M2 preview CLI: print drafts (default `pending`,
 * oldest first) with their Spanish captions for review before M3 Telegram
 * delivery. Usage: npm run previewDrafts [-- <pending|posted|skipped|all>]
 */
import { config } from 'dotenv';
import { applyMigrations, openDb, resolveDbPath } from '../db/migrate.js';
import { scrub } from '../writer/validate.js';

config();

const STATUSES = ['pending', 'posted', 'skipped'] as const;

async function main(): Promise<void> {
  const filter = process.argv[2] ?? 'pending';
  if (filter !== 'all' && !(STATUSES as readonly string[]).includes(filter)) {
    console.error(`previewDrafts failed: status must be one of pending|posted|skipped|all (got "${filter}")`);
    process.exitCode = 1;
    return;
  }

  const db = openDb(resolveDbPath());
  try {
    applyMigrations(db);
    const rows = (
      filter === 'all'
        ? db
            .prepare(
              `SELECT d.id, d.status, d.caption_es, d.created_at,
                      a.title, a.source, a.url
               FROM drafts d JOIN articles a ON a.id = d.article_id
               ORDER BY d.id`,
            )
            .all()
        : db
            .prepare(
              `SELECT d.id, d.status, d.caption_es, d.created_at,
                      a.title, a.source, a.url
               FROM drafts d JOIN articles a ON a.id = d.article_id
               WHERE d.status = ? ORDER BY d.id`,
            )
            .all(filter)
    ) as Array<{
      id: number;
      status: string;
      caption_es: string;
      created_at: string;
      title: string;
      source: string;
      url: string;
    }>;

    if (rows.length === 0) {
      console.log(`No ${filter} drafts.`);
      return;
    }
    for (const row of rows) {
      console.log(`=== draft ${row.id} [${row.status}] (${row.created_at}) ===`);
      // Feed fields are remote-controlled: scrub terminal-escape/control
      // sequences so a hostile title cannot spoof terminal output and
      // undermine the human review gate (display-only; the DB is untouched).
      console.log(`Article: ${scrub(row.title)}`);
      console.log(`Source: ${scrub(row.source)} ${scrub(row.url)}`);
      console.log('--- caption (paste-ready) ---');
      console.log(scrub(row.caption_es));
      console.log();
    }
  } catch (err) {
    console.error(`previewDrafts failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error('previewDrafts failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

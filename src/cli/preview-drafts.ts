#!/usr/bin/env tsx
/**
 * `npm run previewDrafts` — M2 preview CLI: print drafts (default `pending`,
 * oldest first) with their Spanish captions for review before M3 Telegram
 * delivery. Usage: npm run previewDrafts [-- <pending|posted|skipped|all>]
 */
import { config } from 'dotenv';
import { applyMigrations, openDb, resolveDbPath } from '../db/migrate.js';
import { scrub, scrubToLine } from '../writer/validate.js';
import { formatCliFailure } from './format.js';

config();

const STATUSES = ['pending', 'posted', 'skipped'] as const;

export interface DraftPreviewRow {
  id: number;
  status: string;
  caption_es: string;
  /** Null when no X post has been generated for the draft yet. */
  x_post_es: string | null;
  created_at: string;
  title: string;
  source: string;
  url: string;
}

/**
 * Render one draft for terminal review: caption first, then the X post as
 * its own labeled block. Pure (no I/O) so the review output is unit-tested.
 * Feed-controlled fields are single-line scrubbed (display-only); stored
 * caption/X bytes are scrubbed but otherwise printed verbatim.
 */
export function formatDraftPreview(row: DraftPreviewRow): string {
  const lines = [
    `=== draft ${row.id} [${row.status}] (${row.created_at}) ===`,
    `Article: ${scrubToLine(row.title)}`,
    `Source: ${scrubToLine(row.source)} ${scrubToLine(row.url)}`,
    '--- caption (paste-ready) ---',
    scrub(row.caption_es),
    '--- X post: (ready to post) ---',
    row.x_post_es === null ? '(no X post yet)' : scrub(row.x_post_es),
    '',
  ];
  return lines.join('\n');
}

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
              `SELECT d.id, d.status, d.caption_es, d.x_post_es, d.created_at,
                      a.title, a.source, a.url
               FROM drafts d JOIN articles a ON a.id = d.article_id
               ORDER BY d.id`,
            )
            .all()
        : db
            .prepare(
              `SELECT d.id, d.status, d.caption_es, d.x_post_es, d.created_at,
                      a.title, a.source, a.url
               FROM drafts d JOIN articles a ON a.id = d.article_id
               WHERE d.status = ? ORDER BY d.id`,
            )
            .all(filter)
    ) as DraftPreviewRow[];

    if (rows.length === 0) {
      console.log(`No ${filter} drafts.`);
      return;
    }
    for (const row of rows) {
      console.log(formatDraftPreview(row));
    }
  } catch (err) {
    console.error(`previewDrafts failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  // No secrets on this path — sanitized printing is still worth it: drafts
  // carry feed-controlled bytes.
  console.error(formatCliFailure('previewDrafts', err, ''));
  process.exitCode = 1;
});

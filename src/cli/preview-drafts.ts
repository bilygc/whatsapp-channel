#!/usr/bin/env tsx
/**
 * `npm run previewDrafts` — M2 preview CLI: print drafts (default `pending`,
 * oldest first) with their Spanish captions AND Twitter/X variants for review
 * before M3 Telegram delivery. Usage: npm run previewDrafts [-- <pending|posted|skipped|all> [--backfill-x]]
 *   --backfill-x regenerates the X variant for pending drafts that have a
 *   WhatsApp caption but caption_x IS NULL (one LLM call per draft, without
 *   touching caption_es), then shows the preview as usual. Display and
 *   backfill only — never any auto-posting to X.
 */
import { config } from 'dotenv';
import { applyMigrations, openDb, resolveDbPath } from '../db/migrate.js';
import { generateXPost, resolveLlmConfig } from '../writer/openrouter.js';
import { scrubToLine } from '../writer/validate.js';
import {
  backfillXVariants,
  formatDraftPreview,
  parsePreviewDraftsArgs,
  type PreviewDraftsArgs,
  type PreviewRow,
} from '../drafts/preview.js';
import { formatCliFailure } from './format.js';

config();

async function main(): Promise<void> {
  let args: PreviewDraftsArgs;
  try {
    args = parsePreviewDraftsArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const db = openDb(resolveDbPath());
  try {
    applyMigrations(db);

    let backfillExit = 0;
    if (args.backfillX) {
      const { apiKey, model } = resolveLlmConfig();
      if (!apiKey) {
        console.error(
          'previewDrafts failed: OPENROUTER_API_KEY is not set (see .env.example) — cannot backfill X variants.',
        );
        process.exitCode = 1;
        return;
      }
      console.log(`Using model: ${model}`);
      const backfill = await backfillXVariants(db, {
        generateX: (article) => generateXPost(article, { fetchFn: fetch, apiKey, model }),
      });
      for (const r of backfill.results) {
        console.log(
          r.ok
            ? `ok: draft ${r.draftId} -> x variant stored`
            : `FAILED: draft ${r.draftId}: ${scrubToLine(r.error ?? '')}`,
        );
      }
      if (backfill.total === 0) {
        console.log('backfill-x: nothing to do (no pending drafts missing X variants).');
      } else {
        console.log(
          `backfill-x: pending-missing=${backfill.total} filled=${backfill.filled} failed=${backfill.failed}`,
        );
      }
      backfillExit = backfill.exitCode;
    }

    const rows = (
      args.filter === 'all'
        ? db
            .prepare(
              `SELECT d.id, d.status, d.caption_es, d.caption_x, d.created_at,
                      a.title, a.source, a.url
               FROM drafts d JOIN articles a ON a.id = d.article_id
               ORDER BY d.id`,
            )
            .all()
        : db
            .prepare(
              `SELECT d.id, d.status, d.caption_es, d.caption_x, d.created_at,
                      a.title, a.source, a.url
               FROM drafts d JOIN articles a ON a.id = d.article_id
               WHERE d.status = ? ORDER BY d.id`,
            )
            .all(args.filter)
    ) as PreviewRow[];

    if (rows.length === 0) {
      console.log(`No ${args.filter} drafts.`);
      process.exitCode = backfillExit;
      return;
    }
    for (const row of rows) {
      console.log(formatDraftPreview(row));
      console.log();
    }
    process.exitCode = backfillExit;
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

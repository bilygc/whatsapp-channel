import type Database from 'better-sqlite3';
import type { LlmArticle } from '../writer/openrouter.js';
import { saveDraft } from '../writer/run.js';
import { normalizeXPost, scrub, scrubToLine } from '../writer/validate.js';

/**
 * Draft preview + X-variant backfill (display and backfill only — never any
 * auto-posting to X).
 *
 * The Twitter/X variant (`drafts.caption_x`, nullable per migration 0004)
 * postdates most drafts, so pending rows with `caption_x IS NULL` are the
 * normal case, not a data gap. This module gives the operator two things:
 * - `formatDraftPreview`: one paste-ready block per draft showing the article,
 *   the WhatsApp caption, and the X post (or a `— no X variant —` marker).
 * - `backfillXVariants`: regenerate the X variant for pending drafts that
 *   have `caption_es` but `caption_x IS NULL`, through the writer's own
 *   `normalizeXPost` + `saveDraft` upsert path. `caption_es` bytes are passed
 *   back untouched — the backfill never rewrites the WhatsApp caption.
 */

export interface PreviewDraftsArgs {
  /** Draft status filter (pending|posted|skipped|all). */
  filter: string;
  /** Regenerate missing X variants before showing the preview. */
  backfillX: boolean;
}

const PREVIEW_STATUSES = ['pending', 'posted', 'skipped'] as const;

export const PREVIEW_USAGE =
  'npm run previewDrafts [-- <pending|posted|skipped|all> [--backfill-x]]';

/**
 * Parse `npm run previewDrafts [-- ...]` args. Throws a typed
 * `previewDrafts failed: ...` error on bad input (never a raw throw).
 */
export function parsePreviewDraftsArgs(argv: string[]): PreviewDraftsArgs {
  let filter: string | undefined;
  let backfillX = false;
  for (const token of argv) {
    if (token === '--backfill-x') {
      backfillX = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      throw new Error(`previewDrafts failed: usage: ${PREVIEW_USAGE}`);
    }
    if (token.startsWith('--')) {
      throw new Error(
        `previewDrafts failed: unknown flag "${token}" (usage: ${PREVIEW_USAGE})`,
      );
    }
    if (filter !== undefined) {
      throw new Error(
        `previewDrafts failed: expected a single status filter (usage: ${PREVIEW_USAGE})`,
      );
    }
    filter = token;
  }
  const resolved = filter ?? 'pending';
  if (resolved !== 'all' && !(PREVIEW_STATUSES as readonly string[]).includes(resolved)) {
    throw new Error(
      `previewDrafts failed: status must be one of pending|posted|skipped|all (got "${resolved}")`,
    );
  }
  return { filter: resolved, backfillX };
}

export interface PreviewRow {
  id: number;
  status: string;
  caption_es: string;
  caption_x: string | null;
  created_at: string;
  title: string;
  source: string;
  url: string;
}

/**
 * One paste-ready preview block for a draft: article title/source, the
 * WhatsApp caption, and the X post — or a clear marker when the draft
 * predates the X variant. Feed-controlled fields go through the scrub
 * helpers (display-only; the DB is untouched).
 */
export function formatDraftPreview(row: PreviewRow): string {
  return [
    `=== draft ${row.id} [${row.status}] (${row.created_at}) ===`,
    `Article: ${scrubToLine(row.title)}`,
    `Source: ${scrubToLine(row.source)} ${scrubToLine(row.url)}`,
    '--- caption (paste-ready) ---',
    scrub(row.caption_es),
    '',
    '--- X post (paste-ready) ---',
    row.caption_x === null ? '— no X variant —' : scrub(row.caption_x),
  ].join('\n');
}

export interface BackfillXDeps {
  /** One LLM call per draft (injectable seam — mocked in tests). */
  generateX: (article: LlmArticle) => Promise<string>;
}

export interface BackfillXResult {
  draftId: number;
  articleId: number;
  ok: boolean;
  error?: string;
}

export interface BackfillXSummary {
  results: BackfillXResult[];
  total: number;
  filled: number;
  failed: number;
  /** 1 only when at least one draft was attempted and ALL failed. */
  exitCode: number;
}

interface BackfillCandidate {
  draftId: number;
  articleId: number;
  caption_es: string;
  title: string;
  source: string;
  url: string;
}

/**
 * Regenerate the X variant for every `pending` draft with `caption_x IS
 * NULL`: one LLM call each → `normalizeXPost` → `saveDraft` upsert with the
 * EXISTING `caption_es` passed back byte-identical (status, timestamps, and
 * send-once tracking columns are preserved by the upsert, exactly like a
 * writer regenerate). Failures are isolated per draft (LLM error, bad
 * output, or SQLite hiccup): the error is recorded, the draft keeps
 * `caption_x = NULL` for a retry, and the rest still fill. Throws a typed
 * `backfillX failed: <cause>` error only when the run itself cannot start
 * (e.g. drafts table unreadable).
 */
export async function backfillXVariants(
  db: Database.Database,
  deps: BackfillXDeps,
): Promise<BackfillXSummary> {
  let rows: BackfillCandidate[];
  try {
    rows = db
      .prepare(
        `SELECT d.id AS draftId, d.article_id AS articleId, d.caption_es AS caption_es,
                a.title AS title, a.source AS source, a.url AS url
         FROM drafts d JOIN articles a ON a.id = d.article_id
         WHERE d.status = 'pending' AND d.caption_x IS NULL
         ORDER BY d.id`,
      )
      .all() as BackfillCandidate[];
  } catch (err) {
    throw new Error(`backfillX failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const results: BackfillXResult[] = [];
  for (const row of rows) {
    try {
      const article: LlmArticle = { id: row.articleId, title: row.title, source: row.source, url: row.url };
      const rawX = await deps.generateX(article);
      const captionX = normalizeXPost({ caption: rawX, source: row.source, url: row.url });
      saveDraft(db, row.articleId, row.caption_es, captionX);
      results.push({ draftId: row.draftId, articleId: row.articleId, ok: true });
    } catch (err) {
      // Per-draft isolation: record and continue; caption_es is untouched
      // (saveDraft either upserted both captions or threw before writing)
      // and caption_x stays NULL for a retry.
      results.push({
        draftId: row.draftId,
        articleId: row.articleId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const filled = results.filter((r) => r.ok).length;
  const failed = results.length - filled;
  return {
    results,
    total: results.length,
    filled,
    failed,
    exitCode: results.length > 0 && failed === results.length ? 1 : 0,
  };
}

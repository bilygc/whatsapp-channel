import type Database from 'better-sqlite3';
import type { LlmArticle } from './openrouter.js';
import { normalizeCaption } from './validate.js';

export interface WriterDeps {
  now: () => Date;
  /** One LLM call per article (injectable seam — mocked in tests). */
  generate: (article: LlmArticle) => Promise<string>;
  /**
   * Max `selected` rows to process this run (default: all — the standalone
   * `npm run write` behavior). The cron deliver step passes its selection
   * count so one run never spends more than ~4 LLM calls even when stale
   * `selected` leftovers from a failed run are still waiting.
   */
  limit?: number;
}

export interface ArticleResult {
  articleId: number;
  ok: boolean;
  draftId?: number;
  error?: string;
}

export interface WriteSummary {
  results: ArticleResult[];
  total: number;
  written: number;
  failed: number;
  /** 1 only when at least one article was attempted and ALL failed. */
  exitCode: number;
}

/**
 * Insert or regenerate a draft. `drafts.article_id` is UNIQUE (one draft per
 * article) with ON DELETE RESTRICT — so regenerate is an UPDATE of the
 * existing row's caption, never a delete + reinsert (which would lose delivery
 * state and could orphan FK references). Status/created_at/posted_at/views are
 * preserved on conflict, as are the send-once tracking columns
 * (`last_sent_at`, `telegram_message_id` — delivery history owned by the send
 * step in `src/telegram/send.ts`, never rewritten by a regenerate). Returns
 * the draft id. Throws a typed `draft save failed: <cause>` error (e.g.
 * unknown article FK violation).
 */
export function saveDraft(db: Database.Database, articleId: number, caption: string): number {
  try {
    const row = db
      .prepare(
        `INSERT INTO drafts (article_id, caption_es)
         VALUES (@articleId, @caption)
         ON CONFLICT(article_id) DO UPDATE SET caption_es = excluded.caption_es
         RETURNING id`,
      )
      .get({ articleId, caption }) as { id: number };
    return row.id;
  } catch (err) {
    throw new Error(`draft save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Run the writer over all `selected` articles: one LLM call each → validate →
 * draft (status `pending`) → mark article `used`. Failures are isolated per
 * article (LLM error, bad output, or SQLite hiccup): the error is recorded,
 * the article stays `selected` for a retry, and the rest of the run continues.
 * A failed run never loses a draft or an article. Throws a typed
 * `writer run failed: <cause>` error only when the run itself cannot start
 * (e.g. articles table unreadable).
 */
export async function runWriter(db: Database.Database, deps: WriterDeps): Promise<WriteSummary> {
  let articles: LlmArticle[];
  try {
    // Bound per-run write set: the cron deliver step caps LLM calls at its
    // selection count even when stale `selected` leftovers are waiting.
    // Bound parameter (never interpolation) for the LIMIT value.
    if (deps.limit !== undefined) {
      const n = Math.max(0, Math.floor(deps.limit));
      articles = db
        .prepare(`SELECT id, title, source, url FROM articles WHERE status = 'selected' ORDER BY id LIMIT ?`)
        .all(n) as LlmArticle[];
    } else {
      articles = db
        .prepare(
          `SELECT id, title, source, url FROM articles WHERE status = 'selected' ORDER BY id`,
        )
        .all() as LlmArticle[];
    }
  } catch (err) {
    throw new Error(`writer run failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const results: ArticleResult[] = [];
  for (const article of articles) {
    try {
      const raw = await deps.generate(article);
      const caption = normalizeCaption({ caption: raw, source: article.source, url: article.url });
      const draftId = saveDraft(db, article.id, caption);
      db.prepare(`UPDATE articles SET status = 'used' WHERE id = ?`).run(article.id);
      results.push({ articleId: article.id, ok: true, draftId });
    } catch (err) {
      // Per-article isolation: record and continue; the article stays
      // `selected` (retryable) and any existing draft row is untouched.
      results.push({
        articleId: article.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const written = results.filter((r) => r.ok).length;
  const failed = results.length - written;
  return {
    results,
    total: results.length,
    written,
    failed,
    exitCode: results.length > 0 && failed === results.length ? 1 : 0,
  };
}

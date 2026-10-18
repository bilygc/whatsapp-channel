import Database from 'better-sqlite3';
import { canonicalizeUrl, hashCanonicalUrl } from './canonical.js';

export interface NewArticle {
  title: string;
  /** Stable source identifier, e.g. 'ign', 'polygon', 'newsdata'. */
  source: string;
  /** Original article URL (stored as-is; the hash uses the canonical form). */
  url: string;
  imageUrl: string | null;
  /** ISO-8601 UTC string. Callers fall back to fetch time when unknown. */
  publishedAt: string;
}

export type InsertOutcome = 'inserted' | 'skipped' | 'invalid';

const insertStmt = (db: Database.Database) =>
  db.prepare(
    `INSERT INTO articles (url_hash, title, source, url, image_url, published_at)
     VALUES (@urlHash, @title, @source, @url, @imageUrl, @publishedAt)
     ON CONFLICT(url_hash) DO NOTHING`,
  );

/**
 * Insert an article, deduping on `url_hash` via the DB UNIQUE constraint.
 * Returns 'inserted' | 'skipped' (duplicate) | 'invalid' (bad URL — never throws).
 * Unexpected SQLite errors (e.g. SQLITE_BUSY after the busy timeout) propagate
 * to the caller, which treats them as a per-source failure.
 */
export function insertArticle(db: Database.Database, article: NewArticle): InsertOutcome {
  let urlHash: string;
  try {
    // Validate first so a malformed URL is 'invalid', not an unhandled throw.
    canonicalizeUrl(article.url);
    urlHash = hashCanonicalUrl(article.url);
  } catch {
    return 'invalid';
  }

  const info = insertStmt(db).run({
    urlHash,
    title: article.title,
    source: article.source,
    url: article.url,
    imageUrl: article.imageUrl,
    publishedAt: article.publishedAt,
  });
  return info.changes === 0 ? 'skipped' : 'inserted';
}

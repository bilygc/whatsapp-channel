import type Database from 'better-sqlite3';
import { NEWSDATA_QUERY, RSS_SOURCES } from './feeds.js';
import { fetchNewsDataSource } from './newsdata.js';
import { fetchRssSource } from './rss.js';
import { insertArticle, type NewArticle } from './store.js';

export interface SourceResult {
  source: string;
  fetched: number;
  inserted: number;
  skipped: number;
  failed: boolean;
  error?: string;
}

export interface FetchSummary {
  sources: SourceResult[];
  fetched: number;
  inserted: number;
  skipped: number;
  failed: number;
  /** 1 only when ALL sources failed; 0 otherwise. */
  exitCode: number;
}

/** Injectable seams for tests (no real network/clock in tests). */
export interface FetchDeps {
  now: () => Date;
  fetchRss: (source: { id: string; feedUrl: string }) => Promise<NewArticle[]>;
  fetchNewsData: () => Promise<NewArticle[]>;
  newsDataApiKey: string | undefined;
}

export function defaultDeps(
  parseURL: (url: string) => Promise<{ items?: unknown[] }>,
  fetchFn: typeof fetch,
  apiKey: string | undefined,
): FetchDeps {
  // Thin adapters from the injectable seams to the real fetchers.
  const now = () => new Date();
  return {
    now,
    fetchRss: (source) =>
      fetchRssSource(source, {
        // rss-parser's parseURL returns its own Output type; cast through unknown.
        parseURL: parseURL as Parameters<typeof fetchRssSource>[1]['parseURL'],
        now: now(),
      }),
    fetchNewsData: () =>
      fetchNewsDataSource(
        { apiKey: apiKey as string, query: NEWSDATA_QUERY },
        { fetchFn, now: now() },
      ),
    newsDataApiKey: apiKey,
  };
}

/**
 * Run one fetch pass over all sources with per-source isolation: each source
 * is try/caught individually, so one broken feed or API never fails the run.
 * Inserts dedupe on articles.url_hash (ON CONFLICT DO NOTHING). Missing
 * NEWSDATA_API_KEY skips NewsData with a warning, RSS still runs.
 */
export async function runFetch(db: Database.Database, deps: FetchDeps): Promise<FetchSummary> {
  const sources: SourceResult[] = [];

  for (const source of RSS_SOURCES) {
    sources.push(await runOneSource(db, source.id, () => deps.fetchRss(source), deps.now));
  }

  if (deps.newsDataApiKey) {
    sources.push(
      await runOneSource(db, 'newsdata', () => deps.fetchNewsData(), deps.now),
    );
  } else {
    sources.push({
      source: 'newsdata',
      fetched: 0,
      inserted: 0,
      skipped: 0,
      failed: false,
      error: 'skipped: NEWSDATA_API_KEY not set',
    });
  }

  const summary: FetchSummary = {
    sources,
    fetched: sources.reduce((n, s) => n + s.fetched, 0),
    inserted: sources.reduce((n, s) => n + s.inserted, 0),
    skipped: sources.reduce((n, s) => n + s.skipped, 0),
    failed: sources.filter((s) => s.failed).length,
    exitCode: 0,
  };
  // Non-zero exit only if EVERYTHING failed (but not when NewsData was merely skipped).
  const attempted = sources.filter((s) => s.error !== 'skipped: NEWSDATA_API_KEY not set');
  if (attempted.length > 0 && attempted.every((s) => s.failed)) {
    summary.exitCode = 1;
  }
  return summary;
}

async function runOneSource(
  db: Database.Database,
  id: string,
  fetchFn: () => Promise<NewArticle[]>,
  now: () => Date,
): Promise<SourceResult> {
  const result: SourceResult = {
    source: id,
    fetched: 0,
    inserted: 0,
    skipped: 0,
    failed: false,
  };
  let articles: NewArticle[];
  try {
    articles = await fetchFn();
  } catch (err) {
    result.failed = true;
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }

  result.fetched = articles.length;
  for (const item of articles) {
    // Belt-and-braces date fallback: published_at is NOT NULL.
    if (!item.publishedAt) item.publishedAt = now().toISOString();
    let outcome: string;
    try {
      outcome = insertArticle(db, item);
    } catch (err) {
      // Unexpected DB error (e.g. SQLITE_BUSY): count the item skipped, keep the run alive.
      result.skipped += 1;
      result.error = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (outcome === 'inserted') result.inserted += 1;
    else result.skipped += 1;
  }
  return result;
}

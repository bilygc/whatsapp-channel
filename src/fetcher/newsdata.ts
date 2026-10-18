import type { NewArticle } from './store.js';

export interface NewsDataOptions {
  apiKey: string;
  /** Free-text query, e.g. 'video games'. */
  query: string;
  /** Max pages to pull (free tier is quota-limited; default 1). */
  maxPages?: number;
  language?: string;
}

export interface NewsDataDeps {
  fetchFn: typeof fetch;
  now: Date;
}

interface NewsDataItem {
  title?: unknown;
  link?: unknown;
  pubDate?: unknown;
  image_url?: unknown;
}

function toIsoUtc(value: unknown, fallback: Date): string {
  if (typeof value === 'string' && value.trim() !== '') {
    // NewsData returns 'YYYY-MM-DD HH:mm:ss' (no TZ, assumed UTC).
    const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
    const ms = Date.parse(normalized);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return fallback.toISOString();
}

/**
 * Fetch NewsData.io latest news for the query. Throws a typed
 * `newsdata fetch failed: <cause>` error on HTTP errors (invalid key, 429
 * rate limit/quota), unexpected shapes, or network failures — callers catch
 * per source so RSS results survive a NewsData outage.
 */
export async function fetchNewsDataSource(
  options: NewsDataOptions,
  deps: NewsDataDeps,
): Promise<NewArticle[]> {
  const articles: NewArticle[] = [];
  let page: string | undefined;

  const pages = Math.max(1, options.maxPages ?? 1);
  try {
    for (let i = 0; i < pages; i++) {
      const params = new URLSearchParams({
        apikey: options.apiKey,
        q: options.query,
        language: options.language ?? 'en',
        size: '10',
      });
      if (page) params.set('page', page);
      const res = await deps.fetchFn(`https://newsdata.io/api/1/latest?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        status?: unknown;
        results?: unknown;
        nextPage?: unknown;
      };
      if (body.status !== 'success' || !Array.isArray(body.results)) {
        throw new Error('unexpected response shape');
      }
      for (const raw of body.results as NewsDataItem[]) {
        const title = typeof raw.title === 'string' ? raw.title.trim() : '';
        const link = typeof raw.link === 'string' ? raw.link.trim() : '';
        if (title === '' || link === '') continue;
        articles.push({
          title,
          source: 'newsdata',
          url: link,
          imageUrl: typeof raw.image_url === 'string' && raw.image_url !== '' ? raw.image_url : null,
          publishedAt: toIsoUtc(raw.pubDate, deps.now),
        });
      }
      page = typeof body.nextPage === 'string' ? body.nextPage : undefined;
      if (!page) break;
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('newsdata fetch failed:')) throw err;
    throw new Error(
      `newsdata fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return articles;
}

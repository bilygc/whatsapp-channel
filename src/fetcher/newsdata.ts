import { isSafeWebUrl } from './canonical.js';
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
  /** Max response body size in bytes (default NEWSDATA_MAX_BODY_BYTES). */
  maxBytes?: number;
}

/** Default cap for a NewsData response body (~5 MB) — oversize bodies fail the source. */
export const NEWSDATA_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Per-request timeout: a stalled NewsData connection must not hang the run. */
export const NEWSDATA_TIMEOUT_MS = 15_000;

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

function declaredLength(res: Response): number | null {
  try {
    const raw = res.headers?.get('content-length');
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Parse a JSON body with a byte cap enforced BEFORE parsing (memory-DoS
 * guard). Checks the declared content-length first, then the actual bytes.
 * Test doubles that only implement `json()` fall back to a serialized-size
 * approximation. Throws on oversize or unparseable bodies.
 */
async function readJsonCapped(res: Response, maxBytes: number): Promise<unknown> {
  const declared = declaredLength(res);
  if (declared != null && declared > maxBytes) {
    throw new Error(`response body too large (${declared} bytes declared, limit ${maxBytes})`);
  }
  const raw = res as Response & {
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof raw.arrayBuffer === 'function') {
    const buf = await raw.arrayBuffer.call(res);
    if (buf.byteLength > maxBytes) {
      throw new Error(`response body too large (${buf.byteLength} bytes, limit ${maxBytes})`);
    }
    return JSON.parse(Buffer.from(buf).toString('utf8'));
  }
  const body = await res.json();
  const approx = JSON.stringify(body)?.length ?? 0;
  if (approx > maxBytes) {
    throw new Error(`response body too large (limit ${maxBytes} bytes)`);
  }
  return body;
}

/** Strip secrets (API key, full request URL incl. query string) from an error message. */
function sanitize(message: string, secrets: string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * Fetch NewsData.io latest news for the query. Throws a typed
 * `newsdata fetch failed: <cause>` error on HTTP errors (invalid key, 429
 * rate limit/quota), oversize bodies, unexpected shapes, or network failures
 * (incl. redirect rejections and timeouts) — callers catch per source so RSS
 * results survive a NewsData outage. Error messages never contain the API key
 * or request URL.
 */
export async function fetchNewsDataSource(
  options: NewsDataOptions,
  deps: NewsDataDeps,
): Promise<NewArticle[]> {
  const articles: NewArticle[] = [];
  let page: string | undefined;
  const maxBytes = deps.maxBytes ?? NEWSDATA_MAX_BODY_BYTES;

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
      const url = `https://newsdata.io/api/1/latest?${params.toString()}`;
      let res: Response;
      try {
        // /latest never legitimately redirects; the API key rides in the
        // query string, so fail closed rather than leak it to a redirect
        // target. The timeout keeps a stalled connection from hanging the run.
        res = await deps.fetchFn(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(NEWSDATA_TIMEOUT_MS),
        });
      } catch (err) {
        // Redact longest-first: the URL embeds the key, so redact the URL
        // before the bare key to avoid a partial-match miss.
        throw new Error(
          `request failed: ${sanitize(err instanceof Error ? err.message : String(err), [url, options.apiKey])}`,
        );
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await readJsonCapped(res, maxBytes)) as {
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
          // A bad image URL degrades to NULL — never a drop-the-article condition.
          imageUrl: isSafeWebUrl(raw.image_url) ? (raw.image_url as string).trim() : null,
          publishedAt: toIsoUtc(raw.pubDate, deps.now),
        });
      }
      page = typeof body.nextPage === 'string' ? body.nextPage : undefined;
      if (!page) break;
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('newsdata fetch failed:')) throw err;
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`newsdata fetch failed: ${sanitize(cause, [options.apiKey])}`);
  }
  return articles;
}

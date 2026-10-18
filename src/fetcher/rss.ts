import type Parser from 'rss-parser';
import { isSafeWebUrl } from './canonical.js';
import type { NewArticle } from './store.js';

export interface RssSource {
  id: string;
  feedUrl: string;
}

export interface RssDeps {
  fetchFn: typeof fetch;
  parseString: Parser['parseString'];
  now: Date;
  /** Max feed body size in bytes (default RSS_MAX_BODY_BYTES). */
  maxBytes?: number;
  /** Per-request timeout in ms (default RSS_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** Default cap for a feed body (~5 MB) — oversize bodies fail the source. */
export const RSS_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Default per-request timeout: a stalled feed must not hang the run. */
export const RSS_TIMEOUT_MS = 15_000;

function toIsoUtc(value: unknown, fallback: Date): string {
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return fallback.toISOString();
}

function firstImage(item: Record<string, unknown>): string | null {
  const candidates: unknown[] = [];
  const enclosure = item.enclosure as { url?: unknown } | undefined;
  if (enclosure) candidates.push(enclosure.url);
  const media = item['media:content'] as { $?: { url?: unknown } } | undefined;
  if (media?.$) candidates.push(media.$.url);
  candidates.push(item.image, item.image_url);
  for (const candidate of candidates) {
    // A bad image URL degrades to NULL — never a drop-the-article condition.
    if (isSafeWebUrl(candidate)) return (candidate as string).trim();
  }
  return null;
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
 * Read a text body with a byte cap enforced WHILE streaming (memory-DoS
 * guard): the declared content-length is checked first, then chunks are
 * counted as they arrive and the stream is cancelled on overflow. Test
 * doubles that only implement `text()` fall back to a post-read byte check.
 */
async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = declaredLength(res);
  if (declared != null && declared > maxBytes) {
    throw new Error(`response body too large (${declared} bytes declared, limit ${maxBytes})`);
  }
  const stream = res.body as ReadableStream<Uint8Array> | null;
  if (stream != null && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new Error(`response body too large (exceeds ${maxBytes} bytes)`);
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(`response body too large (limit ${maxBytes} bytes)`);
  }
  return text;
}

/**
 * Fetch one RSS feed and map items to NewArticles. Items missing a link or
 * title are dropped (nothing storable); items missing a date fall back to
 * fetch time (`published_at` is NOT NULL). Network/HTTP/oversize/parse
 * failures throw a typed `rss fetch failed for "<id>": <cause>` error —
 * callers catch per source. Redirects follow feed defaults; the timeout and
 * body cap keep a hostile or stalled feed from hanging or OOMing the run.
 */
export async function fetchRssSource(source: RssSource, deps: RssDeps): Promise<NewArticle[]> {
  const maxBytes = deps.maxBytes ?? RSS_MAX_BODY_BYTES;
  const timeoutMs = deps.timeoutMs ?? RSS_TIMEOUT_MS;
  let xml: string;
  try {
    const res = await deps.fetchFn(source.feedUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    xml = await readTextCapped(res, maxBytes);
  } catch (err) {
    throw new Error(
      `rss fetch failed for "${source.id}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let feed: Awaited<ReturnType<RssDeps['parseString']>>;
  try {
    feed = await deps.parseString(xml);
  } catch (err) {
    throw new Error(
      `rss fetch failed for "${source.id}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const articles: NewArticle[] = [];
  for (const raw of feed.items ?? []) {
    const item = raw as Record<string, unknown>;
    const link = typeof item.link === 'string' ? item.link.trim() : '';
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (link === '' || title === '') continue; // malformed item: skip, keep the rest
    articles.push({
      title,
      source: source.id,
      url: link,
      imageUrl: firstImage(item),
      publishedAt: toIsoUtc(item.isoDate ?? item.pubDate, deps.now),
    });
  }
  return articles;
}

import type Parser from 'rss-parser';
import type { NewArticle } from './store.js';

export interface RssSource {
  id: string;
  feedUrl: string;
}

export interface RssDeps {
  parseURL: Parser['parseURL'];
  now: Date;
}

function toIsoUtc(value: unknown, fallback: Date): string {
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return fallback.toISOString();
}

function firstImage(item: Record<string, unknown>): string | null {
  const enclosure = item.enclosure as { url?: unknown } | undefined;
  if (enclosure && typeof enclosure.url === 'string' && enclosure.url !== '') {
    return enclosure.url;
  }
  const media = item['media:content'] as { $?: { url?: unknown } } | undefined;
  if (media?.$ && typeof media.$.url === 'string' && media.$.url !== '') {
    return media.$.url;
  }
  if (typeof item.image === 'string' && item.image !== '') return item.image;
  if (typeof item.image_url === 'string' && item.image_url !== '') {
    return item.image_url as string;
  }
  return null;
}

/**
 * Fetch one RSS feed and map items to NewArticles. Items missing a link or
 * title are dropped (nothing storable); items missing a date fall back to
 * fetch time (`published_at` is NOT NULL). Network/parse failures throw a
 * typed `rss fetch failed for "<id>": <cause>` error — callers catch per source.
 */
export async function fetchRssSource(source: RssSource, deps: RssDeps): Promise<NewArticle[]> {
  let feed: Awaited<ReturnType<RssDeps['parseURL']>>;
  try {
    feed = await deps.parseURL(source.feedUrl);
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

import type { RssSource } from './rss.js';

/**
 * RSS feeds for M1, verified live (HTTP 200) on 2026-10-17. If one rots,
 * per-source degradation in run.ts keeps the rest of the run green —
 * fix the URL here, no orchestrator changes needed.
 */
export const RSS_SOURCES: RssSource[] = [
  { id: 'ign', feedUrl: 'https://feeds.ign.com/ign/all' },
  { id: 'polygon', feedUrl: 'https://www.polygon.com/rss/index.xml' },
  { id: 'eurogamer', feedUrl: 'https://www.eurogamer.net/feed' },
  { id: 'gematsu', feedUrl: 'https://www.gematsu.com/feed' },
  { id: 'nintendolife', feedUrl: 'https://www.nintendolife.com/feeds/news' },
  { id: 'gamedeveloper', feedUrl: 'https://www.gamedeveloper.com/rss.xml' },
];

export const NEWSDATA_QUERY = 'video games';

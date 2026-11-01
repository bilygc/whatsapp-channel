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
  { id: 'gamesreactor', feedUrl: 'https://www.gamereactor.es/rss/rss.php?texttype=0&system=0' },
  { id: 'vidaextra', feedUrl: 'https://www.vidaextra.com/feedburner.xml' },
  { id: 'kotaku', feedUrl: 'https://kotaku.com/feed' },
  { id: 'pcgamer', feedUrl: 'https://www.pcgamer.com/rss/' },
  { id: 'gamespot', feedUrl: 'https://www.gamespot.com/feeds/mashup/'},
  { id: 'gameinformer', feedUrl: 'https://www.gameinformer.com/rss.xml' },
  { id: 'xboxwire', feedUrl: 'https://news.xbox.com/en-us/feed/' },
];

export const NEWSDATA_QUERY = 'video games';

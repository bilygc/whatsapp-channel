import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchNewsDataSource } from './newsdata.js';
import { fetchRssSource } from './rss.js';

const IGN_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
<title>IGN All</title>
<link>https://www.ign.com</link>
<item>
<title>GTA 6 Trailer Breakdown</title>
<link>https://www.ign.com/articles/gta-6-trailer?utm_source=rss</link>
<pubDate>Fri, 17 Oct 2026 09:00:00 GMT</pubDate>
<enclosure url="https://example.com/gta.jpg" type="image/jpeg"/>
</item>
<item>
<title>Item without a date</title>
<link>https://www.ign.com/articles/no-date-item</link>
</item>
<item>
<title>Item without a link</title>
<pubDate>Fri, 17 Oct 2026 08:00:00 GMT</pubDate>
</item>
<item>
<link>https://www.ign.com/articles/no-title-item</link>
<pubDate>Fri, 17 Oct 2026 08:00:00 GMT</pubDate>
</item>
</channel>
</rss>`;

describe('fetchRssSource (HTTP layer mocked — no real network)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses items, canonicalizes URLs, falls back to fetch time for missing dates', async () => {
    const parser = {
      parseURL: vi.fn(async (_url: string) => {
        const Parser = (await import('rss-parser')).default;
        return new Parser().parseString(IGN_RSS);
      }),
    };
    const now = new Date('2026-10-17T12:00:00.000Z');
    const articles = await fetchRssSource(
      { id: 'ign', feedUrl: 'https://feeds.ign.com/ign/all' },
      { parseURL: parser.parseURL, now },
    );
    // 4 raw items: 2 fully valid, 1 missing date (fallback), 1 missing link (dropped),
    // 1 missing title (dropped) — wait, count: no-date kept, no-link dropped, no-title dropped.
    expect(articles).toHaveLength(2);
    expect(articles[0]).toMatchObject({
      source: 'ign',
      title: 'GTA 6 Trailer Breakdown',
      url: 'https://www.ign.com/articles/gta-6-trailer?utm_source=rss',
      imageUrl: 'https://example.com/gta.jpg',
      publishedAt: '2026-10-17T09:00:00.000Z',
    });
    expect(articles[1]).toMatchObject({
      title: 'Item without a date',
      publishedAt: '2026-10-17T12:00:00.000Z',
    });
  });

  it('throws a typed error (never a raw network error) when the feed is unreachable', async () => {
    const err = await fetchRssSource(
      { id: 'ign', feedUrl: 'https://feeds.ign.com/ign/all' },
      {
        parseURL: async () => {
          throw new Error('socket hang up');
        },
        now: new Date('2026-10-17T12:00:00.000Z'),
      },
    ).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(err).toMatch(/rss fetch failed for "ign"/);
    expect(err).toMatch(/socket hang up/);
  });

  it('throws a typed error on malformed XML', async () => {
    await expect(
      fetchRssSource(
        { id: 'ign', feedUrl: 'https://feeds.ign.com/ign/all' },
        {
          parseURL: async () => {
            const Parser = (await import('rss-parser')).default;
            return new Parser().parseString('<rss><broken');
          },
          now: new Date('2026-10-17T12:00:00.000Z'),
        },
      ),
    ).rejects.toThrow(/rss fetch failed for "ign"/);
  });
});

describe('fetchNewsDataSource (fetch mocked — no real network, no API key)', () => {
  afterEach(() => vi.restoreAllMocks());

  function mockFetch(payload: unknown, status = 200) {
    return vi.fn(async (_url: string) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    })) as unknown as typeof fetch;
  }

  it('maps results to articles and falls back to fetch time on missing dates', async () => {
    const articles = await fetchNewsDataSource(
      { apiKey: 'k', query: 'video games' },
      {
        fetchFn: mockFetch({
          status: 'success',
          results: [
            {
              title: 'Big game announced',
              link: 'https://example.com/big?utm_source=x',
              pubDate: '2026-10-17 09:30:00',
              image_url: 'https://example.com/big.jpg',
              source_id: 'somegamesite',
            },
            {
              title: 'No date story',
              link: 'https://example.com/nodate',
              pubDate: null,
              image_url: null,
              source_id: 'other',
            },
            { title: null, link: 'https://example.com/notitle' },
          ],
        }),
        now: new Date('2026-10-17T12:00:00.000Z'),
      },
    );
    expect(articles).toHaveLength(2);
    expect(articles[0]).toMatchObject({
      source: 'newsdata',
      title: 'Big game announced',
      publishedAt: '2026-10-17T09:30:00.000Z',
    });
    expect(articles[1].publishedAt).toBe('2026-10-17T12:00:00.000Z');
  });

  it('throws a typed error on invalid key / rate limit (never raw)', async () => {
    await expect(
      fetchNewsDataSource(
        { apiKey: 'bad', query: 'video games' },
        { fetchFn: mockFetch({ status: 'error', message: 'rate limit' }, 429), now: new Date() },
      ),
    ).rejects.toThrow(/newsdata fetch failed/);
  });

  it('throws a typed error on unexpected response shape', async () => {
    await expect(
      fetchNewsDataSource(
        { apiKey: 'k', query: 'video games' },
        { fetchFn: mockFetch({ unexpected: true }), now: new Date() },
      ),
    ).rejects.toThrow(/newsdata fetch failed/);
  });

  it('throws a typed error on network failure', async () => {
    const failing = (async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    await expect(
      fetchNewsDataSource({ apiKey: 'k', query: 'video games' }, { fetchFn: failing, now: new Date() }),
    ).rejects.toThrow(/newsdata fetch failed.*fetch failed/);
  });
});

describe('migration runner', () => {
  it('applies 0001_init.sql to a fresh DB and sets user_version=1 (idempotent)', async () => {
    const { applyMigrations, getUserVersion } = await import('../db/migrate.js');
    const db = new Database(':memory:');
    try {
      const appliedFirst = applyMigrations(db);
      expect(appliedFirst).toContain('0001_init.sql');
      expect(getUserVersion(db)).toBe(1);
      expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE name = 'articles'`).get(),
      ).toBeTruthy();
      const appliedSecond = applyMigrations(db);
      expect(appliedSecond).toEqual([]);
    } finally {
      db.close();
    }
  });
});

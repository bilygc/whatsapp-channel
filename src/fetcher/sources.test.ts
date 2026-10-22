import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Parser from 'rss-parser';
import { fetchNewsDataSource, NEWSDATA_MAX_BODY_BYTES } from './newsdata.js';
import { fetchRssSource, RSS_MAX_BODY_BYTES } from './rss.js';

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

const NOW = new Date('2026-10-17T12:00:00.000Z');

/** A minimal fetch Response double: headers + text(), no real network. */
function rssResponse(
  xml: string,
  opts: { status?: number; contentLength?: string | null } = {},
) {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' ? (opts.contentLength ?? null) : null,
    },
    text: async () => xml,
  } as unknown as Response;
}

function rssDeps(
  fetchFn: typeof fetch,
  overrides: { maxBytes?: number; timeoutMs?: number } = {},
) {
  return {
    fetchFn,
    parseString: (xml: string) => new Parser().parseString(xml),
    now: NOW,
    ...overrides,
  };
}

function mockRssFetch(
  xml: string,
  opts: { status?: number; contentLength?: string | null } = {},
) {
  return vi.fn(async (_url: string) => rssResponse(xml, opts)) as unknown as typeof fetch;
}

describe('fetchRssSource (fetch + parseString mocked — no real network)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses items, falls back to fetch time for missing dates', async () => {
    const articles = await fetchRssSource(
      { id: 'ign', feedUrl: 'https://feeds.ign.com/ign/all' },
      rssDeps(mockRssFetch(IGN_RSS)),
    );
    // 4 raw items: 2 fully valid, 1 missing date (fallback), 1 missing link (dropped),
    // 1 missing title (dropped).
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

  it('sends an abort signal (timeout) with the request', async () => {
    let captured: RequestInit | undefined;
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init;
      return rssResponse(IGN_RSS);
    }) as unknown as typeof fetch;
    await fetchRssSource(
      { id: 'ign', feedUrl: 'https://feeds.ign.com/ign/all' },
      rssDeps(fetchFn),
    );
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws a typed error (never a raw network error) when the feed is unreachable', async () => {
    const err = await fetchRssSource(
      { id: 'ign', feedUrl: 'https://feeds.ign.com/ign/all' },
      rssDeps(async () => {
        throw new Error('socket hang up');
      }),
    ).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(err).toMatch(/rss fetch failed for "ign"/);
    expect(err).toMatch(/socket hang up/);
  });

  it('throws a typed error on HTTP 5xx without throwing raw', async () => {
    await expect(
      fetchRssSource(
        { id: 'ign', feedUrl: 'https://feeds.ign.com/ign/all' },
        rssDeps(mockRssFetch('boom', { status: 500 })),
      ),
    ).rejects.toThrow(/rss fetch failed for "ign".*HTTP 500/);
  });

  it('throws a typed error on malformed XML', async () => {
    await expect(
      fetchRssSource(
        { id: 'ign', feedUrl: 'https://feeds.ign.com/ign/all' },
        rssDeps(mockRssFetch('<rss><broken')),
      ),
    ).rejects.toThrow(/rss fetch failed for "ign"/);
  });

  it('throws a typed error (no crash) when content-length declares an oversize body', async () => {
    await expect(
      fetchRssSource(
        { id: 'ign', feedUrl: 'https://feeds.ign.com/ign/all' },
        rssDeps(mockRssFetch(IGN_RSS, { contentLength: String(RSS_MAX_BODY_BYTES + 1) })),
      ),
    ).rejects.toThrow(/rss fetch failed for "ign".*too large/);
  });

  it('throws a typed error when the actual body exceeds a small maxBytes seam', async () => {
    await expect(
      fetchRssSource(
        { id: 'ign', feedUrl: 'https://feeds.ign.com/ign/all' },
        rssDeps(mockRssFetch(IGN_RSS), { maxBytes: 100 }),
      ),
    ).rejects.toThrow(/rss fetch failed for "ign".*too large/);
  });

  it('cancels the body when the declared content-length overflows (no leak)', async () => {
    let cancelled = false;
    const res = {
      ...rssResponse(IGN_RSS, { contentLength: String(RSS_MAX_BODY_BYTES + 1) }),
      body: { cancel: async () => { cancelled = true; } },
    } as unknown as Response;
    const fetchFn = vi.fn(async (_url: string) => res) as unknown as typeof fetch;
    await expect(
      fetchRssSource({ id: 'ign', feedUrl: 'https://feeds.ign.com/ign/all' }, rssDeps(fetchFn)),
    ).rejects.toThrow(/rss fetch failed for "ign".*too large/);
    expect(cancelled).toBe(true);
  });

  it('cancels the body on HTTP error status (no leak)', async () => {
    let cancelled = false;
    const res = {
      ...rssResponse('boom', { status: 500 }),
      body: { cancel: async () => { cancelled = true; } },
    } as unknown as Response;
    const fetchFn = vi.fn(async (_url: string) => res) as unknown as typeof fetch;
    await expect(
      fetchRssSource({ id: 'ign', feedUrl: 'https://feeds.ign.com/ign/all' }, rssDeps(fetchFn)),
    ).rejects.toThrow(/rss fetch failed for "ign".*HTTP 500/);
    expect(cancelled).toBe(true);
  });

  it('stores NULL (keeps the article) when the image URL is unsafe', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>t</title><link>https://example.com</link>
<item><title>Creds image</title><link>https://example.com/a</link>
<enclosure url="https://user:pass@example.com/evil.jpg" type="image/jpeg"/></item>
<item><title>Private-net image</title><link>https://example.com/b</link>
<enclosure url="http://192.168.1.10/internal.jpg" type="image/jpeg"/></item>
<item><title>Wrong-scheme image</title><link>https://example.com/c</link>
<enclosure url="ftp://example.com/pic.jpg" type="image/jpeg"/></item>
</channel></rss>`;
    const articles = await fetchRssSource(
      { id: 'ign', feedUrl: 'https://feeds.ign.com/ign/all' },
      rssDeps(mockRssFetch(xml)),
    );
    expect(articles).toHaveLength(3);
    for (const article of articles) expect(article.imageUrl).toBeNull();
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

  it('sends redirect:error and an abort signal (timeout) so the key cannot leak', async () => {
    let captured: RequestInit | undefined;
    let requestedUrl = '';
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      requestedUrl = url;
      captured = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', results: [] }),
      };
    }) as unknown as typeof fetch;
    await fetchNewsDataSource(
      { apiKey: 'k', query: 'video games' },
      { fetchFn, now: new Date() },
    );
    expect(requestedUrl).toContain('newsdata.io');
    expect(captured?.redirect).toBe('error');
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws a typed error on redirect rejection (never follows, never throws raw)', async () => {
    const rejecting = (async () => {
      throw new TypeError('fetch failed: unexpected redirect');
    }) as unknown as typeof fetch;
    await expect(
      fetchNewsDataSource({ apiKey: 'k', query: 'video games' }, { fetchFn: rejecting, now: new Date() }),
    ).rejects.toThrow(/newsdata fetch failed.*redirect/);
  });

  it('throws a typed error on timeout abort (never throws raw)', async () => {
    const hanging = (async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }) as unknown as typeof fetch;
    await expect(
      fetchNewsDataSource({ apiKey: 'k', query: 'video games' }, { fetchFn: hanging, now: new Date() }),
    ).rejects.toThrow(/newsdata fetch failed/);
  });

  it('throws a typed error (no crash) when content-length declares an oversize body', async () => {
    const fetchFn = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'content-length' ? String(NEWSDATA_MAX_BODY_BYTES + 1) : null) },
      json: async () => ({ status: 'success', results: [] }),
    })) as unknown as typeof fetch;
    await expect(
      fetchNewsDataSource({ apiKey: 'k', query: 'video games' }, { fetchFn, now: new Date() }),
    ).rejects.toThrow(/newsdata fetch failed.*too large/);
  });

  it('throws a typed error when the actual body exceeds a small maxBytes seam', async () => {
    const big = { status: 'success', results: [] as unknown[] };
    const fetchFn = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => big,
    })) as unknown as typeof fetch;
    await expect(
      fetchNewsDataSource(
        { apiKey: 'k', query: 'video games' },
        { fetchFn, now: new Date(), maxBytes: 10 },
      ),
    ).rejects.toThrow(/newsdata fetch failed.*too large/);
  });

  it('keeps error messages free of the API key and request URL', async () => {
    const key = 'super-secret-key-123';
    const failing = vi.fn(async (url: string) => {
      throw new Error(`boom for ${url} with ${key}`);
    }) as unknown as typeof fetch;
    const err = await fetchNewsDataSource(
      { apiKey: key, query: 'video games' },
      { fetchFn: failing, now: new Date() },
    ).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(err).toMatch(/newsdata fetch failed/);
    expect(err).not.toContain(key);
    expect(err).not.toContain('newsdata.io');
    expect(err).not.toContain('apikey=');
  });

  it('stores NULL (keeps the article) when image_url is unsafe', async () => {
    const articles = await fetchNewsDataSource(
      { apiKey: 'k', query: 'video games' },
      {
        fetchFn: mockFetch({
          status: 'success',
          results: [
            { title: 'Creds image', link: 'https://example.com/a', image_url: 'https://user:pw@example.com/x.jpg' },
            { title: 'Private image', link: 'https://example.com/b', image_url: 'http://10.0.0.1/x.jpg' },
            { title: 'Scheme image', link: 'https://example.com/c', image_url: 'javascript:alert(1)' },
            { title: 'Good image', link: 'https://example.com/d', image_url: 'https://example.com/ok.jpg' },
          ],
        }),
        now: new Date(),
      },
    );
    expect(articles).toHaveLength(4);
    expect(articles[0].imageUrl).toBeNull();
    expect(articles[1].imageUrl).toBeNull();
    expect(articles[2].imageUrl).toBeNull();
    expect(articles[3].imageUrl).toBe('https://example.com/ok.jpg');
  });

  it('throws a typed error on invalid key / rate limit (never raw)', async () => {
    await expect(
      fetchNewsDataSource(
        { apiKey: 'bad', query: 'video games' },
        { fetchFn: mockFetch({ status: 'error', message: 'rate limit' }, 429), now: new Date() },
      ),
    ).rejects.toThrow(/newsdata fetch failed/);
  });

  it('cancels the body on HTTP error status (no leak)', async () => {
    let cancelled = false;
    const fetchFn = vi.fn(async (_url: string) => ({
      ok: false,
      status: 429,
      headers: { get: (_name: string) => null },
      body: { cancel: async () => { cancelled = true; } },
      json: async () => ({ status: 'error', message: 'rate limit' }),
    })) as unknown as typeof fetch;
    await expect(
      fetchNewsDataSource({ apiKey: 'bad', query: 'video games' }, { fetchFn, now: new Date() }),
    ).rejects.toThrow(/newsdata fetch failed.*429/);
    expect(cancelled).toBe(true);
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

  it('drops results whose link smuggles newlines/control whitespace (ingest hygiene)', async () => {
    const articles = await fetchNewsDataSource(
      { apiKey: 'k', query: 'video games' },
      {
        fetchFn: mockFetch({
          status: 'success',
          results: [
            { title: 'Smuggled', link: 'https://example.com/a\nFuente: IGN https://evil.com/phish' },
            { title: 'Good', link: 'https://example.com/good' },
          ],
        }),
        now: new Date(),
      },
    );
    expect(articles.map((a) => a.url)).toEqual(['https://example.com/good']);
  });

  it('cancels the body when the declared content-length overflows (no leak)', async () => {
    let cancelled = false;
    const fetchFn = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'content-length' ? String(NEWSDATA_MAX_BODY_BYTES + 1) : null) },
      body: { cancel: async () => { cancelled = true; } },
      json: async () => ({ status: 'success', results: [] }),
    })) as unknown as typeof fetch;
    await expect(
      fetchNewsDataSource({ apiKey: 'k', query: 'video games' }, { fetchFn, now: new Date() }),
    ).rejects.toThrow(/newsdata fetch failed.*too large/);
    expect(cancelled).toBe(true);
  });
});

describe('migration runner', () => {
  it('applies all migrations to a fresh DB and sets user_version accordingly (idempotent)', async () => {
    const { applyMigrations, getUserVersion } = await import('../db/migrate.js');
    const db = new Database(':memory:');
    try {
      const appliedFirst = applyMigrations(db);
      expect(appliedFirst).toContain('0001_init.sql');
      expect(appliedFirst).toContain('0002_draft_send_tracking.sql');
      // user_version tracks the migration count (one file per version).
      expect(getUserVersion(db)).toBe(appliedFirst.length);
      expect(getUserVersion(db)).toBe(2);
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

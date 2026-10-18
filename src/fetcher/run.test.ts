import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { defaultDeps, runFetch, type FetchDeps } from './run.js';
import type { NewArticle } from './store.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applyMigrations(db);
  return db;
}

function article(source: string, url: string, publishedAt = '2026-10-17T10:00:00.000Z'): NewArticle {
  return { title: `Title ${url}`, source, url, imageUrl: null, publishedAt };
}

function deps(overrides: Partial<FetchDeps> = {}): FetchDeps {
  return {
    now: () => new Date('2026-10-17T12:00:00.000Z'),
    fetchRss: async () => [],
    fetchNewsData: async () => [],
    newsDataApiKey: 'test-key',
    ...overrides,
  };
}

describe('runFetch — per-source graceful degradation', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
    vi.restoreAllMocks();
  });

  it('inserts articles from all healthy sources and summarizes per source', async () => {
    const db = openTestDb();
    dbs.push(db);
    const result = await runFetch(
      db,
      deps({
        fetchRss: async (source) => [article(source.id, `https://example.com/${source.id}/1`)],
        fetchNewsData: async () => [article('newsdata', 'https://example.com/nd/1')],
      }),
    );
    expect(result.inserted).toBe(7); // 6 RSS + 1 NewsData
    expect(result.failed).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.sources).toHaveLength(7);
    for (const s of result.sources) {
      expect(s).toMatchObject({ fetched: 1, inserted: 1, skipped: 0, failed: false });
    }
  });

  it('one RSS source throwing does NOT fail the run and others still insert', async () => {
    const db = openTestDb();
    dbs.push(db);
    const failing = 'polygon';
    const result = await runFetch(
      db,
      deps({
        fetchRss: async (source) => {
          if (source.id === failing) throw new Error('feed timeout');
          return [article(source.id, `https://example.com/${source.id}/1`)];
        },
        fetchNewsData: async () => [],
      }),
    );
    // 5 healthy RSS sources inserted; the broken one is reported, not thrown.
    expect(result.inserted).toBe(5);
    expect(result.failed).toBe(1);
    expect(result.exitCode).toBe(0);
    const broken = result.sources.find((s) => s.source === failing);
    expect(broken).toMatchObject({ failed: true });
    expect(broken?.error).toMatch(/timeout/);
    const count = db.prepare('SELECT COUNT(*) AS n FROM articles').get() as { n: number };
    expect(count.n).toBe(5);
  });

  it('does not throw when a source returns malformed items; bad items are skipped, good ones kept', async () => {
    const db = openTestDb();
    dbs.push(db);
    const result = await runFetch(
      db,
      deps({
        fetchRss: async (source) =>
          source.id === 'ign'
            ? [
                article('ign', 'https://example.com/ign/good'),
                { ...article('ign', 'not a url'), title: 'Bad item' },
              ]
            : [],
        fetchNewsData: async () => [],
      }),
    );
    expect(result.exitCode).toBe(0);
    const ign = result.sources.find((s) => s.source === 'ign');
    expect(ign).toMatchObject({ fetched: 2, inserted: 1, skipped: 1, failed: false });
  });

  it('NewsData throwing (e.g. rate limit) leaves RSS results intact', async () => {
    const db = openTestDb();
    dbs.push(db);
    const result = await runFetch(
      db,
      deps({
        fetchRss: async (source) => [article(source.id, `https://example.com/${source.id}/1`)],
        fetchNewsData: async () => {
          throw new Error('429 rate limit');
        },
      }),
    );
    expect(result.inserted).toBe(6);
    expect(result.failed).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.sources.find((s) => s.source === 'newsdata')).toMatchObject({
      failed: true,
    });
  });

  it('missing NEWSDATA_API_KEY skips NewsData with a warning, RSS still runs', async () => {
    const db = openTestDb();
    dbs.push(db);
    const fetchNewsData = vi.fn(async () => [article('newsdata', 'https://example.com/x')]);
    const result = await runFetch(
      db,
      deps({
        newsDataApiKey: undefined,
        fetchRss: async (source) => [article(source.id, `https://example.com/${source.id}/1`)],
        fetchNewsData,
      }),
    );
    expect(fetchNewsData).not.toHaveBeenCalled();
    expect(result.inserted).toBe(6);
    expect(result.exitCode).toBe(0);
    expect(result.sources.find((s) => s.source === 'newsdata')).toMatchObject({
      failed: false,
      fetched: 0,
      skipped: 0,
    });
  });

  it('exit code is 1 only when ALL sources fail', async () => {
    const db = openTestDb();
    dbs.push(db);
    const result = await runFetch(
      db,
      deps({
        fetchRss: async () => {
          throw new Error('all feeds down');
        },
        fetchNewsData: async () => {
          throw new Error('api down');
        },
      }),
    );
    expect(result.failed).toBe(7);
    expect(result.exitCode).toBe(1);
    expect(result.inserted).toBe(0);
  });

  it('falls back to fetch time when an item has no usable date', async () => {
    const db = openTestDb();
    dbs.push(db);
    await runFetch(
      db,
      deps({
        fetchRss: async (source) =>
          source.id === 'ign'
            ? [{ ...article('ign', 'https://example.com/ign/nodate'), publishedAt: '' }]
            : [],
        fetchNewsData: async () => [],
      }),
    );
    const row = db.prepare('SELECT published_at FROM articles').get() as {
      published_at: string;
    };
    expect(row.published_at).toBe('2026-10-17T12:00:00.000Z');
  });
});

describe('defaultDeps', () => {
  it('throws loudly (typed error) when NewsData is called without an API key', async () => {
    const deps = defaultDeps(
      { parseString: async () => ({ items: [] }) },
      (async () => {
        throw new Error('must not be called');
      }) as unknown as typeof fetch,
      undefined,
    );
    await expect(deps.fetchNewsData()).rejects.toThrow(
      /newsdata fetch failed: NEWSDATA_API_KEY is not set/,
    );
  });

  it('wires the API key through when present (no throw, typed per-source error on HTTP failure)', async () => {
    const fetchFn = (async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const deps = defaultDeps({ parseString: async () => ({ items: [] }) }, fetchFn, 'k');
    await expect(deps.fetchNewsData()).rejects.toThrow(/newsdata fetch failed.*HTTP 401/);
  });
});

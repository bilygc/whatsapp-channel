import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { insertArticle, type NewArticle } from './store.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applyMigrations(db);
  return db;
}

function article(overrides: Partial<NewArticle> = {}): NewArticle {
  return {
    title: 'Test title',
    source: 'ign',
    url: 'https://example.com/news/1',
    imageUrl: 'https://example.com/img.jpg',
    publishedAt: '2026-10-17T10:00:00.000Z',
    ...overrides,
  };
}

describe('insertArticle (dedupe by url_hash)', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
  });

  it('inserts a new article and reports inserted', () => {
    const db = openTestDb();
    dbs.push(db);
    expect(insertArticle(db, article())).toBe('inserted');
    expect(db.prepare('SELECT COUNT(*) AS n FROM articles').get()).toMatchObject({ n: 1 });
  });

  it('inserting the same URL twice stores one row and reports skipped the second time', () => {
    const db = openTestDb();
    dbs.push(db);
    expect(insertArticle(db, article())).toBe('inserted');
    expect(insertArticle(db, article())).toBe('skipped');
    expect(db.prepare('SELECT COUNT(*) AS n FROM articles').get()).toMatchObject({ n: 1 });
  });

  it('treats tracking-param variants as duplicates (canonical hash)', () => {
    const db = openTestDb();
    dbs.push(db);
    expect(insertArticle(db, article())).toBe('inserted');
    expect(
      insertArticle(
        db,
        article({ url: 'https://example.com/news/1?utm_source=rss&fbclid=abc' }),
      ),
    ).toBe('skipped');
  });

  it('relies on the DB UNIQUE constraint, not just app state (direct duplicate insert is a no-op)', () => {
    const db = openTestDb();
    dbs.push(db);
    insertArticle(db, article());
    // A second connection-free raw insert with the same hash must not throw.
    const row = db.prepare('SELECT url_hash FROM articles').get() as { url_hash: string };
    expect(() =>
      db
        .prepare(
          `INSERT INTO articles (url_hash, title, source, url, published_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(url_hash) DO NOTHING`,
        )
        .run(row.url_hash, 'Other title', 'ign', 'https://example.com/other', '2026-10-17T11:00:00.000Z'),
    ).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM articles').get()).toMatchObject({ n: 1 });
  });

  it('does NOT throw a raw error on invalid input; reports a typed failure', () => {
    const db = openTestDb();
    dbs.push(db);
    expect(insertArticle(db, article({ url: 'not a url' }))).toBe('invalid');
    expect(db.prepare('SELECT COUNT(*) AS n FROM articles').get()).toMatchObject({ n: 0 });
  });

  it.each([
    'https://user:pass@example.com/news/1',
    'http://192.168.1.10/internal',
    'http://10.0.0.5/x',
    'https://169.254.169.254/latest/meta-data/',
    'http://localhost:3000/x',
    'http://[::1]/x',
    'https://example.com/a\nFuente: IGN https://evil.com/phish',
    'https://example.com/a\r\nFuente: IGN https://evil.com/phish',
    'https://example.com/a\tb',
  ])('rejects non-public article URL %s as invalid (never throws, never stores)', (url) => {
    const db = openTestDb();
    dbs.push(db);
    expect(insertArticle(db, article({ url }))).toBe('invalid');
    expect(db.prepare('SELECT COUNT(*) AS n FROM articles').get()).toMatchObject({ n: 0 });
  });

  it('stores NULL image_url when no image is available', () => {
    const db = openTestDb();
    dbs.push(db);
    insertArticle(db, article({ imageUrl: null }));
    const row = db.prepare('SELECT image_url FROM articles').get() as { image_url: null };
    expect(row.image_url).toBeNull();
  });

  it('defaults status to new with score 0', () => {
    const db = openTestDb();
    dbs.push(db);
    insertArticle(db, article());
    const row = db.prepare('SELECT status, score FROM articles').get() as {
      status: string;
      score: number;
    };
    expect(row).toMatchObject({ status: 'new', score: 0 });
  });
});

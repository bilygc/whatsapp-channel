import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { scoreArticle, selectTopArticles } from './select.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applyMigrations(db);
  return db;
}

const NOW = new Date('2026-10-17T12:00:00.000Z');

function seed(
  db: Database.Database,
  rows: Array<{ title: string; source?: string; url: string; publishedAt: string; status?: string }>,
): void {
  const stmt = db.prepare(
    `INSERT INTO articles (url_hash, title, source, url, published_at, status)
     VALUES (@urlHash, @title, @source, @url, @publishedAt, @status)`,
  );
  rows.forEach((r, i) => {
    stmt.run({
      urlHash: `hash-${i}-${r.url}`,
      title: r.title,
      source: r.source ?? 'ign',
      url: r.url,
      publishedAt: r.publishedAt,
      status: r.status ?? 'new',
    });
  });
}

describe('scoreArticle', () => {
  it('scores fresher articles higher than older ones (recency)', () => {
    const fresh = scoreArticle(
      { title: 'Some patch notes', source: 'ign', publishedAt: '2026-10-17T11:00:00.000Z' },
      NOW,
    );
    const stale = scoreArticle(
      { title: 'Some patch notes', source: 'ign', publishedAt: '2026-10-10T11:00:00.000Z' },
      NOW,
    );
    expect(fresh).toBeGreaterThan(stale);
    expect(stale).toBeGreaterThanOrEqual(0);
  });

  it('boosts keyword-relevant titles over generic ones of the same age', () => {
    const at = '2026-10-17T11:00:00.000Z';
    const relevant = scoreArticle({ title: 'GTA 6 trailer on Switch 2 leaked', source: 'ign', publishedAt: at }, NOW);
    const generic = scoreArticle({ title: 'Some patch notes released', source: 'ign', publishedAt: at }, NOW);
    expect(relevant).toBeGreaterThan(generic);
  });

  it('treats an unparseable date as maximally fresh (never NaN, never throws)', () => {
    const score = scoreArticle({ title: 'x', source: 'ign', publishedAt: 'not-a-date' }, NOW);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
  });
});

describe('selectTopArticles', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
  });

  it('selects the top 4 freshest articles and marks them selected', () => {
    const db = openTestDb();
    dbs.push(db);
    seed(
      db,
      [1, 2, 3, 4, 5, 6].map((h) => ({
        title: `News item ${h}`,
        url: `https://example.com/${h}`,
        publishedAt: new Date(NOW.getTime() - h * 3600_000).toISOString(),
      })),
    );
    const result = selectTopArticles(db, { now: NOW });
    expect(result.selected).toHaveLength(4);
    expect(result.scored).toBe(6);
    // Freshest first.
    expect(result.selected.map((a) => a.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
      'https://example.com/4',
    ]);
    const statuses = db
      .prepare(`SELECT status FROM articles WHERE status = 'selected'`)
      .all() as Array<{ status: string }>;
    expect(statuses).toHaveLength(4);
  });

  it('respects a custom limit', () => {
    const db = openTestDb();
    dbs.push(db);
    seed(
      db,
      [1, 2, 3].map((h) => ({
        title: `News ${h}`,
        url: `https://example.com/${h}`,
        publishedAt: NOW.toISOString(),
      })),
    );
    const result = selectTopArticles(db, { limit: 2, now: NOW });
    expect(result.selected).toHaveLength(2);
  });

  it('only considers new articles — selected/used rows are untouched', () => {
    const db = openTestDb();
    dbs.push(db);
    seed(db, [
      { title: 'Old selected', url: 'https://example.com/s', publishedAt: NOW.toISOString(), status: 'selected' },
      { title: 'Old used', url: 'https://example.com/u', publishedAt: NOW.toISOString(), status: 'used' },
      { title: 'Fresh new', url: 'https://example.com/n', publishedAt: NOW.toISOString() },
    ]);
    const result = selectTopArticles(db, { now: NOW });
    expect(result.selected.map((a) => a.url)).toEqual(['https://example.com/n']);
    expect(result.scored).toBe(1);
  });

  it('returns empty (not an error) when there is nothing new', () => {
    const db = openTestDb();
    dbs.push(db);
    const result = selectTopArticles(db, { now: NOW });
    expect(result).toEqual({ selected: [], scored: 0 });
  });

  it('persists scores on all scored rows', () => {
    const db = openTestDb();
    dbs.push(db);
    seed(db, [
      { title: 'GTA 6 news', url: 'https://example.com/a', publishedAt: NOW.toISOString() },
      { title: 'Patch notes', url: 'https://example.com/b', publishedAt: NOW.toISOString() },
    ]);
    selectTopArticles(db, { now: NOW });
    const rows = db.prepare('SELECT score FROM articles').all() as Array<{ score: number }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.score).toBeGreaterThan(0);
  });

  it('prefers keyword-relevant articles over fresher-but-generic ones when scoring says so', () => {
    const db = openTestDb();
    dbs.push(db);
    seed(db, [
      {
        title: 'Some routine patch notes deployed',
        url: 'https://example.com/generic',
        publishedAt: NOW.toISOString(),
      },
      {
        title: 'GTA 6 trailer reveals Switch 2 release date',
        url: 'https://example.com/relevant',
        publishedAt: new Date(NOW.getTime() - 10 * 3600_000).toISOString(),
      },
    ]);
    const result = selectTopArticles(db, { limit: 1, now: NOW });
    expect(result.selected.map((a) => a.url)).toEqual(['https://example.com/relevant']);
  });

  it('translates a raw SQLite failure into a typed error (never a raw throw)', () => {
    const db = openTestDb();
    dbs.push(db);
    db.exec('DROP TABLE articles');
    expect(() => selectTopArticles(db, { now: NOW })).toThrow(/^select failed: /);
  });
});

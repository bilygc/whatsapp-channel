import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import {
  RECENT_LOOKBACK_DAYS,
  SIMILARITY_THRESHOLD,
  normalizeTitle,
  scoreArticle,
  selectTopArticles,
  titleSimilarity,
} from './select.js';

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

describe('normalizeTitle', () => {
  it('lowercases, strips punctuation, and removes stopwords', () => {
    expect(normalizeTitle('GTA 6: Official Trailer!')).toEqual(['6', 'gta', 'trailer']);
  });

  it('collapses the Grand Theft Auto alias and roman numeral VI to the same tokens as GTA 6', () => {
    expect(normalizeTitle('Grand Theft Auto VI')).toEqual(['6', 'gta']);
    expect(normalizeTitle('Grand Theft Auto VI')).toEqual(normalizeTitle('GTA 6'));
  });

  it('folds accents and maps other roman numerals', () => {
    expect(normalizeTitle('Pokémon VII')).toEqual(['7', 'pokemon']);
  });

  it('returns an empty token set for empty or all-stopword titles', () => {
    expect(normalizeTitle('')).toEqual([]);
    expect(normalizeTitle('The and of')).toEqual([]);
  });

  it('keeps distinct inline URLs as opaque tokens so different links stay dissimilar', () => {
    // A URL embedded in a title is an identifier, not prose: two distinct
    // links must not collapse into the same "https example com" token set.
    expect(normalizeTitle('Title https://example.com/a')).not.toEqual(
      normalizeTitle('Title https://example.com/b'),
    );
    expect(
      titleSimilarity('Title https://example.com/a', 'Title https://example.com/b'),
    ).toBeLessThan(SIMILARITY_THRESHOLD);
  });
});

describe('titleSimilarity', () => {
  it('is 1 for identical or alias-equivalent titles', () => {
    expect(titleSimilarity('GTA 6 Trailer', 'Grand Theft Auto VI Trailer')).toBe(1);
  });

  it('is 0 for disjoint topics', () => {
    expect(titleSimilarity('Zelda DLC', 'Elden Ring Patch')).toBe(0);
  });

  it('computes token-set Jaccard (0.5 and 0.6)', () => {
    expect(titleSimilarity('alpha bravo charlie', 'alpha bravo delta')).toBeCloseTo(0.5);
    expect(titleSimilarity('alpha bravo charlie delta', 'alpha bravo charlie echo')).toBeCloseTo(0.6);
  });

  it('treats empty/all-stopword titles as non-matching (never NaN, never a false veto)', () => {
    expect(titleSimilarity('', '')).toBe(0);
    expect(titleSimilarity('the and of', 'GTA 6')).toBe(0);
  });

  it('places crafted pairs on either side of the tunable threshold', () => {
    expect(titleSimilarity('alpha bravo charlie', 'alpha bravo delta')).toBeLessThan(SIMILARITY_THRESHOLD);
    expect(titleSimilarity('GTA 6 Trailer', 'GTA VI Trailer')).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });
});

describe('selectTopArticles — diversity veto', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
  });

  it('selects only one of several same-event articles from different outlets in one batch', () => {
    const db = openTestDb();
    dbs.push(db);
    seed(db, [
      { title: 'GTA 6 Trailer Reveals Release Date', url: 'https://example.com/ign', publishedAt: NOW.toISOString() },
      { title: 'Grand Theft Auto VI Gets a Release Date in New Trailer', url: 'https://example.com/polygon', publishedAt: NOW.toISOString() },
      { title: 'Rockstar Confirms GTA 6 Release Date with Trailer', url: 'https://example.com/eurogamer', publishedAt: NOW.toISOString() },
      { title: 'GTA VI Release Date Announced, Trailer Out Now', url: 'https://example.com/newsdata', publishedAt: NOW.toISOString() },
    ]);
    const result = selectTopArticles(db, { now: NOW, limit: 4 });
    expect(result.scored).toBe(4);
    expect(result.selected).toHaveLength(1);
    const row = db.prepare(`SELECT COUNT(*) AS n FROM articles WHERE status = 'selected'`).get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('still selects all articles when topics are dissimilar', () => {
    const db = openTestDb();
    dbs.push(db);
    seed(db, [
      { title: 'GTA 6 Trailer Reveals Release Date', url: 'https://example.com/a', publishedAt: NOW.toISOString() },
      { title: 'Zelda Tears of the Kingdom DLC Launches', url: 'https://example.com/b', publishedAt: NOW.toISOString() },
      { title: 'Elden Ring Nightreign Patch Notes', url: 'https://example.com/c', publishedAt: NOW.toISOString() },
      { title: 'Minecraft Copper Golem Mob Added', url: 'https://example.com/d', publishedAt: NOW.toISOString() },
    ]);
    const result = selectTopArticles(db, { now: NOW, limit: 4 });
    expect(result.selected).toHaveLength(4);
  });

  it('blocks a similar new article when the same story was selected in a previous run', () => {
    const db = openTestDb();
    dbs.push(db);
    const day2 = new Date(NOW.getTime() + 24 * 3600_000);
    seed(db, [
      { title: 'GTA 6 Trailer Reveals Release Date', url: 'https://example.com/run1', publishedAt: NOW.toISOString() },
    ]);
    const first = selectTopArticles(db, { now: NOW, limit: 1 });
    expect(first.selected).toHaveLength(1);

    seed(db, [
      { title: 'Grand Theft Auto VI Trailer Reveals Release Date', url: 'https://example.com/run2', publishedAt: day2.toISOString() },
    ]);
    const second = selectTopArticles(db, { now: day2, limit: 1 });
    expect(second.scored).toBe(1);
    expect(second.selected).toHaveLength(0);
  });

  it('ignores history older than the lookback window', () => {
    const db = openTestDb();
    dbs.push(db);
    const old = new Date(NOW.getTime() - (RECENT_LOOKBACK_DAYS + 3) * 24 * 3600_000).toISOString();
    seed(db, [
      { title: 'GTA 6 Trailer Reveals Release Date', url: 'https://example.com/old', publishedAt: old, status: 'used' },
      { title: 'Grand Theft Auto VI Trailer Reveals Release Date', url: 'https://example.com/new', publishedAt: NOW.toISOString() },
    ]);
    const result = selectTopArticles(db, { now: NOW, limit: 1 });
    expect(result.selected.map((a) => a.url)).toEqual(['https://example.com/new']);
  });

  it('keeps both articles when their similarity is just below the threshold', () => {
    const db = openTestDb();
    dbs.push(db);
    seed(db, [
      { title: 'alpha bravo charlie', url: 'https://example.com/a', publishedAt: NOW.toISOString() },
      { title: 'alpha bravo delta', url: 'https://example.com/b', publishedAt: NOW.toISOString() },
    ]);
    const result = selectTopArticles(db, { now: NOW, limit: 2 });
    expect(result.selected).toHaveLength(2);
  });

  it('vetoes one article when their similarity reaches the threshold', () => {
    const db = openTestDb();
    dbs.push(db);
    seed(db, [
      { title: 'alpha bravo charlie delta', url: 'https://example.com/a', publishedAt: NOW.toISOString() },
      { title: 'alpha bravo charlie echo', url: 'https://example.com/b', publishedAt: NOW.toISOString() },
    ]);
    const result = selectTopArticles(db, { now: NOW, limit: 2 });
    expect(result.selected).toHaveLength(1);
  });

  it('translates a failure in the recent-history query into a typed error', () => {
    const db = openTestDb();
    dbs.push(db);
    seed(db, [
      { title: 'GTA 6 Trailer', url: 'https://example.com/a', publishedAt: NOW.toISOString() },
    ]);
    const failingDb = {
      prepare: (sql: string) => {
        if (sql.includes('status IN')) throw new Error('history boom');
        return db.prepare(sql);
      },
      transaction: db.transaction.bind(db),
    } as unknown as Database.Database;
    expect(() => selectTopArticles(failingDb, { now: NOW })).toThrow(/^select failed: history boom/);
  });
});

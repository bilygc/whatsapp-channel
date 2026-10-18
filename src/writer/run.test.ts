import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { runWriter, saveDraft, type WriterDeps } from './run.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applyMigrations(db);
  return db;
}

function seedSelected(
  db: Database.Database,
  rows: Array<{ title?: string; source?: string; url: string }>,
): number[] {
  const stmt = db.prepare(
    `INSERT INTO articles (url_hash, title, source, url, published_at, status)
     VALUES (@urlHash, @title, @source, @url, '2026-10-17T10:00:00.000Z', 'selected')`,
  );
  return rows.map((r, i) =>
    Number(
      stmt.run({
        urlHash: `w-hash-${i}-${r.url}`,
        title: r.title ?? `Title ${r.url}`,
        source: r.source ?? 'IGN',
        url: r.url,
      }).lastInsertRowid,
    ),
  );
}

function deps(overrides: Partial<WriterDeps> = {}): WriterDeps {
  return {
    now: () => new Date('2026-10-17T12:00:00.000Z'),
    generate: async (article) =>
      `🔥 ${article.title}\n\n#Videojuegos\n\nFuente: ${article.source} ${article.url}`,
    ...overrides,
  };
}

describe('runWriter', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
    vi.restoreAllMocks();
  });

  it('writes one pending draft per selected article and marks articles used', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }]);

    const summary = await runWriter(db, deps());

    expect(summary).toMatchObject({ total: 2, written: 2, failed: 0, exitCode: 0 });
    const drafts = db.prepare('SELECT article_id, status FROM drafts').all() as Array<{
      article_id: number;
      status: string;
    }>;
    expect(drafts).toHaveLength(2);
    for (const d of drafts) expect(d.status).toBe('pending');
    const used = db.prepare(`SELECT COUNT(*) AS n FROM articles WHERE status = 'used'`).get() as {
      n: number;
    };
    expect(used.n).toBe(2);
  });

  it('isolates LLM failures per article: one failure does not lose the other draft', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [{ url: 'https://example.com/good' }, { url: 'https://example.com/bad' }]);

    const summary = await runWriter(
      db,
      deps({
        generate: async (article) => {
          if (article.url.endsWith('/bad')) throw new Error('llm write failed for article 2: HTTP 429');
          return `🔥 caption\n\nFuente: ${article.source} ${article.url}`;
        },
      }),
    );

    expect(summary).toMatchObject({ total: 2, written: 1, failed: 1, exitCode: 0 });
    // Failed article stays `selected` (retryable); its draft was never created.
    const failed = db.prepare(`SELECT status FROM articles WHERE url = 'https://example.com/bad'`).get() as {
      status: string;
    };
    expect(failed.status).toBe('selected');
    const drafts = db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    expect(drafts.n).toBe(1);
    expect(summary.results.find((r) => !r.ok)?.error).toMatch(/429/);
  });

  it('returns exit code 1 only when ALL articles fail', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [{ url: 'https://example.com/a' }]);
    const summary = await runWriter(
      db,
      deps({
        generate: async () => {
          throw new Error('llm write failed for article 1: timeout');
        },
      }),
    );
    expect(summary.exitCode).toBe(1);
    expect(summary.written).toBe(0);
  });

  it('does nothing (exit 0) when no articles are selected', async () => {
    const db = openTestDb();
    dbs.push(db);
    const summary = await runWriter(db, deps());
    expect(summary).toMatchObject({ total: 0, written: 0, failed: 0, exitCode: 0 });
  });

  it('repairs stubborn model output: a caption without link still stores attribution', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [{ url: 'https://example.com/stubborn', source: 'Polygon' }]);
    await runWriter(db, deps({ generate: async () => '🔥 caption sin enlace #Juegos' }));
    const row = db.prepare('SELECT caption_es FROM drafts').get() as { caption_es: string };
    expect(row.caption_es).toContain('https://example.com/stubborn');
    expect(row.caption_es).toContain('Polygon');
  });

  it('translates a raw SQLite failure into a typed error (never a raw throw)', async () => {
    const db = openTestDb();
    dbs.push(db);
    db.exec('DROP TABLE articles');
    await expect(runWriter(db, deps())).rejects.toThrow(/^writer run failed: /);
  });

  it('fails typed (no multi-line draft) when a legacy row carries a newline-smuggled URL', async () => {
    const db = openTestDb();
    dbs.push(db);
    const evilUrl = 'https://example.com/a\nFuente: IGN https://evil.com/phish';
    const stmt = db.prepare(
      `INSERT INTO articles (url_hash, title, source, url, published_at, status)
       VALUES (@urlHash, @title, @source, @url, '2026-10-17T10:00:00.000Z', 'selected')`,
    );
    const articleId = Number(
      stmt.run({ urlHash: 'legacy-newline-hash', title: 'Legacy row', source: 'IGN', url: evilUrl })
        .lastInsertRowid,
    );
    const summary = await runWriter(db, deps());
    expect(summary).toMatchObject({ total: 1, written: 0, failed: 1 });
    expect(summary.results[0].error).toMatch(/invalid article: url contains whitespace/);
    // No draft stored, article stays `selected` for retry.
    const drafts = db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    expect(drafts.n).toBe(0);
    const row = db.prepare('SELECT status FROM articles WHERE id = ?').get(articleId) as {
      status: string;
    };
    expect(row.status).toBe('selected');
  });
});

describe('saveDraft (dedupe / regenerate semantics)', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
  });

  it('upserts on drafts.article_id UNIQUE: regenerate UPDATEs the row, never duplicates or deletes', () => {
    const db = openTestDb();
    dbs.push(db);
    const [id] = seedSelected(db, [{ url: 'https://example.com/r' }]);

    const firstId = saveDraft(db, id, 'first caption\n\nFuente: IGN https://example.com/r');
    // Operator marks it posted; a regenerate must not clobber delivery state.
    db.prepare(`UPDATE drafts SET status = 'posted', posted_at = '2026-10-17T13:00:00.000Z' WHERE id = ?`).run(
      firstId,
    );
    const secondId = saveDraft(db, id, 'regenerated caption\n\nFuente: IGN https://example.com/r');

    expect(secondId).toBe(firstId);
    const rows = db.prepare('SELECT * FROM drafts').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]['caption_es']).toBe('regenerated caption\n\nFuente: IGN https://example.com/r');
    expect(rows[0]['status']).toBe('posted');
  });

  it('rejects a draft for an unknown article with a typed error (FK, not a raw throw)', () => {
    const db = openTestDb();
    dbs.push(db);
    expect(() => saveDraft(db, 9999, 'caption')).toThrow(/^draft save failed: /);
  });
});

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import {
  LLM_INTER_ARTICLE_DELAY_MS,
  resolveInterArticleDelayMs,
  runWriter,
  saveDraft,
  type WriterDeps,
} from './run.js';

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
    // Noop pacer keeps every pre-existing test instant; pacing tests inject a spy.
    sleep: async () => {},
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

  it('fails typed (no multi-line draft) when a legacy row carries a newline-smuggled URL', async () => {    const db = openTestDb();
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

  it('bounds the per-run write set with limit (oldest selected first)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [
      { url: 'https://example.com/1' },
      { url: 'https://example.com/2' },
      { url: 'https://example.com/3' },
    ]);

    const summary = await runWriter(db, { ...deps(), limit: 2 });

    expect(summary).toMatchObject({ total: 2, written: 2, failed: 0 });
    const drafts = db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    expect(drafts.n).toBe(2);
    // The bounded-out article stays `selected` for a later run.
    const left = db.prepare(`SELECT status FROM articles WHERE url = 'https://example.com/3'`).get() as {
      status: string;
    };
    expect(left.status).toBe('selected');
  });

  it('defaults to unbounded (standalone `npm run write` writes everything selected)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }]);

    const summary = await runWriter(db, deps());

    expect(summary).toMatchObject({ total: 2, written: 2, failed: 0 });
  });
});

describe('runWriter inter-article pacing (free-tier 20 RPM)', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
    vi.restoreAllMocks();
  });

  it('spaces every article except the first by a jittered delay', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [
      { url: 'https://example.com/a' },
      { url: 'https://example.com/b' },
      { url: 'https://example.com/c' },
    ]);
    const sleep = vi.fn(async (_ms: number) => {});

    const summary = await runWriter(db, deps({ sleep, interArticleDelayMs: 1000, random: () => 0.5 }));

    expect(summary.written).toBe(3);
    // 3 articles → 2 gaps (before b and c); no delay before the first.
    expect(sleep).toHaveBeenCalledTimes(2);
    // r=0.5 cancels the ±20% jitter → exactly the base delay.
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 1000);
  });

  it('keeps the jitter within ±20% of the base delay', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [
      { url: 'https://example.com/a' },
      { url: 'https://example.com/b' },
      { url: 'https://example.com/c' },
    ]);
    const sleep = vi.fn(async (_ms: number) => {});
    // First gap → min (0.8×), second → max (1.2×).
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1);

    await runWriter(db, deps({ sleep, interArticleDelayMs: 6000, random }));

    const delays = sleep.mock.calls.map((c) => c[0] as number);
    expect(delays).toEqual([4800, 7200]);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(4800);
      expect(d).toBeLessThanOrEqual(7200);
    }
  });

  it('paces even after a failed article (a burst of retries still trickles out)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [
      { url: 'https://example.com/ok1' },
      { url: 'https://example.com/bad' },
      { url: 'https://example.com/ok2' },
    ]);
    const sleep = vi.fn(async (_ms: number) => {});

    const summary = await runWriter(
      db,
      deps({
        sleep,
        interArticleDelayMs: 1000,
        random: () => 0.5,
        generate: async (article) => {
          if (article.url.endsWith('/bad')) throw new Error('llm write failed: 429');
          return `🔥 caption\n\nFuente: ${article.source} ${article.url}`;
        },
      }),
    );

    expect(summary.written).toBe(2);
    expect(summary.failed).toBe(1);
    // Both gaps still paced despite the middle article failing.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('disables pacing when interArticleDelayMs is 0', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }]);
    const sleep = vi.fn(async (_ms: number) => {});

    await runWriter(db, deps({ sleep, interArticleDelayMs: 0 }));

    expect(sleep).not.toHaveBeenCalled();
  });

  it('a broken pacer never drops an article (pacing is best-effort)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }]);
    const sleep = vi.fn(async (_ms: number) => {
      throw new Error('timer exploded');
    });

    const summary = await runWriter(db, deps({ sleep, interArticleDelayMs: 1000 }));

    expect(summary.written).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.results.every((r) => r.ok)).toBe(true);
  });
});

describe('resolveInterArticleDelayMs', () => {
  it('defaults to 6000 when LLM_INTER_ARTICLE_DELAY_MS is unset', () => {
    expect(LLM_INTER_ARTICLE_DELAY_MS).toBe(6000);
    expect(resolveInterArticleDelayMs({})).toBe(6000);
  });

  it('honours a valid env override (trims whitespace)', () => {
    expect(resolveInterArticleDelayMs({ LLM_INTER_ARTICLE_DELAY_MS: '3000' })).toBe(3000);
    expect(resolveInterArticleDelayMs({ LLM_INTER_ARTICLE_DELAY_MS: '  3000  ' })).toBe(3000);
  });

  it('accepts 0 as an explicit disable (distinct from unset)', () => {
    expect(resolveInterArticleDelayMs({ LLM_INTER_ARTICLE_DELAY_MS: '0' })).toBe(0);
  });

  it('falls back to the default on invalid values', () => {
    for (const bad of ['abc', '', '   ', '-5', '12.5', 'NaN', 'Infinity']) {
      expect(resolveInterArticleDelayMs({ LLM_INTER_ARTICLE_DELAY_MS: bad })).toBe(
        LLM_INTER_ARTICLE_DELAY_MS,
      );
    }
  });
});

describe('runWriter with explicit articleIds (fresh-selection priority)', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
    vi.restoreAllMocks();
  });

  it('writes the fresh picked IDs first instead of draining stale leftovers oldest-first', async () => {
    const db = openTestDb();
    dbs.push(db);
    // Stale leftovers from an earlier failed run (low IDs, still `selected`).
    const stale = seedSelected(db, [
      { url: 'https://example.com/stale-1' },
      { url: 'https://example.com/stale-2' },
    ]);
    // Freshly selected this run (high IDs).
    const fresh = seedSelected(db, [
      { url: 'https://example.com/fresh-1' },
      { url: 'https://example.com/fresh-2' },
    ]);
    void stale;

    const summary = await runWriter(db, { ...deps(), limit: 2, articleIds: fresh });

    expect(summary).toMatchObject({ total: 2, written: 2, failed: 0 });
    const drafted = (
      db.prepare('SELECT article_id FROM drafts').all() as Array<{ article_id: number }>
    ).map((d) => d.article_id);
    expect(drafted.sort((a, b) => a - b)).toEqual([...fresh].sort((a, b) => a - b));
    // Stale leftovers wait — capacity was fully spent on the fresh picks.
    for (const id of stale) {
      const row = db.prepare('SELECT status FROM articles WHERE id = ?').get(id) as {
        status: string;
      };
      expect(row.status).toBe('selected');
    }
  });

  it('backfills leftover selected rows oldest-first when capacity remains after the fresh IDs', async () => {
    const db = openTestDb();
    dbs.push(db);
    const stale = seedSelected(db, [
      { url: 'https://example.com/stale-1' },
      { url: 'https://example.com/stale-2' },
    ]);
    const fresh = seedSelected(db, [{ url: 'https://example.com/fresh-1' }]);

    const seen: number[] = [];
    // Limit 2 = 1 fresh pick + 1 slot of spare capacity for the backlog.
    const summary = await runWriter(
      db,
      deps({
        limit: 2,
        articleIds: fresh,
        generate: async (article) => {
          seen.push(article.id);
          return `🔥 ${article.title}\n\nFuente: ${article.source} ${article.url}`;
        },
      }),
    );

    // Fresh first, then the oldest stale leftover; the newest stale waits.
    expect(seen).toEqual([fresh[0], stale[0]]);
    expect(summary).toMatchObject({ total: 2, written: 2, failed: 0 });
    const left = db.prepare('SELECT status FROM articles WHERE id = ?').get(stale[1]) as {
      status: string;
    };
    expect(left.status).toBe('selected');
  });

  it('a failed fresh write keeps status=selected for retry (draft untouched, rest continue)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [{ url: 'https://example.com/stale-1' }]);
    const fresh = seedSelected(db, [
      { url: 'https://example.com/fresh-ok' },
      { url: 'https://example.com/fresh-bad' },
    ]);

    const summary = await runWriter(
      db,
      deps({
        generate: async (article) => {
          if (article.url.endsWith('/fresh-bad')) throw new Error('llm write failed: timeout');
          return `🔥 caption\n\nFuente: ${article.source} ${article.url}`;
        },
        limit: 2,
        articleIds: fresh,
      }),
    );

    expect(summary).toMatchObject({ total: 2, written: 1, failed: 1 });
    const bad = db.prepare('SELECT status FROM articles WHERE id = ?').get(fresh[1]) as {
      status: string;
    };
    expect(bad.status).toBe('selected');
    const drafts = db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    expect(drafts.n).toBe(1);
  });

  it('ignores unknown article IDs in the explicit list without throwing (backfills stale)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const stale = seedSelected(db, [{ url: 'https://example.com/stale-1' }]);

    const summary = await runWriter(db, { ...deps(), limit: 1, articleIds: [999999] });

    expect(summary).toMatchObject({ total: 1, written: 1, failed: 0 });
    const row = db.prepare('SELECT status FROM articles WHERE id = ?').get(stale[0]) as {
      status: string;
    };
    expect(row.status).toBe('used');
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

  it('preserves the send-once tracking columns on regenerate (delivery history is send-owned)', () => {
    const db = openTestDb();
    dbs.push(db);
    const [id] = seedSelected(db, [{ url: 'https://example.com/r' }]);

    const firstId = saveDraft(db, id, 'first caption\n\nFuente: IGN https://example.com/r');
    // A successful send stamped delivery history; a later regenerate (e.g.
    // after an LLM improvement) must not clear or rewrite it.
    db.prepare(`UPDATE drafts SET last_sent_at = ?, telegram_message_id = ? WHERE id = ?`).run(
      '2026-10-19T08:55:00.000Z',
      21,
      firstId,
    );
    const secondId = saveDraft(db, id, 'regenerated caption\n\nFuente: IGN https://example.com/r');

    expect(secondId).toBe(firstId);
    const row = db.prepare('SELECT last_sent_at, telegram_message_id FROM drafts WHERE id = ?').get(
      firstId,
    ) as { last_sent_at: string | null; telegram_message_id: number | null };
    expect(row).toMatchObject({
      last_sent_at: '2026-10-19T08:55:00.000Z',
      telegram_message_id: 21,
    });
  });

  it('rejects a draft for an unknown article with a typed error (FK, not a raw throw)', () => {
    const db = openTestDb();
    dbs.push(db);
    expect(() => saveDraft(db, 9999, 'caption')).toThrow(/^draft save failed: /);
  });

  it('writes x_post_es alongside caption_es on first insert', () => {
    const db = openTestDb();
    dbs.push(db);
    const [id] = seedSelected(db, [{ url: 'https://example.com/x' }]);

    const draftId = saveDraft(db, id, 'caption\n\nFuente: IGN https://example.com/x', '¡Hola! #Juegos');

    const row = db.prepare('SELECT caption_es, x_post_es FROM drafts WHERE id = ?').get(draftId) as {
      caption_es: string;
      x_post_es: string | null;
    };
    expect(row.caption_es).toContain('caption');
    expect(row.x_post_es).toBe('¡Hola! #Juegos');
  });

  it('stores NULL x_post_es by default (legacy callers without an X post)', () => {
    const db = openTestDb();
    dbs.push(db);
    const [id] = seedSelected(db, [{ url: 'https://example.com/x' }]);

    const draftId = saveDraft(db, id, 'caption\n\nFuente: IGN https://example.com/x');

    const row = db.prepare('SELECT x_post_es FROM drafts WHERE id = ?').get(draftId) as {
      x_post_es: string | null;
    };
    expect(row.x_post_es).toBeNull();
  });

  it('regenerate OVERWRITES x_post_es on the same row while preserving delivery state', () => {
    const db = openTestDb();
    dbs.push(db);
    const [id] = seedSelected(db, [{ url: 'https://example.com/r' }]);

    const firstId = saveDraft(db, id, 'first caption\n\nFuente: IGN https://example.com/r', 'first tweet');
    db.prepare(`UPDATE drafts SET status = 'posted', posted_at = '2026-10-17T13:00:00.000Z' WHERE id = ?`).run(
      firstId,
    );
    const secondId = saveDraft(
      db,
      id,
      'regenerated caption\n\nFuente: IGN https://example.com/r',
      'regenerated tweet',
    );

    expect(secondId).toBe(firstId);
    const row = db.prepare('SELECT caption_es, x_post_es, status FROM drafts WHERE id = ?').get(
      firstId,
    ) as { caption_es: string; x_post_es: string | null; status: string };
    expect(row.caption_es).toContain('regenerated caption');
    expect(row.x_post_es).toBe('regenerated tweet');
    expect(row.status).toBe('posted');
  });

  it('regenerate with NULL x_post_es clears a previously stored X post (overwrite mirrors caption_es)', () => {
    const db = openTestDb();
    dbs.push(db);
    const [id] = seedSelected(db, [{ url: 'https://example.com/r' }]);

    const firstId = saveDraft(db, id, 'caption\n\nFuente: IGN https://example.com/r', 'old tweet');
    const secondId = saveDraft(db, id, 'caption\n\nFuente: IGN https://example.com/r');

    expect(secondId).toBe(firstId);
    const row = db.prepare('SELECT x_post_es FROM drafts WHERE id = ?').get(firstId) as {
      x_post_es: string | null;
    };
    expect(row.x_post_es).toBeNull();
  });
});

describe('runWriter with X posts', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
    vi.restoreAllMocks();
  });

  it('stores both caption_es and x_post_es when generate returns both texts', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [{ url: 'https://example.com/a' }]);

    const summary = await runWriter(
      db,
      deps({
        generate: async (article) => ({
          caption: `🔥 ${article.title}\n\nFuente: ${article.source} ${article.url}`,
          xPost: `¡Notición! #Videojuegos`,
        }),
      }),
    );

    expect(summary).toMatchObject({ total: 1, written: 1, failed: 0, exitCode: 0 });
    const row = db.prepare('SELECT caption_es, x_post_es FROM drafts').get() as {
      caption_es: string;
      x_post_es: string | null;
    };
    expect(row.caption_es).toContain('🔥');
    expect(row.x_post_es).toContain('#Videojuegos');
    expect(row.x_post_es!.length).toBeLessThanOrEqual(280);
  });

  it('keeps caption_es byte-identical whether generate returns a string or an object', async () => {
    const caption = `🔥 Título gancho\n\nCuerpo con emojis 🎮 #Videojuegos\n\nFuente: IGN https://example.com/same`;
    const xPost = `¡Notición! #Videojuegos`;
    const dbString = openTestDb();
    const dbObject = openTestDb();
    dbs.push(dbString, dbObject);
    seedSelected(dbString, [{ url: 'https://example.com/same' }]);
    seedSelected(dbObject, [{ url: 'https://example.com/same' }]);

    await runWriter(dbString, deps({ generate: async () => caption }));
    await runWriter(dbObject, deps({ generate: async () => ({ caption, xPost }) }));

    const fromString = (dbString.prepare('SELECT caption_es FROM drafts').get() as { caption_es: string })
      .caption_es;
    const fromObject = (dbObject.prepare('SELECT caption_es FROM drafts').get() as { caption_es: string })
      .caption_es;
    expect(fromObject).toBe(fromString);
    expect(fromObject).toBe(caption);
  });

  it('a malformed X post leaves caption_es intact and x_post_es NULL (article still ok)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [{ url: 'https://example.com/a' }]);

    const summary = await runWriter(
      db,
      deps({
        // Empty tweet: fails tweet validation, never the article.
        generate: async (article) => ({
          caption: `🔥 caption\n\nFuente: ${article.source} ${article.url}`,
          xPost: '   ',
        }),
      }),
    );

    expect(summary).toMatchObject({ total: 1, written: 1, failed: 0, exitCode: 0 });
    const row = db.prepare('SELECT caption_es, x_post_es FROM drafts').get() as {
      caption_es: string;
      x_post_es: string | null;
    };
    expect(row.caption_es).toContain('https://example.com/a');
    expect(row.x_post_es).toBeNull();
    // The article is consumed (used): the caption succeeded.
    const article = db.prepare(`SELECT status FROM articles`).get() as { status: string };
    expect(article.status).toBe('used');
  });

  it('a legacy string generate stores the caption with x_post_es NULL (no regression)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [{ url: 'https://example.com/a' }]);

    const summary = await runWriter(db, deps());

    expect(summary).toMatchObject({ total: 1, written: 1, failed: 0 });
    const row = db.prepare('SELECT caption_es, x_post_es FROM drafts').get() as {
      caption_es: string;
      x_post_es: string | null;
    };
    expect(row.caption_es).toContain('https://example.com/a');
    expect(row.x_post_es).toBeNull();
  });

  it('an overlong X post is truncated to 280 chars with no attribution appended, caption untouched', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedSelected(db, [{ url: 'https://example.com/a' }]);
    const caption = `🔥 caption\n\nFuente: IGN https://example.com/a`;

    await runWriter(
      db,
      deps({
        generate: async () => ({ caption, xPost: `${'Palabra '.repeat(60)}#Videojuegos` }),
      }),
    );

    const row = db.prepare('SELECT caption_es, x_post_es FROM drafts').get() as {
      caption_es: string;
      x_post_es: string | null;
    };
    expect(row.caption_es).toBe(caption);
    expect(row.x_post_es!.length).toBeLessThanOrEqual(280);
    expect(row.x_post_es).not.toContain('Fuente:');
    expect(row.x_post_es).not.toContain('https://example.com/a');
  });
});

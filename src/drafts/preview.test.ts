import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import {
  backfillXVariants,
  formatDraftPreview,
  parsePreviewDraftsArgs,
  type PreviewRow,
} from './preview.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applyMigrations(db);
  return db;
}

/** Seed one article + one pending draft; returns { articleId, draftId }. */
function seedDraft(
  db: Database.Database,
  opts: { status?: string; captionX?: string | null; url?: string; source?: string } = {},
): { articleId: number; draftId: number } {
  const url = opts.url ?? `https://example.com/${Math.random().toString(36).slice(2)}`;
  const articleId = Number(
    db
      .prepare(
        `INSERT INTO articles (url_hash, title, source, url, published_at, status)
         VALUES (@urlHash, 'Title', @source, @url, '2026-10-17T10:00:00.000Z', 'used')`,
      )
      .run({ urlHash: `hash-${url}`, source: opts.source ?? 'IGN', url }).lastInsertRowid,
  );
  const draftId = Number(
    db
      .prepare(`INSERT INTO drafts (article_id, caption_es, caption_x, status) VALUES (?, ?, ?, ?)`)
      .run(articleId, `🔥 Noticia\n\nFuente: IGN ${url}`, opts.captionX ?? null, opts.status ?? 'pending')
      .lastInsertRowid,
  );
  return { articleId, draftId };
}

function row(overrides: Partial<PreviewRow> = {}): PreviewRow {
  return {
    id: 1,
    status: 'pending',
    caption_es: '🔥 Noticia\n\nFuente: IGN https://example.com/a',
    caption_x: '¡Notición! #Videojuegos https://example.com/a',
    created_at: '2026-10-17T12:00:00.000Z',
    title: 'Some game news',
    source: 'IGN',
    url: 'https://example.com/a',
    ...overrides,
  };
}

describe('parsePreviewDraftsArgs', () => {
  it('defaults to pending with no backfill', () => {
    expect(parsePreviewDraftsArgs([])).toEqual({ filter: 'pending', backfillX: false });
  });

  it('accepts a status filter', () => {
    expect(parsePreviewDraftsArgs(['posted'])).toEqual({ filter: 'posted', backfillX: false });
    expect(parsePreviewDraftsArgs(['all'])).toEqual({ filter: 'all', backfillX: false });
  });

  it('accepts --backfill-x alongside a filter in either order', () => {
    expect(parsePreviewDraftsArgs(['--backfill-x'])).toEqual({ filter: 'pending', backfillX: true });
    expect(parsePreviewDraftsArgs(['posted', '--backfill-x'])).toEqual({ filter: 'posted', backfillX: true });
    expect(parsePreviewDraftsArgs(['--backfill-x', 'skipped'])).toEqual({ filter: 'skipped', backfillX: true });
  });

  it('rejects an unknown status with a typed error', () => {
    expect(() => parsePreviewDraftsArgs(['bogus'])).toThrow(/^previewDrafts failed: status must be one of/);
  });

  it('rejects a second positional with a typed error', () => {
    expect(() => parsePreviewDraftsArgs(['pending', 'posted'])).toThrow(/^previewDrafts failed: /);
  });

  it('rejects unknown flags with a typed error (never silently ignored)', () => {
    expect(() => parsePreviewDraftsArgs(['--post-to-x'])).toThrow(/^previewDrafts failed: unknown flag/);
  });

  it('prints usage for --help (typed, never a raw throw)', () => {
    expect(() => parsePreviewDraftsArgs(['--help'])).toThrow(/^previewDrafts failed: usage: /);
  });
});

describe('formatDraftPreview', () => {
  it('shows article, WhatsApp caption, and X post for easy copy/paste', () => {
    const out = formatDraftPreview(row());
    expect(out).toContain('Article: Some game news');
    expect(out).toContain('Source: IGN https://example.com/a');
    expect(out).toContain('🔥 Noticia');
    expect(out).toContain('¡Notición! #Videojuegos https://example.com/a');
  });

  it('marks a missing X variant instead of printing null/empty', () => {
    const out = formatDraftPreview(row({ caption_x: null }));
    expect(out).toContain('— no X variant —');
    expect(out).not.toContain('null');
    // The WhatsApp caption is still shown.
    expect(out).toContain('🔥 Noticia');
  });

  it('scrubs hostile feed fields to single lines (display-only, DB untouched)', () => {
    const out = formatDraftPreview(
      row({ title: 'Nice game\n0 6 * * * evil', source: 'IGN', url: 'https://example.com/a' }),
    );
    const articleLine = out.split('\n').find((l) => l.startsWith('Article: '));
    expect(articleLine).toBe('Article: Nice game 0 6 * * * evil');
  });
});

describe('backfillXVariants', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
    vi.restoreAllMocks();
  });

  function generateX(article: { url: string }): Promise<string> {
    return Promise.resolve(`post #Videojuegos ${article.url}`);
  }

  it('fills caption_x for pending drafts missing it and reports the summary', async () => {
    const db = openTestDb();
    dbs.push(db);
    const a = seedDraft(db, { url: 'https://example.com/a' });
    const b = seedDraft(db, { url: 'https://example.com/b' });

    const summary = await backfillXVariants(db, { generateX });

    expect(summary).toMatchObject({ total: 2, filled: 2, failed: 0, exitCode: 0 });
    for (const { draftId } of [a, b]) {
      const got = db.prepare('SELECT caption_x FROM drafts WHERE id = ?').get(draftId) as {
        caption_x: string | null;
      };
      expect(got.caption_x).toContain('#Videojuegos');
      expect((got.caption_x ?? '').length).toBeLessThanOrEqual(280);
    }
  });

  it('does NOT rewrite caption_es bytes (byte-identical after backfill)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const { draftId } = seedDraft(db, { url: 'https://example.com/a' });
    const before = (db.prepare('SELECT caption_es FROM drafts WHERE id = ?').get(draftId) as { caption_es: string })
      .caption_es;

    await backfillXVariants(db, { generateX });

    const after = (db.prepare('SELECT caption_es FROM drafts WHERE id = ?').get(draftId) as { caption_es: string })
      .caption_es;
    expect(after).toBe(before);
  });

  it('skips drafts that already have an X variant and non-pending drafts', async () => {
    const db = openTestDb();
    dbs.push(db);
    const filled = seedDraft(db, { url: 'https://example.com/filled', captionX: 'existing #Videojuegos' });
    const posted = seedDraft(db, { url: 'https://example.com/posted', status: 'posted' });
    const generateXSpy = vi.fn(generateX);

    const summary = await backfillXVariants(db, { generateX: generateXSpy });

    expect(summary).toMatchObject({ total: 0, filled: 0, failed: 0, exitCode: 0 });
    expect(generateXSpy).not.toHaveBeenCalled();
    expect(
      (db.prepare('SELECT caption_x FROM drafts WHERE id = ?').get(filled.draftId) as { caption_x: string }).caption_x,
    ).toBe('existing #Videojuegos');
    expect(
      (db.prepare('SELECT caption_x FROM drafts WHERE id = ?').get(posted.draftId) as { caption_x: string | null })
        .caption_x,
    ).toBeNull();
  });

  it('isolates LLM failures per draft: the rest still fill, failures stay NULL', async () => {
    const db = openTestDb();
    dbs.push(db);
    const good = seedDraft(db, { url: 'https://example.com/good' });
    const bad = seedDraft(db, { url: 'https://example.com/bad' });

    const summary = await backfillXVariants(db, {
      generateX: async (article) => {
        if (article.url.endsWith('/bad')) throw new Error('llm write failed for article 2: HTTP 429');
        return `post #Videojuegos ${article.url}`;
      },
    });

    expect(summary).toMatchObject({ total: 2, filled: 1, failed: 1, exitCode: 0 });
    expect(
      (db.prepare('SELECT caption_x FROM drafts WHERE id = ?').get(good.draftId) as { caption_x: string }).caption_x,
    ).toContain('#Videojuegos');
    expect(
      (db.prepare('SELECT caption_x FROM drafts WHERE id = ?').get(bad.draftId) as { caption_x: string | null })
        .caption_x,
    ).toBeNull();
    expect(summary.results.find((r) => !r.ok)?.error).toMatch(/429/);
  });

  it('records a validation failure per draft (empty reply fills nothing, corrupts nothing)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const { draftId } = seedDraft(db, { url: 'https://example.com/a' });
    const before = (db.prepare('SELECT caption_es FROM drafts WHERE id = ?').get(draftId) as { caption_es: string })
      .caption_es;

    const summary = await backfillXVariants(db, { generateX: async () => '   ' });

    expect(summary).toMatchObject({ total: 1, filled: 0, failed: 1, exitCode: 1 });
    expect(summary.results[0].error).toMatch(/x post validation failed/);
    const afterRow = db.prepare('SELECT caption_es, caption_x FROM drafts WHERE id = ?').get(draftId) as {
      caption_es: string;
      caption_x: string | null;
    };
    expect(afterRow.caption_es).toBe(before);
    expect(afterRow.caption_x).toBeNull();
  });

  it('returns exit code 1 only when ALL drafts fail', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedDraft(db, { url: 'https://example.com/a' });

    const summary = await backfillXVariants(db, {
      generateX: async () => {
        throw new Error('llm write failed for article 1: timeout');
      },
    });

    expect(summary.exitCode).toBe(1);
    expect(summary.filled).toBe(0);
  });

  it('preserves draft status and delivery tracking on fill (send-owned columns untouched)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const { draftId } = seedDraft(db, { url: 'https://example.com/a' });
    db.prepare(`UPDATE drafts SET last_sent_at = ?, telegram_message_id = ? WHERE id = ?`).run(
      '2026-10-19T08:55:00.000Z',
      21,
      draftId,
    );

    await backfillXVariants(db, { generateX });

    const rowAfter = db.prepare('SELECT status, last_sent_at, telegram_message_id FROM drafts WHERE id = ?').get(
      draftId,
    ) as { status: string; last_sent_at: string | null; telegram_message_id: number | null };
    expect(rowAfter).toMatchObject({
      status: 'pending',
      last_sent_at: '2026-10-19T08:55:00.000Z',
      telegram_message_id: 21,
    });
  });

  it('throws a typed error (never raw) when the drafts table is unreadable', async () => {
    const db = openTestDb();
    dbs.push(db);
    db.exec('DROP TABLE drafts');
    await expect(backfillXVariants(db, { generateX })).rejects.toThrow(/^backfillX failed: /);
  });
});

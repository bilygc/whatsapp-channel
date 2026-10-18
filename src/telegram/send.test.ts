import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { runTelegramSend, type SendDeps } from './send.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applyMigrations(db);
  return db;
}

/** Seed one article + one draft; returns the draft id. */
function seedDraft(
  db: Database.Database,
  opts: {
    status?: string;
    caption?: string;
    imageUrl?: string | null;
    source?: string;
    url?: string;
  } = {},
): number {
  const url = opts.url ?? `https://example.com/${Math.random().toString(36).slice(2)}`;
  const articleId = Number(
    db
      .prepare(
        `INSERT INTO articles (url_hash, title, source, url, image_url, published_at, status)
         VALUES (@urlHash, 'Title', @source, @url, @imageUrl, '2026-10-17T10:00:00.000Z', 'used')`,
      )
      .run({
        urlHash: `hash-${url}`,
        source: opts.source ?? 'IGN',
        url,
        imageUrl: opts.imageUrl ?? null,
      }).lastInsertRowid,
  );
  return Number(
    db
      .prepare(`INSERT INTO drafts (article_id, caption_es, status) VALUES (?, ?, ?)`)
      .run(
        articleId,
        opts.caption ?? `🔥 Noticia\n\nFuente: IGN ${url}`,
        opts.status ?? 'pending',
      ).lastInsertRowid,
  );
}

function okMessage(messageId = 7): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify({ ok: true, result: { message_id: messageId } }))
        .buffer as ArrayBuffer,
    json: async () => ({ ok: true, result: { message_id: messageId } }),
  } as unknown as Response;
}

function httpError(status: number, description = 'error', retryAfter?: number): Response {
  const body: Record<string, unknown> = { ok: false, description };
  if (retryAfter !== undefined) body.parameters = { retry_after: retryAfter };
  return {
    ok: false,
    status,
    headers: { get: () => null },
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
    json: async () => body,
    body: { cancel: async () => {} },
  } as unknown as Response;
}

function deps(overrides: Partial<SendDeps> = {}): SendDeps {
  return {
    fetchFn: vi.fn(async () => okMessage()),
    token: 'test-token',
    chatId: '123',
    sleep: async () => {},
    ...overrides,
  } as SendDeps;
}

describe('runTelegramSend', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
    vi.restoreAllMocks();
  });

  it('sends only pending drafts, oldest first, and leaves their status alone', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedDraft(db, { status: 'posted', caption: 'already done' });
    const first = seedDraft(db, { caption: '🔥 Primera\n\nFuente: IGN https://example.com/1' });
    const second = seedDraft(db, { caption: '🔥 Segunda\n\nFuente: IGN https://example.com/2' });
    const d = deps();

    const summary = await runTelegramSend(db, d);

    expect(summary).toMatchObject({ total: 2, sent: 2, failed: 0, exitCode: 0 });
    expect(summary.results.map((r) => r.draftId)).toEqual([first, second]);
    const calls = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
    expect(calls).toHaveLength(2);
    // Status changes happen only via the listen buttons, never on send.
    const statuses = db.prepare('SELECT status FROM drafts ORDER BY id').all() as Array<{
      status: string;
    }>;
    expect(statuses.map((s) => s.status)).toEqual(['posted', 'pending', 'pending']);
  });

  it('uses sendPhoto when image_url exists and sendMessage otherwise', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedDraft(db, { imageUrl: 'https://img.example/x.jpg' });
    seedDraft(db, { imageUrl: null });
    const d = deps();
    await runTelegramSend(db, d);
    const calls = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
    expect(calls[0][0]).toMatch(/\/sendPhoto$/);
    expect(calls[1][0]).toMatch(/\/sendMessage$/);
    const photoBody = JSON.parse(calls[0][1].body as string) as Record<string, unknown>;
    expect(photoBody.photo).toBe('https://img.example/x.jpg');
    expect(photoBody).not.toHaveProperty('parse_mode');
    expect(photoBody.reply_markup).toMatchObject({
      inline_keyboard: [
        [
          { text: '✅ Publicado', callback_data: expect.stringMatching(/^draft:\d+:posted$/) },
          { text: '⏭ Omitir', callback_data: expect.stringMatching(/^draft:\d+:skipped$/) },
        ],
      ],
    });
    const textBody = JSON.parse(calls[1][1].body as string) as Record<string, unknown>;
    expect(textBody).not.toHaveProperty('parse_mode');
  });

  it('falls back to sendMessage when Telegram rejects the photo with 400', async () => {
    const db = openTestDb();
    dbs.push(db);
    const draftId = seedDraft(db, { imageUrl: 'https://img.example/gone.jpg' });
    const fetchFn = vi
      .fn(async () => okMessage())
      .mockImplementationOnce(async () => httpError(400, 'Bad Request: wrong file identifier'));
    const summary = await runTelegramSend(db, deps({ fetchFn: fetchFn as typeof fetch }));
    expect(summary).toMatchObject({ sent: 1, failed: 0 });
    expect(summary.results[0]).toMatchObject({ draftId, ok: true, via: 'message', fallback: true });
  });

  it('honours retry_after on 429 then retries once', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedDraft(db);
    const sleep = vi.fn(async () => {});
    const fetchFn = vi
      .fn(async () => okMessage())
      .mockImplementationOnce(async () => httpError(429, 'Too Many Requests', 30));
    const summary = await runTelegramSend(
      db,
      deps({ fetchFn: fetchFn as typeof fetch, sleep: sleep as (ms: number) => Promise<void> }),
    );
    expect(summary).toMatchObject({ sent: 1, failed: 0 });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it('caps the retry_after backoff at 120s so a bogus value finishes fast', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedDraft(db);
    const slept: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      slept.push(ms);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fetchFn = vi
        .fn(async () => okMessage())
        .mockImplementationOnce(async () => httpError(429, 'Too Many Requests', 9999));
      const summary = await runTelegramSend(
        db,
        deps({ fetchFn: fetchFn as typeof fetch, sleep: sleep as (ms: number) => Promise<void> }),
      );
      expect(summary).toMatchObject({ sent: 1, failed: 0 });
      expect(sleep).toHaveBeenCalledOnce();
      expect(slept[0]).toBe(120_000);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toMatch(/9999.*120/);
    } finally {
      warn.mockRestore();
    }
  });

  it('isolates per-draft failures and exits 1 only when everything failed', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedDraft(db, { caption: '🔥 Ok\n\nFuente: IGN https://example.com/ok' });
    seedDraft(db, { imageUrl: 'https://img.example/bad.jpg' });
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith('/sendPhoto')) return httpError(400, 'Bad Request');
      if (String(url).endsWith('/sendMessage')) {
        const count = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter((call) =>
          String(call[0]).endsWith('/sendMessage'),
        ).length;
        // First text send (draft 1) succeeds; the fallback for draft 2 fails.
        if (count === 1) return okMessage();
        return httpError(500, 'Internal Server Error');
      }
      return okMessage();
    });
    const summary = await runTelegramSend(db, deps({ fetchFn: fetchFn as typeof fetch }));
    expect(summary).toMatchObject({ total: 2, sent: 1, failed: 1, exitCode: 0 });
    expect(summary.results[1].error).toMatch(/telegram sendPhoto failed|HTTP 500/);
    // Failed drafts stay pending for a retry.
    expect(
      (db.prepare('SELECT status FROM drafts WHERE id = ?').get(2) as { status: string }).status,
    ).toBe('pending');
  });

  it('exits 1 when every draft failed and never throws a raw error', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedDraft(db);
    const summary = await runTelegramSend(
      db,
      deps({ fetchFn: (async () => httpError(500, 'boom')) as typeof fetch }),
    );
    expect(summary).toMatchObject({ total: 1, sent: 0, failed: 1, exitCode: 1 });
    expect(summary.results[0].error).toMatch(/^telegram send\w* failed for draft \d+: /);
  });

  it('skips drafts whose attribution alone exceeds the caption limit (typed, stays pending)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const draftId = seedDraft(db, {
      caption: `body\n\nFuente: IGN https://example.com/${'x'.repeat(2000)}`,
    });
    const d = deps();
    const summary = await runTelegramSend(db, d);
    expect(summary).toMatchObject({ total: 1, sent: 0, failed: 1, exitCode: 1 });
    expect(summary.results[0]).toMatchObject({ draftId, ok: false });
    expect(summary.results[0].error).toMatch(/attribution/);
    expect(d.fetchFn).not.toHaveBeenCalled();
  });

  it('throws a typed error when the drafts query itself fails', async () => {
    const db = openTestDb();
    dbs.push(db);
    db.exec('DROP TABLE drafts');
    await expect(runTelegramSend(db, deps())).rejects.toThrow(/^telegram send failed: /);
  });

  it('never sends raw transport errors out of the per-draft loop', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedDraft(db);
    const summary = await runTelegramSend(
      db,
      deps({
        fetchFn: (async () => {
          throw new TypeError('socket hang up');
        }) as typeof fetch,
      }),
    );
    expect(summary.results[0].error).toMatch(/^telegram send\w* failed for draft \d+: request failed/);
  });
});

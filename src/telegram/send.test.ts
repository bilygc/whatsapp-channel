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

  it('skips already-sent drafts: the queue is pending AND unsent only (send-once)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const sent = seedDraft(db, { caption: 'already delivered' });
    db.prepare(`UPDATE drafts SET last_sent_at = ?, telegram_message_id = ? WHERE id = ?`).run(
      '2026-10-19T08:55:00.000Z',
      7,
      sent,
    );
    const queued = seedDraft(db, { caption: '🔥 Fresh\n\nFuente: IGN https://example.com/fresh' });
    const d = deps();

    const summary = await runTelegramSend(db, d);

    expect(summary).toMatchObject({ total: 1, sent: 1, failed: 0 });
    expect(summary.results.map((r) => r.draftId)).toEqual([queued]);
    expect(d.fetchFn).toHaveBeenCalledTimes(1);
    // The already-sent row is untouched (not re-stamped, still pending for the human gate).
    const row = db.prepare('SELECT last_sent_at, telegram_message_id FROM drafts WHERE id = ?').get(sent) as {
      last_sent_at: string;
      telegram_message_id: number;
    };
    expect(row).toMatchObject({ last_sent_at: '2026-10-19T08:55:00.000Z', telegram_message_id: 7 });
  });

  it('stamps last_sent_at (injectable clock) + telegram_message_id on success only', async () => {
    const db = openTestDb();
    dbs.push(db);
    const draftId = seedDraft(db);
    const now = new Date('2026-10-19T13:55:00.000Z');

    const summary = await runTelegramSend(
      db,
      deps({ fetchFn: (vi.fn(async () => okMessage(42)) as unknown) as typeof fetch, now: () => now }),
    );

    expect(summary).toMatchObject({ total: 1, sent: 1, failed: 0 });
    const row = db.prepare('SELECT last_sent_at, telegram_message_id, status FROM drafts WHERE id = ?').get(draftId) as {
      last_sent_at: string;
      telegram_message_id: number;
      status: string;
    };
    expect(row.last_sent_at).toBe('2026-10-19T13:55:00.000Z');
    expect(row.telegram_message_id).toBe(42);
    // Status still changes ONLY via the listen buttons.
    expect(row.status).toBe('pending');
  });

  it('failed sends keep last_sent_at NULL, so the draft stays queued for a retry', async () => {
    const db = openTestDb();
    dbs.push(db);
    const draftId = seedDraft(db);
    const fetchFn = vi.fn(async () => httpError(500, 'Internal Server Error'));

    const failed = await runTelegramSend(db, deps({ fetchFn: fetchFn as typeof fetch }));
    expect(failed).toMatchObject({ total: 1, sent: 0, failed: 1, exitCode: 1 });
    const row = db.prepare('SELECT last_sent_at, telegram_message_id FROM drafts WHERE id = ?').get(draftId) as {
      last_sent_at: string | null;
      telegram_message_id: number | null;
    };
    expect(row.last_sent_at).toBeNull();
    expect(row.telegram_message_id).toBeNull();

    // And the retry actually sends once the API recovers.
    const recovered = await runTelegramSend(
      db,
      deps({ fetchFn: (vi.fn(async () => okMessage(9)) as unknown) as typeof fetch }),
    );
    expect(recovered).toMatchObject({ total: 1, sent: 1, failed: 0 });
    const stamped = db.prepare('SELECT last_sent_at, telegram_message_id FROM drafts WHERE id = ?').get(draftId) as {
      last_sent_at: string | null;
      telegram_message_id: number | null;
    };
    expect(stamped.last_sent_at).not.toBeNull();
    expect(stamped.telegram_message_id).toBe(9);
  });

  it('photo→text fallback stamps the FALLBACK message id (the call that delivered)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const draftId = seedDraft(db, { imageUrl: 'https://img.example/gone.jpg' });
    const fetchFn = vi
      .fn(async () => okMessage(99))
      .mockImplementationOnce(async () => httpError(400, 'Bad Request: wrong file identifier'));
    const summary = await runTelegramSend(db, deps({ fetchFn: fetchFn as typeof fetch }));
    expect(summary.results[0]).toMatchObject({ draftId, ok: true, via: 'message', fallback: true });
    const row = db.prepare('SELECT telegram_message_id, last_sent_at FROM drafts WHERE id = ?').get(draftId) as {
      telegram_message_id: number | null;
      last_sent_at: string | null;
    };
    expect(row.telegram_message_id).toBe(99);
    expect(row.last_sent_at).not.toBeNull();
  });

  it('a failing send stamp is recorded typed and the draft stays queued (at-least-once fallback)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const draftId = seedDraft(db);
    // Sabotage ONLY the full stamp: updates carrying a message_id abort, so
    // the best-effort fallback (sent-at without message_id) still lands and
    // the delivered draft is NOT re-queued.
    db.exec(
      `CREATE TRIGGER fail_stamp BEFORE UPDATE ON drafts WHEN NEW.telegram_message_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    const fetchFn = vi.fn(async () => okMessage(7));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summary = await runTelegramSend(db, deps({ fetchFn: fetchFn as typeof fetch }));
      // The message WAS delivered (one API call): treated as delivered with a
      // loud warning — never silently re-queued for a duplicate send.
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(summary).toMatchObject({ total: 1, sent: 1, failed: 0, exitCode: 0 });
      expect(summary.results[0]).toMatchObject({ draftId, ok: true });
      expect(summary.results[0].warning).toMatch(/tracking degraded/);
      expect(summary.warnings).toHaveLength(1);
      expect(summary.warnings[0]).toMatch(/tracking degraded/);
      expect(warn).toHaveBeenCalledOnce();
      const row = db.prepare('SELECT last_sent_at, telegram_message_id FROM drafts WHERE id = ?').get(draftId) as {
        last_sent_at: string | null;
        telegram_message_id: number | null;
      };
      expect(row.last_sent_at).not.toBeNull();
      expect(row.telegram_message_id).toBeNull();
      // And the next run sends nothing new (no duplicate).
      const again = await runTelegramSend(
        db,
        deps({ fetchFn: fetchFn as typeof fetch }),
      );
      expect(again).toMatchObject({ total: 0, sent: 0, failed: 0 });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a totally-failing stamp still reports DELIVERED with a loud warning (never a silent re-queue)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedDraft(db);
    // Sabotage EVERY update on drafts: even the best-effort fallback fails.
    db.exec(
      `CREATE TRIGGER fail_stamp BEFORE UPDATE ON drafts BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    const fetchFn = vi.fn(async () => okMessage(7));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summary = await runTelegramSend(db, deps({ fetchFn: fetchFn as typeof fetch }));
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(summary).toMatchObject({ total: 1, sent: 1, failed: 0, exitCode: 0 });
      expect(summary.results[0].warning).toMatch(/tracking failed/);
      expect(summary.warnings).toHaveLength(1);
      expect(warn).toHaveBeenCalledOnce();
      expect(summary.results[0].error ?? '').not.toContain('Error: Error');
    } finally {
      warn.mockRestore();
    }
  });

  it('a concurrent-race loser (CAS changes === 0) is sent-skipped, not sent', async () => {
    const db = openTestDb();
    dbs.push(db);
    const draftId = seedDraft(db);
    // Simulate the concurrent winner: stamp the row while the "send" is in
    // flight (inside the fetch mock), so our CAS stamp finds changes === 0.
    const fetchFn = vi.fn(async () => {
      db.prepare(
        `UPDATE drafts SET last_sent_at = ?, telegram_message_id = ? WHERE id = ? AND last_sent_at IS NULL`,
      ).run('2026-10-19T08:55:00.000Z', 99, draftId);
      return okMessage(7);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summary = await runTelegramSend(db, deps({ fetchFn: fetchFn as typeof fetch }));
      expect(summary).toMatchObject({ total: 1, sent: 0, failed: 0, exitCode: 0 });
      expect(summary.results[0]).toMatchObject({ draftId, ok: false, skipped: true });
      expect(summary.results[0].warning).toMatch(/concurrent/);
      expect(summary.warnings).toHaveLength(1);
      expect(warn).toHaveBeenCalledOnce();
      // The winner's stamp survives (our message_id 7 does not clobber 99).
      const row = db.prepare('SELECT last_sent_at, telegram_message_id FROM drafts WHERE id = ?').get(draftId) as {
        last_sent_at: string;
        telegram_message_id: number;
      };
      expect(row).toMatchObject({ last_sent_at: '2026-10-19T08:55:00.000Z', telegram_message_id: 99 });
    } finally {
      warn.mockRestore();
    }
  });

  it('bounds the per-run send set: 15 queued → 12 sent, 3 left queued-and-unsent', async () => {
    const db = openTestDb();
    dbs.push(db);
    for (let i = 0; i < 15; i++) seedDraft(db);
    const fetchFn = vi.fn(async () => okMessage(7));

    const summary = await runTelegramSend(db, deps({ fetchFn: fetchFn as typeof fetch }));

    expect(summary).toMatchObject({ total: 12, sent: 12, failed: 0, exitCode: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(12);
    const remaining = db.prepare(
      `SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending' AND last_sent_at IS NULL`,
    ).get() as { n: number };
    expect(remaining.n).toBe(3);
    // The surplus waits for a later window (oldest first).
    const sentIds = summary.results.map((r) => r.draftId).sort((a, b) => a - b);
    expect(sentIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('honours an explicit per-run limit', async () => {
    const db = openTestDb();
    dbs.push(db);
    for (let i = 0; i < 3; i++) seedDraft(db);
    const fetchFn = vi.fn(async () => okMessage(7));

    const summary = await runTelegramSend(db, deps({ fetchFn: fetchFn as typeof fetch, limit: 1 }));

    expect(summary).toMatchObject({ total: 1, sent: 1, failed: 0 });
    const remaining = db.prepare(
      `SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending' AND last_sent_at IS NULL`,
    ).get() as { n: number };
    expect(remaining.n).toBe(2);
  });

  it('refuses a non-integer limit with a typed error (never throws raw)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedDraft(db);
    await expect(runTelegramSend(db, deps({ limit: 1.5 }))).rejects.toThrow(
      /^telegram send failed: limit must be a non-negative integer/,
    );
  });
});

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { runDeliver, type DeliverDeps } from './run.js';
import type { SendSummary } from '../telegram/send.js';
import { SEND_QUEUE_LIMIT } from '../telegram/send.js';
import type { WriteSummary } from '../writer/run.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applyMigrations(db);
  return db;
}

function seedNew(db: Database.Database, urls: string[]): void {
  const stmt = db.prepare(
    `INSERT INTO articles (url_hash, title, source, url, published_at, status)
     VALUES (@urlHash, @title, 'IGN', @url, '2026-10-19T07:00:00.000Z', 'new')`,
  );
  urls.forEach((url, i) => stmt.run({ urlHash: `d-hash-${i}-${url}`, title: `Title ${url}`, url }));
}

/** Seed one article + one pending draft; returns the draft id. */
function seedPendingDraft(db: Database.Database, url: string): number {
  const articleId = Number(
    db
      .prepare(
        `INSERT INTO articles (url_hash, title, source, url, published_at, status)
         VALUES (@urlHash, 'Title', 'IGN', @url, '2026-10-19T07:00:00.000Z', 'used')`,
      )
      .run({ urlHash: `d-pend-${url}`, url }).lastInsertRowid,
  );
  return Number(
    db
      .prepare(`INSERT INTO drafts (article_id, caption_es, status) VALUES (?, ?, 'pending')`)
      .run(articleId, `🔥 Noticia\n\nFuente: IGN ${url}`).lastInsertRowid,
  );
}

function okMessage(): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify({ ok: true, result: { message_id: 7 } }))
        .buffer as ArrayBuffer,
    json: async () => ({ ok: true, result: { message_id: 7 } }),
  } as unknown as Response;
}

function httpError(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify({ ok: false, description: 'boom' }))
        .buffer as ArrayBuffer,
    json: async () => ({ ok: false, description: 'boom' }),
    body: { cancel: async () => {} },
  } as unknown as Response;
}

function deps(overrides: Partial<DeliverDeps> = {}): DeliverDeps {
  return {
    // Realistic default: captions carry the canonical attribution line.
    generate: async (article) => `🔥 ${article.title}\n\nFuente: ${article.source} ${article.url}`,
    fetchFn: (async () => okMessage()) as typeof fetch,
    token: 'test-token',
    chatId: '123',
    sleep: async () => {},
    ...overrides,
  };
}

describe('runDeliver (select → write → telegramSend chain)', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
    vi.restoreAllMocks();
  });

  it('skips write+send when select finds 0 articles (fine outcome, exit 0)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const generate = vi.fn(deps().generate);
    const fetchFn = vi.fn(deps().fetchFn);

    const summary = await runDeliver(db, deps({ generate, fetchFn }));

    expect(summary).toMatchObject({ scored: 0, selected: 0, exitCode: 0 });
    expect(summary.write).toBeNull();
    expect(summary.send).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('runs the full chain on the happy path (exit 0, drafts sent)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedNew(db, ['https://example.com/a', 'https://example.com/b']);

    const summary = await runDeliver(db, deps());

    expect(summary.selected).toBe(2);
    expect(summary.write).toMatchObject({ total: 2, written: 2, failed: 0 });
    expect(summary.send).toMatchObject({ total: 2, sent: 2, failed: 0 });
    expect(summary.exitCode).toBe(0);
  });

  it('write total-failure does NOT abort send: old pendings still deliver, exit per send', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedNew(db, ['https://example.com/doomed']);
    seedPendingDraft(db, 'https://example.com/stale');

    const summary = await runDeliver(
      db,
      deps({
        generate: async () => {
          throw new Error('llm write failed for article 1: HTTP 429');
        },
      }),
    );

    expect(summary.write).toMatchObject({ total: 1, written: 0, failed: 1 });
    // The failed article stays `selected` (retryable); the stale pending still sent.
    expect(summary.send).toMatchObject({ total: 1, sent: 1, failed: 0 });
    expect(summary.exitCode).toBe(0);
    expect(
      (db.prepare(`SELECT status FROM articles WHERE url = ?`).get('https://example.com/doomed') as { status: string }).status,
    ).toBe('selected');
  });

  it('a throwing write run is recorded (not thrown) and send still runs', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedNew(db, ['https://example.com/a']);
    const writeFn = vi.fn(async (): Promise<WriteSummary> => {
      throw new Error('writer run failed: boom');
    });
    const sendFn = vi.fn(async (): Promise<SendSummary> => ({
      results: [],
      total: 0,
      sent: 0,
      failed: 0,
      warnings: [],
      exitCode: 0,
    }));

    const summary = await runDeliver(db, deps({ writeFn, sendFn }));

    expect(summary.write).toBeNull();
    expect(summary.writeSkippedReason).toMatch(/writer run failed/);
    expect(sendFn).toHaveBeenCalledOnce();
    expect(summary.exitCode).toBe(0);
  });

  it('missing LLM generate skips write with a reason but still sends pendings', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedNew(db, ['https://example.com/a']);
    seedPendingDraft(db, 'https://example.com/stale');

    const summary = await runDeliver(db, deps({ generate: undefined }));

    // `limit` selects the new article, but with no generate the write is skipped.
    expect(summary.selected).toBe(1);
    expect(summary.write).toBeNull();
    expect(summary.writeSkippedReason).toMatch(/OPENROUTER_API_KEY/);
    expect(summary.send).toMatchObject({ total: 1, sent: 1, failed: 0 });
    expect(summary.exitCode).toBe(0);
  });

  it('selection failure aborts the chain with a typed error (write/send never run)', async () => {
    const db = openTestDb();
    dbs.push(db);
    db.exec('DROP TABLE articles');
    const writeFn = vi.fn();
    const sendFn = vi.fn();

    await expect(runDeliver(db, deps({ writeFn, sendFn }))).rejects.toThrow(
      /^deliver failed at select: /,
    );
    expect(writeFn).not.toHaveBeenCalled();
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('an injected select failure also aborts with a typed error', async () => {
    const db = openTestDb();
    dbs.push(db);
    const sendFn = vi.fn();

    await expect(
      runDeliver(
        db,
        deps({
          selectFn: () => {
            throw new Error('select failed: boom');
          },
          sendFn,
        }),
      ),
    ).rejects.toThrow(/^deliver failed at select: select failed: boom/);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('missing telegram config is a clean typed refusal (drafts stay pending)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedNew(db, ['https://example.com/a']);

    await expect(runDeliver(db, deps({ token: undefined, chatId: undefined }))).rejects.toThrow(
      /^deliver failed at telegramSend: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set/,
    );
    // Write already ran and its drafts are durable `pending` for a later retry.
    const drafts = db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    expect(drafts.n).toBe(1);
  });

  it('exits 1 only when ALL sends fail and something was attempted', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedNew(db, ['https://example.com/fresh']);
    seedPendingDraft(db, 'https://example.com/x');

    const summary = await runDeliver(
      db,
      deps({ fetchFn: (async () => httpError(500)) as typeof fetch }),
    );

    // Write succeeded (1 fresh draft) but every send failed → exit 1.
    expect(summary.write).toMatchObject({ total: 1, written: 1, failed: 0 });
    expect(summary.send).toMatchObject({ total: 2, sent: 0, failed: 2, exitCode: 1 });
    expect(summary.exitCode).toBe(1);
    // Failed delivery never loses the draft.
    expect(
      (db.prepare('SELECT status FROM drafts').get() as { status: string }).status,
    ).toBe('pending');
  });

  it('a throwing send run becomes a typed error (never a raw throw)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedNew(db, ['https://example.com/a']);

    await expect(
      runDeliver(
        db,
        deps({
          sendFn: async () => {
            throw new Error('telegram send failed: boom');
          },
        }),
      ),
    ).rejects.toThrow(/^deliver failed at telegramSend: telegram send failed: boom/);
  });

  it('bounds the write set at the just-selected count and threads the injected clock', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedNew(db, ['https://example.com/a', 'https://example.com/b']);
    // Stale leftovers from a previous failed run: the bound must not scoop them all up.
    seedNew(db, ['https://example.com/stale']);
    db.prepare(`UPDATE articles SET status = 'selected' WHERE url = 'https://example.com/stale'`).run();

    const seen: Array<{ limit?: number; now?: Date }> = [];
    const now = new Date('2026-10-19T08:00:00.000Z');
    const writeFn = vi.fn(
      async (
        _db: unknown,
        wdeps: { now: () => Date; generate: unknown; limit?: number },
      ): Promise<WriteSummary> => {
        seen.push({ limit: wdeps.limit, now: wdeps.now() });
        return { results: [], total: 0, written: 0, failed: 0, exitCode: 0 };
      },
    );

    const summary = await runDeliver(db, deps({ writeFn, now }));

    // 2 newly selected → the writer receives exactly that as its bound, plus
    // the injected clock (not wall time).
    expect(summary.selected).toBe(2);
    expect(writeFn).toHaveBeenCalledOnce();
    expect(seen[0].limit).toBe(2);
    expect(seen[0].now?.toISOString()).toBe('2026-10-19T08:00:00.000Z');
  });

  it('passes its own send bound (12) explicitly so a backlog drains over windows', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedNew(db, ['https://example.com/a']);
    let seenLimit: number | undefined;
    const sendFn = vi.fn(
      async (
        _db: unknown,
        sdeps: { limit?: number },
      ): Promise<SendSummary> => {
        seenLimit = sdeps.limit;
        return { results: [], total: 0, sent: 0, failed: 0, warnings: [], exitCode: 0 };
      },
    );

    await runDeliver(db, deps({ sendFn }));

    expect(sendFn).toHaveBeenCalledOnce();
    expect(seenLimit).toBe(SEND_QUEUE_LIMIT);
    expect(seenLimit).toBe(12);
  });

  it('caps the real writer at the selection count (integration: stale leftovers wait)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedNew(db, ['https://example.com/fresh']);
    seedNew(db, ['https://example.com/stale']);
    db.prepare(`UPDATE articles SET status = 'selected' WHERE url = 'https://example.com/stale'`).run();

    // Deliver with limit 1 selects 1 fresh article and bounds the writer at
    // 1: the pre-existing stale leftover is not scooped up this run.
    const summary = await runDeliver(db, deps({ limit: 1 }));

    expect(summary.selected).toBe(1);
    expect(summary.write).toMatchObject({ total: 1, written: 1, failed: 0 });
    const stale = db.prepare(`SELECT status FROM articles WHERE url = 'https://example.com/stale'`).get() as {
      status: string;
    };
    expect(stale.status).toBe('selected');
  });
});

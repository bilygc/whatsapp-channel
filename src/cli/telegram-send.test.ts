import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { parseTelegramSendArgs, rearmDrafts } from './telegram-send.js';

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
  opts: { sent?: boolean; status?: string; url?: string } = {},
): number {
  const url = opts.url ?? `https://example.com/${Math.random().toString(36).slice(2)}`;
  const articleId = Number(
    db
      .prepare(
        `INSERT INTO articles (url_hash, title, source, url, image_url, published_at, status)
         VALUES (@urlHash, 'Title', 'IGN', @url, NULL, '2026-10-17T10:00:00.000Z', 'used')`,
      )
      .run({ urlHash: `hash-${url}`, url }).lastInsertRowid,
  );
  const draftId = Number(
    db
      .prepare(`INSERT INTO drafts (article_id, caption_es, status) VALUES (?, ?, ?)`)
      .run(articleId, `🔥 Noticia\n\nFuente: IGN ${url}`, opts.status ?? 'pending').lastInsertRowid,
  );
  if (opts.sent) {
    db.prepare(`UPDATE drafts SET last_sent_at = ?, telegram_message_id = ? WHERE id = ?`).run(
      '2026-10-19T08:55:00.000Z',
      7,
      draftId,
    );
  }
  return draftId;
}

describe('parseTelegramSendArgs', () => {
  it('defaults to a plain send (no resend, no ids)', () => {
    expect(parseTelegramSendArgs([])).toEqual({ resend: false, ids: [] });
  });

  it('parses --resend with positional draft ids', () => {
    expect(parseTelegramSendArgs(['--resend', '3', '7'])).toEqual({ resend: true, ids: [3, 7] });
  });

  it('parses a bare --resend (re-arm everything pending)', () => {
    expect(parseTelegramSendArgs(['--resend'])).toEqual({ resend: true, ids: [] });
  });

  it('rejects ids without --resend (typed, never a raw throw)', () => {
    expect(() => parseTelegramSendArgs(['3'])).toThrow(/^telegramSend failed: draft ids require --resend/);
  });

  it('rejects non-integer ids with a typed error', () => {
    expect(() => parseTelegramSendArgs(['--resend', 'abc'])).toThrow(/^telegramSend failed: invalid draft id/);
    expect(() => parseTelegramSendArgs(['--resend', '0'])).toThrow(/^telegramSend failed: invalid draft id/);
    expect(() => parseTelegramSendArgs(['--resend', '-2'])).toThrow(/^telegramSend failed: invalid draft id/);
  });
});

describe('rearmDrafts (send-once escape hatch)', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
  });

  it('re-arms every pending draft when no ids are given (already-unsent rows are no-ops)', () => {
    const db = openTestDb();
    dbs.push(db);
    const sentA = seedDraft(db, { sent: true });
    const sentB = seedDraft(db, { sent: true });
    const queued = seedDraft(db);

    const count = rearmDrafts(db);

    expect(count).toBe(3);
    for (const id of [sentA, sentB, queued]) {
      const row = db.prepare('SELECT last_sent_at, telegram_message_id FROM drafts WHERE id = ?').get(id) as {
        last_sent_at: string | null;
        telegram_message_id: number | null;
      };
      expect(row.last_sent_at).toBeNull();
      expect(row.telegram_message_id).toBeNull();
    }
  });

  it('re-arms only the given ids when specified (others keep their stamps)', () => {
    const db = openTestDb();
    dbs.push(db);
    const sentA = seedDraft(db, { sent: true });
    const sentB = seedDraft(db, { sent: true });

    expect(rearmDrafts(db, [sentA])).toBe(1);
    const kept = db.prepare('SELECT last_sent_at, telegram_message_id FROM drafts WHERE id = ?').get(sentB) as {
      last_sent_at: string | null;
      telegram_message_id: number | null;
    };
    expect(kept.last_sent_at).toBe('2026-10-19T08:55:00.000Z');
    expect(kept.telegram_message_id).toBe(7);
    const cleared = db.prepare('SELECT last_sent_at FROM drafts WHERE id = ?').get(sentA) as {
      last_sent_at: string | null;
    };
    expect(cleared.last_sent_at).toBeNull();
  });

  it('never touches non-pending drafts (posted/skipped stay stamped or not)', () => {
    const db = openTestDb();
    dbs.push(db);
    const posted = seedDraft(db, { sent: true, status: 'posted' });

    expect(rearmDrafts(db)).toBe(0);
    const row = db.prepare('SELECT last_sent_at FROM drafts WHERE id = ?').get(posted) as {
      last_sent_at: string | null;
    };
    expect(row.last_sent_at).toBe('2026-10-19T08:55:00.000Z');
  });

  it('throws a typed error (never raw) when the drafts table is unreadable', () => {
    const db = openTestDb();
    dbs.push(db);
    db.exec('DROP TABLE drafts');
    expect(() => rearmDrafts(db)).toThrow(/^telegramSend failed: /);
  });

  it('re-armed drafts re-enter the send queue (integration with runTelegramSend)', async () => {
    const { runTelegramSend } = await import('../telegram/send.js');
    const db = openTestDb();
    dbs.push(db);
    const sent = seedDraft(db, { sent: true, url: 'https://example.com/once' });

    const calls: string[] = [];
    const payload = { ok: true, result: { message_id: 11 } };
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer,
        json: async () => payload,
      };
    }) as unknown as typeof fetch;

    // Nothing to send: the draft is stamped.
    const before = await runTelegramSend(
      db,
      { fetchFn, token: 't', chatId: '1', sleep: async () => {} },
    );
    expect(before.total).toBe(0);
    expect(calls).toHaveLength(0);

    // Re-arm → the same draft sends exactly once more with the new message id.
    expect(rearmDrafts(db, [sent])).toBe(1);
    const after = await runTelegramSend(db, { fetchFn, token: 't', chatId: '1', sleep: async () => {} });
    expect(after).toMatchObject({ total: 1, sent: 1, failed: 0 });
    const row = db.prepare('SELECT telegram_message_id FROM drafts WHERE id = ?').get(sent) as {
      telegram_message_id: number | null;
    };
    expect(row.telegram_message_id).toBe(11);
  });
});
